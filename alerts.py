"""
Alert System Module

Telegram bot alerting for critical mining events.
"""
import logging
import requests
from datetime import datetime, timedelta
from typing import Dict, List, Optional
from enum import Enum

logger = logging.getLogger(__name__)


def format_hashrate(hashrate_ghs: float) -> str:
    """Format hashrate from GH/s to appropriate human-readable unit."""
    if abs(hashrate_ghs) >= 1e6:
        return f"{hashrate_ghs / 1e6:.2f} PH/s"
    elif abs(hashrate_ghs) >= 1e3:
        return f"{hashrate_ghs / 1e3:.2f} TH/s"
    else:
        return f"{hashrate_ghs:.2f} GH/s"


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
    OVERHEAT_RECOVERY = "overheat_recovery"


class AlertConfig:
    """Alert configuration"""
    def __init__(self):
        # Telegram settings
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

        # Per-type enable/disable (extended)
        self.enabled_alert_types = {
            'miner_offline': True,
            'high_temperature': True,
            'critical_temperature': True,
            'low_hashrate': True,
            'unprofitable': False,
            'emergency_shutdown': True,
            'miner_online': False,
            'weather_warning': True,
            'overheat_recovery': True
        }

        # Per-miner threshold overrides: {miner_ip: {'temp_warning': 85, 'temp_critical': 92}}
        self.miner_overrides = {}

        # Quiet hours
        self.quiet_hours_enabled = False
        self.quiet_hours_start = "22:00"
        self.quiet_hours_end = "07:00"

        # Daily report
        self.daily_report_enabled = False
        self.daily_report_time = "08:00"


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
    """Manage and dispatch Telegram alerts"""

    def __init__(self, db):
        self.db = db
        self.config = AlertConfig()
        self.alert_history = []
        self.last_alerts = {}  # Track last alert time per type/miner
        self._load_config_from_db()

    def _load_config_from_db(self):
        """Load full config from database settings table"""
        import json
        try:
            raw = self.db.get_setting('alert_config')
            if raw:
                data = json.loads(raw)
                c = self.config
                c.enabled_alert_types = data.get('enabled_alert_types', c.enabled_alert_types)
                c.miner_overrides = data.get('miner_overrides', c.miner_overrides)
                c.quiet_hours_enabled = data.get('quiet_hours_enabled', False)
                c.quiet_hours_start = data.get('quiet_hours_start', '22:00')
                c.quiet_hours_end = data.get('quiet_hours_end', '07:00')
                c.daily_report_enabled = data.get('daily_report_enabled', False)
                c.daily_report_time = data.get('daily_report_time', '08:00')
                c.high_temp_threshold = data.get('high_temp_threshold', 70.0)
                c.low_hashrate_threshold_pct = data.get('low_hashrate_threshold_pct', 20.0)
        except Exception as e:
            logger.debug(f"No saved alert config: {e}")

    def _save_config_to_db(self):
        """Persist full config as JSON in settings table"""
        import json
        c = self.config
        data = {
            'enabled_alert_types': c.enabled_alert_types,
            'miner_overrides': c.miner_overrides,
            'quiet_hours_enabled': c.quiet_hours_enabled,
            'quiet_hours_start': c.quiet_hours_start,
            'quiet_hours_end': c.quiet_hours_end,
            'daily_report_enabled': c.daily_report_enabled,
            'daily_report_time': c.daily_report_time,
            'high_temp_threshold': c.high_temp_threshold,
            'low_hashrate_threshold_pct': c.low_hashrate_threshold_pct
        }
        self.db.set_setting('alert_config', json.dumps(data))

    def configure(self, telegram_bot_token: str = None, telegram_chat_id: str = None,
                  telegram_enabled: bool = None, **kwargs):
        """Configure Telegram bot settings and extended alert config"""
        if telegram_bot_token is not None:
            self.config.telegram_bot_token = telegram_bot_token
        if telegram_chat_id is not None:
            self.config.telegram_chat_id = telegram_chat_id
        if telegram_enabled is not None:
            self.config.telegram_enabled = telegram_enabled

        # Extended config
        if 'enabled_alert_types' in kwargs:
            self.config.enabled_alert_types.update(kwargs['enabled_alert_types'])
        if 'miner_overrides' in kwargs:
            self.config.miner_overrides = kwargs['miner_overrides']
        if 'quiet_hours_enabled' in kwargs:
            self.config.quiet_hours_enabled = kwargs['quiet_hours_enabled']
        if 'quiet_hours_start' in kwargs:
            self.config.quiet_hours_start = kwargs['quiet_hours_start']
        if 'quiet_hours_end' in kwargs:
            self.config.quiet_hours_end = kwargs['quiet_hours_end']
        if 'daily_report_enabled' in kwargs:
            self.config.daily_report_enabled = kwargs['daily_report_enabled']
        if 'daily_report_time' in kwargs:
            self.config.daily_report_time = kwargs['daily_report_time']
        if 'high_temp_threshold' in kwargs and kwargs['high_temp_threshold'] is not None:
            self.config.high_temp_threshold = float(kwargs['high_temp_threshold'])
        if 'low_hashrate_threshold_pct' in kwargs and kwargs['low_hashrate_threshold_pct'] is not None:
            self.config.low_hashrate_threshold_pct = float(kwargs['low_hashrate_threshold_pct'])

        self._save_config_to_db()
        logger.info("Telegram alert configuration updated")

    def get_config(self) -> Dict:
        """Get current configuration"""
        return {
            'telegram': {
                'enabled': self.config.telegram_enabled,
                'bot_token': self.config.telegram_bot_token[:20] + '...' if self.config.telegram_bot_token else '',
                'chat_id': self.config.telegram_chat_id
            },
            'rules': {
                'alert_on_offline': self.config.alert_on_offline,
                'alert_on_high_temp': self.config.alert_on_high_temp,
                'alert_on_critical_temp': self.config.alert_on_critical_temp,
                'alert_on_low_hashrate': self.config.alert_on_low_hashrate,
                'alert_on_unprofitable': self.config.alert_on_unprofitable,
                'alert_on_emergency_shutdown': self.config.alert_on_emergency_shutdown,
                'alert_on_miner_online': self.config.alert_on_miner_online
            },
            'thresholds': {
                'high_temp': self.config.high_temp_threshold,
                'low_hashrate_pct': self.config.low_hashrate_threshold_pct
            },
            'enabled_alert_types': self.config.enabled_alert_types,
            'miner_overrides': self.config.miner_overrides,
            'quiet_hours': {
                'enabled': self.config.quiet_hours_enabled,
                'start': self.config.quiet_hours_start,
                'end': self.config.quiet_hours_end
            },
            'daily_report': {
                'enabled': self.config.daily_report_enabled,
                'time': self.config.daily_report_time
            }
        }

    def is_in_quiet_hours(self) -> bool:
        """Check if current time falls in quiet window (handles overnight spans)"""
        if not self.config.quiet_hours_enabled:
            return False
        try:
            now = datetime.now().strftime("%H:%M")
            start = self.config.quiet_hours_start
            end = self.config.quiet_hours_end
            now_dt = datetime.strptime(now, "%H:%M").time()
            start_dt = datetime.strptime(start, "%H:%M").time()
            end_dt = datetime.strptime(end, "%H:%M").time()

            if start_dt <= end_dt:
                return start_dt <= now_dt < end_dt
            else:
                return now_dt >= start_dt or now_dt < end_dt
        except Exception:
            return False

    def get_device_temp_threshold(self, miner_ip: str, miner_type: str = '') -> Dict:
        """Get temp thresholds for a device. Checks per-miner overrides first,
        then device-specific profiles (e.g., Avalon Nano 3S uses 85/92C)."""
        # Per-miner override
        if miner_ip in self.config.miner_overrides:
            override = self.config.miner_overrides[miner_ip]
            return {
                'warning': override.get('temp_warning', self.config.high_temp_threshold),
                'critical': override.get('temp_critical', 90.0)
            }

        # Device-specific defaults
        miner_type_lower = (miner_type or '').lower()
        if 'nano' in miner_type_lower or 'avalon' in miner_type_lower:
            return {'warning': 85.0, 'critical': 92.0}
        if 'antminer' in miner_type_lower or 's19' in miner_type_lower or 's21' in miner_type_lower:
            return {'warning': 80.0, 'critical': 95.0}
        if 'whatsminer' in miner_type_lower:
            return {'warning': 80.0, 'critical': 95.0}

        return {
            'warning': self.config.high_temp_threshold,
            'critical': 90.0
        }

    def generate_daily_report(self, fleet_data: Dict) -> str:
        """Format and return daily report message for Telegram"""
        uptime = fleet_data.get('uptime_pct', 0)
        sats = fleet_data.get('sats_earned', 0)
        energy_cost = fleet_data.get('energy_cost', 0)
        revenue = fleet_data.get('revenue', 0)
        profit = revenue - energy_cost
        avg_efficiency = fleet_data.get('avg_efficiency_jth', 0)
        avg_temp = fleet_data.get('avg_temp', 0)
        miners_online = fleet_data.get('miners_online', 0)
        miners_total = fleet_data.get('miners_total', 0)

        msg = "Daily Mining Report\n\n"
        msg += f"Fleet: {miners_online}/{miners_total} miners online\n"
        msg += f"Uptime: {uptime:.1f}%\n\n"
        msg += f"Sats Earned: {sats:,}\n"
        msg += f"Revenue: ${revenue:.4f}\n"
        msg += f"Energy Cost: ${energy_cost:.4f}\n"
        msg += f"Net Profit: ${profit:.4f}\n\n"
        msg += f"Avg Efficiency: {avg_efficiency:.1f} J/TH\n"
        msg += f"Avg Temperature: {avg_temp:.1f} C\n"

        return msg

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
        """Send alert through Telegram - respects quiet hours and per-type toggles"""
        # Check per-type enable/disable
        alert_type_key = alert.alert_type.value
        if not self.config.enabled_alert_types.get(alert_type_key, True):
            logger.debug(f"Alert type {alert_type_key} is disabled, skipping")
            return

        # Check quiet hours (except EMERGENCY)
        if alert.level != AlertLevel.EMERGENCY and self.is_in_quiet_hours():
            logger.debug(f"In quiet hours, skipping non-emergency alert: {alert.title}")
            # Still record in DB
            import json
            self.db.add_alert_to_history(
                alert_type=alert.alert_type.value,
                level=alert.level.value,
                title=alert.title,
                message=alert.message,
                data_json=json.dumps(alert.data) if alert.data else None
            )
            return

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

        # Send through Telegram
        if self.config.telegram_enabled:
            if self._send_telegram(alert):
                logger.info(f"Alert sent via Telegram: {alert.title}")
            else:
                logger.warning(f"Failed to send alert via Telegram: {alert.title}")
        else:
            logger.debug(f"Telegram not enabled, alert not sent: {alert.title}")

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

    def alert_miner_offline(self, miner_ip: str, reason: str):
        """Send miner offline alert"""
        if not self.config.alert_on_offline:
            return

        alert = Alert(
            alert_type=AlertType.MINER_OFFLINE,
            level=AlertLevel.WARNING,
            title=f"Miner Offline: {miner_ip}",
            message=f"Miner {miner_ip} is no longer responding.",
            miner_ip=miner_ip,
            data={'reason': reason}
        )
        self.send_alert(alert)

    def alert_miner_online(self, miner_ip: str, hashrate: float, temperature: float = None):
        """Send miner back online alert"""
        if not self.config.alert_on_miner_online:
            return

        data = {'hashrate': format_hashrate(hashrate)}
        if temperature:
            data['temperature'] = f"{temperature:.1f}°C"

        alert = Alert(
            alert_type=AlertType.MINER_ONLINE,
            level=AlertLevel.INFO,
            title=f"Miner Back Online: {miner_ip}",
            message=f"Miner {miner_ip} has reconnected and is mining.",
            miner_ip=miner_ip,
            data=data
        )
        self.send_alert(alert)

    def alert_high_temperature(self, miner_ip: str, temperature: float,
                              threshold: float, hashrate: float, frequency: int):
        """Send high temperature warning"""
        if not self.config.alert_on_high_temp:
            return

        alert = Alert(
            alert_type=AlertType.HIGH_TEMPERATURE,
            level=AlertLevel.WARNING,
            title=f"High Temperature: {miner_ip}",
            message=f"Miner {miner_ip} reached {temperature:.1f}°C (threshold: {threshold:.1f}°C)",
            miner_ip=miner_ip,
            data={
                'temperature': f"{temperature:.1f}°C",
                'threshold': f"{threshold:.1f}°C",
                'hashrate': format_hashrate(hashrate),
                'frequency': f"{frequency} MHz"
            }
        )
        self.send_alert(alert)

    def alert_emergency_shutdown(self, miner_ip: str, temperature: float, reason: str):
        """Send emergency shutdown alert"""
        if not self.config.alert_on_emergency_shutdown:
            return

        alert = Alert(
            alert_type=AlertType.EMERGENCY_SHUTDOWN,
            level=AlertLevel.EMERGENCY,
            title=f"🚨 EMERGENCY SHUTDOWN: {miner_ip}",
            message=f"Miner {miner_ip} has been shut down due to critical temperature!",
            miner_ip=miner_ip,
            data={
                'temperature': f"{temperature:.1f}°C",
                'reason': reason,
                'action': 'Frequency set to minimum, 10-minute cooldown'
            }
        )
        self.send_alert(alert)

    def alert_overheat_recovery(self, miner_ip: str, temperature: float, recovery_temp: float):
        """Send overheat recovery alert when miner is rebooted after cooling down"""
        alert = Alert(
            alert_type=AlertType.OVERHEAT_RECOVERY,
            level=AlertLevel.INFO,
            title=f"Overheat Recovery: {miner_ip}",
            message=f"Miner {miner_ip} cooled to {temperature:.1f}°C and has been rebooted.",
            miner_ip=miner_ip,
            data={
                'temperature': f"{temperature:.1f}°C",
                'recovery_threshold': f"{recovery_temp:.1f}°C",
                'action': 'Automatic reboot triggered'
            }
        )
        self.send_alert(alert)

    def alert_frequency_adjusted(self, miner_ip: str, new_frequency: int,
                                 reason: str, temperature: float):
        """Send frequency adjustment alert (only for critical adjustments)"""
        alert = Alert(
            alert_type=AlertType.CRITICAL_TEMPERATURE,
            level=AlertLevel.CRITICAL,
            title=f"Frequency Adjusted: {miner_ip}",
            message=f"Miner frequency changed to {new_frequency} MHz due to thermal management.",
            miner_ip=miner_ip,
            data={
                'new_frequency': f"{new_frequency} MHz",
                'temperature': f"{temperature:.1f}°C",
                'reason': reason
            }
        )
        self.send_alert(alert)

    def alert_low_hashrate(self, miner_ip: str, current_hashrate: float,
                          expected_hashrate: float, percent_drop: float):
        """Send low hashrate alert"""
        if not self.config.alert_on_low_hashrate:
            return

        alert = Alert(
            alert_type=AlertType.LOW_HASHRATE,
            level=AlertLevel.WARNING,
            title=f"Low Hashrate: {miner_ip}",
            message=f"Miner {miner_ip} hashrate dropped by {percent_drop:.1f}%",
            miner_ip=miner_ip,
            data={
                'current_hashrate': format_hashrate(current_hashrate),
                'expected_hashrate': format_hashrate(expected_hashrate),
                'drop_percent': f"{percent_drop:.1f}%"
            }
        )
        self.send_alert(alert)

    def alert_unprofitable(self, profit_per_day: float, energy_cost: float,
                          revenue: float, btc_price: float):
        """Send unprofitable mining alert"""
        if not self.config.alert_on_unprofitable:
            return

        alert = Alert(
            alert_type=AlertType.UNPROFITABLE,
            level=AlertLevel.WARNING,
            title="⚠️ Mining Unprofitable",
            message=f"Current mining operation is unprofitable: ${profit_per_day:.2f}/day",
            data={
                'daily_profit': f"${profit_per_day:.2f}",
                'energy_cost': f"${energy_cost:.2f}/day",
                'revenue': f"${revenue:.2f}/day",
                'btc_price': f"${btc_price:.2f}"
            }
        )
        self.send_alert(alert)

    def send_custom_alert(self, title: str, message: str, alert_type: str = "custom",
                         level: str = "info", data: Dict = None):
        """Send a custom alert"""
        # Convert string level to enum
        level_map = {
            'info': AlertLevel.INFO,
            'warning': AlertLevel.WARNING,
            'critical': AlertLevel.CRITICAL,
            'emergency': AlertLevel.EMERGENCY
        }
        alert_level = level_map.get(level.lower(), AlertLevel.INFO)

        # Use a generic alert type for custom alerts
        try:
            alert_type_enum = AlertType(alert_type)
        except ValueError:
            alert_type_enum = AlertType.WEATHER_WARNING  # Default fallback

        alert = Alert(
            alert_type=alert_type_enum,
            level=alert_level,
            title=title,
            message=message,
            data=data
        )
        self.send_alert(alert)
