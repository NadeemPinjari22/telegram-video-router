const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

const token = process.env.BOT_TOKEN;
const app = express();
const port = process.env.PORT || 10000;

if (!token) {
    console.error("Error: BOT_TOKEN set nahi hai.");
    process.exit(1);
}

const bot = new TelegramBot(token);
const WEBHOOK_PATH = `/bot${token}`;

app.use(express.json());

app.post(WEBHOOK_PATH, (req, res) => {
    res.sendStatus(200);
    try {
        bot.processUpdate(req.body);
    } catch (error) {
        console.error("Error processing update:", error);
    }
});

const CHANNELS = {
    1: { id: process.env.CHANNEL_1, label: process.env.LABEL_1 || 'Channel 1' },
    2: { id: process.env.CHANNEL_2, label: process.env.LABEL_2 || 'Channel 2' },
    3: { id: process.env.CHANNEL_3, label: process.env.LABEL_3 || 'Channel 3' },
    4: { id: process.env.CHANNEL_4, label: process.env.LABEL_4 || 'Channel 4' },
    5: { id: process.env.CHANNEL_5, label: process.env.LABEL_5 || 'Channel 5' }
};

const userState = {};
const userQueues = {};

function getChannelKeyboard() {
    const keyboard = [];
    for (let i = 1; i <= 5; i++) {
        if (CHANNELS[i].id) {
            keyboard.push([{ text: CHANNELS[i].label, callback_data: `ch_${i}` }]);
        }
    }
    return { inline_keyboard: keyboard };
}

const sendChannelMenu = (chatId) => {
    bot.sendMessage(chatId, "Namaste! Video bhejne ke liye niche diye gaye channel me se koi ek select karein:", {
        reply_markup: getChannelKeyboard()
    });
};

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    userState[chatId] = null;
    sendChannelMenu(chatId);
});

// Yahan callback query ko bilkul seedha aur pakka kar diya hai
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data && data.startsWith('ch_')) {
        const chNum = data.split('_')[1];
        const selectedChannel = CHANNELS[chNum];

        if (!selectedChannel || !selectedChannel.id) {
            try {
                await bot.answerCallbackQuery(query.id, { text: `Error: Yeh channel set nahi hai!`, show_alert: true });
            } catch (e) {}
            return;
        }

        userState[chatId] = selectedChannel.id;
        userQueues[chatId] = { queue: [], processing: false, total: 0, current: 0, label: selectedChannel.label };

        try {
            await bot.answerCallbackQuery(query.id, { text: `${selectedChannel.label} select ho gaya!` });
        } catch (e) {}

        bot.sendMessage(chatId, `✅ **${selectedChannel.label}** select ho gaya hai!\n\nAb aap jitni marzi chahein videos bhejiye, sabhi ishi channel par jayengi.`);
    }
});

async function processQueue(chatId) {
    const userQ = userQueues[chatId];
    if (!userQ || userQ.processing || userQ.queue.length === 0) return;

    userQ.processing = true;
    const targetChannel = userState[chatId];

    while (userQ.queue.length > 0) {
        const msgId = userQ.queue.shift();
        userQ.current++;

        try {
            await new Promise(resolve => setTimeout(resolve, 1200));
            await bot.forwardMessage(targetChannel, chatId, msgId);
            
            bot.sendMessage(chatId, `🟢 (${userQ.current}/${userQ.total}) Video safalta-poorvak **${userQ.label}** par bhej di gayi hai!`);
        } catch (error) {
            console.error("Forward error:", error);
            bot.sendMessage(chatId, `❌ Video #${userQ.current} bhejne me samasya aayi!`);
        }
    }

    userQ.processing = false;
}

bot.on('video', (msg) => {
    const chatId = msg.chat.id;
    const targetChannel = userState[chatId];

    if (!targetChannel) {
        bot.sendMessage(chatId, "⚠️ Pehle upar diye gaye button se apna target channel select kijiye:", {
            reply_markup: getChannelKeyboard()
        });
        return;
    }

    if (!userQueues[chatId]) {
        userQueues[chatId] = { queue: [], processing: false, total: 0, current: 0, label: "Channel" };
    }

    userQueues[chatId].queue.push(msg.message_id);
    userQueues[chatId].total++;

    processQueue(chatId);
});

bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    if (msg.text && !msg.text.startsWith('/') && !userState[chatId]) {
        sendChannelMenu(chatId);
    }
});

app.get('/', (req, res) => {
    res.send('Telegram Video Router Bot is running smoothly!');
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
