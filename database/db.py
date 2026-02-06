"""
SQLite database operations for fleet manager
"""
import sqlite3
import logging
import math
from datetime import datetime, timedelta
from typing import List, Dict, Optional
from contextlib import contextmanager

logger = logging.getLogger(__name__)

# Suffix multipliers for human-readable numeric strings (e.g. '8.52G')
_SUFFIX_MULTIPLIERS = {
    'K': 1e3, 'M': 1e6, 'G': 1e9, 'T': 1e12, 'P': 1e15, 'E': 1e18,
}


def _parse_numeric(value) -> Optional[float]:
    """Parse a numeric value that may have a suffix like K, M, G, T, P, E.

    Returns None if value is None, otherwise returns a float.
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    if not s:
        return None
    suffix = s[-1].upper()
    if suffix in _SUFFIX_MULTIPLIERS:
        try:
            return float(s[:-1]) * _SUFFIX_MULTIPLIERS[suffix]
        except ValueError:
            return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


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
                    auto_optimize INTEGER DEFAULT 0,
                    discovered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Migration: Add auto_optimize column if it doesn't exist (for existing databases)
            try:
                cursor.execute("ALTER TABLE miners ADD COLUMN auto_optimize INTEGER DEFAULT 0")
            except Exception:
                pass  # Column already exists

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
                    default_rate REAL DEFAULT 0.12,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Add default_rate column if it doesn't exist (migration for existing databases)
            try:
                cursor.execute("ALTER TABLE energy_config ADD COLUMN default_rate REAL DEFAULT 0.12")
            except Exception:
                pass  # Column already exists

            # Energy rates table (time-of-use pricing)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS energy_rates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    day_of_week TEXT,
                    start_time TEXT NOT NULL,
                    end_time TEXT NOT NULL,
                    rate_per_kwh REAL NOT NULL,
                    rate_type TEXT DEFAULT 'standard',
                    season TEXT DEFAULT 'all',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Migration: Add season column if it doesn't exist
            try:
                cursor.execute("ALTER TABLE energy_rates ADD COLUMN season TEXT DEFAULT 'all'")
            except Exception:
                pass  # Column already exists

            # Seasonal date configuration table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS seasonal_config (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    season_name TEXT NOT NULL,
                    start_month INTEGER NOT NULL,
                    start_day INTEGER NOT NULL,
                    end_month INTEGER NOT NULL,
                    end_day INTEGER NOT NULL,
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

            # Settings table (key-value store for app settings)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Miner groups table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS miner_groups (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT UNIQUE NOT NULL,
                    color TEXT DEFAULT '#3498db',
                    description TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Miner-to-group junction table (many-to-many)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS miner_group_members (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    miner_ip TEXT NOT NULL,
                    group_id INTEGER NOT NULL,
                    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (group_id) REFERENCES miner_groups(id) ON DELETE CASCADE,
                    UNIQUE(miner_ip, group_id)
                )
            """)

            # Index for faster group member lookups
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_miner_group_members_ip
                ON miner_group_members(miner_ip)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_miner_group_members_group
                ON miner_group_members(group_id)
            """)

            # Pool configuration table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS pool_config (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    miner_ip TEXT NOT NULL,
                    pool_index INTEGER DEFAULT 0,
                    pool_name TEXT NOT NULL,
                    pool_url TEXT NOT NULL,
                    pool_port INTEGER DEFAULT 3333,
                    stratum_user TEXT,
                    stratum_password TEXT DEFAULT 'x',
                    fee_percent REAL DEFAULT 2.0,
                    pool_type TEXT DEFAULT 'FPPS',
                    pool_difficulty REAL,
                    active BOOLEAN DEFAULT 1,
                    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (miner_ip) REFERENCES miners(ip),
                    UNIQUE(miner_ip, pool_index)
                )
            """)

            # Pool earnings history
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS pool_earnings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    miner_ip TEXT NOT NULL,
                    pool_name TEXT NOT NULL,
                    earned_sats INTEGER DEFAULT 0,
                    shares_accepted INTEGER DEFAULT 0,
                    shares_rejected INTEGER DEFAULT 0,
                    pool_difficulty REAL,
                    estimated_sats INTEGER DEFAULT 0,
                    variance_percent REAL,
                    data_source TEXT DEFAULT 'calculated',
                    FOREIGN KEY (miner_ip) REFERENCES miners(ip)
                )
            """)

            # Historical energy rates (for accurate historical cost calculation)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS energy_rates_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    rate_id INTEGER NOT NULL,
                    effective_date DATE NOT NULL,
                    end_date DATE,
                    rate_per_kwh REAL NOT NULL,
                    rate_type TEXT NOT NULL,
                    FOREIGN KEY (rate_id) REFERENCES energy_rates(id)
                )
            """)

            # Create indexes for pool tables
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_pool_config_miner_ip
                ON pool_config(miner_ip)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_pool_earnings_timestamp
                ON pool_earnings(timestamp)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_pool_earnings_miner_ip
                ON pool_earnings(miner_ip)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_energy_rates_history_effective_date
                ON energy_rates_history(effective_date)
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
                  best_difficulty: float = None, timestamp: datetime = None):
        """Add stats entry for a miner"""
        if timestamp is None:
            timestamp = datetime.now()
        best_difficulty = _parse_numeric(best_difficulty)
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO stats (miner_id, hashrate, temperature, power, fan_speed, status,
                                   shares_accepted, shares_rejected, best_difficulty, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (miner_id, hashrate, temperature, power, fan_speed, status,
                  shares_accepted, shares_rejected, best_difficulty, timestamp))

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
        # Calculate cutoff time in Python to avoid UTC/local time issues
        cutoff = datetime.now() - timedelta(hours=hours)
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT * FROM stats
                WHERE miner_id = ?
                AND timestamp > ?
                ORDER BY timestamp ASC
            """, (miner_id, cutoff.strftime('%Y-%m-%d %H:%M:%S')))
            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    def get_best_difficulty_ever(self) -> float:
        """Get the highest best_difficulty ever recorded across all miners"""
        try:
            with self._get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("""
                    SELECT MAX(best_difficulty) as max_diff FROM stats
                    WHERE best_difficulty > 0
                """)
                row = cursor.fetchone()
                if row and row['max_diff'] is not None:
                    return _parse_numeric(row['max_diff']) or 0.0
                return 0.0
        except Exception:
            return 0.0

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

    def update_miner_auto_optimize(self, ip: str, enabled: bool):
        """Update auto-optimize setting for a miner"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                UPDATE miners
                SET auto_optimize = ?
                WHERE ip = ?
            """, (1 if enabled else 0, ip))
            return cursor.rowcount > 0

    def get_miner_auto_optimize(self, ip: str) -> bool:
        """Get auto-optimize setting for a miner"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT auto_optimize FROM miners WHERE ip = ?", (ip,))
            row = cursor.fetchone()
            return bool(row['auto_optimize']) if row and row['auto_optimize'] else False

    def get_all_auto_optimize_settings(self) -> dict:
        """Get auto-optimize settings for all miners"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT ip, auto_optimize FROM miners")
            rows = cursor.fetchall()
            return {row['ip']: bool(row['auto_optimize']) for row in rows}

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
                          rate_structure: str = "tou", currency: str = "USD",
                          default_rate: float = None):
        """Set or update energy configuration"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            # Delete old config
            cursor.execute("DELETE FROM energy_config")
            # Insert new config
            cursor.execute("""
                INSERT INTO energy_config (location, energy_company, rate_structure, currency, default_rate, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (location, energy_company, rate_structure, currency, default_rate, datetime.now()))

    def get_energy_config(self) -> Optional[Dict]:
        """Get energy configuration"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM energy_config ORDER BY id DESC LIMIT 1")
            row = cursor.fetchone()
            return dict(row) if row else None

    def add_energy_rate(self, start_time: str, end_time: str, rate_per_kwh: float,
                        day_of_week: str = None, rate_type: str = "standard",
                        season: str = "all"):
        """Add energy rate for time period"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO energy_rates (day_of_week, start_time, end_time, rate_per_kwh, rate_type, season)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (day_of_week, start_time, end_time, rate_per_kwh, rate_type, season))

    def set_seasonal_config(self, season_name: str, start_month: int, start_day: int,
                            end_month: int, end_day: int):
        """Set or update seasonal date configuration"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM seasonal_config WHERE season_name = ?", (season_name,))
            cursor.execute("""
                INSERT INTO seasonal_config (season_name, start_month, start_day, end_month, end_day)
                VALUES (?, ?, ?, ?, ?)
            """, (season_name, start_month, start_day, end_month, end_day))

    def get_seasonal_config(self) -> List[Dict]:
        """Get seasonal date configuration"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM seasonal_config ORDER BY season_name")
            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    def delete_all_seasonal_config(self):
        """Clear all seasonal configuration"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM seasonal_config")

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
        cutoff = (datetime.now() - timedelta(hours=hours)).strftime('%Y-%m-%d %H:%M:%S')
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT * FROM energy_consumption
                WHERE timestamp > ?
                ORDER BY timestamp DESC
            """, (cutoff,))
            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    def calculate_actual_energy_consumption(self, hours: int = 24) -> Dict:
        """
        Calculate actual energy consumption from power readings in stats table.

        This integrates power over time: Energy (kWh) = Σ(Power_i × Duration_i) / 1000

        Returns:
            Dict with total_kwh, readings_count, time_coverage_percent, and hourly breakdown
        """
        cutoff = (datetime.now() - timedelta(hours=hours)).strftime('%Y-%m-%d %H:%M:%S')

        with self._get_connection() as conn:
            cursor = conn.cursor()

            # Get all power readings ordered by timestamp
            # Group by second-level precision to aggregate all miners polled in the same cycle
            cursor.execute("""
                SELECT strftime('%Y-%m-%d %H:%M:%S', timestamp) as timestamp,
                       SUM(power) as total_power
                FROM stats
                WHERE timestamp > ?
                AND status IN ('online', 'overheating')
                AND power > 0
                GROUP BY strftime('%Y-%m-%d %H:%M:%S', timestamp)
                ORDER BY timestamp ASC
            """, (cutoff,))
            rows = cursor.fetchall()

            if not rows:
                return {
                    'total_kwh': 0,
                    'readings_count': 0,
                    'time_coverage_percent': 0,
                    'hourly_breakdown': []
                }

            # Integrate power over time
            total_energy_wh = 0
            hourly_energy = {}  # hour -> wh
            readings_count = len(rows)

            for i in range(len(rows) - 1):
                current_ts = datetime.fromisoformat(rows[i]['timestamp'])
                next_ts = datetime.fromisoformat(rows[i + 1]['timestamp'])
                power_watts = rows[i]['total_power'] or 0

                # Calculate time interval in hours
                interval_seconds = (next_ts - current_ts).total_seconds()

                # Skip if interval is too large (gap in data > 15 minutes)
                if interval_seconds > 900:
                    continue

                interval_hours = interval_seconds / 3600
                next_power = rows[i + 1]['total_power'] or 0
                avg_power = (power_watts + next_power) / 2
                energy_wh = avg_power * interval_hours
                total_energy_wh += energy_wh

                # Track by hour for TOU calculation
                hour_key = current_ts.strftime('%Y-%m-%d %H:00')
                if hour_key not in hourly_energy:
                    hourly_energy[hour_key] = {'wh': 0, 'readings': 0}
                hourly_energy[hour_key]['wh'] += energy_wh
                hourly_energy[hour_key]['readings'] += 1

            # Calculate time coverage (what % of the requested period has data)
            # Count actual integrated time (excluding gaps) for accurate average power
            total_integrated_seconds = 0
            for i in range(len(rows) - 1):
                current_ts = datetime.fromisoformat(rows[i]['timestamp'])
                next_ts = datetime.fromisoformat(rows[i + 1]['timestamp'])
                interval_seconds = (next_ts - current_ts).total_seconds()
                if interval_seconds <= 900:
                    total_integrated_seconds += interval_seconds

            if rows:
                first_ts = datetime.fromisoformat(rows[0]['timestamp'])
                last_ts = datetime.fromisoformat(rows[-1]['timestamp'])
                actual_span = (last_ts - first_ts).total_seconds() / 3600
                time_coverage = (actual_span / hours) * 100 if hours > 0 else 0
            else:
                time_coverage = 0

            # Calculate average power from actual readings (for extrapolation when coverage is low)
            avg_power_watts = (total_energy_wh / (total_integrated_seconds / 3600)) if total_integrated_seconds > 0 else 0

            # Convert hourly breakdown to list
            hourly_breakdown = [
                {'hour': k, 'kwh': v['wh'] / 1000, 'readings': v['readings']}
                for k, v in sorted(hourly_energy.items())
            ]

            return {
                'total_kwh': total_energy_wh / 1000,
                'readings_count': readings_count,
                'time_coverage_percent': min(100, time_coverage),
                'avg_power_watts': round(avg_power_watts, 2),
                'integrated_hours': round(total_integrated_seconds / 3600, 2),
                'hourly_breakdown': hourly_breakdown
            }

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
        cutoff = (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d %H:%M:%S')
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT * FROM profitability_log
                WHERE timestamp > ?
                ORDER BY timestamp DESC
            """, (cutoff,))
            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    def get_aggregate_stats(self, hours: int = 24) -> Dict:
        """Get aggregated stats over a time period"""
        # Use Python datetime to avoid UTC/localtime issues with SQLite
        cutoff = (datetime.now() - timedelta(hours=hours)).strftime('%Y-%m-%d %H:%M:%S')

        with self._get_connection() as conn:
            cursor = conn.cursor()

            # Calculate shares earned in period (difference between latest and earliest)
            # For each miner, get max - min shares in the period
            cursor.execute("""
                SELECT
                    COALESCE(SUM(shares_gained), 0) as total_shares_accepted,
                    COALESCE(SUM(rejected_gained), 0) as total_shares_rejected
                FROM (
                    SELECT
                        miner_id,
                        MAX(shares_accepted) - MIN(shares_accepted) as shares_gained,
                        MAX(shares_rejected) - MIN(shares_rejected) as rejected_gained
                    FROM stats
                    WHERE timestamp > ?
                    AND status = 'online'
                    GROUP BY miner_id
                )
            """, (cutoff,))
            shares_row = cursor.fetchone()

            # Fallback: If delta is 0, get current total shares from latest stats per miner
            # This handles mock miners and cases where shares haven't changed
            shares_accepted = shares_row['total_shares_accepted'] if shares_row else 0
            shares_rejected = shares_row['total_shares_rejected'] if shares_row else 0

            if shares_accepted == 0:
                cursor.execute("""
                    SELECT
                        COALESCE(SUM(shares_accepted), 0) as current_shares_accepted,
                        COALESCE(SUM(shares_rejected), 0) as current_shares_rejected
                    FROM (
                        SELECT miner_id, shares_accepted, shares_rejected
                        FROM stats s1
                        WHERE timestamp = (
                            SELECT MAX(timestamp) FROM stats s2
                            WHERE s2.miner_id = s1.miner_id
                            AND timestamp > ?
                        )
                        AND status = 'online'
                    )
                """, (cutoff,))
                current_row = cursor.fetchone()
                if current_row:
                    shares_accepted = current_row['current_shares_accepted'] or 0
                    shares_rejected = current_row['current_shares_rejected'] or 0

            # Calculate average fleet power by grouping readings into time buckets
            # Group by 30-second intervals to match the update frequency
            cursor.execute("""
                SELECT
                    AVG(fleet_power) as avg_fleet_power,
                    MAX(fleet_power) as max_power,
                    MIN(fleet_power) as min_power,
                    AVG(avg_temp) as avg_temperature,
                    AVG(total_hashrate) as avg_hashrate
                FROM (
                    SELECT
                        (strftime('%s', timestamp) / 30) as time_bucket,
                        SUM(power) as fleet_power,
                        AVG(temperature) as avg_temp,
                        SUM(hashrate) as total_hashrate
                    FROM stats
                    WHERE timestamp > ?
                    AND status = 'online'
                    GROUP BY time_bucket
                    HAVING COUNT(DISTINCT miner_id) > 0
                )
            """, (cutoff,))
            power_row = cursor.fetchone()

            # Get best difficulty
            cursor.execute("""
                SELECT MAX(best_difficulty) as best_difficulty
                FROM stats
                WHERE timestamp > ?
                AND status = 'online'
            """, (cutoff,))
            diff_row = cursor.fetchone()

            return {
                'total_shares_accepted': shares_accepted,
                'total_shares_rejected': shares_rejected,
                'avg_power': power_row['avg_fleet_power'] if power_row else 0,
                'max_power': power_row['max_power'] if power_row else 0,
                'min_power': power_row['min_power'] if power_row else 0,
                'avg_temperature': power_row['avg_temperature'] if power_row else 0,
                'avg_hashrate': power_row['avg_hashrate'] if power_row else 0,
                'best_difficulty': diff_row['best_difficulty'] if diff_row else 0
            }

    def get_scoring_shares(self, hours: int = 1, miner_id: int = None) -> Dict:
        """Estimate PPLNS scoring shares using exponential decay.

        Uses the formula: score = sum(share_delta * exp(-age / C))
        where C=300 seconds (standard decay constant, same as Braiins/Slush).
        Recent shares (0-5 min) carry most weight; shares >25 min old are negligible.
        """
        DECAY_CONSTANT = 300  # seconds
        cutoff = (datetime.now() - timedelta(hours=hours)).strftime('%Y-%m-%d %H:%M:%S')
        now = datetime.now()

        with self._get_connection() as conn:
            cursor = conn.cursor()

            query = """
                SELECT s.miner_id, m.ip, s.timestamp,
                       COALESCE(s.shares_accepted, 0) as shares_accepted
                FROM stats s
                JOIN miners m ON s.miner_id = m.id
                WHERE s.timestamp > ?
                AND s.status = 'online'
            """
            params = [cutoff]

            if miner_id is not None:
                query += " AND s.miner_id = ?"
                params.append(miner_id)

            query += " ORDER BY s.miner_id, s.timestamp ASC"

            cursor.execute(query, params)
            rows = cursor.fetchall()

            per_miner = {}
            current_miner_id = None
            prev_row = None

            for row in rows:
                mid = row['miner_id']
                ip = row['ip']
                ts_raw = row['timestamp']
                try:
                    ts = datetime.strptime(ts_raw, '%Y-%m-%d %H:%M:%S')
                except ValueError:
                    ts = datetime.strptime(ts_raw[:19], '%Y-%m-%d %H:%M:%S')
                shares = row['shares_accepted']

                if mid != current_miner_id:
                    current_miner_id = mid
                    prev_row = (ts, shares, ip)
                    if ip not in per_miner:
                        per_miner[ip] = 0.0
                    continue

                prev_ts, prev_shares, _ = prev_row
                share_delta = shares - prev_shares
                interval = (ts - prev_ts).total_seconds()

                prev_row = (ts, shares, ip)

                # Skip counter resets (miner reboot) or data gaps
                if share_delta <= 0 or interval > 300:
                    continue

                midpoint = prev_ts + (ts - prev_ts) / 2
                age = (now - midpoint).total_seconds()
                weight = math.exp(-age / DECAY_CONSTANT)
                per_miner[ip] = per_miner.get(ip, 0.0) + share_delta * weight

            total = sum(per_miner.values())

            return {
                'total_scoring_shares': round(total, 2),
                'per_miner': {ip: round(score, 2) for ip, score in per_miner.items()},
                'decay_constant': DECAY_CONSTANT
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
        cutoff = (datetime.now() - timedelta(hours=hours)).strftime('%Y-%m-%d %H:%M:%S')
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT * FROM alert_history
                WHERE timestamp > ?
                ORDER BY timestamp DESC
            """, (cutoff,))
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

    # Settings methods (key-value store)

    def set_setting(self, key: str, value: str):
        """Set a setting value"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO settings (key, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
            """, (key, value, datetime.now()))

    def get_setting(self, key: str, default: str = None) -> Optional[str]:
        """Get a setting value"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT value FROM settings WHERE key = ?", (key,))
            row = cursor.fetchone()
            return row['value'] if row else default

    def delete_setting(self, key: str):
        """Delete a setting"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM settings WHERE key = ?", (key,))

    # Miner Group Management Methods

    def create_group(self, name: str, color: str = '#3498db', description: str = None) -> int:
        """Create a new miner group"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO miner_groups (name, color, description)
                VALUES (?, ?, ?)
            """, (name, color, description))
            return cursor.lastrowid

    def update_group(self, group_id: int, name: str = None, color: str = None, description: str = None):
        """Update an existing group"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            updates = []
            params = []
            if name is not None:
                updates.append("name = ?")
                params.append(name)
            if color is not None:
                updates.append("color = ?")
                params.append(color)
            if description is not None:
                updates.append("description = ?")
                params.append(description)
            if updates:
                params.append(group_id)
                cursor.execute(f"""
                    UPDATE miner_groups SET {', '.join(updates)} WHERE id = ?
                """, params)

    def delete_group(self, group_id: int):
        """Delete a group (members are automatically removed via CASCADE)"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM miner_groups WHERE id = ?", (group_id,))

    def get_all_groups(self) -> List[Dict]:
        """Get all miner groups with member count"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT g.*, COUNT(m.id) as member_count
                FROM miner_groups g
                LEFT JOIN miner_group_members m ON g.id = m.group_id
                GROUP BY g.id
                ORDER BY g.name
            """)
            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    def get_group(self, group_id: int) -> Optional[Dict]:
        """Get a specific group"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM miner_groups WHERE id = ?", (group_id,))
            row = cursor.fetchone()
            return dict(row) if row else None

    def add_miner_to_group(self, miner_ip: str, group_id: int):
        """Add a miner to a group"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT OR IGNORE INTO miner_group_members (miner_ip, group_id)
                VALUES (?, ?)
            """, (miner_ip, group_id))

    def remove_miner_from_group(self, miner_ip: str, group_id: int):
        """Remove a miner from a group"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                DELETE FROM miner_group_members WHERE miner_ip = ? AND group_id = ?
            """, (miner_ip, group_id))

    def get_miner_groups(self, miner_ip: str) -> List[Dict]:
        """Get all groups a miner belongs to"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT g.* FROM miner_groups g
                JOIN miner_group_members m ON g.id = m.group_id
                WHERE m.miner_ip = ?
                ORDER BY g.name
            """, (miner_ip,))
            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    def get_group_members(self, group_id: int) -> List[str]:
        """Get all miner IPs in a group"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT miner_ip FROM miner_group_members WHERE group_id = ?
            """, (group_id,))
            rows = cursor.fetchall()
            return [row['miner_ip'] for row in rows]

    def set_miner_groups(self, miner_ip: str, group_ids: List[int]):
        """Set the groups for a miner (replaces existing memberships)"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            # Remove from all groups first
            cursor.execute("DELETE FROM miner_group_members WHERE miner_ip = ?", (miner_ip,))
            # Add to specified groups
            for group_id in group_ids:
                cursor.execute("""
                    INSERT INTO miner_group_members (miner_ip, group_id)
                    VALUES (?, ?)
                """, (miner_ip, group_id))

    # Pool Configuration Methods
    def add_pool_config(self, miner_ip: str, pool_index: int, pool_name: str,
                       pool_url: str, pool_port: int = 3333, stratum_user: str = None,
                       stratum_password: str = 'x', fee_percent: float = 2.0,
                       pool_type: str = 'FPPS', pool_difficulty: float = None):
        """Add or update pool configuration for a miner"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO pool_config (
                    miner_ip, pool_index, pool_name, pool_url, pool_port,
                    stratum_user, stratum_password, fee_percent, pool_type,
                    pool_difficulty, active, last_updated
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
                ON CONFLICT (miner_ip, pool_index) DO UPDATE SET
                    pool_name = excluded.pool_name,
                    pool_url = excluded.pool_url,
                    pool_port = excluded.pool_port,
                    stratum_user = excluded.stratum_user,
                    stratum_password = excluded.stratum_password,
                    fee_percent = excluded.fee_percent,
                    pool_type = excluded.pool_type,
                    pool_difficulty = excluded.pool_difficulty,
                    last_updated = excluded.last_updated
            """, (miner_ip, pool_index, pool_name, pool_url, pool_port,
                  stratum_user, stratum_password, fee_percent, pool_type,
                  pool_difficulty, datetime.now()))

    def get_pool_config(self, miner_ip: str = None, pool_name: str = None) -> List[Dict]:
        """Get pool configuration(s)"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            if miner_ip and pool_name:
                cursor.execute("""
                    SELECT * FROM pool_config
                    WHERE miner_ip = ? AND pool_name = ? AND active = 1
                    ORDER BY pool_index
                """, (miner_ip, pool_name))
            elif miner_ip:
                cursor.execute("""
                    SELECT * FROM pool_config
                    WHERE miner_ip = ? AND active = 1
                    ORDER BY pool_index
                """, (miner_ip,))
            elif pool_name:
                cursor.execute("""
                    SELECT * FROM pool_config
                    WHERE pool_name = ? AND active = 1
                    ORDER BY miner_ip, pool_index
                """, (pool_name,))
            else:
                cursor.execute("""
                    SELECT * FROM pool_config
                    WHERE active = 1
                    ORDER BY miner_ip, pool_index
                """)
            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    def update_pool_difficulty(self, miner_ip: str, pool_index: int, pool_difficulty: float):
        """Update pool difficulty for a specific miner's pool"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                UPDATE pool_config
                SET pool_difficulty = ?, last_updated = ?
                WHERE miner_ip = ? AND pool_index = ?
            """, (pool_difficulty, datetime.now(), miner_ip, pool_index))

    def add_pool_earnings(self, miner_ip: str, pool_name: str, earned_sats: int = 0,
                         shares_accepted: int = 0, shares_rejected: int = 0,
                         pool_difficulty: float = None, estimated_sats: int = 0,
                         data_source: str = 'calculated'):
        """Log pool earnings data"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            variance_percent = None
            if earned_sats > 0 and estimated_sats > 0:
                variance_percent = ((earned_sats - estimated_sats) / estimated_sats) * 100

            cursor.execute("""
                INSERT INTO pool_earnings (
                    timestamp, miner_ip, pool_name, earned_sats,
                    shares_accepted, shares_rejected, pool_difficulty,
                    estimated_sats, variance_percent, data_source
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (datetime.now(), miner_ip, pool_name, earned_sats,
                  shares_accepted, shares_rejected, pool_difficulty,
                  estimated_sats, variance_percent, data_source))

    def get_pool_earnings_history(self, miner_ip: str = None, pool_name: str = None,
                                  hours: int = 24) -> List[Dict]:
        """Get pool earnings history"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            since = datetime.now() - timedelta(hours=hours)

            if miner_ip and pool_name:
                cursor.execute("""
                    SELECT * FROM pool_earnings
                    WHERE miner_ip = ? AND pool_name = ? AND timestamp >= ?
                    ORDER BY timestamp DESC
                """, (miner_ip, pool_name, since))
            elif miner_ip:
                cursor.execute("""
                    SELECT * FROM pool_earnings
                    WHERE miner_ip = ? AND timestamp >= ?
                    ORDER BY timestamp DESC
                """, (miner_ip, since))
            elif pool_name:
                cursor.execute("""
                    SELECT * FROM pool_earnings
                    WHERE pool_name = ? AND timestamp >= ?
                    ORDER BY timestamp DESC
                """, (pool_name, since))
            else:
                cursor.execute("""
                    SELECT * FROM pool_earnings
                    WHERE timestamp >= ?
                    ORDER BY timestamp DESC
                """, (since,))

            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    # Energy Rate History Methods
    def add_energy_rate_history(self, rate_id: int, effective_date: str,
                                rate_per_kwh: float, rate_type: str, end_date: str = None):
        """Add historical energy rate entry"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO energy_rates_history (
                    rate_id, effective_date, end_date, rate_per_kwh, rate_type
                ) VALUES (?, ?, ?, ?, ?)
            """, (rate_id, effective_date, end_date, rate_per_kwh, rate_type))

    def get_historical_rate(self, timestamp: datetime) -> Optional[Dict]:
        """Get the energy rate that was active at a specific time"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            date_str = timestamp.strftime('%Y-%m-%d')
            time_str = timestamp.strftime('%H:%M:%S')
            day_of_week = timestamp.strftime('%A')

            # First try to get from history table
            cursor.execute("""
                SELECT erh.*, er.day_of_week, er.start_time, er.end_time
                FROM energy_rates_history erh
                JOIN energy_rates er ON erh.rate_id = er.id
                WHERE erh.effective_date <= ?
                AND (erh.end_date IS NULL OR erh.end_date >= ?)
                AND (er.day_of_week IS NULL OR er.day_of_week = ?)
                AND er.start_time <= ? AND er.end_time > ?
                ORDER BY erh.effective_date DESC
                LIMIT 1
            """, (date_str, date_str, day_of_week, time_str, time_str))

            row = cursor.fetchone()
            if row:
                return dict(row)

            # Fallback to current energy_rates table
            cursor.execute("""
                SELECT * FROM energy_rates
                WHERE (day_of_week IS NULL OR day_of_week = ?)
                AND start_time <= ? AND end_time > ?
                ORDER BY id DESC
                LIMIT 1
            """, (day_of_week, time_str, time_str))

            row = cursor.fetchone()
            return dict(row) if row else None

    def get_energy_rate_history(self, rate_id: int = None,
                               start_date: str = None, end_date: str = None) -> List[Dict]:
        """Get energy rate history entries"""
        with self._get_connection() as conn:
            cursor = conn.cursor()

            query = "SELECT * FROM energy_rates_history WHERE 1=1"
            params = []

            if rate_id:
                query += " AND rate_id = ?"
                params.append(rate_id)
            if start_date:
                query += " AND effective_date >= ?"
                params.append(start_date)
            if end_date:
                query += " AND (end_date IS NULL OR end_date <= ?)"
                params.append(end_date)

            query += " ORDER BY effective_date DESC"

            cursor.execute(query, params)
            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    def get_efficiency_history(self, hours: int = 24) -> List[Dict]:
        """Get pre-computed efficiency (J/TH) history by joining power and hashrate from stats table.
        Groups by ~5min intervals and computes efficiency server-side to avoid timestamp mismatch bugs."""
        cutoff = (datetime.now() - timedelta(hours=hours)).strftime('%Y-%m-%d %H:%M:%S')

        # For 7d+ ranges, use hourly buckets; otherwise 5-minute buckets
        bucket_seconds = 3600 if hours > 48 else 300

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(f"""
                SELECT
                    MIN(timestamp) as timestamp,
                    ROUND(AVG(total_power), 1) as avg_power,
                    ROUND(AVG(total_hashrate), 2) as avg_hashrate,
                    CASE
                        WHEN AVG(total_hashrate) > 0
                        THEN ROUND(AVG(total_power) / (AVG(total_hashrate) / 1e12), 1)
                        ELSE 0
                    END as efficiency_jth,
                    COUNT(*) as readings
                FROM (
                    SELECT
                        timestamp,
                        (strftime('%s', timestamp) / {bucket_seconds}) as time_bucket,
                        SUM(power) as total_power,
                        SUM(hashrate) as total_hashrate
                    FROM stats
                    WHERE timestamp > ?
                    AND status IN ('online', 'overheating')
                    AND power > 0
                    AND hashrate > 0
                    GROUP BY timestamp
                ) grouped
                GROUP BY time_bucket
                ORDER BY timestamp ASC
            """, (cutoff,))
            rows = cursor.fetchall()
            return [dict(row) for row in rows]
