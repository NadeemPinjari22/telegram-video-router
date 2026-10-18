const express = require("express");
const https = require("https");

const PORT = Number(process.env.PORT || 10000);
const BOT_TOKEN = process.env.BOT_TOKEN;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Telegram API ko request bhejne ka function
function tgApi(method, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const options = {
      hostname: "api.telegram.org",
      port: 443,
      path: `/bot${BOT_TOKEN}/${method}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data)
      }
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// Render check route
app.get("/", (req, res) => {
  res.send("🚀 Telegram Video Router with 5 Channels is Live!");
});

// Telegram Webhook
app.post("/", async (req, res) => {
  res.sendStatus(200);

  const update = req.body;
  try {
    if (update.message) {
      const chatId = update.message.chat.id;
      const video = update.message.video;
      const text = update.message.text;

      if (text === "/start") {
        await tgApi("sendMessage", {
          chat_id: chatId,
          text: "👋 Namaste! Kripya chune ki video kis channel par bhejna hai (1 se 5):",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Channel 1 📢", callback_data: "ch_1" },
                { text: "Channel 2 📢", callback_data: "ch_2" }
              ],
              [
                { text: "Channel 3 📢", callback_data: "ch_3" },
                { text: "Channel 4 📢", callback_data: "ch_4" }
              ],
              [
                { text: "Channel 5 📢", callback_data: "ch_5" }
              ]
            ]
          }
        });
      } else if (video) {
        const fileId = video.file_id;

        await tgApi("sendMessage", {
          chat_id: chatId,
          text: `✅ Video mil gaya! Ab niche diye gaye 5 channels me se koi ek chune:`,
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Channel 1 📢", callback_data: `send_${fileId}_1` },
                { text: "Channel 2 📢", callback_data: `send_${fileId}_2` }
              ],
              [
                { text: "Channel 3 📢", callback_data: `send_${fileId}_3` },
                { text: "Channel 4 📢", callback_data: `send_${fileId}_4` }
              ],
              [
                { text: "Channel 5 📢", callback_data: `send_${fileId}_5` }
              ]
            ]
          }
        });
      }
    }

    if (update.callback_query) {
      const callbackQuery = update.callback_query;
      const chatId = callbackQuery.message.chat.id;
      const data = callbackQuery.data;

      if (data.startsWith("send_")) {
        const parts = data.split("_");
        const fileId = parts[1];
        const channelNum = parts[2];
        const channelUsername = process.env["CHANNEL_" + channelNum];

        if (!channelUsername) {
          await tgApi("sendMessage", {
            chat_id: chatId,
            text: `❌ Error: Render environment me CHANNEL_${channelNum} set nahi hai.`
          });
          return;
        }

        await tgApi("sendVideo", {
          chat_id: channelUsername,
          video: fileId,
          caption: "Mahale Electronic & NP Decoration Video"
        });

        await tgApi("sendMessage", {
          chat_id: chatId,
          text: `🎉 Badhai ho! Video safaltapurvak Channel ${channelNum} (${channelUsername}) par bhej diya gaya hai.`
        });
      }
    }
  } catch (err) {
    console.error("Webhook Error:", err);
  }
});

app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);
  
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  if (renderUrl) {
    await tgApi("setWebhook", { url: renderUrl });
    console.log("Webhook automatically set to:", renderUrl);
  }
});
