// TELEGRAM MASTER ROUTER
// 5 CHANNELS | GRAMJS | SEQUENTIAL UPLOAD | FLOODWAIT RETRY

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const app = express();

const PORT = Number(process.env.PORT || 10000);

const DATA_DIR = path.join(__dirname, "router-data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// --------------------------------------------------
// TELEGRAM CHANNELS
// --------------------------------------------------

const CHANNELS = {
  1: process.env.CHANNEL_1,
  2: process.env.CHANNEL_2,
  3: process.env.CHANNEL_3,
  4: process.env.CHANNEL_4,
  5: process.env.CHANNEL_5
};

// --------------------------------------------------
// UPLOAD SETTINGS
// --------------------------------------------------

const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024
  }
});

// --------------------------------------------------
// TELEGRAM CLIENT
// --------------------------------------------------

let client = null;

async function getTelegramClient() {
  if (client) return client;

  const apiId = Number(process.env.API_ID);
  const apiHash = process.env.API_HASH;
  const sessionString = process.env.SESSION_STRING;

  if (!apiId) {
    throw new Error("API_ID missing");
  }

  if (!apiHash) {
    throw new Error("API_HASH missing");
  }

  if (!sessionString) {
    throw new Error("SESSION_STRING missing");
  }

  client = new TelegramClient(
    new StringSession(sessionString),
    apiId,
    apiHash,
    {
      connectionRetries: 10,
      retryDelay: 2000
    }
  );

  await client.connect();

  console.log("Telegram connected successfully");

  return client;
}

// --------------------------------------------------
// FLOOD WAIT
// --------------------------------------------------

function getFloodWait(error) {
  const text = String(error?.message || error || "");

  let match = text.match(/FLOOD_WAIT[_ ](\d+)/i);

  if (match) {
    return Number(match[1]);
  }

  match = text.match(/A wait of (\d+) seconds/i);

  if (match) {
    return Number(match[1]);
  }

  return 0;
}

// --------------------------------------------------
// SAFE DELAY
// --------------------------------------------------

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --------------------------------------------------
// UPLOAD TO TELEGRAM
// --------------------------------------------------

async function uploadToTelegram(
  filePath,
  channelNumber,
  caption = "",
  progressCallback = null
) {
  const telegram = await getTelegramClient();

  const destination = CHANNELS[channelNumber];

  if (!destination) {
    throw new Error(
      `CHANNEL_${channelNumber} is not configured`
    );
  }

  return await telegram.sendFile(destination, {
    file: filePath,

    caption: caption,

    forceDocument: false,

    supportsStreaming: true,

    progressCallback: (uploaded, total) => {
      if (!progressCallback) return;

      if (!total) return;

      const percent = Math.floor(
        (Number(uploaded) / Number(total)) * 100
      );

      progressCallback(percent);
    }
  });
}

// --------------------------------------------------
// RETRY SYSTEM
// --------------------------------------------------

async function uploadWithRetry(
  filePath,
  channelNumber,
  caption,
  progressCallback
) {
  const MAX_RETRIES = 10;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {

    try {

      console.log(
        `Uploading ${path.basename(filePath)} to Channel ${channelNumber}`
      );

      const result = await uploadToTelegram(
        filePath,
        channelNumber,
        caption,
        progressCallback
      );

      return result;

    } catch (error) {

      console.error(
        `Upload attempt ${attempt} failed:`,
        error.message
      );

      const floodWait = getFloodWait(error);

      if (floodWait > 0) {

        // Maximum safety wait: 30 minutes
        const safeWait = Math.min(
          floodWait + 3,
          1800
        );

        console.log(
          `Telegram FloodWait: waiting ${safeWait} seconds`
        );

        await delay(safeWait * 1000);

        continue;
      }

      if (attempt >= MAX_RETRIES) {
        throw error;
      }

      // Normal temporary error
      await delay(
        Math.min(attempt * 3000, 15000)
      );
    }
  }

  throw new Error("Maximum retry limit reached");
}

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/health", (req, res) => {

  res.json({
    ok: true,
    service: "Telegram Master Router",
    time: new Date().toISOString()
  });

});

// --------------------------------------------------
// CONFIG CHECK
// --------------------------------------------------

app.get("/api/config", (req, res) => {

  const result
