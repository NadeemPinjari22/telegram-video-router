const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

const token = process.env.BOT_TOKEN;
const app = express();
const port = process.env.PORT || 10000;

if (!token) {
    console.error("Error: BOT_TOKEN set nahi hai.");
    process.exit(1);
}

// Polling error handling ke sath bot start karna
const bot = new TelegramBot(token, { 
    polling: {
        interval: 300,
        autoStart: true,
        params: { timeout: 10 }
    }
});

bot.on('polling_error', (error) => {
    console.log(`Polling error code: ${error.code}`);
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

// Jab bhi aap koi bhi message bhejenge (video ke alawa), turant buttons samne aa jayenge
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    if (msg.video) return; // Video aane par yeh event nahi chalega

    bot.sendMessage(chatId, "Namaste! Channel select karne ke liye niche diye gaye button par click karein:", {
        reply_markup: getChannelKeyboard()
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
        userQueues[chatId] = { queue: [], processing: false, total: 0, current: 0, label: CHANNELS[chNum].label };

        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId, `✅ **${CHANNELS[chNum].label}** select ho gaya hai!\n\nAb aap jitni marzi chahein videos ek sath bhej sakte hain. Bot line me lagakar bhejta rahega.`);
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
            await new Promise(resolve => setTimeout(resolve, 1000));
            await bot.forwardMessage(targetChannel, chatId, msgId);
            
            bot.sendMessage(chatId, `🟢 [PASS] (${userQ.current}/${userQ.total}) Video safalta-poorvak **${userQ.label}** par bhej di gayi hai!`);
        } catch (error) {
            console.error(error);
            bot.sendMessage(chatId, `❌ [REJECT / FAIL] Video #${userQ.current} bhejne me samasya aayi! Kya bot channel par Admin hai?`);
        }
    }

    userQ.processing = false;
}

bot.on('video', (msg) => {
    const chatId = msg.chat.id;
    const targetChannel = userState[chatId];

    if (!targetChannel) {
        bot.sendMessage(chatId, "⚠️ Pehle channel select kijiye:", {
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

app.get('/', (req, res) => {
    res.send('Telegram Video Router Bot is running!');
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
        
