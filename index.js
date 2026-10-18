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
const userCounts = {};

function getChannelKeyboard() {
    const keyboard = [];
    for (let i = 1; i <= 5; i++) {
        if (CHANNELS[i].id) {
            keyboard.push([{ text: CHANNELS[i].label, callback_data: `ch_${i}` }]);
        }
    }
    return { inline_keyboard: keyboard };
}

// Jab bhi koi /start likhe ya kuch bhi bole ya bot khole, seedha buttons dikhao
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    userState[chatId] = null;
    bot.sendMessage(chatId, "Namaste! Yeh lijiye aapke saare channels. Koi ek select kijiye:", {
        reply_markup: getChannelKeyboard()
    });
});

bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

Urgent:
    if (data.startsWith('ch_')) {
        const chNum = data.split('_')[1];
        if (!CHANNELS[chNum].id) {
            bot.answerCallbackQuery(query.id, { text: `Error: Channel ${chNum} set nahi hai.`, show_alert: true });
            return;
        }
        userState[chatId] = CHANNELS[chNum].id;
        userCounts[chatId] = { count: 0, label: CHANNELS[chNum].label };
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId, `✅ **${CHANNELS[chNum].label}** select ho gaya hai!\n\nAb aap jitni marzi chahein videos bhej sakte hain (100, 200 ya 500). Sabhi seedha yahin jayengi aur aapko count dikhta rahega.`);
    }
});

bot.on('video', async (msg) => {
    const chatId = msg.chat.id;
    const targetChannel = userState[chatId];

    // Agar channel select nahi hai, toh automatic buttons bhej do taaki dhundhna na pade!
    if (!targetChannel) {
        bot.sendMessage(chatId, "⚠️ Pehle niche diye gaye button se channel select kijiye:", {
            reply_markup: getChannelKeyboard()
        });
        return;
    }

    if (!userCounts[chatId]) {
        userCounts[chatId] = { count: 0, label: "Channel" };
    }

    try {
        await new Promise(resolve => setTimeout(resolve, 300));
        await bot.forwardMessage(targetChannel, chatId, msg.message_id);
        
        userCounts[chatId].count++;
        const currentCount = userCounts[chatId].count;
        const channelName = userCounts[chatId].label;

        // Pass hone par turant batayega kitni video chali gayi
        bot.sendMessage(chatId, `🟢 [PASS] Video #${currentCount} safalta-poorvak **${channelName}** par bhej di gayi hai!`);
    } catch (error) {
        console.error(error);
        // Fail / Reject hone par turant batayega
        bot.sendMessage(chatId, `❌ [REJECT / FAIL] Ek video bhejane me samasya aayi! Kya bot channel par Admin hai ya net slow hai?`);
    }
});

app.get('/', (req, res) => {
    res.send('Telegram Video Router Bot is running!');
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
