const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const app = express();

const PORT = Number(process.env.PORT || 10000);
const TEMP_DIR = "/tmp/telegram-router";
const MAX_FILE_SIZE = 4 * 1024 * 1024 * 1024;
const GAP_MS = 2500;

fs.mkdirSync(TEMP_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const channels = [];

for (let i = 1; i <= 5; i++) {
  channels.push({
    id: i,
    label:
      process.env["LABEL_" + i] ||
      (i === 5 ? "Long Videos" : "Channel " + i),
    ref: (process.env["CHANNEL_" + i] || "").trim()
  });
}

let telegramClient = null;

let telegramStatus = {
  connected: false,
  authorized: false,
  error: ""
};

const jobs = new Map();

function createJobId() {
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2)
  );
}

function getChannel(id) {
  return channels.find(function (channel) {
    return channel.id === Number(id);
  });
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function cleanFileName(name) {
  return String(name || "video")
    .replace(/[^a-zA-Z0-9._() -]/g, "_")
    .slice(0, 180);
}

async function connectTelegram() {
  const apiId = Number(process.env.API_ID || 0);
  const apiHash = String(
    process.env.API_HASH || ""
  ).trim();

  const sessionString = String(
    process.env.SESSION_STRING || ""
  ).trim();

  if (!apiId) {
    throw new Error("API_ID is missing.");
  }

  if (!apiHash) {
    throw new Error("API_HASH is missing.");
  }

  if (!sessionString) {
    throw new Error("SESSION_STRING is missing.");
  }

  if (telegramClient) {
    try {
      await telegramClient.disconnect();
    } catch (error) {}
  }

  telegramClient = new TelegramClient(
    new StringSession(sessionString),
    apiId,
    apiHash,
    {
      connectionRetries: 5
    }
  );

  await telegramClient.connect();

  const authorized =
    await telegramClient.checkAuthorization();

  if (!authorized) {
    throw new Error(
      "Telegram session is not authorized."
    );
  }

  telegramStatus = {
    connected: true,
    authorized: true,
    error: ""
  };

  console.log(
    "[TELEGRAM] Connected and authorized."
  );

  return telegramClient;
}

async function getTelegramClient() {
  if (
    telegramClient &&
    telegramStatus.connected &&
    telegramStatus.authorized
  ) {
    return telegramClient;
  }

  return connectTelegram();
}

async function startTelegram() {
  try {
    await connectTelegram();
  } catch (error) {
    telegramStatus = {
      connected: false,
      authorized: false,
      error: error.message
    };

    console.error(
      "[TELEGRAM] " + error.message
    );
  }
}

const storage = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, TEMP_DIR);
  },

  filename: function (req, file, callback) {
    const fileName =
      Date.now() +
      "-" +
      Math.random().toString(36).slice(2) +
      "-" +
      cleanFileName(file.originalname);

    callback(null, fileName);
  }
});

const upload = multer({
  storage: storage,

  limits: {
    fileSize: MAX_FILE_SIZE
  }
});

app.get("/api/status", function (req, res) {
  res.json({
    ok: true,
    telegram: telegramStatus,
    channels: channels.map(function (channel) {
      return {
        id: channel.id,
        label: channel.label,
        configured: Boolean(channel.ref)
      };
    })
  });
});

app.get("/api/config", function (req, res) {
  res.json({
    ok: true,
    channels: channels,
    gapMs: GAP_MS,
    maxFileSize: MAX_FILE_SIZE
  });
});

app.post(
  "/api/reconnect",
  async function (req, res) {
    try {
      await connectTelegram();

      res.json({
        ok: true,
        telegram: telegramStatus
      });
    } catch (error) {
      telegramStatus = {
        connected: false,
        authorized: false,
        error: error.message
      };

      res.status(500).json({
        ok: false,
        error: error.message
      });
    }
  }
);

app.get("/api/jobs", function (req, res) {
  const list = Array.from(
    jobs.values()
  ).sort(function (a, b) {
    return b.createdAt - a.createdAt;
  });

  res.json({
    ok: true,
    jobs: list
  });
});

async function sendVideo(job) {
  const channel = getChannel(
    job.channelId
  );

  if (!channel) {
    throw new Error(
      "Invalid channel selected."
    );
  }

  if (!channel.ref) {
    throw new Error(
      "Selected channel is not configured."
    );
  }

  const client =
    await getTelegramClient();

  const entity =
    await client.getEntity(
      channel.ref
    );

  job.status = "uploading";
  job.message = "Uploading...";
  job.progress = 0;

  try {
    await client.sendFile(entity, {
      file: job.filePath,
      caption: job.fileName,

      progressCallback:
        function (uploaded, total) {
          if (total) {
            job.progress = Math.round(
              (Number(uploaded) /
                Number(total)) *
                100
            );
          }
        }
    });

    job.status = "success";
    job.progress = 100;
    job.message = "Upload successful.";

    return true;
  } catch (error) {
    job.status = "failed";
    job.message = "Upload failed.";
    job.error = error.message;

    return false;
  }
}

app.post(
  "/api/upload",
  upload.single("file"),
  async function (req, res) {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "No video received."
      });
    }

    const channelId =
      Number(req.body.channelId);

    const channel =
      getChannel(channelId);

    if (!channel || !channel.ref) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (error) {}

      return res.status(400).json({
        ok: false,
        error:
          "Selected channel is not configured."
      });
    }

    const job = {
      id: createJobId(),
      channelId: channelId,
      fileName: req.file.originalname,
      filePath: req.file.path,

      status: "queued",
      progress: 0,
      message: "Queued",
      error: "",

      createdAt: Date.now()
    };

    jobs.set(job.id, job);

    res.json({
      ok: true,
      jobId: job.id
    });

    try {
      await sendVideo(job);
    } catch (error) {
      job.status = "failed";
      job.message = "Upload failed.";
      job.error = error.message;
    }

    try {
      fs.unlinkSync(job.filePath);
    } catch (error) {}
  }
);

app.get("*", function (req, res) {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

app.use(
  function (error, req, res, next) {
    console.error(error);

    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Internal server error."
      });
    }
  }
);

app.listen(
  PORT,
  "0.0.0.0",
  async function () {
    console.log(
      "[SERVER] Running on port " +
        PORT
    );

    await startTelegram();
  }
);
