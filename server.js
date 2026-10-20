const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const app = express();

const PORT = Number(process.env.PORT || 10000);
const TMP_DIR = '/tmp/telegram-router';
const MAX_FILE_SIZE = 4 * 1024 * 1024 * 1024;
const GAP_MS = 2500;

fs.mkdirSync(TMP_DIR, { recursive: true });

app.use(express.json());

const CHANNELS = [1, 2, 3, 4, 5].map(function(n) {
  return {
    id: n,
    name: process.env['LABEL_' + n] ||
      (n === 5 ? 'Long Videos' : 'Channel ' + n),
    ref: (process.env['CHANNEL_' + n] || '').trim()
  };
});

let client = null;

let telegram = {
  connected: false,
  authorized: false,
  error: ''
};

const jobs = new Map();

function sleep(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

function getChannel(id) {
  return CHANNELS.find(function(c) {
    return c.id === Number(id);
  });
}

function safeName(name) {
  return String(name || 'file')
    .replace(/[^a-zA-Z0-9._() -]/g, '_')
    .slice(0, 180);
}

async function connectTelegram() {
  const apiId = Number(process.env.API_ID);
  const apiHash = String(process.env.API_HASH || '').trim();
  const session = String(process.env.SESSION_STRING || '').trim();

  if (!apiId || !apiHash || !session) {
    throw new Error(
      'API_ID, API_HASH or SESSION_STRING is missing.'
    );
  }

  if (client) {
    try {
      await client.disconnect();
    } catch (e) {}
  }

  client = new TelegramClient(
    new StringSession(session),
    apiId,
    apiHash,
    {
      connectionRetries: 5
    }
  );

  await client.connect();

  if (!(await client.checkAuthorization())) {
    throw new Error(
      'Telegram session is not authorized.'
    );
  }

  telegram = {
    connected: true,
    authorized: true,
    error: ''
  };

  console.log(
    '[TELEGRAM] Connected and authorized.'
  );

  return client;
}

async function getClient() {
  if (
    client &&
    telegram.connected &&
    telegram.authorized
  ) {
    return client;
  }

  return connectTelegram();
}

async function startup() {
  console.log(
    '[SERVER] Running on port ' + PORT
  );

  try {
    await connectTelegram();
  } catch (e) {
    telegram = {
      connected: false,
      authorized: false,
      error: e.message
    };

    console.error(
      '[TELEGRAM] ' + e.message
    );
  }
}

const storage = multer.diskStorage({
  destination: function(req, file, cb) {
    cb(null, TMP_DIR);
  },

  filename: function(req, file, cb) {
    cb(
      null,
      Date.now() +
        '-' +
        Math.random().toString(36).slice(2, 9) +
        '-' +
        safeName(file.originalname)
    );
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: MAX_FILE_SIZE
  }
});app.get('/api/status', function(req, res) {
  res.json({
    ok: true,
    port: PORT,
    telegram: telegram,
    channels: CHANNELS.map(function(c) {
      return {
        id: c.id,
        name: c.name,
        configured: !!c.ref
      };
    })
  });
});

app.get('/api/config', function(req, res) {
  res.json({
    ok: true,
    channels: CHANNELS,
    gapMs: GAP_MS,
    maxFileSize: MAX_FILE_SIZE,
    telegram: telegram
  });
});

app.post('/api/reconnect', async function(req, res) {
  try {
    await connectTelegram();
    res.json({ ok: true });
  } catch (e) {
    telegram = {
      connected: false,
      authorized: false,
      error: e.message
    };

    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});

app.get('/api/test/:id', async function(req, res) {
  try {
    const ch = getChannel(req.params.id);

    if (!ch || !ch.ref) {
      throw new Error('Channel is not configured.');
    }

    const c = await getClient();
    const entity = await c.getEntity(ch.ref);

    res.json({
      ok: true,
      title: entity.title || entity.username || ch.name
    });

  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});

app.get('/api/jobs', function(req, res) {
  res.json({
    ok: true,
    jobs: Array.from(jobs.values()).sort(
      function(a, b) {
        return b.createdAt - a.createdAt;
      }
    )
  });
});

async function doUpload(job) {
  const ch = getChannel(job.channelId);

  if (!ch || !ch.ref) {
    throw new Error(
      'Channel is not configured.'
    );
  }

  const c = await getClient();
  const entity = await c.getEntity(ch.ref);

  job.status = 'uploading';
  job.message = 'Uploading...';
  job.progress = 0;

  try {
    await c.sendFile(entity, {
      file: job.filePath,
      caption: job.fileName,

      progressCallback: function(done, total) {
        job.progress = total
          ? Math.round(
              Number(done) /
              Number(total) *
              100
            )
          : 0;
      }
    });

    job.status = 'success';
    job.progress = 100;
    job.message = 'Upload successful.';

    return true;

  } catch (e) {
    job.status = 'failed';
    job.error = e.message;
    job.message = 'Upload failed.';

    return false;
  }
}

app.post(
  '/api/upload',
  upload.single('file'),
  async function(req, res) {

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: 'No file received.'
      });
    }

    const channelId = Number(
      req.body.channelId
    );

    const ch = getChannel(channelId);

    if (!ch || !ch.ref) {
      tryconst HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telegram Master Router</title>

<style>
body{
  margin:0;
  background:#0b1220;
  color:#fff;
  font-family:Arial,sans-serif
}

.wrap{
  max-width:1000px;
  margin:auto;
  padding:16px
}

.card{
  background:#111c31;
  border:1px solid #293956;
  border-radius:16px;
  padding:18px;
  margin-bottom:16px
}

h1{
  margin:0 0 6px
}

.muted{
  color:#9caac1
}

.channels{
  display:grid;
  grid-template-columns:
    repeat(auto-fit,minmax(150px,1fr));
  gap:10px
}

.ch{
  padding:15px;
  border:1px solid #344866;
  border-radius:12px;
  background:#17243a;
  color:#fff;
  text-align:left
}

.ch.sel{
  border-color:#3b82f6;
  background:#173b72
}

.drop{
  display:block;
  padding:28px;
  border:2px dashed #425574;
  border-radius:14px;
  text-align:center;
  cursor:pointer
}

.drop input{
  display:none
}

.actions{
  display:flex;
  gap:8px;
  flex-wrap:wrap;
  margin-top:12px
}

button{
  border:0;
  border-radius:9px;
  padding:11px 15px;
  font-weight:bold;
  color:#fff;
  background:#334155
}

button.primary{
  background:#2563eb
}

button.danger{
  background:#dc2626
}

.status{
  margin-top:12px;
  padding:9px;
  border-radius:10px;
  background:#18263e
}

.dot{
  display:inline-block;
  width:9px;
  height:9px;
  border-radius:50%;
  background:#ef4444;
  margin-right:7px
}

.online{
  background:#22c55e
}

.file{
  background:#17243a;
  border-radius:10px;
  padding:10px;
  margin-top:8px
}

.bar{
  height:7px;
  background:#2b3b56;
  border-radius:8px;
  margin-top:7px;
  overflow:hidden
}

.fill{
  height:100%;
  width:0;
  background:#2563eb
}

.stats{
  display:flex;
  gap:20px;
  flex-wrap:wrap
}

.log{
  max-height:220px;
  overflow:auto;
  background:#080f1b;
  padding:10px;
  border-radius:10px;
  font:12px monospace
}
</style>
</head>

<body>

<div class="wrap">

<div class="card">
<h1>TELEGRAM MASTER ROUTER</h1>

<div class="muted">
5-channel video router • sequential upload • 2.5 sec gap
</div>

<div class="status">
<span id="dot" class="dot"></span>
<span id="status">Checking Telegram...</span>
</div>
</div>


<div class="card">

<h3>1. Select Channel</h3>

<div id="channels" class="channels"></div>

<p id="selected" class="muted">
No channel selected.
</p>

</div>


<div class="card">

<h3>2. Select Videos</h3>

<label class="drop">

📤<br>
Tap here to select videos

<input
id="files"
type="file"
accept="
