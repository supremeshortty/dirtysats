"""
SQLite database operations for fleet manager
"""
import sqlite3
import logging
from datetime import datetime
from typing import List, Dict, Optional
from contextlib import contextmanager

logger = logging.getLogger(__name__)


class Database:
    """Handle all database operations"""

    def __init__(self, db_path: str):
        self.db_path = db_path
        self._init_db()

    @contextmanager
    def _get_connection(self):
        """Context manager for database connections"""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        except Exception as e:
            conn.rollback()
            logger.error(f"Database error: {e}")
            raise
        finally:
            conn.close()

    def _init_db(self):
        """Initialize database schema"""
        with self._get_connection() as conn:
            cursor = conn.cursor()

            # Miners table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS miners (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ip TEXT UNIQUE NOT NULL,
                    miner_type TEXT NOT NULL,
                    model TEXT,
                    custom_name TEXT,
                    discovered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Stats table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS stats (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    miner_id INTEGER NOT NULL,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    hashrate REAL,
                    temperature REAL,
                    power REAL,
                    fan_speed INTEGER,
                    status TEXT,
                    shares_accepted INTEGER DEFAULT 0,
                    shares_rejected INTEGER DEFAULT 0,
                    best_difficulty REAL DEFAULT 0,
                    FOREIGN KEY (miner_id) REFERENCES miners(id)
                )
            """)

            # Create indexes
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_stats_miner_id
                ON stats(miner_id)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_stats_timestamp
                ON stats(timestamp)
            """)

            # Energy configuration table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS energy_config (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    location TEXT,
                    energy_company TEXT,
                    rate_structure TEXT,
                    currency TEXT DEFAULT 'USD',
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Energy rates table (time-of-use pricing)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS energy_rates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    day_of_week TEXT,
                    start_time TEXT NOT NULL,
                    end_time TEXT NOT NULL,
                    rate_per_kwh REAL NOT NULL,
                    rate_type TEXT DEFAULT 'standard',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Mining schedule table (automated frequency control)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS mining_schedule (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    day_of_week TEXT,
                    start_time TEXT NOT NULL,
                    end_time TEXT NOT NULL,
                    target_frequency INTEGER NOT NULL,
                    enabled INTEGER DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Energy consumption log
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS energy_consumption (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    total_power_watts REAL,
                    energy_kwh REAL,
                    cost REAL,
                    current_rate REAL
                )
            """)

            # Profitability log
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS profitability_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    btc_price REAL,
                    network_difficulty REAL,
                    total_hashrate REAL,
                    estimated_btc_per_day REAL,
                    energy_cost_per_day REAL,
                    profit_per_day REAL
                )
            """)

            # Create indexes for energy tables
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_energy_consumption_timestamp
                ON energy_consumption(timestamp)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_profitability_timestamp
                ON profitability_log(timestamp)
            """)

            # Alert configuration table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS alert_config (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    channel TEXT NOT NULL,
                    config_json TEXT NOT NULL,
                    enabled INTEGER DEFAULT 1,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Alert history table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS alert_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    alert_type TEXT,
                    level TEXT,
                    title TEXT,
                    message TEXT,
                    data_json TEXT
                )
            """)

            # Weather configuration table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS weather_config (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    api_key TEXT,
                    location TEXT,
                    latitude REAL,
                    longitude REAL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Create index for alert history
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_alert_history_timestamp
                ON alert_history(timestamp)
            """)

            # Migrations: Add custom_name column if it doesn't exist
            cursor.execute("PRAGMA table_info(miners)")
            columns = [col[1] for col in cursor.fetchall()]
            if 'custom_name' not in columns:
                logger.info("Adding custom_name column to miners table")
                cursor.execute("ALTER TABLE miners ADD COLUMN custom_name TEXT")

            logger.info("Database initialized successfully")

    def add_miner(self, ip: str, miner_type: str, model: str = None) -> int:
        """Add a new miner to the database"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO miners (ip, miner_type, model, discovered_at, last_seen)
                VALUES (?, ?, ?, ?, ?)
            """, (ip, miner_type, model, datetime.now(), datetime.now()))
            return cursor.lastrowid

    def update_miner(self, ip: str, miner_type: str, model: str = None):
        """Update existing miner or add if not exists"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO miners (ip, miner_type, model, discovered_at, last_seen)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(ip) DO UPDATE SET
                    miner_type = excluded.miner_type,
                    model = excluded.model,
                    last_seen = excluded.last_seen
            """, (ip, miner_type, model, datetime.now(), datetime.now()))

    def get_all_miners(self) -> List[Dict]:
        """Get all miners from database"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM miners ORDER BY ip")
            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    def get_miner_by_ip(self, ip: str) -> Optional[Dict]:
        """Get specific miner by IP"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM miners WHERE ip = ?", (ip,))
            row = cursor.fetchone()
            return dict(row) if row else None

    def add_stats(self, miner_id: int, hashrate: float = None,
                  temperature: float = None, power: float = None,
                  fan_speed: int = None, status: str = "online",
                  shares_accepted: int = None, shares_rejected: int = None,
                  best_difficulty: float = None):
        """Add stats entry for a miner"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO stats (miner_id, hashrate, temperature, power, fan_speed, status,
                                   shares_accepted, shares_rejected, best_difficulty)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (miner_id, hashrate, temperature, power, fan_speed, status,
                  shares_accepted, shares_rejected, best_difficulty))

    def get_latest_stats(self, miner_id: int) -> Optional[Dict]:
        """Get latest stats for a miner"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT * FROM stats
                WHERE miner_id = ?
                ORDER BY timestamp DESC
                LIMIT 1
            """, (miner_id,))
            row = cursor.fetchone()
            return dict(row) if row else None

    def get_historical_stats(self, miner_id: int, limit: int = 100) -> List[Dict]:
        """Get historical stats for a miner"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT * FROM stats
                WHERE miner_id = ?
                ORDER BY timestamp DESC
                LIMIT ?
            """, (miner_id, limit))
            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    def get_stats_history(self, miner_id: int, hours: int = 24) -> List[Dict]:
        """Get stats history for a miner within time window"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT * FROM stats
                WHERE miner_id = ?
                AND timestamp > datetime('now', ? || ' hours')
                ORDER BY timestamp ASC
            """, (miner_id, f'-{hours}'))
            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    def update_miner_custom_name(self, ip: str, custom_name: str):
        """Update custom name for a miner"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                UPDATE miners
                SET custom_name = ?
                WHERE ip = ?
            """, (custom_name if custom_name else None, ip))
            return cursor.rowcount > 0

    def delete_miner(self, ip: str):
        """Delete a miner and its stats"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            # Get miner_id first
            cursor.execute("SELECT id FROM miners WHERE ip = ?", (ip,))
            row = cursor.fetchone()
            if row:
                miner_id = row['id']
                # Delete stats
                cursor.execute("DELETE FROM stats WHERE miner_id = ?", (miner_id,))
                # Delete miner
                cursor.execute("DELETE FROM miners WHERE id = ?", (miner_id,))
                logger.info(f"Deleted miner {ip}")

    # Energy Management Methods

    def set_energy_config(self, location: str, energy_company: str,
                          rate_structure: str = "tou", currency: str = "USD"):
        """Set or update energy configuration"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            # Delete old config
            cursor.execute("DELETE FROM energy_config")
            # Insert new config
            cursor.execute("""
                INSERT INTO energy_config (location, energy_company, rate_structure, currency, updated_at)
                VALUES (?, ?, ?, ?, ?)
            """, (location, energy_company, rate_structure, currency, datetime.now()))

    def get_energy_config(self) -> Optional[Dict]:
        """Get energy configuration"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM energy_config ORDER BY id DESC LIMIT 1")
            row = cursor.fetchone()
            return dict(row) if row else None

    def add_energy_rate(self, start_time: str, end_time: str, rate_per_kwh: float,
                        day_of_week: str = None, rate_type: str = "standard"):
        """Add energy rate for time period"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO energy_rates (day_of_week, start_time, end_time, rate_per_kwh, rate_type)
                VALUES (?, ?, ?, ?, ?)
            """, (day_of_week, start_time, end_time, rate_per_kwh, rate_type))

    def get_energy_rates(self) -> List[Dict]:
        """Get all energy rates"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM energy_rates ORDER BY start_time")
            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    def delete_all_energy_rates(self):
        """Clear all energy rates"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM energy_rates")

    def add_mining_schedule(self, start_time: str, end_time: str, target_frequency: int,
                           day_of_week: str = None, enabled: int = 1):
        """Add mining schedule entry"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO mining_schedule (day_of_week, start_time, end_time, target_frequency, enabled)
                VALUES (?, ?, ?, ?, ?)
            """, (day_of_week, start_time, end_time, target_frequency, enabled))

    def get_mining_schedules(self) -> List[Dict]:
        """Get all mining schedules"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM mining_schedule WHERE enabled = 1 ORDER BY start_time")
            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    def delete_mining_schedule(self, schedule_id: int):
        """Delete a mining schedule"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM mining_schedule WHERE id = ?", (schedule_id,))

    def add_energy_consumption(self, total_power_watts: float, energy_kwh: float,
                              cost: float, current_rate: float):
        """Log energy consumption"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO energy_consumption (total_power_watts, energy_kwh, cost, current_rate)
                VALUES (?, ?, ?, ?)
            """, (total_power_watts, energy_kwh, cost, current_rate))

    def get_energy_consumption_history(self, hours: int = 24) -> List[Dict]:
        """Get energy consumption history"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT * FROM energy_consumption
                WHERE timestamp > datetime('now', ? || ' hours')
                ORDER BY timestamp DESC
            """, (f'-{hours}',))
            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    def add_profitability_log(self, btc_price: float, network_difficulty: float,
                             total_hashrate: float, estimated_btc_per_day: float,
                             energy_cost_per_day: float, profit_per_day: float):
        """Log profitability data"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO profitability_log
                (btc_price, network_difficulty, total_hashrate, estimated_btc_per_day,
                 energy_cost_per_day, profit_per_day)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (btc_price, network_difficulty, total_hashrate, estimated_btc_per_day,
                  energy_cost_per_day, profit_per_day))

    def get_profitability_history(self, days: int = 7) -> List[Dict]:
        """Get profitability history"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT * FROM profitability_log
                WHERE timestamp > datetime('now', ? || ' days')
                ORDER BY timestamp DESC
            """, (f'-{days}',))
            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    def get_aggregate_stats(self, hours: int = 24) -> Dict:
        """Get aggregated stats over a time period"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT
                    SUM(shares_accepted) as total_shares_accepted,
                    SUM(shares_rejected) as total_shares_rejected,
                    AVG(power) as avg_power,
                    MAX(power) as max_power,
                    MIN(power) as min_power,
                    AVG(temperature) as avg_temperature,
                    AVG(hashrate) as avg_hashrate,
                    MAX(best_difficulty) as best_difficulty
                FROM stats
                WHERE timestamp > datetime('now', ? || ' hours')
                AND status = 'online'
            """, (f'-{hours}',))
            row = cursor.fetchone()
            return dict(row) if row else {
                'total_shares_accepted': 0,
                'total_shares_rejected': 0,
                'avg_power': 0,
                'max_power': 0,
                'min_power': 0,
                'avg_temperature': 0,
                'avg_hashrate': 0,
                'best_difficulty': 0
            }

    # Alert Management Methods

    def add_alert_to_history(self, alert_type: str, level: str, title: str,
                             message: str, data_json: str = None):
        """Log alert to history"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO alert_history (alert_type, level, title, message, data_json)
                VALUES (?, ?, ?, ?, ?)
            """, (alert_type, level, title, message, data_json))

    def get_alert_history(self, hours: int = 24) -> List[Dict]:
        """Get alert history"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT * FROM alert_history
                WHERE timestamp > datetime('now', ? || ' hours')
                ORDER BY timestamp DESC
            """, (f'-{hours}',))
            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    def save_alert_config(self, channel: str, config_json: str):
        """Save alert channel configuration"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT OR REPLACE INTO alert_config (channel, config_json, enabled)
                VALUES (?, ?, 1)
            """, (channel, config_json))

    def get_alert_config(self, channel: str = None) -> Optional[Dict]:
        """Get alert configuration for a channel"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            if channel:
                cursor.execute("SELECT * FROM alert_config WHERE channel = ?", (channel,))
                row = cursor.fetchone()
                return dict(row) if row else None
            else:
                cursor.execute("SELECT * FROM alert_config")
                rows = cursor.fetchall()
                return [dict(row) for row in rows]

    # Weather Configuration Methods

    def save_weather_config(self, api_key: str, location: str = None,
                           latitude: float = None, longitude: float = None):
        """Save weather configuration"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            # Delete old config
            cursor.execute("DELETE FROM weather_config")
            # Insert new config
            cursor.execute("""
                INSERT INTO weather_config (api_key, location, latitude, longitude, updated_at)
                VALUES (?, ?, ?, ?, ?)
            """, (api_key, location, latitude, longitude, datetime.now()))

    def get_weather_config(self) -> Optional[Dict]:
        """Get weather configuration"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM weather_config ORDER BY id DESC LIMIT 1")
            row = cursor.fetchone()
            return dict(row) if row else None
