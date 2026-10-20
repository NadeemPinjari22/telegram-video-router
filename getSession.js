const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");

const apiId = 34108331;
const apiHash = "1a07c391caa2a5e0ecb959dbfb27cbe";

async function generateStringSession() {
  console.log("Starting Telegram client to generate String Session...");
  
  const stringSession = new StringSession("");

  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text("Apna phone number dalein (+91...): "),
    password: async () => await input.text("2-Step verification password (agar ho toh, nahi toh khali chhodein): "),
    phoneCode: async () => await input.text("Telegram par aaya OTP code dalein: "),
    onError: (err) => console.log("Error:", err),
  });

  console.log("\n==========================================");
  console.log("Aapki String Session safalta-purvak ban gayi hai!");
  console.log("Neeche di gayi string ko copy karke Render par 'SESSION' environment variable mein daal dein:\n");
  console.log(client.session.save());
  console.log("\n==========================================");
  
  process.exit(0);
}

generateStringSession();
