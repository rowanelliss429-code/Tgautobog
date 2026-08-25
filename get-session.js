const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");

const API_ID = 38230490;
const API_HASH = "de6bc49e310f42540d904a0db34070e7";

(async () => {
  console.log("==============================================");
  console.log("  Telegram Session String Generator");
  console.log("==============================================\n");

  const client = new TelegramClient(
    new StringSession(""),
    API_ID,
    API_HASH,
    { connectionRetries: 5 }
  );

  await client.start({
    phoneNumber: async () => {
      console.log("📱 Phone number ထည့်ပါ (ဥပမာ: +959792310926)");
      return await input.text("Phone: ");
    },
    password: async () => {
      console.log("🔑 2FA password ရှိလျှင်ထည့်ပါ မရှိလျှင် Enter နိပ်ပါ");
      return await input.text("2FA Password: ");
    },
    phoneCode: async () => {
      console.log("📨 Telegram မှ OTP code ထည့်ပါ");
      return await input.text("OTP Code: ");
    },
    onError: (err) => console.error("Error:", err),
  });

  const sessionString = client.session.save();

  console.log("\n==============================================");
  console.log("✅ SESSION STRING ရပြီ!");
  console.log("   Render > Environment Variables မှာ");
  console.log("   SESSION_STRING= နောက်မှာ paste လုပ်ပါ");
  console.log("==============================================\n");
  console.log(sessionString);
  console.log("\n==============================================\n");

  await client.disconnect();
  process.exit(0);
})();
