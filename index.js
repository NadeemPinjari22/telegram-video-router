const express = require("express");
const httpsModule = require("https");

const PORT = Number(process.env.PORT || 10000);
const BOT_TOKEN = process.env.BOT_TOKEN;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

    const req = httpsModule.request(options, (res) => {
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

app.get("/", (req, res) => {
  res.send("🚀 Telegram Permanent Environment-Controlled Bot is Live!");
});

app.post("/", async (req, res) => {
  res.sendStatus(200);

  const update = req.body;
  try {
    if (update.message) {
      const chatId = update.message.chat.id;
      const video = update.message.video;
      const text = update.message.text;

      if (text === "/start" || video) {
        const fileId = video ? video.file_id : "";
        const actionPrefix = video ? `send_${fileId}_` : "btn_";

        // Render environment se button ke naam uthayenge
        const c1 = process.env.LABEL_1 || "Channel 1";
        const c2 = process.env.LABEL_2 || "Channel 2";
        const c3 = process.env.LABEL_3 || "Channel 3";
        const c4 = process.env.LABEL_4 || "Channel 4";
        const c5 = process.env.LABEL_5 || "Channel 5";

        await tgApi("sendMessage", {
          chat_id: chatId,
          text: video ? "✅ Video mil gaya! Ab chuniye ki ise kis channel par bhejna hai:" : "👋 Namaste! Chuniye ki video kis channel par bhejna hai:",
          reply_markup: {
            inline_keyboard: [
              [
                { text: c1, callback_data: actionPrefix + "1" },
                { text: c2, callback_data: actionPrefix + "2" }
              ],
              [
                { text: c3, callback_data: actionPrefix + "3" },
                { text: c4, callback_data: actionPrefix + "4" }
              ],
              [
                { text: c5, callback_data: actionPrefix + "5" }
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

      if (data.includes("btn_") || data.includes("send_")) {
        const parts = data.split("_");
        const num = parts[parts.length - 1]; // Button ka number (1 se 5)
        const fileId = data.startsWith("send_") ? parts[1] : "";

        // Render environment se asli channel ID aur label nikalna
        const targetChannel = process.env["CHANNEL_" + num];
        const channelLabel = process.env["LABEL_" + num] || ("Channel " + num);

        if (!targetChannel) {
          await tgApi("sendMessage", {
            chat_id: chatId,
            text: `❌ Error: Render Environment mein CHANNEL_${num} set nahi hai.`
          });
          return;
        }

        if (!fileId) {
          await tgApi("sendMessage", {
            chat_id: chatId,
            text: `ℹ️ Aapne ${channelLabel} select kiya hai. Ab koi video bhejiye taaki us par bhej sakein.`
          });
          return;
        }

        const result = await tgApi("sendVideo", {
          chat_id: targetChannel,
          video: fileId,
          caption: callbackQuery.message?.caption || ""
        });

        if (result.ok) {
          await tgApi("sendMessage", {
            chat_id: chatId,
            text: `🎉 Badhai ho! Video safaltapurvak ${channelLabel} par bhej diya gaya hai.`
          });
        } else {
          await tgApi("sendMessage", {
            chat_id: chatId,
            text: `❌ Error: Video nahi gaya. Telegram ka error: ${result.description}`
          });
        }
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
    
