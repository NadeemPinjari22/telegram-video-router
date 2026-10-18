const { Telegraf, Markup } = require("telegraf");
const express = require("express");

const PORT = Number(process.env.PORT || 3000);
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const token = process.env.BOT_TOKEN;
const bot = new Telegraf(token);

// यूजर का डेटा स्टोर करने के लिए
const userSessions = new Map();

// /start कमांड भेजने पर बटन दिखेंगे
bot.start((ctx) => {
  ctx.reply(
    "👋 नमस्ते! वीडियो किस चैनल पर भेजना है, कृपया नीचे दिए गए बटन से चुनें:",
    Markup.inlineKeyboard([
      [Markup.button.callback("Channel 1 📢", "ch_1"), Markup.button.callback("Channel 2 📢", "ch_2")],
      [Markup.button.callback("Channel 3 📢", "ch_3")]
    ])
  );
});

// जब यूजर वीडियो भेजेगा
bot.on("video", async (ctx) => {
  const userId = ctx.from.id;
  const fileId = ctx.message.video.file_id;

  userSessions.set(userId, { fileId, caption: ctx.message.caption || "" });

  await ctx.reply(
    "✅ वीडियो मिल गया! अब कृपया चुनें कि इसे किस चैनल पर भेजना है:",
    Markup.inlineKeyboard([
      [Markup.button.callback("Channel 1 📢", "ch_1"), Markup.button.callback("Channel 2 📢", "ch_2")],
      [Markup.button.callback("Channel 3 📢", "ch_3")]
    ])
  );
});

// जब यूजर किसी चैनल के बटन पर क्लिक करेगा
bot.action(/ch_\d/, async (ctx) => {
  const userId = ctx.from.id;
  const channelNum = ctx.match[0].split("_")[1];

  const session = userSessions.get(userId);
  if (!session) {
    return ctx.reply("❌ कोई वीडियो नहीं मिला। कृपया पहले वीडियो भेजें।");
  }

  await ctx.editMessageText(`⏳ वीडियो Channel ${channelNum} पर भेजा जा रहा है, कृपया इंतज़ार करें...`);

  try {
    const channelUsername = process.env["CHANNEL_" + channelNum];
    if (!channelUsername) {
      return ctx.reply(`❌ एरर: Render के Environment में CHANNEL_${channelNum} सेट नहीं है।`);
    }

    await ctx.telegram.sendVideo(channelUsername, session.fileId, {
      caption: session.caption
    });

    await ctx.reply(`🎉 बधाई हो! वीडियो सफलतापूर्वक Channel ${channelNum} (${channelUsername}) पर भेज दिया गया है।`);
    userSessions.delete(userId);
  } catch (err) {
    console.error(err);
    await ctx.reply(`❌ वीडियो भेजने में एरर आया: ${err.message}`);
  }
});

// Render के लिए एक्सप्रेस सर्वर
app.get("/", (req, res) => {
  res.send("🚀 Telegram Video Router Bot is LIVE with Buttons!");
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  bot.launch();
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
