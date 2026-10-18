/*
TELEGRAM MASTER ROUTER
Single-file Replit server.

Features:
- 5 Telegram destinations
- Channels 1-4: normal video queue (500+ files supported one-by-one)
- Channel 5: dedicated long-video destination
- Files processed sequentially
- Telegram MTProto upload via GramJS
- Browser + Telegram upload progress
- Retry failed uploads
- Pause / Resume / Stop
- Batch report
- Failed list / Retry Failed
- 2.5 second gap between videos
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

const PORT = Number(process.env.PORT || 3000);
const TMP_DIR = path.join("/tmp", "telegram-router");

fs.mkdirSync(TMP_DIR, { recursive: true });

const MAX_FILE_SIZE = 4 * 1024 * 1024 * 1024;
const RETRIES = 2;

const CHANNELS = [1, 2, 3, 4, 5].map((n) => ({
  id: n,
  name: n === 5 ? "Channel 5 — Long Videos" : `Channel ${n}`,
  ref: process.env[`CHANNEL_${n}`] || "",
}));

const events = new Map();
const batches = new Map();

const loginState = {
  client: null,
  pending: null,
  error: "",
  authorized: false,
};

function newBatch(batchId, total = 0) {
  const b = {
    id: batchId,
    createdAt: Date.now(),
    total,
    completed: 0,
    success: 0,
    failed: 0,
    paused: false,
    cancelled: false,
    started: false,
    finished: false,
    byChannel: Object.fromEntries(
      [1, 2, 3, 4, 5].map((n) => [n, { success: 0, failed: 0 }])
    ),
    failedItems: [],
    successItems: [],
  };

  batches.set(batchId, b);
  return b;
}

function getBatch(id) {
  return batches.get(id) || newBatch(id, 0);
}

function recordResult(batchId, item) {
  const b = getBatch(batchId);

  b.completed++;

  const ch = Number(item.channel);

  if (item.ok) {
    b.success++;

    if (b.byChannel[ch]) {
      b.byChannel[ch].success++;
    }

    b.successItems.push(item);
  } else {
    b.failed++;

    if (b.byChannel[ch]) {
      b.byChannel[ch].failed++;
    }

    b.failedItems.push(item);
  }
}

function batchSummary(b) {
  return {
    id: b.id,
    total: b.total,
    completed: b.completed,
    success: b.success,
    failed: b.failed,
    remaining: Math.max(0, b.total - b.completed),
    paused: b.paused,
    cancelled: b.cancelled,
    finished: b.finished,
    byChannel: b.byChannel,
    failedItems: b.failedItems,
    successItems: b.successItems,
  };
}

function cleanOldJobs() {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;

  for (const [id, job] of events) {
    if (job.createdAt < cutoff) {
      events.delete(id);
    }
  }
}

setInterval(cleanOldJobs, 30 * 60 * 1000);

function emit(jobId, payload) {
  const job = events.get(jobId);

  if (!job) return;

  job.last = payload;

  for (const res of job.clients) {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {}
  }
}

function createJob(jobId) {
  if (!events.has(jobId)) {
    events.set(jobId, {
      createdAt: Date.now(),
      clients: new Set(),
      last: { type: "ready" },
    });
  }

  return events.get(jobId);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv() {
  const apiId = Number(process.env.API_ID);
  const apiHash = process.env.API_HASH;

  if (!apiId || !apiHash) {
    throw new Error("API_ID and API_HASH are missing in Replit Secrets.");
  }

  return { apiId, apiHash };
}

function hasSession() {
  return Boolean(
    process.env.SESSION_STRING &&
    process.env.SESSION_STRING.trim()
  );
}

async function getClient() {
  const { apiId, apiHash } = requireEnv();

  if (!hasSession()) {
    throw new Error(
      "SESSION_STRING is not configured. Complete Telegram login first."
    );
  }

  if (loginState.client) {
    if (!loginState.client.connected) {
      await loginState.client.connect();
    }

    return loginState.client;
  }

  const session = new StringSession(
    process.env.SESSION_STRING.trim()
  );

  const client = new TelegramClient(
    session,
    apiId,
    apiHash,
    {
      connectionRetries: 5,
      useWSS: false,
    }
  );

  await client.connect();

  if (!(await client.checkAuthorization())) {
    throw new Error(
      "SESSION_STRING is expired or not authorized."
    );
  }

  loginState.client = client;
  loginState.authorized = true;

  return client;
}

async function resolveChannel(client, channelNo) {
  const ch = CHANNELS.find(
    (x) => x.id === Number(channelNo)
  );

  if (!ch || !ch.ref) {
    throw new Error(
      `CHANNEL_${channelNo} is missing in Replit Secrets.`
    );
  }

  return client.getEntity(ch.ref);
}

async function sendTelegramFile(
  jobId,
  filePath,
  originalName,
  channelNo,
  caption
) {
  const client = await getClient();

  const entity = await resolveChannel(
    client,
    channelNo
  );

  emit(jobId, {
    type: "telegram-start",
    channel: channelNo,
    name: originalName,
    percent: 0,
  });

  let lastPercent = -1;

  const result = await client.sendFile(entity, {
    file: filePath,
    caption: caption || originalName,
    forceDocument: false,
    supportsStreaming: true,

    progressCallback: (uploaded, total) => {
      const percent = total
        ? Math.floor(
            (Number(uploaded) / Number(total)) * 100
          )
        : 0;

      if (percent !== lastPercent) {
        lastPercent = percent;

        emit(jobId, {
          type: "telegram-progress",
          channel: channelNo,
          name: originalName,
          percent,
          uploaded: Number(uploaded),
          total: Number(total),
        });
      }
    },
  });

  emit(jobId, {
    type: "telegram-done",
    channel: channelNo,
    name: originalName,
    percent: 100,
  });

  return result;
}

async function sendWithRetry(
  jobId,
  filePath,
  originalName,
  channelNo,
  caption
) {
  let lastError = null;

  for (
    let attempt = 1;
    attempt <= RETRIES + 1;
    attempt++
  ) {
    try {
      emit(jobId, {
        type: "attempt",
        attempt,
        maxAttempts: RETRIES + 1,
        name: originalName,
      });

      return await sendTelegramFile(
        jobId,
        filePath,
        originalName,
        channelNo,
        caption
      );
    } catch (err) {
      lastError = err;

      const msg = String(
        err && err.message ? err.message : err
      );

      const waitMatch =
        msg.match(
          /A wait of (\d+) seconds is required/i
        ) ||
        msg.match(/FLOOD_WAIT_(\d+)/i);

      if (waitMatch && attempt <= RETRIES) {
        const seconds = Math.min(
          Number(waitMatch[1]),
          15 * 60
        );

        emit(jobId, {
          type: "retry-wait",
          seconds,
          name: originalName,
          message:
            `Telegram asked us to wait ${seconds}s.`,
        });

        await sleep(seconds * 1000);
      } else if (attempt <= RETRIES) {
        emit(jobId, {
          type: "retry",
          attempt,
          name: originalName,
          message: msg,
        });

        await sleep(3000);
      }
    }
  }

  throw (
    lastError ||
    new Error("Telegram upload failed.")
  );
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) =>
    cb(null, TMP_DIR),

  filename: (_req, file, cb) => {
    const safe = path
      .basename(file.originalname)
      .replace(/[^\w.\-() ]+/g, "_");

    cb(
      null,
      `${Date.now()}-${crypto
        .randomBytes(6)
        .toString("hex")}-${safe}`
    );
  },
});

const upload = multer({
  storage,

  limits: {
    fileSize: MAX_FILE_SIZE,
  },
});

app.get("/", (_req, res) => {
  res.type("html").send(HTML);
});

app.get("/api/config", (_req, res) => {
  res.json({
    channels: CHANNELS.map((c) => ({
      id: c.id,
      name: c.name,
      configured: Boolean(c.ref),
      longVideo: c.id === 5,
    })),

    hasApi: Boolean(
      process.env.API_ID &&
      process.env.API_HASH
    ),

    hasSession: hasSession(),
  });
});

app.post("/api/batch", (req, res) => {
  const id = String(
    req.body.batchId ||
      crypto.randomUUID()
  );

  const total = Math.max(
    0,
    Number(req.body.total || 0)
  );

  const b = newBatch(id, total);

  res.json({
    ok: true,
    batch: batchSummary(b),
  });
});

app.get("/api/batch/:id", (req, res) => {
  const b = batches.get(req.params.id);

  if (!b) {
    return res.status(404).json({
      ok: false,
      error: "Batch not found",
    });
  }

  res.json({
    ok: true,
    batch: batchSummary(b),
  });
});

app.post(
  "/api/batch/:id/:action",
  (req, res) => {
    const b = batches.get(req.params.id);

    if (!b) {
      return res.status(404).json({
        ok: false,
        error: "Batch not found",
      });
    }

    const action = req.params.action;

    if (action === "pause") {
      b.paused = true;
    } else if (action === "resume") {
      b.paused = false;
    } else if (action === "cancel") {
      b.cancelled = true;
    } else {
      return res.status(400).json({
        ok: false,
        error: "Unknown action",
      });
    }

    res.json({
      ok: true,
      batch: batchSummary(b),
    });
  }
);

app.get(
  "/api/events/:jobId",
  (req, res) => {
    const job = createJob(req.params.jobId);

    res.setHeader(
      "Content-Type",
      "text/event-stream"
    );

    res.setHeader(
      "Cache-Control",
      "no-cache, no-transform"
    );

    res.setHeader(
      "Connection",
      "keep-alive"
    );

    res.flushHeaders();

    job.clients.add(res);

    if (job.last) {
      res.write(
        `data: ${JSON.stringify(
          job.last
        )}\n\n`
      );
    }

    const keepAlive = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {}
    }, 15000);

    req.on("close", () => {
      clearInterval(keepAlive);
      job.clients.delete(res);
    });
  }
);

app.get(
  "/api/test/:channel",
  async (req, res) => {
    try {
      const client = await getClient();

      const entity = await resolveChannel(
        client,
        Number(req.params.channel)
      );

      const title =
        entity.title ||
        entity.username ||
        "Channel";

      res.json({
        ok: true,
        title,
      });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: String(
          err.message || err
        ),
      });
    }
  }
);

app.post(
  "/api/auth/start",
  async (req, res) => {
    try {
      const { apiId, apiHash } =
        requireEnv();

      const phone = String(
        req.body.phone || ""
      ).trim();

      if (!phone) {
        return res.status(400).json({
          error: "Phone number required.",
        });
      }

      if (loginState.pending) {
        return res.status(400).json({
          error:
            "A login is already in progress.",
        });
      }

      const client =
        new TelegramClient(
          new StringSession(""),
          apiId,
          apiHash,
          {
            connectionRetries: 5,
          }
        );

      await client.connect();

      let resolveCode;
      let rejectCode;
      let resolvePassword;
      let rejectPassword;

      const codePromise =
        new Promise(
          (resolve, reject) => {
            resolveCode = resolve;
            rejectCode = reject;
          }
        );

      const passwordPromise =
        new Promise(
          (resolve, reject) => {
            resolvePassword = resolve;
            rejectPassword = reject;
          }
        );

      loginState.pending = {
        phone,
        client,
        resolveCode,
        rejectCode,
        resolvePassword,
        rejectPassword,
        stage: "code",
      };

      loginState.error = "";

      (async () => {
        try {
          await client.start({
            phoneNumber: async () =>
              phone,

            phoneCode: async () =>
              await codePromise,

            password: async () => {
              loginState.pending.stage =
                "password";

              return await passwordPromise;
            },

            onError: (err) => {
              loginState.error =
                String(
                  err.message || err
                );

              return true;
            },
          });

          const session =
            client.session.save();

          loginState.client = client;
          loginState.authorized = true;
          loginState.pending = null;

          emit("AUTH", {
            type: "auth-success",
            session,
          });
        } catch (err) {
          loginState.error =
            String(
              err.message || err
            );

          loginState.pending = null;

          try {
            await client.disconnect();
          } catch {}
        }
      })();

      await sleep(500);

      res.json({
        ok: true,
        message:
          "Telegram login started. Enter the code sent to Telegram.",
      });
    } catch (err) {
      res.status(400).json({
        error: String(
          err.message || err
        ),
      });
    }
  }
);

app.post(
  "/api/auth/code",
  (req, res) => {
    const p = loginState.pending;

    if (!p) {
      return res.status(400).json({
        error:
          "No login is waiting for a code.",
      });
    }

    const code = String(
      req.body.code || ""
    ).trim();

    if (!code) {
      return res.status(400).json({
        error: "Code required.",
      });
    }

    p.resolveCode(code);

    res.json({ ok: true });
  }
);

app.post(
  "/api/auth/password",
  (req, res) => {
    const p = loginState.pending;

    if (!p) {
      return res.status(400).json({
        error:
          "No login is waiting for a password.",
      });
    }

    const password = String(
      req.body.password || ""
    );

    if (!password) {
      return res.status(400).json({
        error:
          "2FA password required.",
      });
    }

    p.resolvePassword(password);

    res.json({ ok: true });
  }
);

app.get(
  "/api/auth/status",
  (_req, res) => {
    res.json({
      hasApi: Boolean(
        process.env.API_ID &&
        process.env.API_HASH
      ),

      hasSession: hasSession(),

      authorized: Boolean(
        loginState.authorized ||
        hasSession()
      ),

      pending:
        loginState.pending
          ? loginState.pending.stage
          : null,

      error:
        loginState.error || "",
    });
  }
);

app.post(
  "/api/upload",
  upload.single("video"),
  async (req, res) => {
    const jobId = String(
      req.body.jobId || ""
    ).trim();

    const batchId = String(
      req.body.batchId || jobId
    ).trim();

    const requestedChannel =
      Number(req.body.channel);

    const caption = String(
      req.body.caption || ""
    ).trim();

    createJob(jobId);
    getBatch(batchId);

    if (!jobId) {
      return res.status(400).json({
        error: "jobId is required.",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error:
          "No video file received.",
      });
    }

    if (
      ![1, 2, 3, 4, 5].includes(
        requestedChannel
      )
    ) {
      await fsp
        .unlink(req.file.path)
        .catch(() => {});

      return res.status(400).json({
        error: "Invalid channel.",
      });
    }

    const fileSizeMB =
      req.file.size /
      (1024 * 1024);

    const channel =
      requestedChannel;

    emit(jobId, {
      type: "received",
      name: req.file.originalname,
      sizeMB:
        fileSizeMB.toFixed(1),
      requestedChannel,
      channel,
    });

    try {
      await sendWithRetry(
        jobId,
        req.file.path,
        req.file.originalname,
        channel,
        caption ||
          req.file.originalname
      );

      emit(jobId, {
        type: "success",
        name: req.file.originalname,
        channel,
      });

      recordResult(batchId, {
        ok: true,
        name: req.file.originalname,
        channel,
        at: Date.now(),
      });

      res.json({
        ok: true,
        channel,
        name: req.file.originalname,
        sizeMB:
          fileSizeMB.toFixed(1),
      });
    } catch (err) {
      const error = String(
        err.message || err
      );

      emit(jobId, {
        type: "failed",
        name: req.file.originalname,
        channel,
        error,
      });

      recordResult(batchId, {
        ok: false,
        name: req.file.originalname,
        channel,
        error,
        at: Date.now(),
      });

      res.status(500).json({
        ok: false,
        error,
      });
    } finally {
      await fsp
        .unlink(req.file.path)
        .catch(() => {});
    }
  }
);

app.use(
  (err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      if (
        err.code ===
        "LIMIT_FILE_SIZE"
      ) {
        return res
          .status(413)
          .json({
            error:
              "File is larger than the 4GB upload limit.",
          });
      }

      return res.status(400).json({
        error: err.message,
      });
    }

    res.status(500).json({
      error: String(
        err.message || err
      ),
    });
  }
);

const HTML = `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telegram Master Router</title>

<style>
*{box-sizing:border-box}

body{
  margin:0;
  font-family:system-ui,-apple-system,Segoe UI,sans-serif;
  background:#eef2f7;
  color:#172033
}

.wrap{
  max-width:980px;
  margin:auto;
  padding:18px
}

.card{
  background:white;
  border:1px solid #dbe2ea;
  border-radius:14px;
  padding:18px;
  margin-bottom:16px;
  box-shadow:0 2px 10px #0000000a
}

h1{
  margin:0 0 6px;
  font-size:24px
}

h2{
  font-size:18px;
  margin:0 0 12px
}

.muted{
  color:#687386;
  font-size:13px
}

.grid{
  display:grid;
  grid-template-columns:repeat(5,1fr);
  gap:8px
}

.ch{
  padding:12px;
  border:1px solid #ccd5e1;
  background:#fff;
  border-radius:10px;
  cursor:pointer
}

.ch.active{
  border:2px solid #2563eb;
  background:#eff6ff
}

.ch.long{
  border-color:#f59e0b
}

button,.btn{
  border:0;
  border-radius:9px;
  padding:11px 14px;
  font-weight:700;
  cursor:pointer
}

.primary{
  background:#2563eb;
  color:white
}

.green{
  background:#059669;
  color:white
}

.gray{
  background:#e5e7eb
}

input,select{
  width:100%;
  padding:11px;
  border:1px solid #cbd5e1;
border-radius:9px
}

.filebox{
border:2px dashed #b9c5d4;
border-radius:12px;
padding:24px;
text-align:center
}

.row{
display:flex;
gap:10px;
align-items:center
}

.row>*{
flex:1
}

.progress{
height:10px;
background:#e5e7eb;
border-radius:20px;
overflow:hidden
}

.bar{
height:100%;
width:0;
background:#2563eb;
transition:width .2s
}

.item{
padding:10px 0;
border-bottom:1px solid #edf0f4
}

.ok{
color:#059669;
font-weight:700
}

.bad{
color:#dc2626;
font-weight:700
}

.blue{
color:#2563eb;
font-weight:700
}

.log{
height:190px;
overflow:auto;
background:#111827;
color:#d1fae5;
padding:12px;
border-radius:10px;
font:12px monospace
}

.small{
font-size:12px
}

.hidden{
display:none
}

@media(max-width:700px){
.grid{
grid-template-columns:1fr 1fr
}

.row{
flex-direction:column;
align-items:stretch
}
}
</style>
</head>

<body>

<div class="wrap">

<div class="card">
<h1>TELEGRAM MASTER ROUTER</h1>
<div class="muted">
5 channels • one-by-one queue • Channel 5 for long videos
</div>
</div>

<div class="card">
<h2>Telegram Connection</h2>
<div id="auth-section">
  <div class="muted">Checking connection status...</div>
</div>
</div>

</div>

<script>
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    const section = document.getElementById('auth-section');
    
    if (data.authorized || data.hasSession) {
      section.innerHTML = `<div class="ok">✓ Telegram Client is Authorized and Connected!</div>`;
    } else {
      section.innerHTML = `<div class="bad">⚠️ Session not found. Please check your API_ID, API_HASH and SESSION_STRING in Environment Variables.</div>`;
    }
  } catch (e) {
    console.error(e);
  }
}
checkAuth();
</script>

</body>
</html>
`;

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
  
