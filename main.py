import os
import asyncio
import requests
import threading
import logging
from flask import Flask
from telethon import TelegramClient, events, errors
from telethon.sessions import StringSession
from pymongo import MongoClient
from datetime import datetime, timezone

# --- CONFIGURATION ---
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)
# Render Env ထဲမှာ API_ID နဲ့ API_HASH ကို သေချာပေါက် ထည့်ပေးရပါမယ်
API_ID = os.getenv("API_ID")
API_HASH = os.getenv("API_HASH")
BOT_TOKEN = os.getenv("BOT_TOKEN")
# Use ADMIN_IDS for multiple admins; ADMIN_ID remains supported for compatibility.
ADMIN_IDS_RAW = os.getenv("ADMIN_IDS", os.getenv("ADMIN_ID", "")).strip()
MONGODB_URI = os.getenv("MONGODB_URI")
MONGODB_DB = os.getenv("MONGODB_DB", "telegram_sessions")
MONGODB_COLLECTION = os.getenv("MONGODB_COLLECTION", "sessions")

# Admin IDs ကို numeric Telegram user IDs အဖြစ်ပြောင်းခြင်း။
# ဥပမာ ADMIN_IDS=123456789,987654321
try:
    ADMIN_IDS = {int(value.strip()) for value in ADMIN_IDS_RAW.split(",") if value.strip()}
except ValueError:
    raise ValueError("ADMIN_IDS must contain numeric Telegram user IDs separated by commas")

logger.info("Configuration loaded; ADMIN_IDS=%s, API_ID configured=%s, BOT_TOKEN configured=%s", sorted(ADMIN_IDS), bool(API_ID), bool(BOT_TOKEN))

# --- MONGODB ---
# Session strings are highly sensitive. Keep MONGODB_URI private in Render.
mongo_collection = None
if MONGODB_URI:
    try:
        mongo_client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        mongo_client.admin.command("ping")
        mongo_collection = mongo_client[MONGODB_DB][MONGODB_COLLECTION]
        print("MongoDB connected")
    except Exception as e:
        print(f"MongoDB connection failed: {e}")
else:
    print("Warning: MONGODB_URI is not configured; sessions will not be saved.")

def save_session(session_string, phone, admin_id):
    if mongo_collection is None:
        return False
    mongo_collection.insert_one({
        "session_string": session_string,
        "phone": phone,
        "admin_id": admin_id,
        "created_at": datetime.now(timezone.utc)
    })
    return True

# --- FLASK WEB SERVER ---
app = Flask(__name__)

@app.route('/')
def home():
    return "Bot is running 24/7!"

def run_flask():
    port = int(os.getenv("PORT", 8080))
    app.run(host='0.0.0.0', port=port)

# --- SELF-PING SYSTEM ---
async def keep_alive():
    url = os.getenv("RENDER_EXTERNAL_URL")
    if not url:
        return
    
    while True:
        try:
            await asyncio.sleep(240)
            requests.get(url)
        except:
            pass

# --- TELEGRAM BOT ---
bot = TelegramClient('bot_session', int(API_ID) if API_ID else 0, API_HASH).start(bot_token=BOT_TOKEN)

user_states = {}

def is_admin(event):
    allowed = event.sender_id in ADMIN_IDS
    if not allowed:
        logger.warning("Ignored message from sender_id=%s; configured ADMIN_IDS=%s; text=%r", event.sender_id, sorted(ADMIN_IDS), event.raw_text[:80])
    return allowed

@bot.on(events.NewMessage(pattern=r'^/myid(?:@\w+)?(?:\s.*)?$'))
async def my_id(event):
    await event.respond(f"သင့် Telegram numeric ID: `{event.sender_id}`")

@bot.on(events.NewMessage(pattern=r'^/start(?:@\w+)?(?:\s.*)?$'))
async def start(event):
    if not is_admin(event):
        return
    await event.respond("မင်္ဂလာပါ Admin! Session String ထုတ်ဖို့အတွက် /generate ကို နှိပ်ပါ။")

@bot.on(events.NewMessage(pattern=r'^/generate(?:@\w+)?(?:\s.*)?$'))
async def generate_session(event):
    if not is_admin(event):
        return
    
    # Error checking for API credentials
    if not API_ID or not API_HASH:
        await event.respond("Error: API_ID သို့မဟုတ် API_HASH ကို Environment Variables မှာ မတွေ့ပါ။")
        return

    user_states[event.sender_id] = {'step': 'phone'}
    await event.respond("Session ထုတ်မယ့် အကောင့်ရဲ့ ဖုန်းနံပါတ်ကို +95 ပုံစံဖြင့် ရိုက်ထည့်ပေးပါ။")

@bot.on(events.NewMessage)
async def handle_steps(event):
    if not is_admin(event) or event.sender_id not in user_states:
        return
    
    state = user_states[event.sender_id]
    text = event.text.strip()

    if text.startswith('/'): return # Ignore other commands

    if state['step'] == 'phone':
        state['phone'] = text
        state['step'] = 'otp_request'
        
        # New client for the user
        temp_client = TelegramClient(StringSession(), int(API_ID), API_HASH)
        await temp_client.connect()
        
        try:
            # အရေးကြီးချက်: phone number ကို ပို့ပေးခြင်း
            sent_code = await temp_client.send_code_request(text)
            state['client'] = temp_client
            state['phone_code_hash'] = sent_code.phone_code_hash
            state['step'] = 'otp'
            await event.respond("Telegram မှ ပို့ပေးလိုက်သော OTP Code ကို ရိုက်ထည့်ပေးပါ။")
        except Exception as e:
            await event.respond(f"Error: {str(e)}\nပြန်စရန် /generate ကို နှိပ်ပါ။")
            await temp_client.disconnect()
            del user_states[event.sender_id]

    elif state['step'] == 'otp':
        temp_client = state['client']
        try:
            await temp_client.sign_in(state['phone'], text, phone_code_hash=state['phone_code_hash'])
            session_str = temp_client.session.save()
            save_session(session_str, state['phone'], event.sender_id)
            await event.respond(f"✅ Success! Session String:\n\n`{session_str}`")
            await temp_client.disconnect()
            del user_states[event.sender_id]
        except errors.SessionPasswordNeededError:
            state['step'] = 'password'
            await event.respond("2-Step Verification Password ကို ရိုက်ထည့်ပေးပါ။")
        except Exception as e:
            await event.respond(f"Error: {str(e)}\nပြန်စရန် /generate ကို နှိပ်ပါ။")
            await temp_client.disconnect()
            del user_states[event.sender_id]

    elif state['step'] == 'password':
        temp_client = state['client']
        try:
            await temp_client.sign_in(password=text)
            session_str = temp_client.session.save()
            save_session(session_str, state['phone'], event.sender_id)
            await event.respond(f"✅ Success! Session String:\n\n`{session_str}`")
            await temp_client.disconnect()
            del user_states[event.sender_id]
        except Exception as e:
            await event.respond(f"Error: {str(e)}")
            await temp_client.disconnect()
            del user_states[event.sender_id]

if __name__ == "__main__":
    threading.Thread(target=run_flask, daemon=True).start()
    loop = asyncio.get_event_loop()
    loop.create_task(keep_alive())
    bot.run_until_disconnected()
