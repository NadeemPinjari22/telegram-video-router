const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

const token = process.env.BOT_TOKEN;
const app = express();
const port = process.env.PORT || 10000;

if (!token) {
    console.error("Error: BOT_TOKEN set nahi hai.");
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

const CHANNELS = {
    1: { id: process.env.CHANNEL_1, label: process.env.LABEL_1 || 'Channel 1' },
    2: { id: process.env.CHANNEL_2, label: process.env.LABEL_2 || 'Channel 2' },
    3: { id: process.env.CHANNEL_3, label: process.env.LABEL_3 || 'Channel 3' },
    4: { id: process.env.CHANNEL_4, label: process.env.LABEL_4 || 'Channel 4' },
    5: { id: process.env.CHANNEL_5, label: process.env.LABEL_5 || 'Channel 5' }
};

const userState = {};

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    userState[chatId] = null;
    
    const keyboard = [];
    for (let i = 1; i <= 5; i++) {
        if (CHANNELS[i].id) {
            keyboard.push([{ text: CHANNELS[i].label, callback_data: `ch_${i}` }]);
        }
    }

    bot.sendMessage(chatId, "Namaste! Chuniye ki video kis channel par bhejna hai:", {
        reply_markup: { inline_keyboard: keyboard }
    });
});

bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith('ch_')) {
        const chNum = data.split('_')[1];
        if (!CHANNELS[chNum].id) {
            bot.answerCallbackQuery(query.id, { text: `Error: Channel ${chNum} set nahi hai.`, show_alert: true });
            return;
        }
        userState[chatId] = CHANNELS[chNum].id;
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId, `ℹ️ Aapne ${CHANNELS[chNum].label} select kiya hai. Ab koi video bhejiye taaki us par bhej sakein.`);
    }
});

bot.on('video', async (msg) => {
    const chatId = msg.chat.id;
    const targetChannel = userState[chatId];

    if (!targetChannel) {
        bot.sendMessage(chatId, "⚠️ Pehle kisi channel ka button dabaiye, fir video bhejiye!");
        return;
    }

    try {
        await bot.forwardMessage(targetChannel, chatId, msg.message_id);
        bot.sendMessage(chatId, "✅ Video safalta-poorvak channel par bhej di gayi hai!");
        userState[chatId] = null;
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, `❌ Error: Video bhejne me samasya aayi. Kya bot channel par Admin hai?`);
    }
});

app.get('/', (req, res) => {
    res.send('Telegram Video Router Bot is running!');
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
