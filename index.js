const express = require("express");
const https = require("https");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;
// अगर आप किसी खास चैनल में वीडियो भेजना चाहते हैं, तो Render Environment में CHANNEL_ID डालें (जैसे: @mychannel या -100123456789)
const DEFAULT_CHANNEL = process.env.CHANNEL_ID || null;

// Telegram API को रिक्वेस्ट भेजने का फंक्शन
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
        "Content-Length": Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ ok: false, error: body });
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.write(data);
    req.end();
  });
}

// जब तक नए मैसेज आएंगे, उन्हें चेक करने के लिए Polling इंजन
let lastUpdateId = 0;

async function pollUpdates() {
  if (!BOT_TOKEN) {
    console.error("❌ Error: BOT_TOKEN नहीं मिला! कृपया Render Environment में BOT_TOKEN डालें।");
    return;
  }

  // पहले पुराना कोई अटका हुआ Webhook हटाएं ताकि बॉट तुरंत काम करे
  await tgApi("deleteWebhook", { drop_pending_updates: false });
  console.log("✅ Bot successfully connected! Waiting for messages...");

  while (true) {
    try {
      const response = await tgApi("getUpdates", {
        offset: lastUpdateId + 1,
        timeout: 20,
      });

      if (response && response.ok && response.result.length > 0) {
        for (const update of response.result) {
          lastUpdateId = update.update_id;
          await handleUpdate(update);
        }
      }
    } catch (err) {
      console.error("Polling error:", err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// मैसेज और वीडियो को हैंडल करने का फंक्शन
async function handleUpdate(update) {
  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  // 1. अगर यूज़र /start या hi भेजे
  if (text === "/start" || text.toLowerCase() === "hi" || text.toLowerCase() === "hello") {
    await tgApi("sendMessage", {
      chat_id: chatId,
      text:
        "👋 नमस्ते! **Video Upload Board Bot** अब चालू है!\n\n" +
        "📤 **कैसे इस्तेमाल करें:**\n" +
        "1. मुझे कोई भी **Video** भेजें।\n" +
        "2. अगर किसी खास चैनल में भेजना है, तो वीडियो के कैप्शन (Caption) में चैनल का यूज़रनेम लिखें (जैसे: `@my_channel`)।\n" +
        (DEFAULT_CHANNEL
          ? `\n✅ डिफ़ॉल्ट चैनल सेट है: ${DEFAULT_CHANNEL}`
          : "\n⚠️ डिफ़ॉल्ट चैनल सेट नहीं है। आप वीडियो के कैप्शन में `@channel_username` लिखकर भेज सकते हैं।"),
      parse_mode: "Markdown",
    });
    return;
  }

  // 2. अगर यूज़र ने कोई Video या Document भेजा है
  if (msg.video || msg.document) {
    const captionText = (msg.caption || "").trim();
    let targetChannel = DEFAULT_CHANNEL;
    let finalCaption = captionText;

    // अगर कैप्शन की शुरुआत में @channel या -100 लिखा है तो उसे चैनल मान लें
    if (captionText.startsWith("@") || captionText.startsWith("-100")) {
      const parts = captionText.split(" ");
      targetChannel = parts[0];
      finalCaption = parts.slice(1).join(" ");
    }

    if (!targetChannel) {
      await tgApi("sendMessage", {
        chat_id: chatId,
        text:
          "✅ आपका वीडियो मिल गया!\n\n" +
          "लेकिन इसे किस चैनल में भेजना है, यह सेट नहीं है।\n" +
          "👉 **तरीका 1:** वीडियो भेजते समय Caption में अपने चैनल का यूज़रनेम लिखें (जैसे: `@mychannel मेरा वीडियो`)\n" +
          "👉 **तरीका 2:** Render के Environment में जाकर `CHANNEL_ID` नाम से अपना चैनल जोड़ दें।",
      });
      return;
    }

    // चैनल में वीडियो कॉपी/अपलोड करना
    const res = await tgApi("copyMessage", {
      chat_id: targetChannel,
      from_chat_id: chatId,
      message_id: msg.message_id,
      caption: finalCaption || undefined,
    });

    if (res && res.ok) {
      await tgApi("sendMessage", {
        chat_id: chatId,
        text: `🚀 वीडियो सफलतापूर्वक **${targetChannel}** पर अपलोड हो गया है!`,
        parse_mode: "Markdown",
      });
    } else {
      await tgApi("sendMessage", {
        chat_id: chatId,
        text: `❌ चैनल (${targetChannel}) में वीडियो भेजने में एरर आया:\n\`${res.description || "पक्का करें कि बॉट उस चैनल में Admin है!"}\``,
        parse_mode: "Markdown",
      });
    }
    return;
  }

  // बाकी किसी भी मैसेज का जवाब
  await tgApi("sendMessage", {
    chat_id: chatId,
    text: "कृपया मुझे कोई **Video** भेजें जिसे चैनल पर अपलोड करना है, या मदद के लिए `/start` लिखें।",
    parse_mode: "Markdown",
  });
}

// Render को चालू रखने के लिए वेब पेज
app.get("/", (req, res) => {
  res.send("🚀 Telegram Video Upload Bot is LIVE and Running!");
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  pollUpdates();
});
                                 
