# Telegram Bot Setup Guide

Get instant mining fleet alerts on your phone with Telegram! 📱

## 🤖 Step 1: Create Your Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` command
3. Choose a name (e.g., "My Mining Fleet")
4. Choose a username (e.g., "my_mining_fleet_bot")
5. **Save the bot token** - looks like: `1234567890:ABCdefGHIjklMNOpqrsTUVwxyz`

## 💬 Step 2: Get Your Chat ID

**Method 1: Using the Bot**
1. Send any message to your new bot (e.g., "hello")
2. Open this URL in your browser (replace `YOUR_BOT_TOKEN`):
   ```
   https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates
   ```
3. Look for `"chat":{"id":123456789}` - that's your Chat ID

**Method 2: Using @userinfobot**
1. Search for **@userinfobot** on Telegram
2. Send `/start`
3. It will reply with your ID

**For Group Chats:**
1. Add your bot to the group
2. Send a message in the group
3. Use the getUpdates URL method
4. Group IDs are negative (e.g., `-123456789`)

## ⚙️ Step 3: Configure in Dashboard

1. Open your mining dashboard: `http://raspberrypi.local:5001`
2. Go to **Alerts** tab
3. Scroll to **Telegram Bot** section
4. Enter your:
   - **Bot Token** (from Step 1)
   - **Chat ID** (from Step 2)
5. Click **Save Telegram Config**
6. Click **Test Telegram** to verify it works!

## 📊 What Alerts You'll Get

You'll automatically receive Telegram messages for:

- 🔴 **Emergency Shutdowns** - Critical temperature reached
- ⚠️ **High Temperature Warnings** - Miner getting too hot
- 📴 **Miner Offline** - Miner stopped responding
- ✅ **Miner Back Online** - Miner recovered
- 🔧 **Frequency Adjustments** - Auto-tuning changes
- 🌡️ **Heat Wave Warnings** - Weather predictions
- 📉 **Low Hashrate** - Performance drops
- 💰 **Unprofitable Mining** - Mining costs exceed earnings (if enabled)

## 🎨 Message Format

Telegram alerts include:
- **Emoji indicators** based on severity (ℹ️ ⚠️ 🚨 🔴)
- **Bold titles** for quick scanning
- **Miner IP address** in monospace font
- **Detailed metrics** (temperature, hashrate, frequency)
- **Timestamp** for each alert
- **Markdown formatting** for easy reading

### Example Alert:
```
🚨 High Temperature Warning

Miner 10.0.0.100 reached 70.5°C

🖥️ Miner: 10.0.0.100

📊 Details:
• Temperature: 70.5°C
• Warning Threshold: 68.0°C
• Hashrate: 500.0 GH/s
• Frequency: 525 MHz

🕐 2025-10-30 15:30:45
```

## 🔕 Alert Cooldown

- Alerts have a **15-minute cooldown** to prevent spam
- You won't get the same alert twice within 15 minutes
- Critical/emergency alerts always go through

## 🔒 Privacy & Security

- Your bot token is stored securely in the local database
- All communication is direct Telegram Bot API (HTTPS)
- No third-party services involved
- Your mining data never leaves your network

## 🛠️ Troubleshooting

**"Failed to send Telegram alert"**
- Check your bot token is correct
- Verify your chat ID (positive for personal, negative for groups)
- Make sure you've started the bot (send any message to it first)

**Bot not responding to test**
- Refresh your browser
- Check Raspberry Pi internet connection
- Verify bot token hasn't expired

**Alerts not arriving**
- Check bot isn't muted in Telegram
- Verify you're monitoring the correct chat
- Check dashboard logs for errors

## 🚀 Pro Tips

1. **Use a Group Chat** - Add family/team members to get alerts together
2. **Multiple Bots** - Create separate bots for different mining locations
3. **Silent Notifications** - Mute info-level alerts, keep critical ones
4. **Forward to Channel** - Create a Telegram channel for mining logs
5. **Bot Commands** - (Future feature: send commands back to miners)

## 📱 Mobile Experience

Telegram alerts work perfectly on:
- iPhone/iPad (iOS app)
- Android phones/tablets
- Desktop (Windows/Mac/Linux)
- Web browser

---

**Need help?** Check the bot setup in your dashboard or visit https://core.telegram.org/bots
