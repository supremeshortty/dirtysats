"""
Telegram Bot Setup Helper - Streamlined configuration for DirtySats alerts

This utility helps users:
1. Create a bot with BotFather
2. Get their Chat ID
3. Validate the configuration
4. Test the connection
5. Import and apply configuration
"""
import requests
import logging
from typing import Dict, Optional, Tuple
from datetime import datetime

logger = logging.getLogger(__name__)


class TelegramSetupHelper:
    """Helper for setting up Telegram bot alerting"""

    TELEGRAM_BOT_API = "https://api.telegram.org"

    def __init__(self, db=None):
        self.db = db

    @staticmethod
    def validate_bot_token(token: str) -> Tuple[bool, str]:
        """
        Validate a bot token by checking with Telegram API.

        Returns:
            (is_valid, message)
        """
        try:
            url = f"{TelegramSetupHelper.TELEGRAM_BOT_API}/bot{token}/getMe"
            response = requests.get(url, timeout=5)

            if response.status_code == 200:
                data = response.json()
                if data.get('ok'):
                    bot_info = data.get('result', {})
                    bot_name = bot_info.get('first_name', 'Unknown')
                    bot_username = bot_info.get('username', 'unknown')
                    return True, f"✅ Valid bot token! Bot: @{bot_username} ({bot_name})"
                else:
                    return False, "❌ Invalid bot token (API rejected)"
            else:
                return False, f"❌ API error: HTTP {response.status_code}"

        except requests.exceptions.Timeout:
            return False, "❌ Timeout connecting to Telegram API (check internet)"
        except Exception as e:
            return False, f"❌ Error validating token: {str(e)}"

    @staticmethod
    def validate_chat_id(bot_token: str, chat_id: str) -> Tuple[bool, str]:
        """
        Validate a chat ID by sending a test message.

        Returns:
            (is_valid, message)
        """
        try:
            url = f"{TelegramSetupHelper.TELEGRAM_BOT_API}/bot{bot_token}/sendMessage"
            payload = {
                "chat_id": chat_id,
                "text": "🧪 *Test Message*\n\nIf you see this, your Telegram configuration is working!",
                "parse_mode": "Markdown"
            }

            response = requests.post(url, json=payload, timeout=10)

            if response.status_code == 200:
                data = response.json()
                if data.get('ok'):
                    return True, "✅ Chat ID is valid! Test message sent."
                else:
                    error = data.get('description', 'Unknown error')
                    if "chat not found" in error.lower() or "user is deleted" in error.lower():
                        return False, f"❌ Chat ID not found. Make sure you've started the bot first."
                    else:
                        return False, f"❌ Telegram error: {error}"
            else:
                return False, f"❌ API error: HTTP {response.status_code}"

        except requests.exceptions.Timeout:
            return False, "❌ Timeout (check internet connection)"
        except Exception as e:
            return False, f"❌ Error: {str(e)}"

    @staticmethod
    def get_setup_instructions() -> str:
        """Get formatted setup instructions"""
        return """
╔════════════════════════════════════════════════════════════════╗
║             TELEGRAM BOT SETUP INSTRUCTIONS                     ║
╚════════════════════════════════════════════════════════════════╝

📱 STEP 1: Create Your Bot
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Open Telegram and search for @BotFather
2. Send /newbot command
3. Choose a name (e.g., "DirtySats Mining Bot")
4. Choose a username (e.g., "dirtysats_mining_bot")
5. 📋 COPY THE TOKEN - looks like:
   1234567890:ABCdefGHIjklMNOpqrsTUVwxyz

💬 STEP 2: Get Your Chat ID
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Option A - Using Your New Bot (Recommended):
  1. Send ANY message to your new bot (e.g., "hello")
  2. Get Chat ID using URL:
     https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates
  3. Look for "chat":{"id":123456789}
  4. 📋 COPY THE ID

Option B - Using @userinfobot:
  1. Search @userinfobot on Telegram
  2. Send /start
  3. Reply shows your User ID
  4. For groups: Add bot to group, send message, use URL method

⚙️ STEP 3: Configure in DirtySats
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Open DirtySats dashboard: http://your-pi:5001
2. Go to Alerts tab
3. Scroll to Telegram Configuration section
4. Paste:
   - Bot Token (from Step 1)
   - Chat ID (from Step 2)
5. Click "Save Configuration"
6. Click "Send Test Alert"
7. ✅ You should receive a test message in Telegram

🧪 STEP 4: Verify It Works
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Dashboard will show:
  ✅ Bot Token Status (green checkmark)
  ✅ Chat ID Status (green checkmark)
  ✅ Last Test (shows timestamp)

📊 YOU'LL NOW RECEIVE ALERTS FOR:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  📴 Miner offline / back online
  🌡️ High temperature warnings
  🔴 Critical temperature (emergency)
  📉 Low hashrate detected
  💰 Unprofitable mining periods
  🌊 Weather warnings (if enabled)
  🔧 Frequency adjustments
  ⚡ Power events

🔒 SECURITY NOTES:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Token is stored locally in your database (not in cloud)
• Communication is HTTPS directly with Telegram
• Your mining data never leaves your network
• Keep token private - don't share it publicly

🆘 TROUBLESHOOTING:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Problem: "Failed to send Telegram alert"
  → Check bot token is correct
  → Verify Chat ID is positive number
  → Make sure you started the bot first

Problem: "Chat not found"
  → Send any message to your bot first (e.g., /start)
  → Verify Chat ID in getUpdates response

Problem: Bot not responding
  → Check internet connection
  → Verify token hasn't expired
  → Try sending message to bot manually

═══════════════════════════════════════════════════════════════════
Questions? Check: https://core.telegram.org/bots/faq
═══════════════════════════════════════════════════════════════════
"""

    @staticmethod
    def get_quick_reference() -> str:
        """Quick reference card for common tasks"""
        return """
╔════════════════════════════════════════════════════════════════╗
║                   TELEGRAM QUICK REFERENCE                      ║
╚════════════════════════════════════════════════════════════════╝

🤖 BOTS:
  @BotFather          - Create/manage your bot
  @userinfobot        - Get your user/chat ID
  @userinfobot        - Group admin info

📍 URLS TO BOOKMARK:
  Bot Token Test:
    https://api.telegram.org/botYOUR_TOKEN/getMe

  Get Chat ID:
    https://api.telegram.org/botYOUR_TOKEN/getUpdates

  Send Message (manual):
    https://api.telegram.org/botYOUR_TOKEN/sendMessage
      ?chat_id=YOUR_CHAT_ID
      &text=Hello

⚡ CHAT ID FORMATS:
  Personal: 123456789 (positive number)
  Group:    -123456789 (negative number)
  Supergroup: -100123456789 (negative, longer)

🔑 HOW TO GET BOT TOKEN:
  1. Chat @BotFather
  2. /newbot
  3. Answer 2 questions
  4. Token appears ← SAVE THIS

🔑 HOW TO GET CHAT ID:
  1. Start your bot (send /start or "hello")
  2. Use getUpdates URL (see above)
  3. Find: "chat":{"id":123456789}
  4. 123456789 is your Chat ID

✅ TEST YOUR SETUP:
  1. Token valid? → https://api.telegram.org/botTOKEN/getMe
  2. Chat ID works? → Use sendMessage URL above
  3. Both green? → Configure in DirtySats dashboard

═══════════════════════════════════════════════════════════════════
"""

    def get_current_config(self) -> Dict:
        """Get current Telegram configuration from database"""
        if not self.db:
            return {"error": "Database not initialized"}

        try:
            with self.db._get_connection(readonly=True) as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT key, value FROM settings WHERE key LIKE 'telegram_%'")
                result = cursor.fetchall()

            config = {}
            for row in result:
                config[row[0]] = row[1]

            return {
                "configured": bool(config.get("telegram_bot_token")),
                "config": config
            }
        except Exception as e:
            logger.error(f"Error retrieving config: {e}")
            return {"error": str(e)}

    def save_config(self, bot_token: str, chat_id: str) -> Tuple[bool, str]:
        """
        Save Telegram configuration to database.

        Returns:
            (success, message)
        """
        if not self.db:
            return False, "Database not initialized"

        try:
            # Validate inputs
            if not bot_token or len(bot_token) < 10:
                return False, "Invalid bot token format"

            if not str(chat_id):
                return False, "Chat ID required"

            # Validate with API
            is_valid, msg = self.validate_bot_token(bot_token)
            if not is_valid:
                return False, msg

            # Store in database
            with self.db._get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                    ("telegram_bot_token", bot_token)
                )
                cursor.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                    ("telegram_chat_id", str(chat_id))
                )
                cursor.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                    ("telegram_enabled", "true")
                )
                cursor.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                    ("telegram_config_timestamp", datetime.utcnow().isoformat())
                )

            logger.info("Telegram configuration saved successfully")
            return True, "✅ Configuration saved and validated!"

        except Exception as e:
            logger.error(f"Error saving config: {e}")
            return False, f"Error saving configuration: {str(e)}"

    def get_status_report(self, bot_token: str, chat_id: str) -> Dict:
        """
        Get detailed status report of Telegram setup.

        Returns full status with all checks
        """
        token_valid, token_msg = self.validate_bot_token(bot_token)
        chat_valid, chat_msg = self.validate_chat_id(bot_token, chat_id)

        return {
            "timestamp": datetime.utcnow().isoformat(),
            "bot_token": {
                "valid": token_valid,
                "message": token_msg,
                "status": "✅" if token_valid else "❌"
            },
            "chat_id": {
                "valid": chat_valid,
                "message": chat_msg,
                "status": "✅" if chat_valid else "❌"
            },
            "overall_status": "READY" if (token_valid and chat_valid) else "INCOMPLETE",
            "next_steps": self._get_next_steps(token_valid, chat_valid),
            "help": "Run: python -m telegram_setup_helper --help"
        }

    @staticmethod
    def _get_next_steps(token_valid: bool, chat_valid: bool) -> list:
        """Get next steps based on validation results"""
        steps = []

        if not token_valid:
            steps.append("1️⃣ Get valid bot token from @BotFather")

        if token_valid and not chat_valid:
            steps.append("2️⃣ Get your Chat ID (send message to bot, use getUpdates)")

        if token_valid and chat_valid:
            steps.append("✅ Save configuration in DirtySats dashboard")
            steps.append("🧪 Send test alert to verify")
            steps.append("📊 Start receiving mining alerts!")

        return steps


# CLI Interface for standalone use
if __name__ == "__main__":
    import sys
    import argparse

    parser = argparse.ArgumentParser(
        description="DirtySats Telegram Setup Helper",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python telegram_setup_helper.py --setup
  python telegram_setup_helper.py --validate-token YOUR_TOKEN
  python telegram_setup_helper.py --validate-chatid TOKEN CHATID
  python telegram_setup_helper.py --help
        """
    )

    parser.add_argument('--setup', action='store_true',
                        help='Show full setup instructions')
    parser.add_argument('--quick', action='store_true',
                        help='Show quick reference')
    parser.add_argument('--validate-token', metavar='TOKEN',
                        help='Validate a bot token')
    parser.add_argument('--validate-chatid', nargs=2, metavar=('TOKEN', 'CHATID'),
                        help='Validate token and chat ID together')

    args = parser.parse_args()

    helper = TelegramSetupHelper()

    if args.setup:
        print(helper.get_setup_instructions())

    elif args.quick:
        print(helper.get_quick_reference())

    elif args.validate_token:
        is_valid, msg = helper.validate_bot_token(args.validate_token)
        print(f"\n{msg}\n")
        sys.exit(0 if is_valid else 1)

    elif args.validate_chatid:
        token, chat_id = args.validate_chatid
        print("\n🔍 Running validation checks...\n")
        report = helper.get_status_report(token, chat_id)

        print(f"Bot Token:  {report['bot_token']['status']} {report['bot_token']['message']}")
        print(f"Chat ID:    {report['chat_id']['status']} {report['chat_id']['message']}")
        print(f"\nStatus: {report['overall_status']}")

        if report['next_steps']:
            print("\nNext steps:")
            for step in report['next_steps']:
                print(f"  {step}")
        print()

    else:
        parser.print_help()
