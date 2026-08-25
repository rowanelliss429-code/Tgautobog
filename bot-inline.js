const { Telegraf, Markup } = require("telegraf");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram/tl");
const { MongoClient } = require("mongodb");
const crypto = require("crypto");
require("dotenv").config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_ID = Number(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const ADMIN_IDS = String(process.env.ADMIN_IDS || process.env.ADMIN_ID || "").split(",").map(x => Number(x.trim())).filter(Number.isSafeInteger);
const ADMIN_ID = ADMIN_IDS[0];
const MONGO_URI = process.env.MONGO_URI;
const SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY;
const PORT = Number(process.env.PORT || 3000);
const MAX_ACCOUNTS = 10;
const GP_DELAY_MS = 6000;
const SEND_COOLDOWN_MS = 15 * 60 * 1000;
const STOP_COOLDOWN_MS = 20 * 60 * 1000;

const missingEnv = [
  ["BOT_TOKEN", BOT_TOKEN], ["API_ID", API_ID], ["API_HASH", API_HASH],
  ["ADMIN_ID or ADMIN_IDS", ADMIN_IDS.length > 0], ["MONGO_URI", MONGO_URI]
].filter(([, value]) => value === false || value === undefined || value === null || value === "" || (typeof value === "number" && !Number.isFinite(value))).map(([name]) => name);
if (missingEnv.length) {
  throw new Error(`Missing Render Environment Variables: ${missingEnv.join(", ")}`);
}
const KEY = SESSION_ENCRYPTION_KEY ? crypto.createHash("sha256").update(SESSION_ENCRYPTION_KEY).digest() : null;
function encrypt(value) {
  if (!KEY) return String(value);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}
function decrypt(value) {
  if (!value) return "";
  if (!KEY) return String(value);
  const [ivB64, tagB64, dataB64] = String(value).split(".");
  if (!ivB64 || !tagB64 || !dataB64) return String(value);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
  } catch { throw new Error("Encrypted account data cannot be decrypted; check SESSION_ENCRYPTION_KEY"); }
}
function encryptJson(value) { return KEY ? encrypt(JSON.stringify(value || [])) : JSON.stringify(value || []); }
function decryptJson(value) { try { return JSON.parse(decrypt(value)); } catch { return Array.isArray(value) ? value : []; } }

const bot = new Telegraf(BOT_TOKEN);
let db;
const clients = new Map();
const states = new Map();
let job = null;
let repeatTimer = null;
let scheduledNames = [];
let stopRequested = false;
let stopPresses = 0;
let lastStopAt = 0;
let cooldownUntil = 0;

const isAdmin = ctx => ADMIN_IDS.includes(Number(ctx.from?.id));
const adminOnly = async (ctx, next) => {
  if (isAdmin(ctx)) return next();
  console.warn(`Unauthorized Telegram user ${ctx.from?.id}; configured ADMIN_IDS=${ADMIN_IDS.join(",")}`);
  if (ctx.message?.text === "/start" || ctx.callbackQuery) await ctx.reply("ဒီ bot ကို admin account သာ အသုံးပြုနိုင်ပါသည်။").catch(() => {});
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connectDB() {
  const mongo = new MongoClient(MONGO_URI);
  await mongo.connect();
  db = mongo.db("gpbot");
}
async function accounts() {
  const rows = await db.collection("accounts").find({}).sort({ order: 1, addedAt: 1 }).toArray();
  return rows.map(a => ({ ...a, sessionString: KEY ? (a.sessionCiphertext ? decrypt(a.sessionCiphertext) : a.sessionString || "") : (a.sessionString || ""), gpLinks: KEY ? (a.gpLinksCiphertext ? decryptJson(a.gpLinksCiphertext) : a.gpLinks || []) : (a.gpLinks || []) }));
}
async function accountByName(name) { return (await accounts()).find(a => a.name === name) || null; }
async function saveAccount(name, data) {
  const safe = { ...data };
  if (Object.prototype.hasOwnProperty.call(safe, "sessionString")) { if (KEY) { safe.sessionCiphertext = encrypt(safe.sessionString); delete safe.sessionString; } }
  if (Object.prototype.hasOwnProperty.call(safe, "gpLinks")) { if (KEY) { safe.gpLinksCiphertext = encryptJson(safe.gpLinks); delete safe.gpLinks; } }
  return db.collection("accounts").updateOne({ name }, { $set: safe, ...(KEY ? { $unset: { sessionString: "", gpLinks: "" } } : {}) }, { upsert: true });
}
async function deleteAccount(name) {
  await db.collection("accounts").deleteOne({ name });
  await db.collection("sendlogs").deleteMany({ accName: name });
}
async function migrateLegacyAccountData() {
  if (!KEY) return;
  const rows = await db.collection("accounts").find({}).toArray();
  for (const row of rows) {
    const patch = {};
    if (row.sessionString && !row.sessionCiphertext) patch.sessionString = row.sessionString;
    if (Array.isArray(row.gpLinks) && !row.gpLinksCiphertext) patch.gpLinks = row.gpLinks;
    if (Object.keys(patch).length) await saveAccount(row.name, patch);
  }
}
const settings = async () => (await db.collection("settings").findOne({ _id: "main" })) || {};
const saveSettings = data => db.collection("settings").updateOne({ _id: "main" }, { $set: data }, { upsert: true });

function mainMenu() {
  return Markup.keyboard([
    ["Add ACC", "ACC List", "Ready"],
    ["Time", "Join GP", "Msg"],
    ["Send", "Stop"]
  ]).resize().persistent();
}
function backButton() { return Markup.inlineKeyboard([[Markup.button.callback("Back", "menu:main")]]); }
function cancelButton() { return Markup.inlineKeyboard([[Markup.button.callback("Cancel ❌", "flow:cancel")]]); }
async function safeAnswer(ctx, text = "") {
  if (ctx.callbackQuery) await ctx.answerCbQuery(text).catch(() => {});
}
async function removeInlineButtons(ctx) {
  if (ctx.callbackQuery) await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
}
async function showMenu(ctx, text = "Main Menu") {
  await safeAnswer(ctx);
  if (ctx.callbackQuery) {
    await removeInlineButtons(ctx);
    return ctx.reply(text, mainMenu()).catch(() => {});
  }
  return ctx.reply(text, mainMenu()).catch(() => {});
}
async function tell(ctx, text, extra = {}) { return ctx.reply(text, extra); }
function setState(type, data = {}) { states.set(ADMIN_ID, { type, ...data }); }
function clearState() { states.delete(ADMIN_ID); }
function currentState() { return states.get(ADMIN_ID); }
function pickMessage(text) { return String(text).split("{spin}")[Math.floor(Math.random() * String(text).split("{spin}").length)].trim(); }
function floodWaitSeconds(err) {
  return Number(err?.seconds || err?.value || String(err?.message || "").match(/FLOOD_WAIT[_ ]?(\d+)/i)?.[1] || 0);
}
function parseLinks(text) { return String(text).split(",").map(x => x.trim()).filter(Boolean); }
function remaining(ms) { return ms <= 0 ? "ပြီးပါပြီ" : `${Math.ceil(ms / 60000)} မိနစ်ခန့်ကျန်`; }

async function buildClient(session) {
  const client = new TelegramClient(new StringSession(session), API_ID, API_HASH, { connectionRetries: 5 });
  await client.connect();
  return client;
}
async function loadClients() {
  for (const a of await accounts()) {
    if (!clients.has(a.name) && a.sessionString) {
      try { clients.set(a.name, await buildClient(a.sessionString)); } catch (e) { console.error(a.name, e.message); }
    }
  }
}
async function joinOne(client, link) {
  const entity = await client.getEntity(link);
  await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
}
async function sendOne(client, link, message) {
  const entity = await client.getEntity(link);
  await client.sendMessage(entity, { message, parseMode: "html", linkPreview: false });
}
async function lastSent(name, link) { return db.collection("sendlogs").findOne({ accName: name, gpLink: link }); }
async function markSent(name, link) { return db.collection("sendlogs").updateOne({ accName: name, gpLink: link }, { $set: { sentAt: new Date() } }, { upsert: true }); }

async function readiness() {
  const list = await accounts();
  if (!list.length) return "⚠️ Account မရှိသေးပါ။ Add ACC ကိုနှိပ်ပြီး account ထည့်ပါ။";
  const lines = [];
  let ok = true;
  for (const [i, a] of list.entries()) {
    const gps = a.gpLinks || [];
    const msg = a.customMsg || (await settings()).globalMsg || "";
    if (!clients.has(a.name) || !gps.length || !msg) ok = false;
    lines.push(`${i + 1}. ${a.name} — ${clients.has(a.name) ? "Connected" : "Disconnected"} | GP ${gps.length} | Msg ${msg ? "ရှိ" : "မရှိ"}`);
  }
  return `📋 Ready စစ်ဆေးချက်\n\n${lines.join("\n")}\n\n${ok ? "✅ အဆင်သင့်ဖြစ်ပါပြီ။" : "⚠️ Account/GP/Message မပြည့်စုံသေးပါ။"}\n\nအားလုံးပို့ရန် /send all\nတစ်ခုတည်းပို့ရန် /send acc1`;
}

async function runSend(names) {
  if (job) return;
  if (Date.now() < cooldownUntil) { await bot.telegram.sendMessage(ADMIN_ID, `⏳ Cooldown ရှိနေသေးသည် — ${remaining(cooldownUntil - Date.now())}`); return; }
  job = { names, startedAt: Date.now() };
  stopRequested = false;
  try {
    const global = (await settings()).globalMsg || "";
    for (const name of names) {
      const a = await accountByName(name);
      const client = clients.get(name);
      if (!a || !client) { await bot.telegram.sendMessage(ADMIN_ID, `⚠️ ${name} Connected မဟုတ်ပါ`); continue; }
      const msg = a.customMsg || global;
      const gps = a.gpLinks || [];
      if (!msg || !gps.length) { await bot.telegram.sendMessage(ADMIN_ID, `⏭ ${name}: GP သို့မဟုတ် message မရှိပါ`); continue; }
      for (let i = 0; i < gps.length; i++) {
        if (stopRequested) throw new Error("STOP_REQUESTED");
        const link = gps[i];
        try {
          const old = await lastSent(name, link);
          if (old && Date.now() - new Date(old.sentAt).getTime() < SEND_COOLDOWN_MS) {
            await bot.telegram.sendMessage(ADMIN_ID, `⏭ ${name} GP${i + 1} — 15 မိနစ်မပြည့်သေးပါ`);
          } else {
            await sendOne(client, link, pickMessage(msg));
            await markSent(name, link);
            await bot.telegram.sendMessage(ADMIN_ID, `✅ ${name} GP${i + 1} ပို့ပြီးပါပြီ`);
          }
        } catch (err) {
          const wait = floodWaitSeconds(err);
          if (wait) {
            await bot.telegram.sendMessage(ADMIN_ID, `⏳ Telegram က ${wait} စက္ကန့်စောင့်ခိုင်းနေပါသည်။ ပြီးမှ ဆက်ပို့မည်။`);
            await sleep(wait * 1000);
            i--;
            continue;
          }
          await bot.telegram.sendMessage(ADMIN_ID, `❌ ${name} GP${i + 1} မအောင်မြင်ပါ — ${err.message}`);
        }
        if (i < gps.length - 1) await sleep(GP_DELAY_MS);
      }
      await bot.telegram.sendMessage(ADMIN_ID, `📌 ${name} ပြီးပါပြီ။ နောက်တစ်ကြိမ်ပို့ရန် 15 မိနစ်နားမည်။`);
    }
  } catch (err) { if (err.message === "STOP_REQUESTED") await bot.telegram.sendMessage(ADMIN_ID, "⏹️ ပို့နေမှု ရပ်လိုက်ပါပြီ"); else console.error(err); }
  finally {
    job = null;
    if (!stopRequested && Date.now() >= cooldownUntil && scheduledNames.length) {
      repeatTimer = setTimeout(() => runSend(scheduledNames), SEND_COOLDOWN_MS);
      await bot.telegram.sendMessage(ADMIN_ID, "⏰ 15 မိနစ်ပြည့်လျှင် auto-send ပြန်စမည်။");
    }
    stopRequested = false;
  }
}

async function runJoin(name, links) {
  const client = clients.get(name);
  if (!client) return bot.telegram.sendMessage(ADMIN_ID, `❌ ${name} Connected မဟုတ်ပါ`);
  const accepted = [];
  for (let i = 0; i < links.length; i++) {
    try { await joinOne(client, links[i]); accepted.push(links[i]); await bot.telegram.sendMessage(ADMIN_ID, `✅ ${name} GP${i + 1} ပြီးပါပြီ`); }
    catch (err) {
      const wait = floodWaitSeconds(err);
      if (wait) { await bot.telegram.sendMessage(ADMIN_ID, `⏳ Telegram အမိန့်အတိုင်း ${wait} စက္ကန့်စောင့်ပြီး ဆက်လုပ်မည်`); await sleep(wait * 1000); i--; continue; }
      if (/already|PARTICIPANT/i.test(err.message)) { accepted.push(links[i]); await bot.telegram.sendMessage(ADMIN_ID, `ℹ️ ${name} GP${i + 1} ဝင်ပြီးသားပါ`); }
      else await bot.telegram.sendMessage(ADMIN_ID, `❌ ${name} GP${i + 1} မအောင်မြင်ပါ — ${err.message}`);
    }
    if (i < links.length - 1) await sleep(GP_DELAY_MS);
  }
  if (accepted.length) {
    const a = await accountByName(name);
    const merged = [...new Set([...(a?.gpLinks || []), ...accepted])];
    await saveAccount(name, { gpLinks: merged });
    await bot.telegram.sendMessage(ADMIN_ID, `🏁 ${name} GP join အားလုံးပြီးပါပြီ။ သိမ်းထားသော GP: ${merged.length} ခု`);
  }
  const refreshed = await accounts();
  await bot.telegram.sendMessage(ADMIN_ID, await readiness(), readyButtons(refreshed));
}
function readyButtons(list) {
  const rows = list.map((a, i) => !(a.gpLinks || []).length ? [Markup.button.callback(`Add GP Acc${i + 1}`, `ready:addgp:${i}`)] : [] ).filter(r => r.length);
  rows.push([Markup.button.callback("Back", "menu:main")]);
  return Markup.inlineKeyboard(rows);
}

bot.use(async (ctx, next) => {
  try { await safeAnswer(ctx); } catch (_) {}
  return next();
});
bot.catch((err, ctx) => { console.error("Telegram handler error", { updateId: ctx.update?.update_id, message: err.message, stack: err.stack }); });
process.on("unhandledRejection", err => console.error("Unhandled promise rejection", err));
process.on("uncaughtException", err => console.error("Uncaught exception (kept alive)", err));
bot.start(adminOnly, ctx => showMenu(ctx, "👋 GP Auto Sender Bot\n\nMain Menu ကိုရွေးပါ။"));
bot.command("send", adminOnly, async ctx => {
  const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
  const list = await accounts();
  if (!arg) return tell(ctx, "အသုံးပြုပုံ: /send all သို့မဟုတ် /send acc1");
  const names = arg === "all" ? list.map(a => a.name) : [list[Number(arg.replace("acc", "")) - 1]?.name].filter(Boolean);
  if (!names.length) return tell(ctx, "⚠️ Account မတွေ့ပါ");
  await tell(ctx, `📤 ${arg === "all" ? "Account အားလုံး" : arg} ကို ပို့စတင်မည်`); scheduledNames = names; runSend(names);
});
bot.command("menu", adminOnly, ctx => showMenu(ctx));

bot.action("menu:main", adminOnly, ctx => { clearState(); return showMenu(ctx); });
bot.action("menu:add", adminOnly, async ctx => {
  const list = await accounts();
  if (list.length >= MAX_ACCOUNTS) return tell(ctx, "⚠️ Account ထည့်နိုင်သည့် အများဆုံးအရေအတွက် 10 ခု ပြည့်သွားပါပြီ။", backButton());
  setState("add_session"); await tell(ctx, "Account session ကို ရိုးရိုးစာသား သို့မဟုတ် `.txt` file အဖြစ် ပို့ပါ။ Bot က စစ်ဆေးပြီး ချိတ်ဆက်ပေးမည်။", cancelButton());
});
function accountListKeyboard() { return Markup.inlineKeyboard([[Markup.button.callback("Remove ACC", "acc:remove")], [Markup.button.callback("Replace ACC", "acc:replace")], [Markup.button.callback("Back", "menu:main")]]); }
async function sendAccountList(ctx) {
  const list = await accounts();
  if (!list.length) return tell(ctx, "📭 Account မရှိသေးပါ။", accountListKeyboard());
  return tell(ctx, `👤 ACC List\n\n${list.map((a, i) => `${i + 1}. ${a.name} — ${clients.has(a.name) ? "Connected" : "Disconnected"}`).join("\n")}`, accountListKeyboard());
}
bot.action("menu:list", adminOnly, sendAccountList);
bot.action("acc:remove", adminOnly, async ctx => { const list = await accounts(); if (!list.length) return tell(ctx, "📭 Account မရှိသေးပါ။", backButton()); setState("remove_acc"); await removeInlineButtons(ctx); return tell(ctx, `ဖယ်ရှားမည့် account နံပါတ်ကို ပို့ပါ။\nဥပမာ: 2 သို့မဟုတ် No2\n\n${list.map((a, i) => `${i + 1}. ${a.name}`).join("\n")}`, Markup.inlineKeyboard([[Markup.button.callback("Cancel ❌", "flow:cancel")], [Markup.button.callback("Back", "menu:list")]])); });
bot.action("acc:replace", adminOnly, async ctx => { const list = await accounts(); if (!list.length) return tell(ctx, "📭 Account မရှိသေးပါ။", backButton()); setState("replace_index"); await removeInlineButtons(ctx); return tell(ctx, `အစားထိုးမည့် account နံပါတ်ကို ပို့ပါ။\nဥပမာ: 2 သို့မဟုတ် No2\n\n${list.map((a, i) => `${i + 1}. ${a.name}`).join("\n")}`, Markup.inlineKeyboard([[Markup.button.callback("Cancel ❌", "flow:cancel")], [Markup.button.callback("Back", "menu:list")]])); });
bot.action("menu:ready", adminOnly, async ctx => { const list = await accounts(); return tell(ctx, await readiness(), readyButtons(list)); });
bot.action("menu:time", adminOnly, async ctx => {
  const list = await accounts(); const lines = [];
  for (const a of list) for (const [i, link] of (a.gpLinks || []).entries()) { const x = await lastSent(a.name, link); lines.push(`${a.name} GP${i + 1}: ${x ? remaining(SEND_COOLDOWN_MS - (Date.now() - new Date(x.sentAt).getTime())) : "ပို့ရန် အသင့်"}`); }
  tell(ctx, `⏱ ကျန်ရှိချိန်\n\n${lines.join("\n") || "GP မရှိသေးပါ"}`, backButton());
});
bot.action("menu:join", adminOnly, async ctx => {
  const list = await accounts(); if (!list.length) return tell(ctx, "⚠️ အရင်ဆုံး Add ACC လုပ်ပါ။", backButton());
  setState("choose_join"); return tell(ctx, "Account ရွေးချယ်ပါ။", Markup.inlineKeyboard([...list.map((a, i) => [Markup.button.callback(`Join Acc${i + 1} GP`, `join:choose:${i}`)]), [Markup.button.callback("Back", "menu:main")]]));
});
bot.action(/^join:choose:(\d+)$/, adminOnly, async (ctx) => { const list = await accounts(); const a = list[Number(ctx.match[1])]; if (!a) return; setState("join_links", { name: a.name }); tell(ctx, `${a.name} အတွက် join မည့် GP link များကို comma (,) ခံပြီး ပို့ပါ။`, Markup.inlineKeyboard([[Markup.button.callback("Cancel ❌", "flow:cancel")], [Markup.button.callback("Back", "menu:join")]])); });
bot.action(/^ready:addgp:(\d+)$/, adminOnly, async ctx => { const list = await accounts(); const a = list[Number(ctx.match[1])]; if (!a) return; setState("join_links", { name: a.name }); await safeAnswer(ctx, `Add GP Acc${Number(ctx.match[1]) + 1}`); await removeInlineButtons(ctx); return tell(ctx, `${a.name} အတွက် GP link များကို comma (,) ခံပြီး ပို့ပါ။ Join ပြီးလျှင် GP list ထဲသို့ သိမ်းမည်။`, Markup.inlineKeyboard([[Markup.button.callback("Cancel ❌", "flow:cancel")], [Markup.button.callback("Back", "menu:ready")]])); });
bot.action("menu:msg", adminOnly, async ctx => {
  const list = await accounts();
  const rows = [[Markup.button.callback("Global Msg", "msg:global")], ...list.map((a, i) => [Markup.button.callback(`Edit Acc${i + 1} Msg`, `msg:acc:${i}`)]), [Markup.button.callback("Back", "menu:main")]];
  tell(ctx, "Message ပြင်မည့် account ကို ရွေးပါ။", Markup.inlineKeyboard(rows));
});
bot.action("msg:global", adminOnly, async ctx => { setState("global_msg"); tell(ctx, "Account အားလုံးသုံးမည့် Global message ကို ပို့ပါ။ Custom message ရှိသော account များက Global message မသုံးပါ။", cancelButton()); });
bot.action(/^msg:acc:(\d+)$/, adminOnly, async ctx => { const list = await accounts(); const a = list[Number(ctx.match[1])]; if (!a) return; setState("acc_msg", { name: a.name }); tell(ctx, `${a.name} အတွက် သီးသန့် message ကို ရေးပို့ပါ။`, Markup.inlineKeyboard([[Markup.button.callback("Completed ✅", "flow:completed")], [Markup.button.callback("Cancel ❌", "flow:cancel")]])); });
bot.action("menu:send", adminOnly, async ctx => tell(ctx, "အားလုံးပို့ရန် `/send all`\nAccount တစ်ခုတည်းပို့ရန် `/send acc1` ဟု ရိုက်ပါ။\nGP တစ်ခုချင်း 6 seconds ခြားပြီး ပို့မည်။", backButton()));
bot.action("menu:stop", adminOnly, async ctx => {
  const now = Date.now(); stopPresses = now - lastStopAt < 10000 ? stopPresses + 1 : 1; lastStopAt = now;
  if (job) stopRequested = true;
  if (repeatTimer) { clearTimeout(repeatTimer); repeatTimer = null; }
  if (stopPresses >= 2) { cooldownUntil = now + STOP_COOLDOWN_MS; stopPresses = 0; return tell(ctx, "⏹️ Stop လုပ်ပြီးပါပြီ။ 20 မိနစ် cooldown ထားထားသည်။", backButton()); }
  tell(ctx, "⏹️ Stop တောင်းဆိုပြီးပါပြီ။ ထပ်မံနှိပ်လျှင် 20 မိနစ် cooldown ထားမည်။", backButton());
});
bot.action("flow:cancel", adminOnly, async ctx => {
  clearState();
  await safeAnswer(ctx, "Cancelled");
  await removeInlineButtons(ctx);
  return tell(ctx, "❌ ပယ်ဖျက်ပြီးပါပြီ။ Main Menu ကို ပြန်သုံးနိုင်ပါပြီ။", mainMenu()).catch(() => {});
});
bot.action("flow:completed", adminOnly, async ctx => { const s = currentState(); if (!s || s.type !== "acc_msg") return; clearState(); tell(ctx, "✅ Message ပြင်ဆင်ပြီးပါပြီ။", mainMenu()); });

async function receiveSession(ctx, text) {
  const value = String(text || "").trim();
  if (!value || value.length < 20 || /^(hello|test|account|session)$/i.test(value)) return tell(ctx, "⚠️ ရိုးရိုးစာသားဖြစ်နေပါသည်။ Telegram session string ကိုသာ ပို့ပါ။", cancelButton());
  try {
    await tell(ctx, "⏳ Connecting...");
    const client = await buildClient(value); const state = currentState();
    if (state?.type === "replace_session") {
      const list = await accounts(); const old = list[state.index];
      if (!old) { await client.disconnect().catch(() => {}); clearState(); return tell(ctx, "❌ Replace လုပ်မည့် account မတွေ့ပါ။", mainMenu()); }
      if (clients.has(old.name)) await clients.get(old.name).disconnect().catch(() => {});
      await saveAccount(old.name, { sessionString: value, active: true }); clients.set(old.name, client); clearState();
      return tell(ctx, `✅ ${old.name} ကို account အသစ်ဖြင့် replace လုပ်ပြီး Connected ဖြစ်ပါပြီ။`, mainMenu());
    }
    const list = await accounts(); const name = `Acc${list.length + 1}`;
    await saveAccount(name, { name, sessionString: value, active: true, gpLinks: [], customMsg: "", order: list.length, addedAt: new Date() }); clients.set(name, client); clearState(); await tell(ctx, `✅ ${name} Connected`, mainMenu());
  } catch (err) { tell(ctx, `❌ Session မှားနေသည် သို့မဟုတ် ချိတ်ဆက်မရပါ — ${err.message}`, cancelButton()); }
}
bot.on("document", adminOnly, async ctx => {
  const s = currentState(); if (!s || !["add_session", "replace_session"].includes(s.type)) return;
  try { const f = await ctx.telegram.getFile(ctx.message.document.file_id); const https = require("https"); const data = await new Promise((resolve, reject) => https.get(`https://api.telegram.org/file/bot${BOT_TOKEN}/${f.file_path}`, r => { let x = ""; r.on("data", c => x += c); r.on("end", () => resolve(x)); r.on("error", reject); }).on("error", reject)); await receiveSession(ctx, data); } catch (e) { tell(ctx, `❌ File ဖတ်မရပါ — ${e.message}`, cancelButton()); }
});
bot.on("text", adminOnly, async ctx => {
  const s = currentState(); const text = ctx.message.text.trim();
  if (text === "/cancel") { clearState(); return showMenu(ctx); }
  if (s?.type === "remove_acc" || s?.type === "replace_index") {
    const match = text.match(/^no?\s*(\d+)$/i);
    if (!match) return tell(ctx, "⚠️ Account နံပါတ်ကိုသာ ပို့ပါ။ ဥပမာ: 2 သို့မဟုတ် No2", cancelButton());
    const index = Number(match[1]) - 1; const list = await accounts(); const a = list[index];
    if (!a) return tell(ctx, `❌ Account ${match[1]} မတွေ့ပါ။ 1 မှ ${list.length} အတွင်း နံပါတ်ပို့ပါ။`, cancelButton());
    if (s.type === "remove_acc") {
      clearState();
      try { if (clients.has(a.name)) { await clients.get(a.name).disconnect().catch(() => {}); clients.delete(a.name); } await deleteAccount(a.name); return tell(ctx, `✅ ${a.name} ကို ဖယ်ရှားပြီးပါပြီ။`, mainMenu()); }
      catch (err) { return tell(ctx, `❌ Remove မအောင်မြင်ပါ — ${err.message}`, mainMenu()); }
    }
    setState("replace_session", { index }); return tell(ctx, `${a.name} ကို အစားထိုးရန် session ကို စာသား သို့မဟုတ် .txt file အဖြစ် ပို့ပါ။`, Markup.inlineKeyboard([[Markup.button.callback("Cancel ❌", "flow:cancel")], [Markup.button.callback("Back", "acc:replace")]]));
  }
  if (!s) {
    if (text === "Add ACC") {
      const list = await accounts();
      if (list.length >= MAX_ACCOUNTS) return tell(ctx, "⚠️ Account ထည့်နိုင်သည့် အများဆုံးအရေအတွက် 10 ခု ပြည့်သွားပါပြီ။");
      setState("add_session"); return tell(ctx, "Account session ကို ရိုးရိုးစာသား သို့မဟုတ် `.txt` file အဖြစ် ပို့ပါ။ Bot က စစ်ဆေးပြီး ချိတ်ဆက်ပေးမည်။", cancelButton());
    }
    if (text === "ACC List") return sendAccountList(ctx);
    if (text === "Ready") { const list = await accounts(); return tell(ctx, await readiness(), readyButtons(list)); }
    if (text === "Time") {
      const list = await accounts(); const lines = [];
      for (const a of list) for (const [i, link] of (a.gpLinks || []).entries()) { const x = await lastSent(a.name, link); lines.push(`${a.name} GP${i + 1}: ${x ? remaining(SEND_COOLDOWN_MS - (Date.now() - new Date(x.sentAt).getTime())) : "ပို့ရန် အသင့်"}`); }
      return tell(ctx, `⏱ ကျန်ရှိချိန်\\n\\n${lines.join("\\n") || "GP မရှိသေးပါ"}`, backButton());
    }
    if (text === "Join GP") {
      const list = await accounts(); if (!list.length) return tell(ctx, "⚠️ အရင်ဆုံး Add ACC လုပ်ပါ။", backButton());
      return tell(ctx, "Account ရွေးချယ်ပါ။", Markup.inlineKeyboard([...list.map((a, i) => [Markup.button.callback(`Join Acc${i + 1} GP`, `join:choose:${i}`)]), [Markup.button.callback("Back", "menu:main")]]));
    }
    if (text === "Msg") {
      const list = await accounts();
      return tell(ctx, "Message ပြင်မည့် account ကို ရွေးပါ။", Markup.inlineKeyboard([[Markup.button.callback("Global Msg", "msg:global")], ...list.map((a, i) => [Markup.button.callback(`Edit Acc${i + 1} Msg`, `msg:acc:${i}`)]), [Markup.button.callback("Back", "menu:main")]]));
    }
    if (text === "Send") return tell(ctx, "အားလုံးပို့ရန် `/send all`\\nAccount တစ်ခုတည်းပို့ရန် `/send acc1` ဟု ရိုက်ပါ။\\nGP တစ်ခုချင်း 6 seconds ခြားပြီး ပို့မည်။", backButton());
    if (text === "Stop") {
      const now = Date.now(); stopPresses = now - lastStopAt < 10000 ? stopPresses + 1 : 1; lastStopAt = now;
      if (job) stopRequested = true;
      if (repeatTimer) { clearTimeout(repeatTimer); repeatTimer = null; }
      if (stopPresses >= 2) { cooldownUntil = now + STOP_COOLDOWN_MS; stopPresses = 0; return tell(ctx, "⏹️ Stop လုပ်ပြီးပါပြီ။ 20 မိနစ် cooldown ထားထားသည်။", backButton()); }
      return tell(ctx, "⏹️ Stop တောင်းဆိုပြီးပါပြီ။ ထပ်မံနှိပ်လျှင် 20 မိနစ် cooldown ထားမည်။", backButton());
    }
    return;
  }
  if (s.type === "add_session" || s.type === "replace_session") return receiveSession(ctx, text);
  if (s.type === "join_links") { clearState(); const links = parseLinks(text); if (!links.length) return tell(ctx, "⚠️ GP link မတွေ့ပါ။", cancelButton()); tell(ctx, `🚀 ${s.name} join စတင်မည် — GP ${links.length} ခု`); return runJoin(s.name, links); }
  if (s.type === "global_msg") { await saveSettings({ globalMsg: text }); clearState(); return tell(ctx, "✅ Global message သိမ်းပြီးပါပြီ။", mainMenu()); }
  if (s.type === "acc_msg") { await saveAccount(s.name, { customMsg: text }); clearState(); return tell(ctx, `✅ ${s.name} message သိမ်းပြီးပါပြီ။`, mainMenu()); }
});

require("http").createServer((_, res) => { res.writeHead(200); res.end("GP Bot OK"); }).listen(PORT, () => console.log(`HTTP health server listening on ${PORT}`));
(async () => {
  console.log("[startup] connecting to MongoDB...");
  await connectDB();
  console.log("[startup] MongoDB connected; checking Telegram token...");
  const me = await bot.telegram.getMe();
  console.log(`[startup] Telegram bot @${me.username} ready; ADMIN_IDS=${ADMIN_IDS.join(",")}`);
  await migrateLegacyAccountData();
  const s = await settings();
  await loadClients();
  if (s.schedulerOn) { scheduledNames = (await accounts()).map(a => a.name); runSend(scheduledNames); }
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  await bot.launch({ dropPendingUpdates: true });
  console.log("[startup] long polling started; waiting for updates");
  await bot.telegram.sendMessage(ADMIN_ID, "✅ Button GP Bot အသင့်ဖြစ်ပြီ။ /start နိပ်ပါ");
})().catch(err => { console.error("[startup] FAILED:", err.stack || err.message); process.exitCode = 1; });
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
