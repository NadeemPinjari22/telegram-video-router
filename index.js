const express = require("express");
const multer = require("multer");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { TelegramClient, StringSession, errors } = require("telegram");

// ================= CONFIGURATION =================
const PORT = Number(process.env.PORT || 3000);
const COOLDOWN_MS = 3000; // Har video ke baad 3 second ka compulsory safe gap
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2GB
const TMP_DIR = path.resolve(__dirname, "telegram_uploads");

// Temp directory create karna
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// Multer Disk Storage config
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TMP_DIR),
  filename: (_req, file, cb) => {
    const safeHash = crypto.randomBytes(6).toString("hex");
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `vid_${Date.now()}_${safeHash}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE }
});

// ================= GLOBAL STATE & CACHE =================
let tgClient = null;
let connectingPromise = null;
const entityCache = new Map();
const sseClients = new Map();
const dbJobs = new Map();
const queue = [];
let isQueueRunning = false;

// ================= TELEGRAM ENGINE =================
async function getTelegramClient() {
  if (!process.env.API_ID || !process.env.API_HASH) {
    throw new Error("Secrets mein API_ID aur API_HASH add karein.");
  }
  if (!process.env.SESSION_STRING) {
    throw new Error("Secrets mein SESSION_STRING add karein.");
  }

  if (tgClient && tgClient.connected) return tgClient;
  if (connectingPromise) return connectingPromise;

  connectingPromise = (async () => {
    const client = new TelegramClient(
      new StringSession(process.env.SESSION_STRING),
      Number(process.env.API_ID),
      process.env.API_HASH,
      {
        connectionRetries: 5,
        retryDelay: 2000,
        autoReconnect: true,
        useWSS: false,
        deviceModel: "Cloud Video Router",
        appVersion: "2.5.0"
      }
    );

    await client.connect();
    tgClient = client;
    return client;
  })();

  try {
    return await connectingPromise;
  } finally {
    connectingPromise = null;
  }
}

// Channel Entity Resolver (Cache ke sath taaki PEER_FLOOD na aaye)
async function resolveChannel(client, channelNum) {
  const channelVal = process.env[`CHANNEL_${channelNum}`] || channelNum;
  if (!channelVal) {
    throw new Error(`CHANNEL_${channelNum} configuration missing hai.`);
  }

  if (entityCache.has(channelVal)) {
    return entityCache.get(channelVal);
  }

  const entity = await client.getEntity(channelVal);
  entityCache.set(channelVal, entity);
  return entity;
}

// ================= PROGRESS BROADCASTER =================
function updateJob(jobId, data) {
  const current = dbJobs.get(jobId) || {};
  const updated = { ...current, ...data };
  dbJobs.set(jobId, updated);

  const clients = sseClients.get(jobId);
  if (clients) {
    const msg = `data: ${JSON.stringify(updated)}\n\n`;
    for (const res of clients) {
      res.write(msg);
    }
  }
}

// Auto Temp File Delete (Storage safe rakhne ke liye)
async function safeDelete(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      await fsp.unlink(filePath);
    }
  } catch (err) {
    console.error(`File delete error: ${err.message}`);
  }
}

// ================= VIDEO DISPATCH CORE =================
async function sendVideoTask(task) {
  const { filePath, fileName, channel, jobId, caption } = task;
  const client = await getTelegramClient();
  const entity = await resolveChannel(client, channel);

  let success = false;
  let attempt = 0;
  const maxAttempts = 3;

  while (attempt < maxAttempts && !success) {
    attempt++;
    try {
      updateJob(jobId, { status: "uploading", attempt, percent: 0, speed: "Starting..." });

      let lastBytes = 0;
      let lastTime = Date.now();

      await client.sendFile(entity, {
        file: filePath,
        caption: caption || fileName,
        forceDocument: false,
        supportsStreaming: true,
        workers: 4, // 4 threads safe speed
        progressCallback: (progress) => {
          const now = Date.now();
          const timeGap = Math.max(0.3, (now - lastTime) / 1000);
          const bytesDiff = progress - lastBytes;
          const speedBytes = bytesDiff / timeGap;

          lastBytes = progress;
          lastTime = now;

          const percent = Math.min(100, Math.round(progress * 100));
          const speedMB = (speedBytes / (1024 * 1024)).toFixed(2);

          updateJob(jobId, {
            percent,
            speed: `${speedMB} MB/s`,
            status: "uploading"
          });
        }
      });

      success = true;
      updateJob(jobId, { status: "completed", percent: 100, speed: "0 MB/s", error: null });

    } catch (err) {
      console.error(`[Upload Attempt ${attempt}]:`, err.message);

      if (err instanceof errors.FloodWaitError || err.seconds) {
        const wait = err.seconds || 10;
        updateJob(jobId, { status: "rate_limit", error: `Telegram limit! Waiting ${wait}s...` });
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }

      if (attempt >= maxAttempts) {
        updateJob(jobId, { status: "failed", error: err.message });
        throw err;
      }

      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// Queue Processing Loop
async function runQueue() {
  if (isQueueRunning || queue.length === 0) return;
  isQueueRunning = true;

  while (queue.length > 0) {
    const task = queue.shift();
    try {
      await sendVideoTask(task);
    } catch (e) {
      console.error(`Task ${task.jobId} failed.`);
    } finally {
      await safeDelete(task.filePath);

      if (queue.length > 0) {
        updateJob(task.jobId, { status: "cooldown", message: "Anti-Ban safe delay active..." });
        await new Promise((r) => setTimeout(r, COOLDOWN_MS));
      }
    }
  }

  isQueueRunning = false;
}

// ================= API ENDPOINTS =================

// Health check endpoint
app.get("/", (req, res) => {
  res.send("🚀 Telegram Video Router Engine is running successfully!");
});

// SSE Live Progress
app.get("/api/progress/:jobId", (req, res) => {
  const { jobId } = req.params;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  if (!sseClients.has(jobId)) {
    sseClients.set(jobId, new Set());
  }
  sseClients.get(jobId).add(res);

  const initial = dbJobs.get(jobId) || { status: "waiting", percent: 0 };
  res.write(`data: ${JSON.stringify(initial)}\n\n`);

  req.on("close", () => {
    const clients = sseClients.get(jobId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) sseClients.delete(jobId);
    }
  });
});

// Dispatch video API
app.post("/api/dispatch", upload.single("video"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, message: "No video file provided." });
  }

  const channel = req.body.channel || "1";
  const caption = req.body.caption || "";
  const jobId = crypto.randomUUID();

  const task = {
    jobId,
    filePath: req.file.path,
    fileName: req.file.originalname,
    channel,
    caption
  };

  dbJobs.set(jobId, {
    jobId,
    fileName: req.file.originalname,
    status: "in_queue",
    percent: 0,
    speed: "0 MB/s",
    error: null
  });

  queue.push(task);
  runQueue();

  res.status(202).json({
    ok: true,
    jobId,
    fileName: req.file.originalname,
    queueLength: queue.length
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
    
