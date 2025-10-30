"""
Alert System Module

Multi-channel alerting for critical mining events:
- Email notifications
- SMS via Twilio
- Webhook/Discord/Slack integration
- Configurable alert rules
"""
import logging
import smtplib
import requests
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime, timedelta
from typing import Dict, List, Optional
from enum import Enum

logger = logging.getLogger(__name__)


class AlertLevel(Enum):
    """Alert severity levels"""
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"
    EMERGENCY = "emergency"


class AlertType(Enum):
    """Types of alerts"""
    MINER_OFFLINE = "miner_offline"
    HIGH_TEMPERATURE = "high_temperature"
    CRITICAL_TEMPERATURE = "critical_temperature"
    LOW_HASHRATE = "low_hashrate"
    UNPROFITABLE = "unprofitable"
    EMERGENCY_SHUTDOWN = "emergency_shutdown"
    MINER_ONLINE = "miner_online"
    WEATHER_WARNING = "weather_warning"


class AlertConfig:
    """Alert configuration"""
    def __init__(self):
        # Email settings
        self.email_enabled = False
        self.smtp_server = ""
        self.smtp_port = 587
        self.smtp_username = ""
        self.smtp_password = ""
        self.email_from = ""
        self.email_to = []

        # SMS settings (Twilio)
        self.sms_enabled = False
        self.twilio_account_sid = ""
        self.twilio_auth_token = ""
        self.twilio_from_number = ""
        self.sms_to_numbers = []

        # Webhook settings
        self.webhook_enabled = False
        self.webhook_urls = []

        # Discord webhook
        self.discord_enabled = False
        self.discord_webhook_url = ""

        # Slack webhook
        self.slack_enabled = False
        self.slack_webhook_url = ""

        # Telegram
        self.telegram_enabled = False
        self.telegram_bot_token = ""
        self.telegram_chat_id = ""

        # Alert rules
        self.alert_cooldown = timedelta(minutes=15)  # Min time between same alert
        self.alert_on_offline = True
        self.alert_on_high_temp = True
        self.alert_on_critical_temp = True
        self.alert_on_low_hashrate = True
        self.alert_on_unprofitable = False
        self.alert_on_emergency_shutdown = True
        self.alert_on_miner_online = False

        # Thresholds
        self.high_temp_threshold = 70.0  # °C
        self.low_hashrate_threshold_pct = 20.0  # % below expected


class Alert:
    """Represents a single alert"""
    def __init__(self, alert_type: AlertType, level: AlertLevel,
                 title: str, message: str, miner_ip: str = None,
                 data: Dict = None):
        self.alert_type = alert_type
        self.level = level
        self.title = title
        self.message = message
        self.miner_ip = miner_ip
        self.data = data or {}
        self.timestamp = datetime.now()

    def to_dict(self):
        """Convert to dictionary"""
        return {
            'alert_type': self.alert_type.value,
            'level': self.level.value,
            'title': self.title,
            'message': self.message,
            'miner_ip': self.miner_ip,
            'data': self.data,
            'timestamp': self.timestamp.isoformat()
        }


class AlertManager:
    """Manage and dispatch alerts across multiple channels"""

    def __init__(self, db):
        self.db = db
        self.config = AlertConfig()
        self.alert_history = []
        self.last_alerts = {}  # Track last alert time per type/miner

    def configure(self, config_dict: Dict):
        """Configure alert settings from dictionary"""
        # Email
        if 'email' in config_dict:
            email = config_dict['email']
            self.config.email_enabled = email.get('enabled', False)
            self.config.smtp_server = email.get('smtp_server', '')
            self.config.smtp_port = email.get('smtp_port', 587)
            self.config.smtp_username = email.get('username', '')
            self.config.smtp_password = email.get('password', '')
            self.config.email_from = email.get('from', '')
            self.config.email_to = email.get('to', [])

        # SMS
        if 'sms' in config_dict:
            sms = config_dict['sms']
            self.config.sms_enabled = sms.get('enabled', False)
            self.config.twilio_account_sid = sms.get('account_sid', '')
            self.config.twilio_auth_token = sms.get('auth_token', '')
            self.config.twilio_from_number = sms.get('from_number', '')
            self.config.sms_to_numbers = sms.get('to_numbers', [])

        # Webhooks
        if 'webhook' in config_dict:
            webhook = config_dict['webhook']
            self.config.webhook_enabled = webhook.get('enabled', False)
            self.config.webhook_urls = webhook.get('urls', [])

        # Discord
        if 'discord' in config_dict:
            discord = config_dict['discord']
            self.config.discord_enabled = discord.get('enabled', False)
            self.config.discord_webhook_url = discord.get('webhook_url', '')

        # Slack
        if 'slack' in config_dict:
            slack = config_dict['slack']
            self.config.slack_enabled = slack.get('enabled', False)
            self.config.slack_webhook_url = slack.get('webhook_url', '')

        # Telegram
        if 'telegram' in config_dict:
            telegram = config_dict['telegram']
            self.config.telegram_enabled = telegram.get('enabled', False)
            self.config.telegram_bot_token = telegram.get('bot_token', '')
            self.config.telegram_chat_id = telegram.get('chat_id', '')

        logger.info("Alert configuration updated")

    def should_send_alert(self, alert: Alert) -> bool:
        """Check if alert should be sent (cooldown check)"""
        # Create unique key for this alert type + miner
        key = f"{alert.alert_type.value}:{alert.miner_ip or 'global'}"

        # Check if we've sent this alert recently
        if key in self.last_alerts:
            last_time = self.last_alerts[key]
            if datetime.now() - last_time < self.config.alert_cooldown:
                logger.debug(f"Alert {key} in cooldown, skipping")
                return False

        return True

    def send_alert(self, alert: Alert):
        """Send alert through all configured channels"""
        # Check cooldown
        if not self.should_send_alert(alert):
            return

        # Record alert in database
        import json
        self.db.add_alert_to_history(
            alert_type=alert.alert_type.value,
            level=alert.level.value,
            title=alert.title,
            message=alert.message,
            data_json=json.dumps(alert.data) if alert.data else None
        )

        # Also keep in memory for quick access
        self.alert_history.append(alert)
        key = f"{alert.alert_type.value}:{alert.miner_ip or 'global'}"
        self.last_alerts[key] = datetime.now()

        # Send through each enabled channel
        success_count = 0

        if self.config.email_enabled:
            if self._send_email(alert):
                success_count += 1

        if self.config.sms_enabled:
            if self._send_sms(alert):
                success_count += 1

        if self.config.webhook_enabled:
            if self._send_webhook(alert):
                success_count += 1

        if self.config.discord_enabled:
            if self._send_discord(alert):
                success_count += 1

        if self.config.slack_enabled:
            if self._send_slack(alert):
                success_count += 1

        if self.config.telegram_enabled:
            if self._send_telegram(alert):
                success_count += 1

        logger.info(f"Alert sent via {success_count} channel(s): {alert.title}")

    def _send_email(self, alert: Alert) -> bool:
        """Send email alert"""
        try:
            msg = MIMEMultipart('alternative')
            msg['Subject'] = f"[{alert.level.value.upper()}] {alert.title}"
            msg['From'] = self.config.email_from
            msg['To'] = ', '.join(self.config.email_to)

            # Create email body
            text = f"{alert.message}\n\n"
            text += f"Time: {alert.timestamp.strftime('%Y-%m-%d %H:%M:%S')}\n"
            if alert.miner_ip:
                text += f"Miner: {alert.miner_ip}\n"
            if alert.data:
                text += f"\nDetails:\n"
                for key, value in alert.data.items():
                    text += f"  {key}: {value}\n"

            msg.attach(MIMEText(text, 'plain'))

            # Send email
            with smtplib.SMTP(self.config.smtp_server, self.config.smtp_port) as server:
                server.starttls()
                server.login(self.config.smtp_username, self.config.smtp_password)
                server.send_message(msg)

            logger.info(f"Email alert sent: {alert.title}")
            return True

        except Exception as e:
            logger.error(f"Failed to send email alert: {e}")
            return False

    def _send_sms(self, alert: Alert) -> bool:
        """Send SMS alert via Twilio"""
        try:
            from twilio.rest import Client

            client = Client(
                self.config.twilio_account_sid,
                self.config.twilio_auth_token
            )

            # Create SMS message
            message_text = f"[{alert.level.value.upper()}] {alert.title}\n{alert.message}"
            if alert.miner_ip:
                message_text += f"\nMiner: {alert.miner_ip}"

            # Send to all configured numbers
            for to_number in self.config.sms_to_numbers:
                client.messages.create(
                    body=message_text,
                    from_=self.config.twilio_from_number,
                    to=to_number
                )

            logger.info(f"SMS alert sent: {alert.title}")
            return True

        except ImportError:
            logger.error("Twilio library not installed. Run: pip install twilio")
            return False
        except Exception as e:
            logger.error(f"Failed to send SMS alert: {e}")
            return False

    def _send_webhook(self, alert: Alert) -> bool:
        """Send webhook alert"""
        try:
            payload = alert.to_dict()

            for url in self.config.webhook_urls:
                response = requests.post(
                    url,
                    json=payload,
                    timeout=10
                )
                response.raise_for_status()

            logger.info(f"Webhook alert sent: {alert.title}")
            return True

        except Exception as e:
            logger.error(f"Failed to send webhook alert: {e}")
            return False

    def _send_discord(self, alert: Alert) -> bool:
        """Send Discord webhook alert"""
        try:
            # Discord webhook format
            color_map = {
                AlertLevel.INFO: 3447003,      # Blue
                AlertLevel.WARNING: 16776960,  # Yellow
                AlertLevel.CRITICAL: 16711680, # Red
                AlertLevel.EMERGENCY: 10038562 # Dark red
            }

            embed = {
                "title": alert.title,
                "description": alert.message,
                "color": color_map.get(alert.level, 3447003),
                "timestamp": alert.timestamp.isoformat(),
                "fields": []
            }

            if alert.miner_ip:
                embed["fields"].append({
                    "name": "Miner",
                    "value": alert.miner_ip,
                    "inline": True
                })

            for key, value in alert.data.items():
                embed["fields"].append({
                    "name": key,
                    "value": str(value),
                    "inline": True
                })

            payload = {"embeds": [embed]}

            response = requests.post(
                self.config.discord_webhook_url,
                json=payload,
                timeout=10
            )
            response.raise_for_status()

            logger.info(f"Discord alert sent: {alert.title}")
            return True

        except Exception as e:
            logger.error(f"Failed to send Discord alert: {e}")
            return False

    def _send_slack(self, alert: Alert) -> bool:
        """Send Slack webhook alert"""
        try:
            # Slack webhook format
            color_map = {
                AlertLevel.INFO: "good",
                AlertLevel.WARNING: "warning",
                AlertLevel.CRITICAL: "danger",
                AlertLevel.EMERGENCY: "danger"
            }

            fields = []
            if alert.miner_ip:
                fields.append({
                    "title": "Miner",
                    "value": alert.miner_ip,
                    "short": True
                })

            for key, value in alert.data.items():
                fields.append({
                    "title": key,
                    "value": str(value),
                    "short": True
                })

            payload = {
                "attachments": [{
                    "color": color_map.get(alert.level, "good"),
                    "title": alert.title,
                    "text": alert.message,
                    "fields": fields,
                    "ts": int(alert.timestamp.timestamp())
                }]
            }

            response = requests.post(
                self.config.slack_webhook_url,
                json=payload,
                timeout=10
            )
            response.raise_for_status()

            logger.info(f"Slack alert sent: {alert.title}")
            return True

        except Exception as e:
            logger.error(f"Failed to send Slack alert: {e}")
            return False

    def _send_telegram(self, alert: Alert) -> bool:
        """Send Telegram bot alert"""
        try:
            # Emoji mapping for alert levels
            emoji_map = {
                AlertLevel.INFO: "ℹ️",
                AlertLevel.WARNING: "⚠️",
                AlertLevel.CRITICAL: "🚨",
                AlertLevel.EMERGENCY: "🔴"
            }

            # Build formatted message
            emoji = emoji_map.get(alert.level, "📢")
            message = f"{emoji} *{alert.title}*\n\n"
            message += f"{alert.message}\n\n"

            # Add miner info if present
            if alert.miner_ip:
                message += f"🖥️ *Miner:* `{alert.miner_ip}`\n"

            # Add alert data
            if alert.data:
                message += "\n📊 *Details:*\n"
                for key, value in alert.data.items():
                    # Format key nicely (capitalize, replace underscores)
                    formatted_key = key.replace('_', ' ').title()
                    message += f"• {formatted_key}: `{value}`\n"

            # Add timestamp
            timestamp = alert.timestamp.strftime('%Y-%m-%d %H:%M:%S')
            message += f"\n🕐 {timestamp}"

            # Send via Telegram Bot API
            url = f"https://api.telegram.org/bot{self.config.telegram_bot_token}/sendMessage"
            payload = {
                "chat_id": self.config.telegram_chat_id,
                "text": message,
                "parse_mode": "Markdown"
            }

            response = requests.post(url, json=payload, timeout=10)
            response.raise_for_status()

            logger.info(f"Telegram alert sent: {alert.title}")
            return True

        except Exception as e:
            logger.error(f"Failed to send Telegram alert: {e}")
            return False

    def get_alert_history(self, hours: int = 24) -> List[Dict]:
        """Get alert history from database"""
        return self.db.get_alert_history(hours)

    # Convenience methods for creating common alerts

    def alert_miner_offline(self, miner_ip: str, miner_type: str):
        """Alert when miner goes offline"""
        if not self.config.alert_on_offline:
            return

        alert = Alert(
            alert_type=AlertType.MINER_OFFLINE,
            level=AlertLevel.WARNING,
            title=f"Miner Offline: {miner_ip}",
            message=f"{miner_type} miner at {miner_ip} has gone offline",
            miner_ip=miner_ip,
            data={'miner_type': miner_type}
        )
        self.send_alert(alert)

    def alert_high_temperature(self, miner_ip: str, temp: float, threshold: float):
        """Alert when temperature is high but not critical"""
        if not self.config.alert_on_high_temp:
            return

        alert = Alert(
            alert_type=AlertType.HIGH_TEMPERATURE,
            level=AlertLevel.WARNING,
            title=f"High Temperature: {miner_ip}",
            message=f"Miner temperature {temp:.1f}°C exceeds threshold {threshold:.1f}°C",
            miner_ip=miner_ip,
            data={
                'temperature': f"{temp:.1f}°C",
                'threshold': f"{threshold:.1f}°C"
            }
        )
        self.send_alert(alert)

    def alert_critical_temperature(self, miner_ip: str, temp: float, critical: float):
        """Alert when temperature reaches critical level"""
        if not self.config.alert_on_critical_temp:
            return

        alert = Alert(
            alert_type=AlertType.CRITICAL_TEMPERATURE,
            level=AlertLevel.CRITICAL,
            title=f"CRITICAL Temperature: {miner_ip}",
            message=f"Miner temperature {temp:.1f}°C has reached critical level {critical:.1f}°C",
            miner_ip=miner_ip,
            data={
                'temperature': f"{temp:.1f}°C",
                'critical_threshold': f"{critical:.1f}°C"
            }
        )
        self.send_alert(alert)

    def alert_emergency_shutdown(self, miner_ip: str, temp: float, reason: str):
        """Alert when emergency shutdown triggered"""
        if not self.config.alert_on_emergency_shutdown:
            return

        alert = Alert(
            alert_type=AlertType.EMERGENCY_SHUTDOWN,
            level=AlertLevel.EMERGENCY,
            title=f"EMERGENCY SHUTDOWN: {miner_ip}",
            message=f"Miner has been shut down: {reason}",
            miner_ip=miner_ip,
            data={
                'temperature': f"{temp:.1f}°C",
                'reason': reason
            }
        )
        self.send_alert(alert)

    def alert_weather_warning(self, location: str, forecast_high: float, message: str):
        """Alert about upcoming hot weather"""
        alert = Alert(
            alert_type=AlertType.WEATHER_WARNING,
            level=AlertLevel.INFO,
            title=f"Weather Alert: {location}",
            message=message,
            data={
                'location': location,
                'forecast_high': f"{forecast_high:.1f}°F"
            }
        )
        self.send_alert(alert)

    def alert_unprofitable(self, profit_per_day: float):
        """Alert when mining becomes unprofitable"""
        if not self.config.alert_on_unprofitable:
            return

        alert = Alert(
            alert_type=AlertType.UNPROFITABLE,
            level=AlertLevel.WARNING,
            title="Mining Unprofitable",
            message=f"Current profitability is negative: ${profit_per_day:.2f}/day",
            data={
                'profit_per_day': f"${profit_per_day:.2f}"
            }
        )
        self.send_alert(alert)
