/*
TELEGRAM MASTER ROUTER — Render/GramJS
- 5 Telegram destinations
- Channel 5 = Long Videos
- SESSION_STRING login
- Startup Telegram connection check
- Sequential uploads
- Retry failed uploads
- Pause / Resume / Stop
- Per-channel counters
- SSE live progress
- 4GB multer limit
*/

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const http = require("http");

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const app = express();
const server = http.createServer(app);

server.requestTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 120000;

app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT || 10000);

const TMP_DIR = path.join("/tmp", "telegram-router");

const MAX_FILE_SIZE = 4 * 1024 * 1024 * 1024;

const RETRIES = 2;

const GAP_MS = 2500;

fs.mkdirSync(TMP_DIR, { recursive: true });

const CHANNELS = [1, 2, 3, 4, 5].map(n => ({
  id: n,
  name:
    process.env[`LABEL_${n}`] ||
    (n === 5 ? "Long Videos" : `Channel ${n}`),

  ref: process.env[`CHANNEL_${n}`] || ""
}));

const jobs = new Map();

const batches = new Map();

const telegramState = {
  client: null,
  connected: false,
  authorized: false,
  error: "",
  checkedAt: null
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hasEnv(name) {
  return Boolean(
    process.env[name] &&
    String(process.env[name]).trim()
  );
}

function requireTelegramEnv() {
  const apiId = Number(process.env.API_ID);

  const apiHash = String(
    process.env.API_HASH || ""
  ).trim();

  const session = String(
    process.env.SESSION_STRING || ""
  ).trim();

  if (!apiId || !apiHash) {
    throw new Error(
      "API_ID or API_HASH is missing."
    );
  }

  if (!session) {
    throw new Error(
      "SESSION_STRING is missing."
    );
  }

  return {
    apiId,
    apiHash,
    session
  };
}

async function getClient() {
  if (
    telegramState.client &&
    telegramState.connected &&
    telegramState.authorized
  ) {
    return telegramState.client;
  }

  const {
    apiId,
    apiHash,
    session
  } = requireTelegramEnv();

  const client = new TelegramClient(
    new StringSession(session),
    apiId,
    apiHash,
    {
      connectionRetries: 5
    }
  );

  await client.connect();

  const authorized =
    await client.checkAuthorization();

  if (!authorized) {
    throw new Error(
      "Telegram session is not authorized."
    );
  }

  telegramState.client = client;
  telegramState.connected = true;
  telegramState.authorized = true;
  telegramState.error = "";
  telegramState.checkedAt =
    new Date().toISOString();

  return client;
}

async function startupTelegramCheck() {
  console.log(
    "[TELEGRAM] Checking SESSION_STRING..."
  );

  try {
    await getClient();

    console.log(
      "[TELEGRAM] Connected and authorized successfully."
    );

    console.log(
      "[TELEGRAM] READY — Router can upload."
    );
  } catch (err) {
    telegramState.connected = false;
    telegramState.authorized = false;
    telegramState.error =
      err?.message || String(err);

    telegramState.checkedAt =
      new Date().toISOString();

    console.error(
      "[TELEGRAM] FAILED:",
      telegramState.error
    );
  }
}

function getChannel(channelId) {
  const id = Number(channelId);

  return CHANNELS.find(
    channel => channel.id === id
  );
}

function ensureChannel(channelId) {
  const channel = getChannel(channelId);

  if (!channel) {
    throw new Error(
      `Invalid channel: ${channelId}`
    );
  }

  if (!channel.ref) {
    throw new Error(
      `CHANNEL_${channel.id} is missing in Render Environment Variables.`
    );
  }

  return channel;
}

async function resolveChannel(
  client,
  channel
) {
  return await client.getEntity(channel.ref);
}

function makeJobId() {
  return crypto.randomUUID();
}

function safeName(name) {
  return String(name || "file")
    .replace(/[^\w.\-() ]+/g, "_")
    .slice(0, 180);
}

function createJob(data) {
  const job = {
    id: makeJobId(),

    batchId: data.batchId || null,

    channelId: Number(data.channelId),

    fileName: data.fileName || "file",

    filePath: data.filePath || "",

    status: "queued",

    progress: 0,

    error: "",

    message: "",

    createdAt: Date.now(),

    startedAt: null,

    finishedAt: null
  };

  jobs.set(job.id, job);

  return job;
}

function updateJob(job, patch) {
  Object.assign(job, patch);

  broadcast({
    type: "job",
    job
  });
}

const clients = new Set();

function broadcast(payload) {
  const data =
    `data: ${JSON.stringify(payload)}\n\n`;

  for (const res of clients) {
    try {
      res.write(data);
    } catch (_) {}
  }
}

app.get("/api/events", (req, res) => {
  res.setHeader(
    "Content-Type",
    "text/event-stream"
  );

  res.setHeader(
    "Cache-Control",
    "no-cache"
  );

  res.setHeader(
    "Connection",
    "keep-alive"
  );

  res.flushHeaders();

  clients.add(res);

  res.write(
    `data: ${JSON.stringify({
      type: "connected"
    })}\n\n`
  );

  req.on("close", () => {
    clients.delete(res);
  });
});// ===============================
// MULTER UPLOAD CONFIGURATION
// ===============================

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, TMP_DIR);
  },

  filename: (req, file, cb) => {
    const unique =
      Date.now() +
      "-" +
      Math.random()
        .toString(36)
        .slice(2, 10);

    cb(
      null,
      `${unique}-${safeName(file.originalname)}`
    );
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: MAX_FILE_SIZE
  }
});


// ===============================
// BASIC ROUTES
// ===============================

app.get("/", (req, res) => {
  res.send(HTML);
});


app.get("/api/config", (req, res) => {
  res.json({
    ok: true,

    channels: CHANNELS.map(c => ({
      id: c.id,
      name: c.name,
      configured: Boolean(c.ref)
    })),

    gapMs: GAP_MS,

    maxFileSize: MAX_FILE_SIZE,

    telegram: {
      connected: telegramState.connected,
      authorized: telegramState.authorized,
      error: telegramState.error,
      checkedAt: telegramState.checkedAt
    }
  });
});


app.get("/api/status", async (req, res) => {
  res.json({
    ok: true,

    server: {
      running: true,
      port: PORT,
      uptime: process.uptime()
    },

    telegram: {
      connected:
        telegramState.connected,

      authorized:
        telegramState.authorized,

      error:
        telegramState.error || "",

      checkedAt:
        telegramState.checkedAt
    },

    channels:
      CHANNELS.map(c => ({
        id: c.id,
        name: c.name,
        configured: Boolean(c.ref)
      }))
  });
});


// ===============================
// TELEGRAM RECONNECT
// ===============================

app.post(
  "/api/telegram/reconnect",
  async (req, res) => {
    try {
      if (telegramState.client) {
        try {
          await telegramState.client.disconnect();
        } catch (_) {}
      }

      telegramState.client = null;
      telegramState.connected = false;
      telegramState.authorized = false;

      await getClient();

      res.json({
        ok: true,
        message:
          "Telegram connected successfully."
      });

    } catch (err) {
      telegramState.error =
        err?.message || String(err);

      res.status(500).json({
        ok: false,
        error: telegramState.error
      });
    }
  }
);


// ===============================
// TEST CHANNEL
// ===============================

app.get(
  "/api/test/:channel",
  async (req, res) => {
    try {
      const channel =
        ensureChannel(
          req.params.channel
        );

      const client =
        await getClient();

      const entity =
        await resolveChannel(
          client,
          channel
        );

      res.json({
        ok: true,

        channel: {
          id: channel.id,
          name: channel.name
        },

        telegram: {
          title:
            entity?.title ||
            entity?.username ||
            "Telegram Channel"
        }
      });

    } catch (err) {
      res.status(500).json({
        ok: false,
        error:
          err?.message ||
          String(err)
      });
    }
  }
);


// ===============================
// BATCH CREATION
// ===============================

app.post(
  "/api/batch/create",
  (req, res) => {
    const batchId =
      makeJobId();

    const batch = {
      id: batchId,

      channelId:
        Number(req.body?.channelId || 0),

      total: 0,

      completed: 0,

      success: 0,

      failed: 0,

      status: "created",

      createdAt: Date.now(),

      finishedAt: null
    };

    batches.set(
      batchId,
      batch
    );

    res.json({
      ok: true,
      batch
    });
  }
);


// ===============================
// BATCH STATUS
// ===============================

app.get(
  "/api/batch/:id",
  (req, res) => {
    const batch =
      batches.get(req.params.id);

    if (!batch) {
      return res.status(404).json({
        ok: false,
        error: "Batch not found."
      });
    }

    const batchJobs =
      [...jobs.values()]
        .filter(
          job =>
            job.batchId ===
            batch.id
        );

    res.json({
      ok: true,

      batch,

      jobs: batchJobs
    });
  }
);


// ===============================
// JOB STATUS
// ===============================

app.get(
  "/api/jobs",
  (req, res) => {
    const list =
      [...jobs.values()]
        .sort(
          (a, b) =>
            b.createdAt -
            a.createdAt
        );

    res.json({
      ok: true,
      jobs: list
    });
  }
);


// ===============================
// UPLOAD ONE FILE
// ===============================

async function uploadOneJob(job) {
  if (!job.filePath) {
    throw new Error(
      "File path missing."
    );
  }

  const channel =
    ensureChannel(
      job.channelId
    );

  const client =
    await getClient();

  const entity =
    await resolveChannel(
      client,
      channel
    );

  updateJob(job, {
    status: "uploading",
    startedAt: Date.now(),
    progress: 0,
    message:
      `Uploading to ${channel.name}`
  });

  let lastError = null;

  for (
    let attempt = 1;
    attempt <= RETRIES + 1;
    attempt++
  ) {

    try {

      await client.sendFile(
        entity,
        {
          file: job.filePath,

          caption:
            job.fileName,

          forceDocument: false,

          progressCallback:
            (uploaded, total) => {

              let percent = 0;

              if (total > 0) {
                percent =
                  Math.round(
                    (Number(uploaded) /
                      Number(total)) *
                      100
                  );
              }

              updateJob(job, {
                progress:
                  Math.max(
                    0,
                    Math.min(
                      100,
                      percent
                    )
                  ),

                message:
                  `Uploading ${percent}%`
              });
            }
        }
      );

      updateJob(job, {
        status: "success",

        progress: 100,

        finishedAt:
          Date.now(),

        message:
          "Upload successful."
      });

      return true;

    } catch (err) {

      lastError =
        err?.message ||
        String(err);

      console.error(
        `[UPLOAD] Attempt ${attempt} failed:`,
        lastError
      );

      if (
        attempt <= RETRIES
      ) {
        updateJob(job, {
          status: "retrying",

          message:
            `Retry ${attempt}/${RETRIES}...`,

          error:
            lastError
        });

        await sleep(3000);
      }
    }
  }

  updateJob(job, {
    status: "failed",

    finishedAt:
      Date.now(),

    error:
      lastError ||
      "Upload failed.",

    message:
      "Upload failed."
  });

  return false;
}


// ===============================
// SINGLE FILE UPLOAD API
// ===============================

app.post(
  "/api/upload",
  upload.single("file"),

  async (req, res) => {

    let uploadedFile =
      req.file;

    try {

      if (!uploadedFile) {
        return res.status(400).json({
          ok: false,
          error: "No file received."
        });
      }

      const channelId =
        Number(
          req.body?.channelId
        );

      ensureChannel(
        channelId
      );

      const batchId =
        req.body?.batchId ||
        null;

      const job =
        createJob({
          batchId,

          channelId,

          fileName:
            uploadedFile.originalname,

          filePath:
            uploadedFile.path
        });

      if (batchId) {

        const batch =
          batches.get(batchId);

        if (batch) {
          batch.total++;
          batch.status =
            "running";
        }
      }

      res.json({
        ok: true,

        jobId: job.id,

        batchId,

        message:
          "Upload queued."
      });

      // Run after response
      setImmediate(
        async () => {

          try {

            const success =
              await uploadOneJob(
                job
              );

            if (batchId) {

              const batch =
                batches.get(
                  batchId
                );

              if (batch) {

                batch.completed++;

                if (success) {
                  batch.success++;
                } else {
                  batch.failed++;
                }

                if (
                  batch.completed >=
                  batch.total
                ) {
                  batch.status =
                    "completed";

                  batch.finishedAt =
                    Date.now();
                }

                broadcast({
                  type: "batch",
                  batch
                });
              }
            }

          } catch (err) {

            updateJob(job, {
              status: "failed",

              error:
                err?.message ||
                String(err),

              finishedAt:
                Date.now()
            });

          } finally {

            try {
              await fsp.unlink(
                uploadedFile.path
              );
            } catch (_) {}

          }
        }
      );

    } catch (err) {

      if (
        uploadedFile?.path
      ) {
        try {
          await fsp.unlink(
            uploadedFile.path
          );
        } catch (_) {}
      }

      res.status(500).json({
        ok: false,

        error:
          err?.message ||
          String(err)
      });
    }
  }
);


// ===============================
// RETRY FAILED JOB
// ===============================

app.post(
  "/api/job/:id/retry",
  async (req, res) => {

    const oldJob =
      jobs.get(
        req.params.id
      );

    if (!oldJob) {
      return res.status(404).json({
        ok: false,
        error: "Job not found."
      });
    }

    if (
      oldJob.status !==
      "failed"
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Only failed jobs can be retried."
      });
    }

    if (
      !oldJob.filePath ||
      !fs.existsSync(
        oldJob.filePath
      )
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Original uploaded file is no longer available."
      });
    }

    const newJob =
      createJob({
        batchId:
          oldJob.batchId,

        channelId:
          oldJob.channelId,

        fileName:
          oldJob.fileName,

        filePath:
          oldJob.filePath
      });

    res.json({
      ok: true,

      jobId:
        newJob.id
    });

    setImmediate(
      async () => {
        try {
          await uploadOneJob(
            newJob
          );
        } catch (err) {
          updateJob(
            newJob,
            {
              status: "failed",
              error:
                err?.message ||
                String(err)
            }
          );
        }
      }
    );
  }
);


// ===============================
// DELETE JOB
// ===============================

app.delete(
  "/api/job/:id",
  async (req, res) => {

    const job =
      jobs.get(
        req.params.id
      );

    if (!job) {
      return res.status(404).json({
        ok: false,
        error: "Job not found."
      });
    }

    try {

      if (
        job.filePath &&
        fs.existsSync(
          job.filePath
        )
      ) {
        await fsp.unlink(
          job.filePath
        );
      }

    } catch (_) {}

    jobs.delete(
      req.params.id
    );

    res.json({
      ok: true
    });
  }
);


// ===============================
// GLOBAL ERROR HANDLER
// ===============================

app.use(
  (err, req, res, next) => {

    console.error(
      "[SERVER ERROR]",
      err
    );

    if (
      res.headersSent
    ) {
      return next(err);
    }

    res.status(500).json({
      ok: false,

      error:
        err?.message ||
        "Internal server error."
    });
  }
);// ===============================
// DASHBOARD UI
// ===============================

const HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">

<title>Telegram Master Router</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Arial, sans-serif;
  background: #0b1220;
  color: #ffffff;
}

.container {
  max-width: 1100px;
  margin: auto;
  padding: 20px;
}

.header {
  background: #111c31;
  border-radius: 18px;
  padding: 22px;
  margin-bottom: 18px;
  border: 1px solid #263653;
}

.header h1 {
  margin: 0 0 8px;
  font-size: 26px;
}

.header p {
  margin: 0;
  color: #9eabc2;
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  padding: 8px 13px;
  border-radius: 20px;
  background: #18263e;
  color: #b8c4d9;
}

.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #777;
}

.dot.online {
  background: #22c55e;
}

.dot.offline {
  background: #ef4444;
}

.card {
  background: #111c31;
  border: 1px solid #263653;
  border-radius: 18px;
  padding: 20px;
  margin-bottom: 18px;
}

.card h2 {
  margin-top: 0;
  font-size: 19px;
}

.channels {
  display: grid;
  grid-template-columns:
    repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
}

.channel {
  border: 1px solid #334563;
  background: #16233a;
  color: white;
  border-radius: 14px;
  padding: 16px;
  cursor: pointer;
  text-align: left;
  transition: .2s;
}

.channel:hover {
  transform: translateY(-2px);
  border-color: #4f8cff;
}

.channel.selected {
  border-color: #4f8cff;
  background: #173a70;
}

.channel .number {
  font-size: 13px;
  color: #8fa2c2;
}

.channel .name {
  margin-top: 6px;
  font-size: 17px;
  font-weight: bold;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 16px;
}

button {
  border: 0;
  border-radius: 11px;
  padding: 12px 17px;
  cursor: pointer;
  font-weight: bold;
}

.primary {
  background: #2563eb;
  color: white;
}

.success {
  background: #16a34a;
  color: white;
}

.warning {
  background: #d97706;
  color: white;
}

.danger {
  background: #dc2626;
  color: white;
}

.secondary {
  background: #334155;
  color: white;
}

button:disabled {
  opacity: .45;
  cursor: not-allowed;
}

.drop {
  border: 2px dashed #405273;
  border-radius: 16px;
  padding: 30px;
  text-align: center;
  color: #aab7cc;
  cursor: pointer;
}

.drop:hover {
  border-color: #4f8cff;
}

input[type=file] {
  display: none;
}

.file-list {
  margin-top: 15px;
}

.file-item {
  background: #16233a;
  border-radius: 12px;
  padding: 12px;
  margin-top: 8px;
}

.progress {
  width: 100%;
  height: 8px;
  background: #263653;
  border-radius: 10px;
  overflow: hidden;
  margin-top: 8px;
}

.progress-bar {
  height: 100%;
  width: 0%;
  background: #2563eb;
  transition: width .2s;
}

.stats {
  display: grid;
  grid-template-columns:
    repeat(auto-fit, minmax(130px, 1fr));
  gap: 10px;
}

.stat {
  background: #16233a;
  border-radius: 14px;
  padding: 15px;
}

.stat-title {
  color: #8fa2c2;
  font-size: 13px;
}

.stat-value {
  font-size: 24px;
  font-weight: bold;
  margin-top: 5px;
}

.log {
  background: #08101d;
  border-radius: 12px;
  padding: 12px;
  max-height: 260px;
  overflow-y: auto;
  font-family: monospace;
  font-size: 12px;
}

.log-line {
  padding: 4px 0;
  border-bottom: 1px solid #182337;
}

.small {
  color: #8fa2c2;
  font-size: 13px;
}

.selected-info {
  margin-top: 12px;
  color: #9fb0ca;
}

@media (max-width: 600px) {
  .container {
    padding: 12px;
  }

  .header h1 {
    font-size: 22px;
  }

  .drop {
    padding: 22px 12px;
  }
}
</style>
</head>

<body>

<div class="container">

  <div class="header">

    <h1>TELEGRAM MASTER ROUTER</h1>

    <p>
      Upload videos and send them to your selected Telegram channel.
    </p>

    <div class="status">
      <span id="statusDot" class="dot"></span>
      <span id="statusText">
        Checking Telegram connection...
      </span>
    </div>

  </div>


  <div class="card">

    <h2>1. Select Destination</h2>

    <div
      id="channels"
      class="channels">
    </div>

    <div
      id="selectedInfo"
      class="selected-info">
      No channel selected.
    </div>

  </div>


  <div class="card">

    <h2>2. Select Videos</h2>

    <label
      class="drop"
      for="fileInput">

      <div style="font-size:40px;">
        📤
      </div>

      <div>
        Tap here to select videos
      </div>

      <div class="small">
        Multiple videos supported
      </div>

    </label>

    <input
      id="fileInput"
      type="file"
      accept="video/*"
      multiple>

    <div
      id="fileList"
      class="file-list">
    </div>

    <div class="actions">

      <button
        id="startBtn"
        class="primary"
        onclick="startUploads()">
        START UPLOAD
      </button>

      <button
        class="warning"
        onclick="pauseUploads()">
        PAUSE
      </button>

      <button
        class="success"
        onclick="resumeUploads()">
        RESUME
      </button>

      <button
        class="danger"
        onclick="stopUploads()">
        STOP
      </button>

      <button
        class="secondary"
        onclick="clearFiles()">
        CLEAR
      </button>

    </div>

  </div>


  <div class="card">

    <h2>Upload Statistics</h2>

    <div class="stats">

      <div class="stat">
        <div class="stat-title">
          Total
        </div>
        <div
          id="totalCount"
          class="stat-value">
          0
        </div>
      </div>

      <div class="stat">
        <div class="stat-title">
          Success
        </div>
        <div
          id="successCount"
          class="stat-value">
          0
        </div>
      </div>

      <div class="stat">
        <div class="stat-title">
          Failed
        </div>
        <div
          id="failedCount"
          class="stat-value">
          0
        </div>
      </div>

      <div class="stat">
        <div class="stat-title">
          Current
        </div>
        <div
          id="currentCount"
          class="stat-value">
          0
        </div>
      </div>

    </div>

  </div>


  <div class="card">

    <h2>Live Logs</h2>

    <div
      id="logs"
      class="log">
    </div>

  </div>

</div>


<script>

let channels = [];

let selectedChannel = null;

let selectedFiles = [];

let paused = false;

let stopped = false;

let running = false;

let successCount = 0;

let failedCount = 0;

let currentIndex = 0;


const $ = id =>
  document.getElementById(id);


function log(message) {

  const box =
    $("logs");

  const line =
    document.createElement(
      "div"
    );

  line.className =
    "log-line";

  line.textContent =
    new Date()
      .toLocaleTimeString()
      + " — "
      + message;

  box.prepend(line);
}


function setStatus(
  online,
  text
) {

  const dot =
    $("statusDot");

  dot.className =
    "dot " +
    (online
      ? "online"
      : "offline");

  $("statusText")
    .textContent =
    text;
}


async function loadConfig() {

  try {

    const response =
      await fetch(
        "/api/config"
      );

    const data =
      await response.json();

    channels =
      data.channels || [];

    renderChannels();

    if (
      data.telegram &&
      data.telegram.authorized
    ) {

      setStatus(
        true,
        "Telegram Connected"
      );

      log(
        "Telegram connection ready."
      );

    } else {

      setStatus(
        false,
        "Telegram Not Connected"
      );

      log(
        "Telegram connection is not ready."
      );
    }

  } catch (err) {

    setStatus(
      false,
      "Server connection failed"
    );

    log(
      "Could not load server status."
    );
  }
}


function renderChannels() {

  const box =
    $("channels");

  box.innerHTML = "";

  channels.forEach(
    channel => {

      const button =
        document.createElement(
          "button"
        );

      button.className =
        "channel";

      button.dataset.id =
        channel.id;

      button.innerHTML = `
        <div class="number">
          CHANNEL ${channel.id}
        </div>

        <div class="name">
          ${escapeHtml(channel.name)}
        </div>

        <div class="small">
          ${
            channel.configured
              ? "Configured"
              : "Not configured"
          }
        </div>
      `;

      button.onclick =
        () =>
          selectChannel(
            channel.id
          );

      box.appendChild(
        button
      );
    }
  );
}


function selectChannel(id) {

  selectedChannel =
    Number(id);

  document
    .querySelectorAll(
      ".channel"
    )
    .forEach(
      button => {

        button.classList.toggle(
          "selected",
          Number(
            button.dataset.id
          ) ===
          selectedChannel
        );
      }
    );

  const channel =
    channels.find(
      c =>
        c.id ===
        selectedChannel
    );

  $("selectedInfo")
    .textContent =
    channel
      ? `Selected: ${channel.name}`
      : "No channel selected.";

  log(
    `Selected Channel ${selectedChannel}`
  );
}


$("fileInput")
  .addEventListener(
    "change",
    event => {

      selectedFiles =
        Array.from(
          event.target.files
        );

      renderFiles();

      updateStats();
    }
  );


function renderFiles() {

  const box =
    $("fileList");

  box.innerHTML = "";

  selectedFiles.forEach(
    (file, index) => {

      const item =
        document.createElement(
          "div"
        );

      item.className =
        "file-item";

      item.id =
        `file-${index}`;

      item.innerHTML = `
        <div>
          <strong>
            ${escapeHtml(file.name)}
          </strong>
        </div>

        <div class="small">
          ${formatSize(file.size)}
        </div>

        <div class="progress">
          <div
            id="progress-${index}"
            class="progress-bar">
          </div>
        </div>

        <div
          id="status-${index}"
          class="small">
          Waiting...
        </div>
      `;

      box.appendChild(
        item
      );
    }
  );
}


function formatSize(bytes) {

  if (!bytes) {
    return "0 B";
  }

  const units = [
    "B",
    "KB",
    "MB",
    "GB"
  ];

  let size =
    Number(bytes);

  let i = 0;

  while (
    size >= 1024 &&
    i <
    units.length - 1
  ) {

    size /= 1024;
    i++;
  }

  return (
    size.toFixed(1)
    + " "
    + units[i]
  );
}


function escapeHtml(value) {

  return String(value)
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );
}


function updateStats() {

  $("totalCount")
    .textContent =
    selectedFiles.length;

  $("successCount")
    .textContent =
    successCount;

  $("failedCount")
    .textContent =
    failedCount;

  $("currentCount")
    .textContent =
    currentIndex;
}


function setFileStatus(
  index,
  text
) {

  const element =
    $(
      `status-${index}`
    );

  if (element) {
    element.textContent =
      text;
  }
}


function setFileProgress(
  index,
  percent
) {

  const bar =
    $(
      `progress-${index}`
    );

  if (bar) {
    bar.style.width =
      `${percent}%`;
  }
}


async function waitIfPaused() {

  while (
    paused &&
    !stopped
  ) {
    await sleep(500);
  }
}


function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}


function pauseUploads() {

  if (!running) {
    return;
  }

  paused = true;

  log(
    "Uploads paused."
  );
}


function resumeUploads() {

  paused = false;

  log(
    "Uploads resumed."
  );
}


function stopUploads() {

  stopped = true;

  paused = false;

  log(
    "Stop requested."
  );
}


function clearFiles() {

  if (running) {
    log(
      "Stop upload before clearing files."
    );

    return;
  }

  selectedFiles = [];

  $("fileInput").value =
    "";

  $("fileList").innerHTML =
    "";

  successCount = 0;

  failedCount = 0;

  currentIndex = 0;

  updateStats();

  log(
    "File list cleared."
  );
}


async function startUploads() {

  if (running) {

    log(
      "Upload already running."
    );

    return;
  }

  if (!selectedChannel) {

    alert(
      "Please select a Telegram channel first."
    );

    return;
  }

  if (
    selectedFiles.length ===
    0
  ) {

    alert(
      "Please select at least one video."
    );

    return;
  }

  running = true;

  stopped = false;

  paused = false;

  successCount = 0;

  failedCount = 0;

  currentIndex = 0;

  updateStats();

  log(
    `Starting ${selectedFiles.length} upload(s)...`
  );

  for (
    let i = 0;
    i < selectedFiles.length;
    i++
  ) {

    if (stopped) {

      setFileStatus(
        i,
        "Stopped"
      );

      break;
    }

    currentIndex =
      i + 1;

    updateStats();

    await waitIfPaused();

    if (stopped) {
      break;
    }

    const file =
      selectedFiles[i];

    setFileStatus(
      i,
      "Uploading..."
    );

    setFileProgress(
      i,
      0
    );

    const success =
      await uploadFile(
        file,
        i
      );

    if (success) {

      successCount++;

      setFileStatus(
        i,
        "Success ✓"
      );

      setFileProgress(
        i,
        100
      );

    } else {

      failedCount++;

      setFileStatus(
        i,
        "Failed ✗"
      );
    }

    updateStats();

    if (
      i <
      selectedFiles.length - 1 &&
      !stopped
    ) {

      log(
        "Waiting 2.5 seconds..."
      );

      await sleep(
        2500
      );
    }
  }

  running = false;

  updateStats();

  if (stopped) {

    log(
      "Upload process stopped."
    );

  } else {

    log(
      `Completed. Success: ${successCount}, Failed: ${failedCount}`
    );

    alert(
      `Upload completed.\n\nSuccess: ${successCount}\nFailed: ${failedCount}`
    );
  }
}


async function uploadFile(
  file,
  index
) {

  const form =
    new FormData();

  form.append(
    "file",
    file
  );

  form.append(
    "channelId",
    selectedChannel
  );

  try {

    const response =
      await fetch(
        "/api
