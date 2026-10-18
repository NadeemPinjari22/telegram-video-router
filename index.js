toconst { Telegraf, Markup } = require("telegraf");
const express = require("express");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const TMP = path.join(__dirname, "telegram_uploads");

fs.mkdirSync(TMP, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Bot token check
const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("Error: BOT_TOKEN environment variable is missing!");
}

const bot = new Telegraf(token);

// User sessions store karne ke liye
const userSessions = new Map();

// /start command
bot.start((ctx) => {
  ctx.reply(
    "👋 Namaste! Video Upload Board Bot ab bilkul taiyar hai.\nAapko bas koi bhi Video bhejna hai, uske baad aapko Channel select karne ke buttons mil jayenge!",
    Markup.inlineKeyboard([
      [Markup.button.callback("Channel 1 📢", "ch_1"), Markup.button.callback("Channel 2 📢", "ch_2")],
      [Markup.button.callback("Channel 3 📢", "ch_3")]
    ])
  );
});

// Jab user video bhejega
bot.on("video", async (ctx) => {
  const userId = ctx.from.id;
  const video = ctx.message.video;
  const fileId = video.file_id;

  userSessions.set(userId, { fileId, caption: ctx.message.caption || "" });

  await ctx.reply(
    "✅ Video mil gaya! Ab kripya chune ki ise kis channel par bhejna hai:",
    Markup.inlineKeyboard([
      [Markup.button.callback("Channel 1 📢", "ch_1"), Markup.button.callback("Channel 2 📢", "ch_2")],
      [Markup.button.callback("Channel 3 📢", "ch_3")]
    ])
  );
});

// Jab user channel ka button dabayega
bot.action(/ch_\d/, async (ctx) => {
  const userId = ctx.from.id;
  const data = ctx.match[0]; // jaise 'ch_1', 'ch_2'
  const channelNum = data.split("_")[1];

  const session = userSessions.get(userId);
  if (!session) {
    return ctx.reply("❌ Koi video nahi mila. Kripya pehle video bhejein.");
  }

  await ctx.editMessageText(`⏳ Video Channel ${channelNum} par bheja ja raha hai, kripya intezaar karein...`);

  try {
    const channelUsername = process.env["CHANNEL_" + channelNum];
    if (!channelUsername) {
      return ctx.reply(`❌ Error: CHANNEL_${channelNum} ka secret variable set nahi hai.`);
    }

    await ctx.telegram.sendVideo(channelUsername, session.fileId, {
      caption: session.caption
    });

    await ctx.reply(`🎉 Badhai ho! Video safaltapurvak Channel ${channelNum} (${channelUsername}) par bhej diya gaya hai.`);
    userSessions.delete(userId);
  } catch (err) {
    console.error(err);
    await ctx.reply(`❌ Video bhejne me error aaya: ${err.message}`);
  }
});

// Express server route
app.get("/", (req, res) => {
  res.send("🚀 Telegram Video Upload Bot is LIVE and Running!");
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  bot.launch();
});

// Graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
