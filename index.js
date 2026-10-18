const express = require("express");
const https = require("https");

const PORT = Number(process.env.PORT || 10000);
const BOT_TOKEN = process.env.BOT_TOKEN;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 👉 YAHAN APNE HISAAB SE CHANNEL KE NAAM AUR USERNAME SET KAREIN:
const BUTTON_CHANNELS = {
  btn_1: { label: "Channel 1 (Name)", target: "@AapkaPehlaChannel" },
  btn_2: { label: "Channel 2 (Name)", target: "@AapkaDusraChannel" },
  btn_3: { label: "Channel 3 (Name)", target: "@AapkaTeesraChannel" },
  btn_4: { label: "Channel 4 (Name)", target: "@AapkaChauthaChannel" },
  btn_5: { label: "Channel 5 (Name)", target: "@AapkaPanchvaChannel" }
};

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

app.get("/", (req, res) => {
  res.send("🚀 Telegram Custom Control Bot is Live!");
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

        await tgApi("sendMessage", {
          chat_id: chatId,
          text: video ? "✅ Video mil gaya! Ab chuniye ki ise kis channel par bhejna hai:" : "👋 Namaste! Chuniye ki video kis channel par bhejna hai:",
          reply_markup: {
            inline_keyboard: [
              [
                { text: BUTTON_CHANNELS.btn_1.label, callback_data: actionPrefix + "btn_1" },
                { text: BUTTON_CHANNELS.btn_2.label, callback_data: actionPrefix + "btn_2" }
              ],
              [
                { text: BUTTON_CHANNELS.btn_3.label, callback_data: actionPrefix + "btn_3" },
                { text: BUTTON_CHANNELS.btn_4.label, callback_data: actionPrefix + "btn_4" }
              ],
              [
                { text: BUTTON_CHANNELS.btn_5.label, callback_data: actionPrefix + "btn_5" }
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

      if (data.includes("btn_")) {
        const parts = data.split("btn_");
        const fileId = parts[0].replace("send_", "");
        const btnKey = "btn_" + parts[1];
        const channelObj = BUTTON_CHANNELS[btnKey];

        if (!fileId) {
          await tgApi("sendMessage", {
            chat_id: chatId,
            text: `ℹ️ Aapne ${channelObj.label} select kiya hai. Ab koi video bhejiye taaki us par bhej sakein.`
          });
          return;
        }

        await tgApi("sendVideo", {
          chat_id: channelObj.target,
          video: fileId,
          caption: update.message?.caption || ""
        });

        await tgApi("sendMessage", {
          chat_id: chatId,
          text: `🎉 Badhai ho! Video safaltapurvak ${channelObj.label} (${channelObj.target}) par bhej diya gaya hai.`
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
