const { Telegraf } = require("telegraf");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram/tl");
const { MongoClient } = require("mongodb");
require("dotenv").config();

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_ID    = parseInt(process.env.API_ID)   || 17349;
const API_HASH  = process.env.API_HASH            || "344583e45741c457fe1862106095a5eb";
const ADMIN_ID  = parseInt(process.env.ADMIN_ID);
const MONGO_URI = process.env.MONGO_URI;

// ─── MONGODB ──────────────────────────────────────────────────────────────────
let db;
async function connectDB() {
  const c = new MongoClient(MONGO_URI);
  await c.connect();
  db = c.db("gpbot");
  console.log("✅ MongoDB connected!");
}

async function getSettings() {
  return (await db.collection("settings").findOne({ _id: "main" })) || {};
}
async function saveSettings(data) {
  await db.collection("settings").updateOne({ _id: "main" }, { $set: data }, { upsert: true });
}
async function getAccounts() {
  return await db.collection("accounts").find({}).sort({ order: 1, addedAt: 1 }).toArray();
}
async function getAccount(name) {
  return await db.collection("accounts").findOne({ name });
}
async function saveAccount(name, data) {
  await db.collection("accounts").updateOne({ name }, { $set: data }, { upsert: true });
}
async function deleteAccount(name) {
  await db.collection("accounts").deleteOne({ name });
  await db.collection("sendlogs").deleteMany({ accName: name });
}
async function getAccGPs(name) {
  const a = await getAccount(name); return a?.gpLinks || [];
}
async function saveAccGPs(name, links) {
  await saveAccount(name, { gpLinks: links });
}
async function getAccMsg(name, fallback) {
  const a = await getAccount(name); return a?.customMsg || fallback || "";
}
async function getLastSent(accName, gpLink) {
  const d = await db.collection("sendlogs").findOne({ accName, gpLink });
  return d?.sentAt || null;
}
async function updateLastSent(accName, gpLink) {
  await db.collection("sendlogs").updateOne(
    { accName, gpLink },
    { $set: { accName, gpLink, sentAt: new Date() } },
    { upsert: true }
  );
}

// ─── STATE ────────────────────────────────────────────────────────────────────
let globalMsg        = "";
let intervalMinutes  = 60;
let sendDelaySeconds = 6;
let schedulerTimer   = null;
let isSending        = false;
let isJoining        = false;
const clientPool     = {};
const pendingAdd     = {};

// ─── BOT ──────────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

function isAdmin(ctx) { return ctx.from?.id === ADMIN_ID; }
function adminOnly(ctx, next) {
  if (!isAdmin(ctx)) return;
  return next();
}

// spin: "word1{spin}word2{spin}word3 rest" → random pick
function pickSpun(template) {
  const parts = template.split("{spin}").map(s => s.trim());
  return parts[Math.floor(Math.random() * parts.length)];
}

function sleep(sec) { return new Promise(r => setTimeout(r, sec * 1000)); }

// ─── GRAMJS CLIENT ────────────────────────────────────────────────────────────
async function buildClient(sessionString) {
  const client = new TelegramClient(
    new StringSession(sessionString), API_ID, API_HASH,
    { connectionRetries: 5 }
  );
  await client.connect();
  return client;
}

async function initAllClients() {
  const accounts = await getAccounts();
  for (const acc of accounts) {
    if (!clientPool[acc.name]) {
      try {
        clientPool[acc.name] = await buildClient(acc.sessionString);
        console.log(`✅ Connected: ${acc.name}`);
      } catch (e) {
        console.error(`❌ Failed: ${acc.name} — ${e.message}`);
      }
    }
  }
}

// ─── JOIN (သင့် joingp.txt logic နဲ့တူ) ─────────────────────────────────────
async function joinGroup(client, link) {
  // Telethon: target = GROUP.split('/')[-1]
  // GramJS equivalent:
  const target = link.includes("/") ? link.split("/").pop() : link;
  const entity = await client.getEntity(link).catch(() => target);
  await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
}

// ─── SEND MESSAGE (သင့် sendmessage.txt logic နဲ့တူ) ────────────────────────
async function sendToGroup(client, link, message) {
  // Telethon: await client.send_message(RECEIVER, MESSAGE)
  // GramJS equivalent:
  const entity = await client.getEntity(link).catch(async () => {
    const target = link.includes("/") ? link.split("/").pop() : link;
    return await client.getEntity(target);
  });
  // parseMode: "html" — link နဲ့ mention တွေ render ဖြစ်အောင်
  await client.sendMessage(entity, {
    message,
    parseMode: "html",
    linkPreview: false,   // link preview ပြမလား မပြဘူးလား (false=မပြ)
  });
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────
function startScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (intervalMinutes <= 0) return;
  schedulerTimer = setInterval(async () => {
    if (!isSending) await sendAllAccounts(false);
  }, intervalMinutes * 60 * 1000);
  console.log(`⏰ Scheduler: every ${intervalMinutes} min`);
}

// ─── CORE SEND ────────────────────────────────────────────────────────────────
async function sendAllAccounts(force = false) {
  if (isSending) {
    await bot.telegram.sendMessage(ADMIN_ID, "⚠️ ပို့နေဆဲ ရှိသေးသည်။ ခဏစောင့်ပါ။");
    return;
  }
  const accounts = await getAccounts();
  const active   = accounts.filter(a => clientPool[a.name]);
  if (!active.length) {
    await bot.telegram.sendMessage(ADMIN_ID, "⚠️ Connected account မရှိသေး။");
    return;
  }

  isSending = true;
  let totalOK = 0, totalFail = 0, totalSkip = 0;

  await bot.telegram.sendMessage(ADMIN_ID,
    `🚀 ပို့မည်...\n👤 Active: ${active.length} accounts\n⏱ Delay: ${sendDelaySeconds}s`
  );

  for (const acc of active) {
    const client  = clientPool[acc.name];
    const gpLinks = await getAccGPs(acc.name);
    const msg     = await getAccMsg(acc.name, globalMsg);

    if (!gpLinks.length) {
      await bot.telegram.sendMessage(ADMIN_ID, `⏭ [${acc.name}] GP မရှိသေး`);
      continue;
    }
    if (!msg) {
      await bot.telegram.sendMessage(ADMIN_ID, `⏭ [${acc.name}] Message မသတ်မှတ်ရသေး`);
      continue;
    }

    await bot.telegram.sendMessage(ADMIN_ID, `\n▶️ [${acc.name}] GP ${gpLinks.length} ခု ပို့မည်...`);
    let ok = 0, fail = 0, skip = 0;

    for (let i = 0; i < gpLinks.length; i++) {
      const link = gpLinks[i];
      const num  = i + 1;

      // rate limit check
      if (!force) {
        const last = await getLastSent(acc.name, link);
        if (last) {
          const diff = (Date.now() - new Date(last).getTime()) / 60000;
          if (diff < intervalMinutes) {
            const rem = Math.ceil(intervalMinutes - diff);
            skip++; totalSkip++;
            await bot.telegram.sendMessage(ADMIN_ID, `⏭ Skip ${num} — [${acc.name}] ⏳ ${rem} မိနစ်ကျန်`);
            continue;
          }
        }
      }

      const msgToSend = pickSpun(msg);
      try {
        // သင့် sendmessage.txt logic နဲ့တူ
        await sendToGroup(client, link, msgToSend);
        await updateLastSent(acc.name, link);
        ok++; totalOK++;
        await bot.telegram.sendMessage(ADMIN_ID, `✅ Send ${num} done — [${acc.name}]`);
      } catch (err) {
        fail++; totalFail++;
        await bot.telegram.sendMessage(ADMIN_ID, `❌ Fail ${num} — [${acc.name}]\n⚠️ ${err.message}`);
      }

      if (i < gpLinks.length - 1) {
        await bot.telegram.sendMessage(ADMIN_ID, `⏳ ${sendDelaySeconds}s စောင့်နေသည်...`);
        await sleep(sendDelaySeconds);
      }
    }
    await bot.telegram.sendMessage(ADMIN_ID, `📊 [${acc.name}] ✅${ok} ❌${fail} ⏭${skip}`);
  }

  await bot.telegram.sendMessage(ADMIN_ID,
    `\n🏁 ပြီးပါပြီ\n✅ ${totalOK}  ❌ ${totalFail}  ⏭ ${totalSkip}`
  );
  isSending = false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOT COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── /start ───────────────────────────────────────────────────────────────────
bot.start(adminOnly, async (ctx) => {
  const accounts  = await getAccounts();
  const connected = accounts.filter(a => clientPool[a.name]).length;
  const sched     = schedulerTimer ? `🟢 ${intervalMinutes} မိနစ်တစ်ကြိမ်` : "🔴 ပိတ်ထား";
  const msgShow   = globalMsg ? `"${globalMsg.substring(0,30)}..."` : "⚠️ မသတ်မှတ်ရသေး";

  await ctx.reply(
`👋 GP Auto Sender Bot 🤖

━━━━━━━━━━━━━━━━━━
📊 လောလောဆယ် အခြေအနေ
━━━━━━━━━━━━━━━━━━
👤 Accounts  : ${accounts.length} ခု (🟢 ${connected} connected)
💬 Global msg: ${msgShow}
⏰ Scheduler : ${sched}
⏱ Send delay : ${sendDelaySeconds}s
🔒 Rate limit: ${intervalMinutes} မိနစ်တစ်ကြိမ်

━━━━━━━━━━━━━━━━━━
👤 ACCOUNT Commands
━━━━━━━━━━━━━━━━━━
/accounts
  → account စာရင်းနဲ့ နံပါတ်တွေကြည့်

/addaccount မိဘ
  → "မိဘ" နာမည်နဲ့ account ထည့်
  → bot က session .txt file တောင်းမည်
  → file ပို့ရုံပဲ — auto connect ဖြစ်မည်

/removeaccount မိဘ
  → "မိဘ" account ဖျက်

/accountstatus
  → connected / disconnected ကြည့်

━━━━━━━━━━━━━━━━━━
🔗 GP Commands (နံပါတ်နဲ့သုံး)
━━━━━━━━━━━━━━━━━━
⚠️ /accounts နိပ်ပြီး account နံပါတ် သိပါ

/check1
  → account 1 ရဲ့ GP list + msg + ကျန်ချိန် ကြည့်

/1gp https://t.me/+xxx,https://t.me/+yyy
  → account 1 ရဲ့ GP link တွေ သတ်မှတ်
  → comma ခြားပြီး အများကြီးထည့်လို့ရ

/1gp
  → account 1 ရဲ့ GP list ကြည့်

/1addgp https://t.me/+zzz
  → account 1 ကို GP တစ်ခုထပ်ထည့်

/1removegp 2
  → account 1 ရဲ့ GP နံပါတ် 2 ဖျက်

/1cleargp
  → account 1 ရဲ့ GP အကုန်ဖျက်

💡 Account 2 → /2gp /check2 /2addgp ...
💡 Account 3 → /3gp /check3 /3addgp ...`
  );

  await ctx.reply(
`━━━━━━━━━━━━━━━━━━
💬 MESSAGE Commands
━━━━━━━━━━━━━━━━━━
/msg မင်္ဂလာပါ ညီကိုများ
  → account အကုန်အတွက် global message

/msg
  → global message ကြည့်

/1msg မင်္ဂလာပါ ညီကိုများ
  → account 1 သီးသန့် message
  → global msg ထက် priority မြင့်

/1msg
  → account 1 message ကြည့်

/1clearmsg
  → account 1 custom msg ဖျက်

💡 Spin syntax (ပို့တိုင်း message ပြောင်း):
/msg မင်္ဂလာပါ{spin}ဟေး{spin}ဟယ်လို ညီကိုများ
  GP1 → "မင်္ဂလာပါ ညီကိုများ"
  GP2 → "ဟေး ညီကိုများ"
  GP3 → "ဟယ်လို ညီကိုများ"

━━━━━━━━━━━━━━━━━━
🤝 JOIN Commands
━━━━━━━━━━━━━━━━━━
/joingp https://t.me/+xxx,https://t.me/+yyy
  → connected account အကုန်နဲ့ join
  → join တိုင်းကြား 3s delay

/joingp မိဘ https://t.me/+xxx,https://t.me/+yyy
  → "မိဘ" account တစ်ကောင်တည်းသာ join

━━━━━━━━━━━━━━━━━━
⚙️ SETTINGS Commands
━━━━━━━━━━━━━━━━━━
/setinterval 60min
  → rate limit ပြောင်း (2hr, 30min စသည်)

/setdelay 6
  → GP တိုင်းကြား delay seconds ပြောင်း

━━━━━━━━━━━━━━━━━━
📤 SEND Commands
━━━━━━━━━━━━━━━━━━
/send
  → rate limit စစ်ပြီးပို့

/forcesend
  → rate limit မစစ်ဘဲ ချက်ချင်းအကုန်ပို့

/time 60min
  → 60 မိနစ်တစ်ကြိမ် 24hr auto ပို့
  → /time 2hr လည်းရ

/time stop
  → auto ပို့ ရပ်

/status
  → account တိုင်း GP တိုင်း ကျန်ချိန် အကုန်ကြည့်

━━━━━━━━━━━━━━━━━━
📌 စတင်သုံးနည်း (အဆင့်)
━━━━━━━━━━━━━━━━━━
1️⃣ /addaccount မိဘ
   → bot က file တောင်းမည် → session .txt ပို့

2️⃣ /joingp link1,link2,...
   → GP တွေကို account တွေနဲ့ join

3️⃣ /1gp link1,link2,...
   → account 1 ရဲ့ ပို့မည့် GP list ထည့်

4️⃣ /msg မင်္ဂလာပါ{spin}ဟေး ညီကိုများ
   → message သတ်မှတ် (spin ထည့်ရင် ပိုကောင်း)

5️⃣ /setinterval 60min
   → rate limit သတ်မှတ်

6️⃣ /time 60min
   → scheduler ဖွင့် ✅

━━━━━━━━━━━━━━━━━━
🛡 Spam Protection (auto)
━━━━━━━━━━━━━━━━━━
✅ ${sendDelaySeconds}s delay (GP တိုင်းကြား)
✅ Rate limit: ${intervalMinutes} မိနစ်တစ်ကြိမ်
✅ Message spin: ပို့တိုင်း message ပြောင်း
✅ Sequential: ACC1 ပြီးမှ ACC2`
  );
});

// ─── ACCOUNT COMMANDS ─────────────────────────────────────────────────────────
bot.command("accounts", adminOnly, async (ctx) => {
  const accounts = await getAccounts();
  if (!accounts.length) return ctx.reply("📭 Account မရှိသေး\n\n/addaccount မိဘ");
  const list = accounts.map((a, i) => {
    const st  = clientPool[a.name] ? "🟢" : "🔴";
    const gps = (a.gpLinks || []).length;
    const cm  = a.customMsg ? "💬" : "";
    return `${i+1}. ${st} ${a.name} — GP:${gps} ${cm}`;
  }).join("\n");
  ctx.reply(`👤 Accounts (${accounts.length}):\n\n${list}\n\n🟢=on 🔴=off 💬=custom msg`);
});

bot.command("addaccount", adminOnly, async (ctx) => {
  const name = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!name) return ctx.reply("⚠️ Usage: /addaccount မိဘ");
  pendingAdd[ADMIN_ID] = name;
  ctx.reply(`📎 "${name}" အတွက် session .txt file ပို့ပါ\n\nget-session.js run ပြီးရတဲ့ string ကို .txt ထဲ paste လုပ်ပြီးပို့ပါ`);
});

bot.command("removeaccount", adminOnly, async (ctx) => {
  const name = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!name) return ctx.reply("⚠️ Usage: /removeaccount မိဘ");
  if (!(await getAccount(name))) return ctx.reply(`❌ "${name}" မတွေ့ပါ`);
  if (clientPool[name]) {
    try { await clientPool[name].disconnect(); } catch(_) {}
    delete clientPool[name];
  }
  await deleteAccount(name);
  ctx.reply(`🗑️ "${name}" ဖျက်ပြီး`);
});

bot.command("accountstatus", adminOnly, async (ctx) => {
  const accounts = await getAccounts();
  if (!accounts.length) return ctx.reply("📭 Account မရှိသေး");
  const lines = accounts.map((a, i) =>
    `${i+1}. ${a.name} — ${clientPool[a.name] ? "🟢 Connected" : "🔴 Disconnected"}`
  );
  ctx.reply(`📊 Account Status:\n\n${lines.join("\n")}`);
});

// session file upload
bot.on("document", adminOnly, async (ctx) => {
  const name = pendingAdd[ADMIN_ID];
  if (!name) return ctx.reply("⚠️ /addaccount မိဘ ကို အရင်ရိုက်ပါ");
  try {
    const info = await ctx.telegram.getFile(ctx.message.document.file_id);
    const url  = `https://api.telegram.org/file/bot${BOT_TOKEN}/${info.file_path}`;
    const https = require("https");
    const sessionStr = await new Promise((res, rej) => {
      https.get(url, r => {
        let d = ""; r.on("data", c => d += c); r.on("end", () => res(d.trim())); r.on("error", rej);
      });
    });
    if (!sessionStr || sessionStr.length < 20) return ctx.reply("❌ File မှားနေသည်");
    await ctx.reply(`⏳ "${name}" ချိတ်နေသည်...`);
    const client = await buildClient(sessionStr);
    clientPool[name] = client;
    const accounts = await getAccounts();
    await saveAccount(name, {
      name, sessionString: sessionStr, active: true,
      gpLinks: [], customMsg: "", order: accounts.length, addedAt: new Date()
    });
    delete pendingAdd[ADMIN_ID];
    ctx.reply(`✅ "${name}" connected! 🎉\n\n/accounts နိပ်ပြီးကြည့်ပါ`);
  } catch(err) {
    ctx.reply(`❌ Error: ${err.message}`);
  }
});

// ─── GLOBAL MSG ───────────────────────────────────────────────────────────────
bot.command("msg", adminOnly, async (ctx) => {
  // split only on first space to preserve multiline
  const firstSpace = ctx.message.text.indexOf(" ");
  const text = firstSpace === -1 ? "" : ctx.message.text.slice(firstSpace + 1).trim();
  if (!text) {
    return ctx.reply(
      globalMsg
        ? `💬 Global message:\n\n"${globalMsg}"\n\nပြောင်းရန်: /msg စာသား`
        : "⚠️ Usage: /msg စာသား\n\n💡 Spin: မင်္ဂလာပါ{spin}ဟေး{spin}ဟယ်လို..."
    );
  }
  globalMsg = text;
  saveSettings({ globalMsg }).catch(() => {});
  const parts = text.split("{spin}");
  ctx.reply(
    `✅ Global message:\n\n"${text}"` +
    (parts.length > 1 ? `\n\n💡 Spin ${parts.length} မျိုး:\n${parts.map((p,i)=>`${i+1}. "${p.trim()}"`).join("\n")}` : "")
  );
});

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
bot.command("setinterval", adminOnly, (ctx) => {
  const arg = ctx.message.text.split(" ")[1];
  if (!arg) return ctx.reply(`⚠️ Usage: /setinterval 60min (သို့) /setinterval 2hr\nလက်ရှိ: ${intervalMinutes} မိနစ်`);
  const hrM = arg.match(/^(\d+)hr$/i), minM = arg.match(/^(\d+)min$/i);
  const mins = hrM ? parseInt(hrM[1])*60 : minM ? parseInt(minM[1]) : 0;
  if (!mins) return ctx.reply("⚠️ Format: 60min (သို့) 2hr");
  intervalMinutes = mins;
  saveSettings({ intervalMinutes }).catch(() => {});
  if (schedulerTimer) startScheduler();
  ctx.reply(`✅ Rate limit: ${mins} မိနစ်တစ်ကြိမ် (${mins>=60?(mins/60).toFixed(1)+"hr":mins+"min"})`);
});

bot.command("setdelay", adminOnly, (ctx) => {
  const n = parseInt(ctx.message.text.split(" ")[1]);
  if (!n || n < 1) return ctx.reply("⚠️ Usage: /setdelay 6");
  sendDelaySeconds = n;
  saveSettings({ sendDelaySeconds }).catch(() => {});
  ctx.reply(`✅ Delay: ${n}s (GP တိုင်းကြား)`);
});

// ─── TIME ─────────────────────────────────────────────────────────────────────
bot.command("time", adminOnly, (ctx) => {
  const arg = ctx.message.text.split(" ")[1];
  if (!arg) return ctx.reply(
    schedulerTimer
      ? `⏰ Scheduler: ${intervalMinutes} မိနစ်တစ်ကြိမ် 🟢\n\nရပ်ရန်: /time stop`
      : "⚠️ Usage: /time 60min\nရပ်ရန်: /time stop"
  );
  if (arg.toLowerCase() === "stop") {
    if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
    saveSettings({ schedulerOn: false }).catch(() => {});
    return ctx.reply("⏹️ Scheduler ရပ်ပြီး");
  }
  const hrM = arg.match(/^(\d+)hr$/i), minM = arg.match(/^(\d+)min$/i);
  const mins = hrM ? parseInt(hrM[1])*60 : minM ? parseInt(minM[1]) : 0;
  if (!mins) return ctx.reply("⚠️ Format: /time 60min (သို့) /time 2hr");
  intervalMinutes = mins;
  saveSettings({ intervalMinutes, schedulerOn: true }).catch(() => {});
  startScheduler();
  ctx.reply(`✅ Scheduler: ${mins} မိနစ်တစ်ကြိမ် 🟢\n🔒 Rate limit: ${mins} မိနစ်\n\nရပ်ရန်: /time stop`);
});

// ─── SEND ─────────────────────────────────────────────────────────────────────
bot.command("send", adminOnly, async (ctx) => {
  await ctx.reply("📤 ပို့မည်... (rate limit စစ်မည်)");
  await sendAllAccounts(false);
});

bot.command("forcesend", adminOnly, async (ctx) => {
  await ctx.reply("⚡ Force send — rate limit မစစ်ဘဲ အကုန်ပို့မည်!");
  await sendAllAccounts(true);
});

// ─── STATUS ───────────────────────────────────────────────────────────────────
bot.command("status", adminOnly, async (ctx) => {
  const accounts  = await getAccounts();
  const connected = accounts.filter(a => clientPool[a.name]).length;
  const sched     = schedulerTimer ? `🟢 ${intervalMinutes} မိနစ်တစ်ကြိမ်` : "🔴 ပိတ်";

  let lines = `📊 Status\n\n`;
  lines += `👤 Accounts: ${accounts.length} (🟢${connected})\n`;
  lines += `💬 Global msg: ${globalMsg ? `"${globalMsg.substring(0,30)}..."` : "⚠️ မသတ်မှတ်ရသေး"}\n`;
  lines += `⏰ Scheduler: ${sched}\n`;
  lines += `🔒 Interval: ${intervalMinutes} မိနစ် | ⏱ Delay: ${sendDelaySeconds}s\n`;
  lines += `🔄 ပို့နေဆဲ: ${isSending ? "🔄 ဟုတ်" : "❌ မဟုတ်"}`;

  for (const acc of accounts) {
    const gps = await getAccGPs(acc.name);
    const st  = clientPool[acc.name] ? "🟢" : "🔴";
    lines += `\n\n━━━━━━━━━━━━━━━━━━\n${st} [${acc.name}] GP:${gps.length} msg:${acc.customMsg?"custom":"global"}`;
    for (let i = 0; i < gps.length; i++) {
      const last  = await getLastSent(acc.name, gps[i]);
      const short = gps[i].length > 32 ? gps[i].substring(0,32)+"..." : gps[i];
      if (!last) {
        lines += `\n  ${i+1}. ✅ ${short}`;
      } else {
        const rem = Math.ceil(intervalMinutes - (Date.now()-new Date(last).getTime())/60000);
        lines += rem <= 0
          ? `\n  ${i+1}. ✅ ${short}`
          : `\n  ${i+1}. ⏳${rem}မိနစ် ${short}`;
      }
    }
  }
  ctx.reply(lines);
});

// ─── JOIN GP ──────────────────────────────────────────────────────────────────
bot.command("joingp", adminOnly, async (ctx) => {
  if (isJoining) return ctx.reply("⚠️ Join လုပ်နေဆဲ ရှိသေးသည်");
  const args = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!args) return ctx.reply(
    "⚠️ Usage:\n/joingp link1,link2 — account အကုန် join\n/joingp မိဘ link1,link2 — တစ်ကောင်တည်း join"
  );

  const accounts = await getAccounts();
  const parts    = args.split(" ");
  const namedAcc = accounts.find(a => a.name === parts[0]);

  let targets, linksStr;
  if (namedAcc) {
    if (!clientPool[namedAcc.name]) return ctx.reply(`❌ "${namedAcc.name}" connected မဟုတ်သေး`);
    targets  = [namedAcc.name];
    linksStr = parts.slice(1).join(" ").trim();
  } else {
    targets  = accounts.filter(a => clientPool[a.name]).map(a => a.name);
    linksStr = args;
  }

  const links = linksStr.split(",").map(l => l.trim()).filter(Boolean);
  if (!links.length) return ctx.reply("⚠️ GP link ထည့်ပါ");
  if (!targets.length) return ctx.reply("❌ Connected account မရှိသေး");

  isJoining = true;
  await ctx.reply(`🚀 Join စတင်မည်\n👤 ${targets.join(", ")}\n🔗 GP: ${links.length} ခု\n⏱ 3s delay`);

  for (const accName of targets) {
    const client = clientPool[accName];
    let ok = 0, fail = 0, already = 0;
    await bot.telegram.sendMessage(ADMIN_ID, `\n▶️ [${accName}] Join စမည်...`);

    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      try {
        // သင့် joingp.txt logic
        await joinGroup(client, link);
        ok++;
        await bot.telegram.sendMessage(ADMIN_ID, `✅ Join ${i+1} done — [${accName}]\n${link}`);
      } catch (err) {
        const msg = err.message || "";
        if (msg.includes("USER_ALREADY_PARTICIPANT") || msg.includes("already")) {
          already++;
          await bot.telegram.sendMessage(ADMIN_ID, `ℹ️ Join ${i+1} — [${accName}] ပြီးနေပြီ\n${link}`);
        } else {
          fail++;
          await bot.telegram.sendMessage(ADMIN_ID, `❌ Fail ${i+1} — [${accName}]\n${link}\n⚠️ ${msg}`);
        }
      }
      if (i < links.length - 1) await sleep(3);
    }
    await bot.telegram.sendMessage(ADMIN_ID,
      `📊 [${accName}] ✅${ok} ❌${fail} ℹ️${already}(ပြီးနေပြီ)`
    );
    if (targets.indexOf(accName) < targets.length - 1) await sleep(3);
  }

  await bot.telegram.sendMessage(ADMIN_ID, "🏁 GP Join အကုန်ပြီးပါပြီ!");
  isJoining = false;
});

// ─── DYNAMIC ACCOUNT COMMANDS (နံပါတ်နဲ့) ────────────────────────────────────
// /check1  /1gp  /1addgp  /1removegp  /1cleargp  /1msg  /1clearmsg
bot.on("text", adminOnly, async (ctx) => {
  if (!ctx.message?.text) return;
  // bot username ကိုပဲ strip လုပ် — /cmd@BotName → /cmd
  // message ထဲက @mention နဲ့ newline တွေ မဖျက်ရ
  const rawText = ctx.message.text || "";
  const text = rawText.replace(/^(\/\w+)@\w+/, "$1");

  const knownCmds = [
    "/start","/accounts","/addaccount","/removeaccount","/accountstatus",
    "/msg","/setinterval","/setdelay","/time","/send","/forcesend",
    "/status","/joingp"
  ];
  const base = text.split(" ")[0].toLowerCase();
  if (knownCmds.includes(base)) return;

  const accounts = await getAccounts();
  function getByNum(n) {
    const i = parseInt(n) - 1;
    return (i >= 0 && i < accounts.length) ? accounts[i] : null;
  }

  // /check1
  let m = text.match(/^\/check(\d+)$/);
  if (m) {
    const acc = getByNum(m[1]);
    if (!acc) return ctx.reply(`❌ Account ${m[1]} မတွေ့ပါ\n/accounts နိပ်ပြီးကြည့်ပါ`);
    const gps  = await getAccGPs(acc.name);
    const msg  = await getAccMsg(acc.name, globalMsg);
    const st   = clientPool[acc.name] ? "🟢 Connected" : "🔴 Disconnected";
    let gpList = gps.length === 0 ? "\n📭 GP မရှိသေး" : "\n\n📋 GP List:";
    for (let i = 0; i < gps.length; i++) {
      const last  = await getLastSent(acc.name, gps[i]);
      const short = gps[i].length > 35 ? gps[i].substring(0,35)+"..." : gps[i];
      if (!last) { gpList += `\n${i+1}. ✅ ${short}`; }
      else {
        const rem = Math.ceil(intervalMinutes - (Date.now()-new Date(last).getTime())/60000);
        gpList += rem <= 0 ? `\n${i+1}. ✅ ${short}` : `\n${i+1}. ⏳${rem}မိနစ် ${short}`;
      }
    }
    const n = m[1];
    return ctx.reply(
      `👤 [${acc.name}] (#${n})\n${st}\n🔗 GP: ${gps.length}\n💬 Msg: ${(await getAccount(acc.name))?.customMsg ? "custom" : msg ? "global" : "⚠️ မသတ်မှတ်ရသေး"}` +
      gpList +
      `\n\n📝 Edit:\n/${n}gp link1,link2\n/${n}addgp link\n/${n}removegp 1\n/${n}msg စာသား`
    );
  }

  // /1gp link1,link2
  m = text.match(/^\/(\d+)gp (.+)$/);
  if (m) {
    const acc = getByNum(m[1]);
    if (!acc) return ctx.reply(`❌ Account ${m[1]} မတွေ့ပါ`);
    const links = m[2].split(",").map(l=>l.trim()).filter(Boolean);
    await saveAccGPs(acc.name, links);
    return ctx.reply(`✅ [${acc.name}] GP ${links.length} ခု:\n\n${links.map((l,i)=>`${i+1}. ${l}`).join("\n")}`);
  }

  // /1gp (view)
  m = text.match(/^\/(\d+)gp$/);
  if (m) {
    const acc = getByNum(m[1]);
    if (!acc) return ctx.reply(`❌ Account ${m[1]} မတွေ့ပါ`);
    const links = await getAccGPs(acc.name);
    if (!links.length) return ctx.reply(`📭 [${acc.name}] GP မရှိသေး\n/${m[1]}gp link1,link2`);
    return ctx.reply(`📋 [${acc.name}] GP (${links.length}):\n\n${links.map((l,i)=>`${i+1}. ${l}`).join("\n")}`);
  }

  // /1addgp link
  m = text.match(/^\/(\d+)addgp (.+)$/);
  if (m) {
    const acc = getByNum(m[1]);
    if (!acc) return ctx.reply(`❌ Account ${m[1]} မတွေ့ပါ`);
    const links = await getAccGPs(acc.name);
    links.push(m[2].trim());
    await saveAccGPs(acc.name, links);
    return ctx.reply(`✅ [${acc.name}] GP ထည့်ပြီး:\n${m[2].trim()}\n\nစုစုပေါင်း: ${links.length}`);
  }

  // /1removegp 2
  m = text.match(/^\/(\d+)removegp (\d+)$/);
  if (m) {
    const acc = getByNum(m[1]);
    if (!acc) return ctx.reply(`❌ Account ${m[1]} မတွေ့ပါ`);
    const links = await getAccGPs(acc.name);
    const idx   = parseInt(m[2]) - 1;
    if (idx < 0 || idx >= links.length) return ctx.reply(`⚠️ 1 မှ ${links.length} ထိ`);
    const removed = links.splice(idx, 1)[0];
    await saveAccGPs(acc.name, links);
    return ctx.reply(`🗑️ [${acc.name}] ဖျက်ပြီး:\n${removed}\n\nကျန်: ${links.length}`);
  }

  // /1cleargp
  m = text.match(/^\/(\d+)cleargp$/);
  if (m) {
    const acc = getByNum(m[1]);
    if (!acc) return ctx.reply(`❌ Account ${m[1]} မတွေ့ပါ`);
    await saveAccGPs(acc.name, []);
    return ctx.reply(`🗑️ [${acc.name}] GP အကုန်ဖျက်ပြီး`);
  }

  // /1msg text
  m = text.match(/^\/(\d+)msg ([\s\S]+)$/);
  if (m) {
    const acc = getByNum(m[1]);
    if (!acc) return ctx.reply(`❌ Account ${m[1]} မတွေ့ပါ`);
    const msg = m[2].trim();
    await saveAccount(acc.name, { customMsg: msg });
    const parts = msg.split("{spin}");
    return ctx.reply(
      `✅ [${acc.name}] Custom message:\n\n"${msg}"` +
      (parts.length > 1 ? `\n\n💡 Spin ${parts.length} မျိုး` : "")
    );
  }

  // /1msg (view)
  m = text.match(/^\/(\d+)msg$/);
  if (m) {
    const acc = getByNum(m[1]);
    if (!acc) return ctx.reply(`❌ Account ${m[1]} မတွေ့ပါ`);
    const a   = await getAccount(acc.name);
    return ctx.reply(
      a?.customMsg
        ? `💬 [${acc.name}] Custom msg:\n\n"${a.customMsg}"\n\nဖျက်ရန်: /${m[1]}clearmsg`
        : `💬 [${acc.name}] Custom msg မသတ်မှတ်ရသေး (global သုံးနေသည်)\n\nသတ်မှတ်ရန်: /${m[1]}msg စာသား`
    );
  }

  // /1clearmsg
  m = text.match(/^\/(\d+)clearmsg$/);
  if (m) {
    const acc = getByNum(m[1]);
    if (!acc) return ctx.reply(`❌ Account ${m[1]} မတွေ့ပါ`);
    await saveAccount(acc.name, { customMsg: "" });
    return ctx.reply(`🗑️ [${acc.name}] Custom msg ဖျက်ပြီး`);
  }
});

// ─── KEEP ALIVE ───────────────────────────────────────────────────────────────
const http = require("http");
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200); res.end("GP Bot OK"); })
  .listen(PORT, () => console.log(`🌐 Port ${PORT}`));
setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  http.get(url, r => console.log(`💓 ${r.statusCode}`)).on("error", () => {});
}, 14 * 60 * 1000);

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  await connectDB();

  const s = await getSettings();
  if (s.globalMsg)        globalMsg        = s.globalMsg;
  if (s.intervalMinutes)  intervalMinutes  = s.intervalMinutes;
  if (s.sendDelaySeconds) sendDelaySeconds = s.sendDelaySeconds;

  await initAllClients();
  if (s.schedulerOn && intervalMinutes > 0) startScheduler();

  await bot.telegram.deleteWebhook({ drop_pending_updates: true });

  let launched = false, retry = 0;
  while (!launched) {
    try {
      await bot.launch({ dropPendingUpdates: true });
      launched = true;
      console.log("✅ Bot started!");
    } catch (err) {
      if (err.response?.error_code === 409) {
        retry++;
        console.log(`⚠️ 409 conflict — retry ${retry} in 5s...`);
        await sleep(5);
        await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(()=>{});
      } else throw err;
    }
  }

  await bot.telegram.sendMessage(ADMIN_ID, "✅ GP Bot အသင့်ဖြစ်ပြီ!\n\n/start နိပ်ပါ");

  process.once("SIGINT",  () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main().catch(console.error);
