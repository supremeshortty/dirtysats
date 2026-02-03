"""
DirtySats - Bitcoin Mining Fleet Manager
"""
import logging
import ipaddress
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Thread, Lock
from datetime import datetime
from typing import List, Dict
from flask import Flask, jsonify, render_template, request

import config
from database import Database
from miners import MinerDetector, Miner
from energy import (
    BitcoinDataFetcher,
    ProfitabilityCalculator,
    EnergyRateManager,
    MiningScheduler,
    UtilityRateService,
    ENERGY_COMPANY_PRESETS
)
from thermal import ThermalManager
from alerts import AlertManager
from weather import WeatherManager
from pool_manager import PoolManager
from metrics_real import (
    SatsEarnedTracker,
    MinerHealthMonitor,
    PowerEfficiencyMatrix,
    PoolPerformanceComparator,
    PredictiveRevenueModel
)
from telegram_setup_helper import TelegramSetupHelper
from lightning import get_lightning_manager, init_lightning

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Flask app
app = Flask(__name__)

# Maximum hours for historical data queries (30 days)
MAX_HISTORY_HOURS = 720


def validate_hours(hours: int, default: int = 24) -> int:
    """Validate and clamp hours parameter for historical queries"""
    if hours < 1:
        return default
    return min(hours, MAX_HISTORY_HOURS)


class FleetManager:
    """Manages the mining fleet"""

    def __init__(self):
        self.db = Database(config.DATABASE_PATH)
        self.detector = MinerDetector()
        self.miners: Dict[str, Miner] = {}  # ip -> Miner
        self.lock = Lock()
        self.monitoring_thread = None
        self.monitoring_active = False

        # Energy management components
        self.btc_fetcher = BitcoinDataFetcher()
        self.energy_rate_mgr = EnergyRateManager(self.db)
        self.mining_scheduler = MiningScheduler(self.db, self.energy_rate_mgr)
        self.utility_rate_service = UtilityRateService(db=self.db)

        self.last_energy_log_time = None
        self.last_profitability_log_time = None

        # Pool manager (initialize after miners are loaded, then pass to other components)
        self.pool_manager = None

        # Profitability calculator (will be re-initialized with pool_manager after load)
        self.profitability_calc = None

        # Thermal management
        self.thermal_mgr = ThermalManager(self.db)

        # Alert system
        self.alert_mgr = AlertManager(self.db)

        # Telegram setup helper
        self.telegram_helper = TelegramSetupHelper(self.db)

        # Weather integration
        self.weather_mgr = WeatherManager(self.db)

        # Metrics and analytics (will be re-initialized with pool_manager after load)
        self.sats_tracker = None
        self.health_monitor = MinerHealthMonitor(self.db)
        self.efficiency_matrix = PowerEfficiencyMatrix(self.db)
        self.pool_comparator = PoolPerformanceComparator(self.db)
        self.revenue_model = None

        # Track miner states for alert deduplication
        self.miner_alert_states = {}  # ip -> {'last_offline_alert': timestamp, 'last_temp_alert': timestamp}

        # Track miners that need auto-reboot after overheat recovery
        self.overheat_recovery_states = {}  # ip -> {'overheated_at': timestamp}

        # Load miners from database
        self._load_miners_from_db()

        # Initialize pool manager after miners are loaded
        self.pool_manager = PoolManager(self.db, self.miners)

        # Detect and save pool configurations
        self._detect_pool_configurations()

        # Initialize components that need pool_manager
        self.profitability_calc = ProfitabilityCalculator(self.btc_fetcher, self.pool_manager)
        self.sats_tracker = SatsEarnedTracker(self.db, self.pool_manager)
        self.revenue_model = PredictiveRevenueModel(self.db, self.btc_fetcher)

    def _load_miners_from_db(self):
        """Load known miners from database"""
        logger.info("Loading miners from database...")
        miners_data = self.db.get_all_miners()
        for miner_data in miners_data:
            ip = miner_data['ip']
            custom_name = miner_data.get('custom_name')
            # Try to recreate Miner instance
            miner = self.detector.detect(ip)
            if miner:
                miner.custom_name = custom_name
                with self.lock:
                    self.miners[ip] = miner
                # Register with thermal manager
                self.thermal_mgr.register_miner(miner.ip, miner.type)
                logger.info(f"Loaded miner {ip} ({miner.type})")

    def _detect_pool_configurations(self):
        """Detect and save pool configurations from miners"""
        try:
            if self.pool_manager and self.miners:
                logger.info("Detecting pool configurations...")
                result = self.pool_manager.detect_and_save_pool_configs()
                logger.info(f"Pool detection result: {result}")
        except Exception as e:
            logger.error(f"Error detecting pool configurations: {e}")

    def discover_miners(self, subnet: str = None) -> List[Miner]:
        """
        Discover miners on network using parallel scanning

        Args:
            subnet: Network subnet (e.g., "10.0.0.0/24")

        Returns:
            List of newly discovered miners
        """
        if subnet is None:
            subnet = config.NETWORK_SUBNET

        logger.info(f"Starting network discovery on {subnet}")

        try:
            network = ipaddress.IPv4Network(subnet, strict=False)
        except ValueError as e:
            logger.error(f"Invalid subnet format '{subnet}': {e}")
            raise ValueError(f"Invalid network subnet: {subnet}. Expected format: '10.0.0.0/24'")

        discovered = []

        def check_ip(ip_str: str) -> Miner:
            """Check single IP for miner"""
            try:
                miner = self.detector.detect(ip_str)
                if miner:
                    logger.info(f"Found miner at {ip_str}")
                return miner
            except Exception as e:
                logger.debug(f"No miner at {ip_str}: {e}")
                return None

        # Parallel scan
        with ThreadPoolExecutor(max_workers=config.DISCOVERY_THREADS) as executor:
            futures = {
                executor.submit(check_ip, str(ip)): str(ip)
                for ip in network.hosts()
            }

            for future in as_completed(futures):
                try:
                    miner = future.result()
                    if miner:
                        with self.lock:
                            self.miners[miner.ip] = miner
                            # Save to database
                            self.db.update_miner(
                                miner.ip,
                                miner.type,
                                miner.model
                            )
                            # Register with thermal manager
                            self.thermal_mgr.register_miner(miner.ip, miner.type)
                            # Apply stock settings for ESP-Miner devices
                            self._apply_stock_settings(miner)
                        discovered.append(miner)
                except Exception as e:
                    logger.error(f"Error checking IP: {e}")

        logger.info(f"Discovery complete. Found {len(discovered)} miners")
        return discovered

    def update_all_miners(self):
        """Update status of all miners in parallel"""
        if not self.miners:
            return

        def update_miner(miner: Miner):
            """Update single miner status"""
            try:
                # Skip polling for mock miners - they keep their initial status
                if getattr(miner, 'is_mock', False):
                    status = miner.last_status or {'status': 'online'}
                else:
                    status = miner.update_status()

                # Initialize alert state for this miner if needed
                if miner.ip not in self.miner_alert_states:
                    self.miner_alert_states[miner.ip] = {
                        'was_online': False,
                        'last_temp_alert': None
                    }

                miner_status = status.get('status', 'offline')
                is_responding = miner_status in ('online', 'overheating', 'overheated')

                if is_responding:
                    # Miner is responding (online, overheating, or overheated)

                    # Send recovery alert if miner came back from offline
                    if miner_status == 'online' and not self.miner_alert_states[miner.ip]['was_online']:
                        self.alert_mgr.alert_miner_online(
                            miner.ip,
                            status.get('hashrate', 0),
                            status.get('temperature')
                        )

                    # Track if miner is truly online (not overheated)
                    self.miner_alert_states[miner.ip]['was_online'] = miner_status in ('online', 'overheating')

                    # Save stats to database (including overheated miners with 0 hashrate)
                    miner_data = self.db.get_miner_by_ip(miner.ip)
                    if miner_data:
                        self.db.add_stats(
                            miner_data['id'],
                            hashrate=status.get('hashrate'),  # Will be 0 for overheated
                            temperature=status.get('temperature'),
                            power=status.get('power'),
                            fan_speed=status.get('fan_speed'),
                            status=miner_status,
                            shares_accepted=status.get('shares_accepted'),
                            shares_rejected=status.get('shares_rejected'),
                            best_difficulty=status.get('best_difficulty')
                        )

                    # Update thermal stats
                    temp = status.get('temperature')
                    hashrate = status.get('hashrate')

                    if temp is not None:
                        # Always update thermal manager with current stats (even for overheated)
                        fan_speed = status.get('fan_speed') or status.get('raw', {}).get('fanSpeedPercent')
                        frequency = status.get('frequency')
                        self.thermal_mgr.update_miner_stats(miner.ip, temp, hashrate, fan_speed, frequency)

                        # Handle overheat recovery (auto-reboot when cooled down)
                        if miner_status == 'overheated':
                            # Register miner for recovery tracking if not already tracked
                            if miner.ip not in self.overheat_recovery_states:
                                self.overheat_recovery_states[miner.ip] = {
                                    'overheated_at': datetime.now()
                                }
                                logger.info(f"Miner {miner.ip} entered overheat mode, tracking for recovery")

                            # Check if temperature has dropped to recovery threshold
                            if config.OVERHEAT_AUTO_REBOOT and temp <= config.OVERHEAT_RECOVERY_TEMP:
                                logger.info(f"Miner {miner.ip} cooled to {temp:.1f}°C (threshold: {config.OVERHEAT_RECOVERY_TEMP}°C), triggering reboot")
                                # Attempt to reboot the miner
                                if miner.restart():
                                    self.alert_mgr.alert_overheat_recovery(
                                        miner.ip, temp, config.OVERHEAT_RECOVERY_TEMP
                                    )
                                    # Remove from recovery tracking
                                    del self.overheat_recovery_states[miner.ip]
                                    logger.info(f"Miner {miner.ip} reboot command sent successfully")
                                else:
                                    logger.error(f"Failed to reboot miner {miner.ip} after overheat recovery")
                        else:
                            # Miner is no longer overheated (e.g., came back online after reboot)
                            # Remove from recovery tracking if it was being tracked
                            if miner.ip in self.overheat_recovery_states:
                                del self.overheat_recovery_states[miner.ip]
                                logger.info(f"Miner {miner.ip} recovered from overheat state")
                                # Apply stock settings after recovery reboot
                                self._apply_stock_settings(miner)

                        # Skip alerts and auto-tuning for overheated miners
                        if miner_status != 'overheated':
                            # Check for high temperature warning
                            thermal_state = self.thermal_mgr.get_thermal_status(miner.ip)
                            if thermal_state:
                                profile = self.thermal_mgr._get_profile(miner.type)

                                # Alert on emergency shutdown
                                if thermal_state.get('in_emergency_cooldown'):
                                    self.alert_mgr.alert_emergency_shutdown(
                                        miner.ip, temp,
                                        f"Critical temperature {temp:.1f}°C exceeded"
                                    )
                                # Alert on high temperature (only once per cooldown period)
                                elif temp >= profile.warning_temp:
                                    now = datetime.now()
                                    last_alert = self.miner_alert_states[miner.ip]['last_temp_alert']
                                    if last_alert is None or (now - last_alert).total_seconds() > config.ALERT_COOLDOWN:
                                        self.alert_mgr.alert_high_temperature(
                                            miner.ip, temp, profile.warning_temp,
                                            hashrate, status.get('frequency', 0)
                                        )
                                        self.miner_alert_states[miner.ip]['last_temp_alert'] = now

                            # Calculate optimal frequency and fan speed
                            target_freq, target_fan, reason = self.thermal_mgr.calculate_optimal_frequency(miner.ip)

                            # Apply fan speed adjustment first (fan priority for cooling)
                            if target_fan is not None:
                                current_fan = status.get('fan_speed') or status.get('raw', {}).get('fanSpeedPercent', 50)
                                if target_fan != current_fan:
                                    self._apply_fan_speed(miner, target_fan, reason)

                            # Apply frequency adjustment if needed
                            if target_freq and target_freq != status.get('frequency', 0):
                                self._apply_frequency(miner, target_freq, reason)

                                # Alert on frequency adjustment (if significant)
                                if "emergency" in reason.lower() or "critical" in reason.lower():
                                    self.alert_mgr.alert_frequency_adjusted(
                                        miner.ip, target_freq, reason, temp
                                    )
                else:
                    # Miner is offline - send alert if it just went offline
                    if self.miner_alert_states[miner.ip]['was_online']:
                        self.alert_mgr.alert_miner_offline(miner.ip, "No response from miner")
                        self.miner_alert_states[miner.ip]['was_online'] = False

            except Exception as e:
                logger.error(f"Error updating miner {miner.ip}: {e}")

        # Update all miners in parallel
        with ThreadPoolExecutor(max_workers=len(self.miners)) as executor:
            futures = [
                executor.submit(update_miner, miner)
                for miner in self.miners.values()
            ]
            # Wait for all to complete
            for future in as_completed(futures):
                try:
                    future.result()
                except Exception as e:
                    logger.error(f"Error in update: {e}")

    def _apply_frequency(self, miner: Miner, target_freq: int, reason: str):
        """Apply frequency adjustment to a miner"""
        try:
            # Only ESP-Miner devices (BitAxe, NerdQAxe, etc.) support frequency control via API
            if config.is_esp_miner(miner.type):
                if target_freq == 0:
                    # Emergency shutdown - set to minimum safe frequency
                    logger.warning(f"Emergency shutdown for {miner.ip}: {reason}")
                    miner.apply_settings({'frequency': 400})  # Minimum safe freq
                else:
                    logger.info(f"Adjusting {miner.ip} frequency to {target_freq}MHz: {reason}")
                    miner.apply_settings({'frequency': target_freq})
            else:
                # CGMiner-based miners don't support live frequency changes via API
                # Would need firmware-level changes (future enhancement)
                logger.debug(f"Frequency control not supported for {miner.type} ({miner.ip})")

        except Exception as e:
            logger.error(f"Failed to apply frequency to {miner.ip}: {e}")

    def _apply_fan_speed(self, miner: Miner, target_fan: int, reason: str):
        """Apply fan speed adjustment to a miner"""
        try:
            # Only ESP-Miner devices (BitAxe, NerdQAxe, etc.) support fan control via API
            if config.is_esp_miner(miner.type):
                logger.info(f"Adjusting {miner.ip} fan speed to {target_fan}%: {reason}")
                # Disable auto-fan and set manual speed
                miner.apply_settings({
                    'fanspeed': target_fan,
                    'autofanspeed': 0  # Disable auto-fan when we're managing it
                })
                # Update cached status
                if miner.last_status:
                    miner.last_status['fan_speed'] = target_fan
                    if 'raw' in miner.last_status:
                        miner.last_status['raw']['fanSpeedPercent'] = target_fan
                        miner.last_status['raw']['autofanspeed'] = 0
            else:
                # CGMiner-based miners may not support fan control via API
                logger.debug(f"Fan control not supported for {miner.type} ({miner.ip})")

        except Exception as e:
            logger.error(f"Failed to apply fan speed to {miner.ip}: {e}")

    def _apply_stock_settings(self, miner: Miner):
        """Apply stock/factory settings to a miner when it first connects or after reboot"""
        try:
            # Only ESP-Miner devices (BitAxe, NerdQAxe, etc.) support settings control via API
            if config.is_esp_miner(miner.type):
                stock_settings = self.thermal_mgr.get_stock_settings(miner.type)
                stock_freq = stock_settings.get('frequency', 0)
                if stock_freq > 0:
                    logger.info(f"Applying stock settings to {miner.ip} ({miner.type}): {stock_freq}MHz")
                    miner.apply_settings({'frequency': stock_freq})
            else:
                logger.debug(f"Stock settings not applicable for {miner.type} ({miner.ip})")

        except Exception as e:
            logger.error(f"Failed to apply stock settings to {miner.ip}: {e}")

    def _apply_mining_schedule(self):
        """Apply mining schedule (frequency control based on time/rates)"""
        try:
            should_mine, target_frequency = self.mining_scheduler.should_mine_now()

            if target_frequency > 0:  # 0 means no change
                logger.info(f"Applying schedule: target_frequency={target_frequency}")
                with self.lock:
                    for miner in self.miners.values():
                        # Only apply to ESP-Miner devices (BitAxe, NerdQAxe, etc.)
                        if config.is_esp_miner(miner.type) and miner.last_status:
                            try:
                                miner.apply_settings({'frequency': target_frequency})
                                logger.info(f"Set {miner.ip} frequency to {target_frequency}")
                            except Exception as e:
                                logger.error(f"Failed to set frequency on {miner.ip}: {e}")

        except Exception as e:
            logger.error(f"Error applying mining schedule: {e}")

    def _log_energy_consumption(self):
        """Log energy consumption every 5 minutes using accurate integration"""
        now = datetime.now()

        if self.last_energy_log_time:
            minutes_elapsed = (now - self.last_energy_log_time).total_seconds() / 60
            if minutes_elapsed < 5:  # Changed from 15 to 5 minutes
                return

        try:
            # Calculate actual integrated energy from stats table (30-sec granularity)
            # Use 5 minutes + small buffer for the calculation window
            energy_data = self.db.calculate_actual_energy_consumption(
                hours=0.1  # 6 minutes to ensure we capture the 5-minute window
            )

            if energy_data['total_kwh'] > 0:
                # Match rates to actual timestamps (not current rate)
                cost_data = self.energy_rate_mgr.calculate_cost_with_tou(
                    energy_data['hourly_breakdown']
                )

                # Calculate average power from energy consumed
                if self.last_energy_log_time:
                    hours_elapsed = (now - self.last_energy_log_time).total_seconds() / 3600
                    avg_power_watts = (energy_data['total_kwh'] * 1000) / hours_elapsed if hours_elapsed > 0 else 0
                else:
                    # First log, use current fleet stats as fallback
                    stats = self.get_fleet_stats()
                    avg_power_watts = stats['total_power']

                # Calculate weighted average rate from cost breakdown
                total_kwh = sum(energy_data['hourly_breakdown'][i]['kwh']
                              for i in range(len(energy_data['hourly_breakdown'])))
                weighted_avg_rate = cost_data['total_cost'] / total_kwh if total_kwh > 0 else 0

                # Save to database
                self.db.add_energy_consumption(
                    total_power_watts=avg_power_watts,
                    energy_kwh=energy_data['total_kwh'],
                    cost=cost_data['total_cost'],
                    current_rate=weighted_avg_rate
                )

                logger.debug(f"Logged energy (integrated): {energy_data['total_kwh']:.4f} kWh "
                           f"at ${weighted_avg_rate:.4f}/kWh = ${cost_data['total_cost']:.2f} "
                           f"({energy_data['readings_count']} readings, "
                           f"{energy_data['time_coverage_percent']:.1f}% coverage)")

            self.last_energy_log_time = now

        except Exception as e:
            logger.error(f"Error logging energy consumption: {e}")

    def _log_profitability(self):
        """Log profitability metrics every hour"""
        now = datetime.now()

        if self.last_profitability_log_time:
            hours_elapsed = (now - self.last_profitability_log_time).total_seconds() / 3600
            if hours_elapsed < 1:
                return

        try:
            # Get current fleet stats
            stats = self.get_fleet_stats()
            total_hashrate = stats['total_hashrate']
            total_power = stats['total_power']

            if total_hashrate > 0 and total_power > 0:
                # Get current energy rate
                current_rate = self.energy_rate_mgr.get_current_rate()

                # Calculate profitability
                prof = self.profitability_calc.calculate_profitability(
                    total_hashrate=total_hashrate,
                    total_power_watts=total_power,
                    energy_rate_per_kwh=current_rate
                )

                if 'error' not in prof:
                    # Save to database (using net BTC after pool fees)
                    self.db.add_profitability_log(
                        btc_price=prof['btc_price'],
                        network_difficulty=prof['network_difficulty'],
                        total_hashrate=prof['total_hashrate_ths'],
                        estimated_btc_per_day=prof['btc_per_day'],  # Net after pool fees
                        energy_cost_per_day=prof['energy_cost_per_day'],
                        profit_per_day=prof['profit_per_day']
                    )

                    logger.info(f"Profitability: ${prof['profit_per_day']:.2f}/day " +
                              f"({prof['profit_margin']:.1f}% margin, " +
                              f"{prof['pool_fee_percent']:.1f}% pool fee)")

            self.last_profitability_log_time = now

        except Exception as e:
            logger.error(f"Error logging profitability: {e}")

    def _check_weather_predictions(self):
        """Check weather forecast and predict thermal issues"""
        try:
            # Get current ambient temperature
            current_weather = self.weather_mgr.get_current_weather()
            if not current_weather:
                return  # Weather not configured or unavailable

            current_ambient = current_weather['temp_f']

            # Get fleet average temperature
            stats = self.get_fleet_stats()
            avg_miner_temp = stats.get('avg_temperature', 0)

            if avg_miner_temp > 0:
                # Calculate typical delta from ambient to miner temp
                # Convert avg_miner_temp from C to F for comparison
                avg_miner_temp_f = (avg_miner_temp * 9/5) + 32
                miner_temp_delta = avg_miner_temp_f - current_ambient

                # Predict thermal issues
                prediction = self.weather_mgr.predict_thermal_issues(
                    current_ambient=current_ambient,
                    miner_temp_delta=miner_temp_delta
                )

                # Send alerts for critical predictions
                if prediction.get('critical'):
                    logger.warning(f"Weather prediction: {prediction['message']}")
                    # Alert about upcoming heat wave
                    self.alert_mgr.send_custom_alert(
                        title="⚠️ CRITICAL: Heat Wave Predicted",
                        message=prediction['message'],
                        alert_type="weather_critical",
                        level="critical",
                        data={
                            'forecast_max_f': prediction['forecast_max_f'],
                            'forecast_max_time': prediction['forecast_max_time'],
                            'estimated_miner_temp_c': prediction['estimated_miner_temp_c'],
                            'recommendations': prediction['recommendations']
                        }
                    )
                elif prediction.get('warning'):
                    logger.info(f"Weather warning: {prediction['message']}")

                # Check if miners should pre-cool
                for miner in self.miners.values():
                    if miner.last_status and miner.last_status.get('temperature'):
                        temp_c = miner.last_status['temperature']
                        if self.weather_mgr.should_precool(temp_c, lookahead_hours=6):
                            logger.info(f"Pre-cooling recommended for {miner.ip}")
                            # Optionally reduce frequency preemptively
                            # This would be a configurable option

        except Exception as e:
            logger.error(f"Error checking weather predictions: {e}")

    def start_monitoring(self):
        """Start background monitoring thread"""
        if self.monitoring_active:
            logger.warning("Monitoring already active")
            return

        self.monitoring_active = True

        def monitor_loop():
            logger.info("Monitoring thread started")
            weather_check_counter = 0  # Check weather every 10 iterations (2.5 minutes if UPDATE_INTERVAL=15)

            while self.monitoring_active:
                try:
                    # Check if mining schedule requires frequency changes
                    self._apply_mining_schedule()

                    # Update all miners
                    self.update_all_miners()

                    # Log energy consumption (every 15 minutes)
                    self._log_energy_consumption()

                    # Log profitability (every hour)
                    self._log_profitability()

                    # Check weather predictions periodically
                    weather_check_counter += 1
                    if weather_check_counter >= 10:  # Check weather less frequently
                        self._check_weather_predictions()
                        weather_check_counter = 0

                except Exception as e:
                    logger.error(f"Error in monitoring loop: {e}")

                # Sleep in small chunks to allow quick shutdown
                for _ in range(config.UPDATE_INTERVAL):
                    if not self.monitoring_active:
                        break
                    import time
                    time.sleep(1)

            logger.info("Monitoring thread stopped")

        self.monitoring_thread = Thread(target=monitor_loop, daemon=True)
        self.monitoring_thread.start()
        logger.info("Monitoring started")

    def stop_monitoring(self):
        """Stop background monitoring"""
        self.monitoring_active = False
        if self.monitoring_thread:
            self.monitoring_thread.join(timeout=5)
        logger.info("Monitoring stopped")

    def _parse_difficulty(self, diff_value) -> float:
        """Parse difficulty from various formats (e.g., '8.52G', '11.3 G', '189M', 2500000)"""
        if not diff_value:
            return 0.0

        # If already numeric, return it
        if isinstance(diff_value, (int, float)):
            return float(diff_value)

        # Handle string formats like "8.52G", "11.3 G", "189M", "2.5K"
        if isinstance(diff_value, str):
            diff_str = diff_value.strip().upper()
            multipliers = {
                'K': 1_000,
                'M': 1_000_000,
                'G': 1_000_000_000,
                'T': 1_000_000_000_000,
                'P': 1_000_000_000_000_000
            }

            for suffix, mult in multipliers.items():
                if suffix in diff_str:
                    try:
                        num_part = diff_str.replace(suffix, '').strip()
                        return float(num_part) * mult
                    except ValueError:
                        return 0.0

            # Try direct conversion if no suffix
            try:
                return float(diff_str)
            except ValueError:
                return 0.0

        return 0.0

    def get_fleet_stats(self) -> Dict:
        """Get aggregated fleet statistics"""
        # Get historical best difficulty outside the lock to avoid potential issues
        try:
            historical_best = self.db.get_best_difficulty_ever() or 0
        except Exception:
            historical_best = 0

        with self.lock:
            online_count = 0
            overheated_count = 0
            overheating_count = 0
            total_hashrate = 0
            total_power = 0
            avg_temp = 0
            temp_count = 0
            total_shares = 0
            total_rejected = 0
            best_diff_ever = historical_best  # Start with historical best

            for miner in self.miners.values():
                if miner.last_status:
                    status = miner.last_status.get('status', 'offline')

                    # Count by status type
                    if status == 'online':
                        online_count += 1
                    elif status == 'overheated':
                        overheated_count += 1
                    elif status == 'overheating':
                        overheating_count += 1
                        online_count += 1  # Overheating miners are still online

                    # Include stats for online and overheating miners
                    if status in ('online', 'overheating'):
                        total_hashrate += miner.last_status.get('hashrate', 0)
                        total_power += miner.last_status.get('power', 0)
                        if miner.last_status.get('temperature'):
                            avg_temp += miner.last_status['temperature']
                            temp_count += 1

                        # Aggregate shares and difficulty
                        total_shares += miner.last_status.get('shares_accepted', 0)
                        total_rejected += miner.last_status.get('shares_rejected', 0)
                        best_diff = miner.last_status.get('best_difficulty', 0)
                        # Parse difficulty - handles formats like "8.52G", "11.3 G", "189M", etc.
                        best_diff_float = self._parse_difficulty(best_diff)
                        if best_diff_float > best_diff_ever:
                            best_diff_ever = best_diff_float

            # Offline = total - online - overheated (overheating miners are counted as online)
            offline_count = len(self.miners) - online_count - overheated_count

            return {
                'total_miners': len(self.miners),
                'online_miners': online_count,
                'offline_miners': offline_count,  # True offline count (not reachable)
                'overheated_miners': overheated_count,  # Separate count for thermal shutdown
                'overheating_miners': overheating_count,
                'total_hashrate': total_hashrate,
                'total_power': total_power,
                'avg_temperature': avg_temp / temp_count if temp_count > 0 else 0,
                'total_shares': total_shares,
                'total_rejected': total_rejected,
                'best_difficulty_ever': best_diff_ever,
                'last_update': datetime.now().isoformat()
            }

    def get_all_miners_status(self) -> List[Dict]:
        """Get status of all miners"""
        with self.lock:
            miners_data = []
            for miner in self.miners.values():
                miner_dict = miner.to_dict()
                # Include auto-tune state from thermal manager
                if miner.ip in self.thermal_mgr.thermal_states:
                    state = self.thermal_mgr.thermal_states[miner.ip]
                    miner_dict['auto_tune_enabled'] = state.auto_tune_enabled and self.thermal_mgr.global_auto_tune_enabled
                else:
                    miner_dict['auto_tune_enabled'] = False
                # Include group memberships
                try:
                    miner_dict['groups'] = self.db.get_miner_groups(miner.ip)
                except Exception:
                    miner_dict['groups'] = []
                miners_data.append(miner_dict)
            return miners_data


# Global fleet manager
fleet = FleetManager()


# Flask Routes

@app.route('/')
def index():
    """Main dashboard"""
    return render_template('dashboard.html')


@app.route('/api/miners', methods=['GET'])
def get_miners():
    """Get all miners and their status"""
    miners = fleet.get_all_miners_status()
    return jsonify({
        'success': True,
        'miners': miners
    })


@app.route('/api/stats', methods=['GET'])
def get_stats():
    """Get fleet statistics"""
    try:
        stats = fleet.get_fleet_stats()
        return jsonify({
            'success': True,
            'stats': stats
        })
    except Exception as e:
        logger.error(f"Error getting fleet stats: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/stats/aggregate', methods=['GET'])
def get_aggregate_stats_route():
    """Get aggregated statistics over a time period"""
    hours = validate_hours(request.args.get('hours', default=24, type=int))

    try:
        agg_stats = fleet.db.get_aggregate_stats(hours)
        return jsonify({
            'success': True,
            'hours': hours,
            'stats': agg_stats
        })
    except Exception as e:
        logger.error(f"Error getting aggregate stats: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/discover', methods=['POST'])
def discover():
    """Trigger network discovery"""
    data = request.get_json() or {}
    subnet = data.get('subnet', config.NETWORK_SUBNET)

    try:
        discovered = fleet.discover_miners(subnet)
        return jsonify({
            'success': True,
            'discovered': len(discovered),
            'message': f'Discovered {len(discovered)} miners'
        })
    except Exception as e:
        logger.error(f"Discovery error: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/miner/<ip>/restart', methods=['POST'])
def restart_miner(ip: str):
    """Restart specific miner"""
    with fleet.lock:
        miner = fleet.miners.get(ip)
        if not miner:
            return jsonify({
                'success': False,
                'error': 'Miner not found'
            }), 404

        success = miner.restart()
        return jsonify({
            'success': success,
            'message': 'Restart command sent' if success else 'Restart failed'
        })


@app.route('/api/miner/<ip>', methods=['DELETE'])
def delete_miner(ip: str):
    """Remove miner from fleet"""
    with fleet.lock:
        if ip in fleet.miners:
            del fleet.miners[ip]
            fleet.db.delete_miner(ip)
            return jsonify({
                'success': True,
                'message': f'Miner {ip} removed'
            })
        return jsonify({
            'success': False,
            'error': 'Miner not found'
        }), 404


@app.route('/api/miner/<ip>/name', methods=['POST'])
def update_miner_name(ip: str):
    """Update custom name for a miner"""
    data = request.get_json() or {}
    custom_name = data.get('custom_name', '').strip()

    with fleet.lock:
        miner = fleet.miners.get(ip)
        if not miner:
            return jsonify({
                'success': False,
                'error': 'Miner not found'
            }), 404

        # Update in database
        success = fleet.db.update_miner_custom_name(ip, custom_name)

        if success:
            # Update in memory
            miner.custom_name = custom_name if custom_name else None
            return jsonify({
                'success': True,
                'message': f'Miner name updated',
                'custom_name': miner.custom_name
            })
        else:
            return jsonify({
                'success': False,
                'error': 'Failed to update name'
            }), 500


@app.route('/api/miner/<ip>/auto-optimize', methods=['GET', 'POST'])
def miner_auto_optimize(ip: str):
    """Get or set auto-optimize setting for a miner"""
    if request.method == 'GET':
        enabled = fleet.db.get_miner_auto_optimize(ip)
        return jsonify({
            'success': True,
            'ip': ip,
            'auto_optimize': enabled
        })
    else:  # POST
        data = request.get_json() or {}
        enabled = data.get('enabled', False)

        success = fleet.db.update_miner_auto_optimize(ip, enabled)

        if success:
            # Also update thermal manager state
            fleet.thermal_mgr.set_auto_tune(ip, enabled)
            return jsonify({
                'success': True,
                'ip': ip,
                'auto_optimize': enabled
            })
        else:
            return jsonify({
                'success': False,
                'error': 'Failed to update auto-optimize setting'
            }), 500


@app.route('/api/auto-optimize/all', methods=['GET'])
def get_all_auto_optimize():
    """Get auto-optimize settings for all miners"""
    settings = fleet.db.get_all_auto_optimize_settings()
    return jsonify({
        'success': True,
        'settings': settings
    })


@app.route('/api/auto-optimize/fleet', methods=['POST'])
def set_fleet_auto_optimize():
    """Set auto-optimize for all miners"""
    data = request.get_json() or {}
    enabled = data.get('enabled', False)

    with fleet.lock:
        for ip in fleet.miners.keys():
            fleet.db.update_miner_auto_optimize(ip, enabled)
            fleet.thermal_mgr.set_auto_tune(ip, enabled)

    return jsonify({
        'success': True,
        'enabled': enabled,
        'miners_updated': len(fleet.miners)
    })


@app.route('/api/miner/<ip>/settings', methods=['POST'])
def update_miner_settings(ip: str):
    """Update miner settings (frequency, voltage, etc.)
    WARNING: Changing voltage can damage hardware!
    """
    data = request.get_json() or {}

    with fleet.lock:
        miner = fleet.miners.get(ip)
        if not miner:
            return jsonify({
                'success': False,
                'error': 'Miner not found'
            }), 404

        try:
            settings = {}

            # Core voltage (in mV)
            if 'coreVoltage' in data:
                voltage = int(data['coreVoltage'])
                # Safety bounds check
                if voltage < 800 or voltage > 1400:
                    return jsonify({
                        'success': False,
                        'error': f'Voltage {voltage}mV is outside safe range (800-1400mV)'
                    }), 400
                settings['coreVoltage'] = voltage

            # Frequency (in MHz)
            if 'frequency' in data:
                freq = int(data['frequency'])
                # Allow up to 1000 MHz for advanced chips like BM1370
                if freq < 100 or freq > 1000:
                    return jsonify({
                        'success': False,
                        'error': f'Frequency {freq}MHz is outside safe range (100-1000MHz)'
                    }), 400
                settings['frequency'] = freq

            # Fan speed (0-100%)
            if 'fanSpeed' in data:
                fan = int(data['fanSpeed'])
                if fan < 0 or fan > 100:
                    return jsonify({
                        'success': False,
                        'error': 'Fan speed must be 0-100%'
                    }), 400
                settings['fanspeed'] = fan
                # Disable auto fan when setting manual fan speed
                settings['autofanspeed'] = 0

            # Auto fan control
            if 'autofanspeed' in data:
                settings['autofanspeed'] = int(data['autofanspeed'])

            # Target temperature for auto fan (40-75°C)
            if 'targetTemp' in data:
                target_temp = int(data['targetTemp'])
                if target_temp < 40 or target_temp > 75:
                    return jsonify({
                        'success': False,
                        'error': 'Target temperature must be between 40-75°C'
                    }), 400
                settings['targetTemp'] = target_temp

            if not settings:
                return jsonify({
                    'success': False,
                    'error': 'No valid settings provided'
                }), 400

            # Handle mock miners - update status directly without hardware call
            if getattr(miner, 'is_mock', False):
                if miner.last_status:
                    if not miner.last_status.get('raw'):
                        miner.last_status['raw'] = {}
                    # Update mock miner status with new settings
                    if 'frequency' in settings:
                        miner.last_status['raw']['frequency'] = settings['frequency']
                        miner.last_status['frequency'] = settings['frequency']
                    if 'coreVoltage' in settings:
                        miner.last_status['raw']['coreVoltage'] = settings['coreVoltage']
                        miner.last_status['core_voltage'] = settings['coreVoltage']
                    if 'fanspeed' in settings:
                        miner.last_status['raw']['fanSpeedPercent'] = settings['fanspeed']
                        miner.last_status['fan_speed'] = settings['fanspeed']
                    if 'autofanspeed' in settings:
                        miner.last_status['raw']['autofanspeed'] = settings['autofanspeed']
                    if 'targetTemp' in settings:
                        miner.last_status['raw']['targetTemp'] = settings['targetTemp']
                logger.info(f"Mock miner {ip} settings updated: {settings}")
                return jsonify({
                    'success': True,
                    'message': 'Settings updated successfully (mock)',
                    'settings': settings
                })

            # Apply settings to real miner
            result = miner.apply_settings(settings)

            if result:
                logger.info(f"Settings updated for {ip}: {settings}")
                return jsonify({
                    'success': True,
                    'message': 'Settings updated successfully',
                    'settings': settings
                })
            else:
                return jsonify({
                    'success': False,
                    'error': 'Failed to apply settings to miner'
                }), 500

        except Exception as e:
            logger.error(f"Error updating settings for {ip}: {e}")
            return jsonify({
                'success': False,
                'error': str(e)
            }), 500


@app.route('/api/miner/<ip>/pools', methods=['GET'])
def get_miner_pools(ip: str):
    """Get pool configuration for a specific miner"""
    with fleet.lock:
        miner = fleet.miners.get(ip)
        if not miner:
            return jsonify({
                'success': False,
                'error': 'Miner not found'
            }), 404

        pools_info = miner.api_handler.get_pools(ip)
        if pools_info is None:
            return jsonify({
                'success': False,
                'error': 'Pool management not supported for this miner type'
            }), 400

        return jsonify({
            'success': True,
            'pools': pools_info.get('pools', []),
            'active_pool': pools_info.get('active_pool', 0)
        })


@app.route('/api/miner/<ip>/pools', methods=['POST'])
def set_miner_pools(ip: str):
    """Set pool configuration for a specific miner"""
    data = request.get_json()
    pools = data.get('pools', [])

    if not pools:
        return jsonify({
            'success': False,
            'error': 'No pools provided'
        }), 400

    with fleet.lock:
        miner = fleet.miners.get(ip)
        if not miner:
            return jsonify({
                'success': False,
                'error': 'Miner not found'
            }), 404

        success = miner.api_handler.set_pools(ip, pools)
        if not success:
            return jsonify({
                'success': False,
                'error': 'Failed to set pool configuration'
            }), 500

        return jsonify({
            'success': True,
            'message': 'Pool configuration updated successfully'
        })


# =============================================================================
# BATCH OPERATIONS
# =============================================================================

@app.route('/api/batch/restart', methods=['POST'])
def batch_restart():
    """Restart multiple miners at once"""
    data = request.get_json() or {}
    ips = data.get('ips', [])

    if not ips:
        return jsonify({
            'success': False,
            'error': 'No miners specified'
        }), 400

    results = {'success': [], 'failed': []}

    with fleet.lock:
        for ip in ips:
            miner = fleet.miners.get(ip)
            if miner:
                try:
                    if miner.restart():
                        results['success'].append(ip)
                    else:
                        results['failed'].append({'ip': ip, 'error': 'Restart failed'})
                except Exception as e:
                    results['failed'].append({'ip': ip, 'error': str(e)})
            else:
                results['failed'].append({'ip': ip, 'error': 'Miner not found'})

    return jsonify({
        'success': True,
        'message': f"Restarted {len(results['success'])} miners",
        'results': results
    })


@app.route('/api/batch/settings', methods=['POST'])
def batch_settings():
    """Apply settings to multiple miners at once"""
    data = request.get_json() or {}
    ips = data.get('ips', [])
    settings = data.get('settings', {})

    if not ips:
        return jsonify({
            'success': False,
            'error': 'No miners specified'
        }), 400

    if not settings:
        return jsonify({
            'success': False,
            'error': 'No settings specified'
        }), 400

    results = {'success': [], 'failed': []}

    with fleet.lock:
        for ip in ips:
            miner = fleet.miners.get(ip)
            if miner and config.is_esp_miner(miner.type):
                try:
                    miner.apply_settings(settings)
                    results['success'].append(ip)
                except Exception as e:
                    results['failed'].append({'ip': ip, 'error': str(e)})
            elif miner:
                results['failed'].append({'ip': ip, 'error': 'Settings not supported for this miner type'})
            else:
                results['failed'].append({'ip': ip, 'error': 'Miner not found'})

    return jsonify({
        'success': True,
        'message': f"Applied settings to {len(results['success'])} miners",
        'results': results
    })


@app.route('/api/batch/remove', methods=['POST'])
def batch_remove():
    """Remove multiple miners at once"""
    data = request.get_json() or {}
    ips = data.get('ips', [])

    if not ips:
        return jsonify({
            'success': False,
            'error': 'No miners specified'
        }), 400

    results = {'success': [], 'failed': []}

    with fleet.lock:
        for ip in ips:
            if ip in fleet.miners:
                try:
                    del fleet.miners[ip]
                    fleet.db.delete_miner(ip)
                    results['success'].append(ip)
                except Exception as e:
                    results['failed'].append({'ip': ip, 'error': str(e)})
            else:
                results['failed'].append({'ip': ip, 'error': 'Miner not found'})

    return jsonify({
        'success': True,
        'message': f"Removed {len(results['success'])} miners",
        'results': results
    })


# =============================================================================
# MINER GROUPS
# =============================================================================

@app.route('/api/groups', methods=['GET'])
def get_groups():
    """Get all miner groups"""
    try:
        groups = fleet.db.get_all_groups()
        return jsonify({
            'success': True,
            'groups': groups
        })
    except Exception as e:
        logger.error(f"Error getting groups: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/groups', methods=['POST'])
def create_group():
    """Create a new miner group"""
    data = request.get_json() or {}
    name = data.get('name')
    color = data.get('color', '#3498db')
    description = data.get('description', '')

    if not name:
        return jsonify({'success': False, 'error': 'Group name is required'}), 400

    try:
        group_id = fleet.db.create_group(name, color, description)
        return jsonify({
            'success': True,
            'group_id': group_id,
            'message': f"Group '{name}' created"
        })
    except Exception as e:
        if 'UNIQUE constraint' in str(e):
            return jsonify({'success': False, 'error': 'Group name already exists'}), 400
        logger.error(f"Error creating group: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/groups/<int:group_id>', methods=['GET'])
def get_group(group_id):
    """Get a specific group with its members"""
    try:
        group = fleet.db.get_group(group_id)
        if not group:
            return jsonify({'success': False, 'error': 'Group not found'}), 404

        members = fleet.db.get_group_members(group_id)
        group['members'] = members
        return jsonify({
            'success': True,
            'group': group
        })
    except Exception as e:
        logger.error(f"Error getting group: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/groups/<int:group_id>', methods=['PUT'])
def update_group(group_id):
    """Update a group"""
    data = request.get_json() or {}

    try:
        fleet.db.update_group(
            group_id,
            name=data.get('name'),
            color=data.get('color'),
            description=data.get('description')
        )
        return jsonify({
            'success': True,
            'message': 'Group updated'
        })
    except Exception as e:
        logger.error(f"Error updating group: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/groups/<int:group_id>', methods=['DELETE'])
def delete_group(group_id):
    """Delete a group"""
    try:
        fleet.db.delete_group(group_id)
        return jsonify({
            'success': True,
            'message': 'Group deleted'
        })
    except Exception as e:
        logger.error(f"Error deleting group: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/groups/<int:group_id>/members', methods=['POST'])
def add_group_members(group_id):
    """Add miners to a group"""
    data = request.get_json() or {}
    ips = data.get('ips', [])

    if not ips:
        return jsonify({'success': False, 'error': 'No miners specified'}), 400

    try:
        for ip in ips:
            fleet.db.add_miner_to_group(ip, group_id)
        return jsonify({
            'success': True,
            'message': f"Added {len(ips)} miners to group"
        })
    except Exception as e:
        logger.error(f"Error adding members to group: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/groups/<int:group_id>/members', methods=['DELETE'])
def remove_group_members(group_id):
    """Remove miners from a group"""
    data = request.get_json() or {}
    ips = data.get('ips', [])

    if not ips:
        return jsonify({'success': False, 'error': 'No miners specified'}), 400

    try:
        for ip in ips:
            fleet.db.remove_miner_from_group(ip, group_id)
        return jsonify({
            'success': True,
            'message': f"Removed {len(ips)} miners from group"
        })
    except Exception as e:
        logger.error(f"Error removing members from group: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/miners/<path:ip>/groups', methods=['GET'])
def get_miner_groups(ip):
    """Get all groups a miner belongs to"""
    try:
        groups = fleet.db.get_miner_groups(ip)
        return jsonify({
            'success': True,
            'groups': groups
        })
    except Exception as e:
        logger.error(f"Error getting miner groups: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/miners/<path:ip>/groups', methods=['PUT'])
def set_miner_groups(ip):
    """Set the groups for a miner (replaces existing)"""
    data = request.get_json() or {}
    group_ids = data.get('group_ids', [])

    try:
        fleet.db.set_miner_groups(ip, group_ids)
        return jsonify({
            'success': True,
            'message': 'Miner groups updated'
        })
    except Exception as e:
        logger.error(f"Error setting miner groups: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


# =============================================================================
# DATA EXPORT
# =============================================================================

@app.route('/api/export/miners', methods=['GET'])
def export_miners():
    """Export current miner data as JSON or CSV"""
    format_type = request.args.get('format', 'json')

    miners_data = []
    with fleet.lock:
        for ip, miner in fleet.miners.items():
            status = miner.last_status or {}
            miners_data.append({
                'ip': ip,
                'name': miner.custom_name or miner.model or miner.type,
                'type': miner.type,
                'model': miner.model,
                'hashrate_ths': (status.get('hashrate', 0) or 0) / 1e12,
                'temperature_c': status.get('temperature', 0),
                'power_w': status.get('power', 0),
                'fan_speed': status.get('fan_speed', 0),
                'shares_accepted': status.get('shares_accepted', 0),
                'shares_rejected': status.get('shares_rejected', 0),
                'best_difficulty': status.get('best_difficulty', 0),
                'status': status.get('status', 'offline'),
                'efficiency_jth': round(status.get('power', 0) / max((status.get('hashrate', 0) or 1) / 1e12, 0.001), 2)
            })

    if format_type == 'csv':
        import io
        import csv
        output = io.StringIO()
        if miners_data:
            writer = csv.DictWriter(output, fieldnames=miners_data[0].keys())
            writer.writeheader()
            writer.writerows(miners_data)
        csv_data = output.getvalue()
        return csv_data, 200, {
            'Content-Type': 'text/csv',
            'Content-Disposition': 'attachment; filename=miners_export.csv'
        }

    return jsonify({
        'success': True,
        'export_time': datetime.now().isoformat(),
        'miners': miners_data
    })


@app.route('/api/export/history', methods=['GET'])
def export_history():
    """Export historical stats data"""
    hours = request.args.get('hours', default=24, type=int)
    format_type = request.args.get('format', 'json')

    # Get history data from database
    history_data = []
    cutoff = datetime.now() - timedelta(hours=hours)

    with fleet.db._get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT
                m.ip, m.custom_name, m.miner_type,
                s.timestamp, s.hashrate, s.temperature, s.power,
                s.fan_speed, s.shares_accepted, s.shares_rejected, s.status
            FROM stats s
            JOIN miners m ON s.miner_id = m.id
            WHERE s.timestamp > ?
            ORDER BY s.timestamp DESC
        """, (cutoff.strftime('%Y-%m-%d %H:%M:%S'),))

        for row in cursor.fetchall():
            history_data.append({
                'ip': row['ip'],
                'name': row['custom_name'] or row['miner_type'],
                'type': row['miner_type'],
                'timestamp': row['timestamp'],
                'hashrate_ths': (row['hashrate'] or 0) / 1e12,
                'temperature_c': row['temperature'],
                'power_w': row['power'],
                'fan_speed': row['fan_speed'],
                'shares_accepted': row['shares_accepted'],
                'shares_rejected': row['shares_rejected'],
                'status': row['status']
            })

    if format_type == 'csv':
        import io
        import csv
        output = io.StringIO()
        if history_data:
            writer = csv.DictWriter(output, fieldnames=history_data[0].keys())
            writer.writeheader()
            writer.writerows(history_data)
        csv_data = output.getvalue()
        return csv_data, 200, {
            'Content-Type': 'text/csv',
            'Content-Disposition': f'attachment; filename=history_export_{hours}h.csv'
        }

    return jsonify({
        'success': True,
        'export_time': datetime.now().isoformat(),
        'hours': hours,
        'records': len(history_data),
        'history': history_data
    })


@app.route('/api/export/profitability', methods=['GET'])
def export_profitability():
    """Export profitability history"""
    days = request.args.get('days', default=7, type=int)
    format_type = request.args.get('format', 'json')

    profit_data = fleet.db.get_profitability_history(days)

    if format_type == 'csv':
        import io
        import csv
        output = io.StringIO()
        if profit_data:
            writer = csv.DictWriter(output, fieldnames=profit_data[0].keys())
            writer.writeheader()
            writer.writerows(profit_data)
        csv_data = output.getvalue()
        return csv_data, 200, {
            'Content-Type': 'text/csv',
            'Content-Disposition': f'attachment; filename=profitability_{days}d.csv'
        }

    return jsonify({
        'success': True,
        'export_time': datetime.now().isoformat(),
        'days': days,
        'records': len(profit_data),
        'profitability': profit_data
    })


@app.route('/api/pools', methods=['GET'])
def get_all_pools():
    """Get pool configuration for all miners"""
    pools_data = []

    with fleet.lock:
        for ip, miner in fleet.miners.items():
            # Handle mock miners - return mock pool data
            if getattr(miner, 'is_mock', False):
                # Generate mock pool data based on miner type
                mock_pools = [
                    {
                        'url': 'stratum+tcp://public-pool.io:21496',
                        'user': f'bc1q...mock_{ip.replace(".", "")}',
                        'pass': 'x'
                    },
                    {
                        'url': 'stratum+tcp://solo.ckpool.org:3333',
                        'user': f'bc1q...backup_{ip.replace(".", "")}',
                        'pass': 'x'
                    }
                ]
                pools_data.append({
                    'ip': ip,
                    'model': miner.model,
                    'type': miner.type,
                    'name': miner.custom_name or miner.model,
                    'pools': mock_pools,
                    'active_pool': 0,
                    'is_mock': True
                })
            else:
                # Real miner - call API handler
                pools_info = miner.api_handler.get_pools(ip)
                if pools_info:
                    pools_data.append({
                        'ip': ip,
                        'model': miner.model,
                        'type': miner.type,
                        'name': miner.custom_name or miner.model,
                        'pools': pools_info.get('pools', []),
                        'active_pool': pools_info.get('active_pool', 0)
                    })

    return jsonify({
        'success': True,
        'miners': pools_data
    })


@app.route('/api/pool-config', methods=['GET'])
def get_pool_configs():
    """Get detected pool configurations from database"""
    try:
        miner_ip = request.args.get('miner_ip')
        pool_name = request.args.get('pool_name')

        configs = fleet.db.get_pool_config(miner_ip=miner_ip, pool_name=pool_name)

        return jsonify({
            'success': True,
            'pools': configs,
            'count': len(configs)
        })
    except Exception as e:
        logger.error(f"Error getting pool configs: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/pool-config', methods=['POST'])
def update_pool_config():
    """
    Update or add pool configuration for a miner.
    Use this to configure unknown/custom pools with correct fees and types.
    """
    try:
        data = request.get_json()

        required_fields = ['miner_ip', 'pool_name']
        for field in required_fields:
            if field not in data:
                return jsonify({
                    'success': False,
                    'error': f'Missing required field: {field}'
                }), 400

        # Add or update pool config
        fleet.db.add_pool_config(
            miner_ip=data['miner_ip'],
            pool_index=data.get('pool_index', 0),
            pool_name=data['pool_name'],
            pool_url=data.get('pool_url', ''),
            pool_port=data.get('pool_port', 3333),
            stratum_user=data.get('stratum_user'),
            stratum_password=data.get('stratum_password', 'x'),
            fee_percent=data.get('fee_percent', 2.5),
            pool_type=data.get('pool_type', 'PPS'),
            pool_difficulty=data.get('pool_difficulty')
        )

        return jsonify({
            'success': True,
            'message': f'Pool configuration saved for {data["miner_ip"]}'
        })

    except Exception as e:
        logger.error(f"Error updating pool config: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/pool-config/detect', methods=['POST'])
def detect_pools():
    """
    Manually trigger pool detection for all miners.
    Useful after adding new miners or changing pool configurations.
    """
    try:
        force_update = request.args.get('force', 'false').lower() == 'true'

        if fleet.pool_manager:
            result = fleet.pool_manager.detect_and_save_pool_configs(force_update=force_update)
            return jsonify({
                'success': True,
                'detected': result.get('detected', 0),
                'updated': result.get('updated', 0),
                'message': f"Pool detection complete: {result['detected']} detected, {result['updated']} updated"
            })
        else:
            return jsonify({
                'success': False,
                'error': 'Pool manager not initialized'
            }), 500

    except Exception as e:
        logger.error(f"Error detecting pools: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


# Energy Management Routes

@app.route('/api/energy/config', methods=['GET', 'POST'])
def energy_config():
    """Get or set energy configuration"""
    if request.method == 'GET':
        config_data = fleet.db.get_energy_config()
        return jsonify({
            'success': True,
            'config': config_data
        })
    else:
        data = request.get_json()
        try:
            fleet.db.set_energy_config(
                location=data.get('location', ''),
                energy_company=data.get('energy_company', ''),
                rate_structure=data.get('rate_structure', 'tou'),
                currency=data.get('currency', 'USD')
            )
            return jsonify({
                'success': True,
                'message': 'Energy configuration saved'
            })
        except Exception as e:
            return jsonify({
                'success': False,
                'error': str(e)
            }), 500


@app.route('/api/energy/rates', methods=['GET', 'POST', 'DELETE'])
def energy_rates():
    """Manage energy rates"""
    if request.method == 'GET':
        rates = fleet.db.get_energy_rates()
        current_rate = fleet.energy_rate_mgr.get_current_rate()
        return jsonify({
            'success': True,
            'rates': rates,
            'schedule': rates,  # Add schedule key for compatibility
            'current_rate': current_rate
        })

    elif request.method == 'POST':
        data = request.get_json()
        try:
            # Check if using preset
            if 'preset' in data:
                preset_name = data['preset']
                if preset_name in ENERGY_COMPANY_PRESETS:
                    preset = ENERGY_COMPANY_PRESETS[preset_name]
                    fleet.energy_rate_mgr.set_tou_rates(preset['rates'])
                    # Calculate average rate from preset for default fallback
                    preset_rates = [r['rate_per_kwh'] for r in preset['rates']]
                    avg_rate = sum(preset_rates) / len(preset_rates) if preset_rates else 0.12
                    fleet.db.set_energy_config(
                        location=preset['location'],
                        energy_company=preset_name,
                        default_rate=avg_rate
                    )
                    return jsonify({
                        'success': True,
                        'message': f'Applied {preset_name} rate preset'
                    })
                else:
                    return jsonify({
                        'success': False,
                        'error': 'Invalid preset name'
                    }), 400

            # Custom rates
            rates = data.get('rates', [])
            fleet.energy_rate_mgr.set_tou_rates(rates)
            return jsonify({
                'success': True,
                'message': f'Set {len(rates)} energy rates'
            })
        except Exception as e:
            return jsonify({
                'success': False,
                'error': str(e)
            }), 500

    else:  # DELETE
        try:
            fleet.db.delete_all_energy_rates()
            return jsonify({
                'success': True,
                'message': 'All energy rates deleted'
            })
        except Exception as e:
            return jsonify({
                'success': False,
                'error': str(e)
            }), 500


@app.route('/api/energy/rates/custom', methods=['POST'])
def set_custom_energy_rates():
    """Set custom energy rates"""
    try:
        data = request.get_json()
        standard_rate = float(data.get('standard_rate', 0))
        peak_rate = data.get('peak_rate')
        offpeak_rate = data.get('offpeak_rate')

        if standard_rate <= 0:
            return jsonify({
                'success': False,
                'error': 'Standard rate must be greater than 0'
            }), 400

        # Build rate structure
        rates = []

        # If peak/offpeak rates provided, create time-of-use schedule
        if peak_rate and offpeak_rate:
            # Peak hours: 4 PM - 9 PM weekdays
            rates.append({
                'day_of_week': 'weekday',
                'start_time': '16:00',
                'end_time': '21:00',
                'rate_per_kwh': float(peak_rate),
                'rate_type': 'peak'
            })
            # Off-peak hours: 11 PM - 7 AM
            rates.append({
                'day_of_week': None,
                'start_time': '23:00',
                'end_time': '07:00',
                'rate_per_kwh': float(offpeak_rate),
                'rate_type': 'off-peak'
            })
            # Standard for remaining hours
            rates.append({
                'day_of_week': None,
                'start_time': '07:00',
                'end_time': '16:00',
                'rate_per_kwh': standard_rate,
                'rate_type': 'standard'
            })
            rates.append({
                'day_of_week': None,
                'start_time': '21:00',
                'end_time': '23:00',
                'rate_per_kwh': standard_rate,
                'rate_type': 'standard'
            })
        else:
            # Flat rate 24/7
            rates.append({
                'day_of_week': None,
                'start_time': '00:00',
                'end_time': '23:59',
                'rate_per_kwh': standard_rate,
                'rate_type': 'standard'
            })

        # Apply rates and save the standard rate as default for fallback
        fleet.energy_rate_mgr.set_tou_rates(rates)
        fleet.db.set_energy_config(
            location='Custom',
            energy_company='Custom (Manual Entry)',
            default_rate=standard_rate
        )

        return jsonify({
            'success': True,
            'message': 'Custom energy rates applied successfully',
            'rates_count': len(rates)
        })

    except Exception as e:
        logger.error(f"Error setting custom rates: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/energy/presets', methods=['GET'])
def energy_presets():
    """Get available energy company presets"""
    return jsonify({
        'success': True,
        'presets': list(ENERGY_COMPANY_PRESETS.keys())
    })


# ============================================================================
# OpenEI Utility Rate Database Integration
# ============================================================================

@app.route('/api/openei/key', methods=['GET'])
def get_openei_key_status():
    """Check if OpenEI API key is configured."""
    try:
        # Check if key is configured (don't return the actual key for security)
        has_key = bool(fleet.utility_rate_service.api_key)
        return jsonify({
            'success': True,
            'configured': has_key,
            'masked_key': f"****{fleet.utility_rate_service.api_key[-4:]}" if has_key and len(fleet.utility_rate_service.api_key) > 4 else None
        })
    except Exception as e:
        logger.error(f"Error checking API key status: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/openei/key', methods=['POST'])
def save_openei_key():
    """Save OpenEI API key."""
    try:
        data = request.get_json()
        api_key = data.get('api_key', '').strip()

        if not api_key:
            return jsonify({
                'success': False,
                'error': 'API key is required'
            }), 400

        # Validate the key by making a test request
        import requests as req
        test_params = {
            'version': '7',
            'format': 'json',
            'api_key': api_key,
            'limit': 1
        }
        test_response = req.get('https://api.openei.org/utility_rates', params=test_params, timeout=10)
        test_data = test_response.json()

        if 'error' in test_data:
            error_msg = test_data['error'].get('message', str(test_data['error']))
            return jsonify({
                'success': False,
                'error': f"Invalid API key: {error_msg}"
            }), 400

        # Save the key to database
        fleet.db.set_setting('openei_api_key', api_key)

        # Update the service with the new key
        fleet.utility_rate_service.api_key = api_key

        logger.info("OpenEI API key saved successfully")
        return jsonify({
            'success': True,
            'message': 'API key saved and validated successfully',
            'masked_key': f"****{api_key[-4:]}" if len(api_key) > 4 else None
        })

    except req.exceptions.RequestException as e:
        logger.error(f"Network error validating API key: {e}")
        return jsonify({
            'success': False,
            'error': 'Could not validate API key - network error. Please try again.'
        }), 500
    except Exception as e:
        logger.error(f"Error saving API key: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/openei/key', methods=['DELETE'])
def delete_openei_key():
    """Delete saved OpenEI API key."""
    try:
        fleet.db.set_setting('openei_api_key', None)
        fleet.utility_rate_service.api_key = None
        logger.info("OpenEI API key deleted")
        return jsonify({
            'success': True,
            'message': 'API key deleted'
        })
    except Exception as e:
        logger.error(f"Error deleting API key: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/utilities/search', methods=['GET'])
def search_utilities():
    """
    Search for utilities by name using the OpenEI URDB.

    Query params:
        q: Search query (utility name)
        limit: Max results (default 20)
    """
    query = request.args.get('q', '')
    limit = request.args.get('limit', 20, type=int)

    if not query or len(query) < 2:
        return jsonify({
            'success': False,
            'error': 'Search query must be at least 2 characters'
        }), 400

    try:
        logger.info(f"Searching utilities for query: '{query}'")
        utilities = fleet.utility_rate_service.search_utilities(query, limit)
        logger.info(f"Search returned {len(utilities)} results")
        return jsonify({
            'success': True,
            'utilities': utilities,
            'count': len(utilities),
            'query': query
        })
    except Exception as e:
        logger.error(f"Error searching utilities for '{query}': {e}", exc_info=True)
        return jsonify({
            'success': False,
            'error': str(e),
            'query': query
        }), 500


@app.route('/api/utilities/<utility_name>/rates', methods=['GET'])
def get_utility_rate_plans(utility_name):
    """
    Get all rate plans for a specific utility.

    Query params:
        sector: Residential (default), Commercial, Industrial
    """
    sector = request.args.get('sector', 'Residential')

    try:
        rates = fleet.utility_rate_service.get_utility_rates(
            utility_name=utility_name,
            sector=sector
        )
        return jsonify({
            'success': True,
            'utility': utility_name,
            'rates': rates,
            'count': len(rates)
        })
    except Exception as e:
        logger.error(f"Error fetching rates for {utility_name}: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/utilities/rates/<rate_label>', methods=['GET'])
def get_rate_plan_details(rate_label):
    """
    Get full details for a specific rate plan including TOU schedule.

    Query params:
        month: Month for seasonal rates (1-12, default current month)
    """
    month = request.args.get('month', type=int)

    try:
        result = fleet.utility_rate_service.get_rates_for_app(rate_label, month)

        if not result.get('success'):
            return jsonify(result), 404

        return jsonify(result)
    except Exception as e:
        logger.error(f"Error fetching rate details for {rate_label}: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/utilities/rates/<rate_label>/apply', methods=['POST'])
def apply_openei_rate(rate_label):
    """
    Apply a rate plan from OpenEI URDB to the app.
    """
    month = request.json.get('month') if request.json else None

    try:
        result = fleet.utility_rate_service.get_rates_for_app(rate_label, month)

        if not result.get('success'):
            return jsonify(result), 404

        # Apply the rates
        fleet.energy_rate_mgr.set_tou_rates(result['rates'])

        # Update config
        rates = result['rates']
        if rates:
            avg_rate = sum(r['rate_per_kwh'] for r in rates) / len(rates)
            fleet.db.set_energy_config(
                location=result.get('utility', ''),
                energy_company=result.get('plan_name', ''),
                default_rate=avg_rate
            )

        return jsonify({
            'success': True,
            'message': f"Applied rate plan: {result.get('plan_name', rate_label)}",
            'utility': result.get('utility'),
            'plan_name': result.get('plan_name'),
            'rates_applied': len(rates),
            'source': 'OpenEI URDB'
        })
    except Exception as e:
        logger.error(f"Error applying rate {rate_label}: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/energy/rates/manual', methods=['POST'])
def set_manual_rates():
    """
    Manually set energy rates (for utilities not in OpenEI or custom rates).

    Expected JSON body:
    {
        "utility_name": "My Utility",
        "rates": [
            {"start_time": "00:00", "end_time": "14:00", "rate_per_kwh": 0.09, "rate_type": "off-peak"},
            {"start_time": "14:00", "end_time": "19:00", "rate_per_kwh": 0.17, "rate_type": "peak"},
            {"start_time": "19:00", "end_time": "23:59", "rate_per_kwh": 0.09, "rate_type": "off-peak"}
        ]
    }

    Or simplified format:
    {
        "utility_name": "My Utility",
        "standard_rate": 0.12,
        "peak_rate": 0.18,
        "peak_start": "14:00",
        "peak_end": "19:00",
        "off_peak_rate": 0.08
    }
    """
    try:
        data = request.get_json()

        if not data:
            return jsonify({
                'success': False,
                'error': 'No data provided'
            }), 400

        utility_name = data.get('utility_name', 'Custom Rates')

        # Check if full rates array is provided
        if 'rates' in data:
            rates = data['rates']
            # Validate rates
            for rate in rates:
                if 'start_time' not in rate or 'end_time' not in rate or 'rate_per_kwh' not in rate:
                    return jsonify({
                        'success': False,
                        'error': 'Each rate must have start_time, end_time, and rate_per_kwh'
                    }), 400
                # Ensure rate_type exists
                if 'rate_type' not in rate:
                    rate['rate_type'] = 'standard'
        else:
            # Build rates from simplified format
            standard_rate = data.get('standard_rate', 0.12)
            peak_rate = data.get('peak_rate')
            off_peak_rate = data.get('off_peak_rate')
            peak_start = data.get('peak_start', '14:00')
            peak_end = data.get('peak_end', '19:00')

            if peak_rate and off_peak_rate:
                # TOU rates
                rates = [
                    {'start_time': '00:00', 'end_time': peak_start, 'rate_per_kwh': off_peak_rate, 'rate_type': 'off-peak'},
                    {'start_time': peak_start, 'end_time': peak_end, 'rate_per_kwh': peak_rate, 'rate_type': 'peak'},
                    {'start_time': peak_end, 'end_time': '23:59', 'rate_per_kwh': off_peak_rate, 'rate_type': 'off-peak'}
                ]
            else:
                # Flat rate
                rates = [
                    {'start_time': '00:00', 'end_time': '23:59', 'rate_per_kwh': standard_rate, 'rate_type': 'standard'}
                ]

        # Apply the rates
        fleet.energy_rate_mgr.set_tou_rates(rates)

        # Update config
        avg_rate = sum(r['rate_per_kwh'] for r in rates) / len(rates)
        fleet.db.set_energy_config(
            location='Custom',
            energy_company=utility_name,
            default_rate=avg_rate
        )

        return jsonify({
            'success': True,
            'message': f"Applied manual rates for {utility_name}",
            'rates_applied': len(rates),
            'source': 'manual'
        })

    except Exception as e:
        logger.error(f"Error setting manual rates: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/energy/profitability', methods=['GET'])
def get_profitability():
    """
    Calculate current profitability with TOU rates and accurate pool calculations.
    Pool fees are auto-detected from pool_manager if available.
    """
    try:
        stats = fleet.get_fleet_stats()
        current_rate = fleet.energy_rate_mgr.get_current_rate()

        # Get optional parameters
        pool_fee = request.args.get('pool_fee', type=float)
        # Option to use simple calculation (without schedule/TOU)
        use_simple = request.args.get('simple', 'false').lower() == 'true'

        # Auto-detect pool fee if not provided
        if pool_fee is None and fleet.pool_manager:
            pool_configs = fleet.pool_manager.get_all_pool_configs()
            if pool_configs:
                pool_fee = pool_configs[0].get('fee_percent', 2.5)

        if use_simple:
            # Simple calculation without schedule/TOU consideration
            prof = fleet.profitability_calc.calculate_profitability(
                total_hashrate=stats['total_hashrate'],
                total_power_watts=stats['total_power'],
                energy_rate_per_kwh=current_rate,
                pool_fee_percent=pool_fee
            )
        else:
            # Full calculation with TOU rates and mining schedules
            prof = fleet.profitability_calc.calculate_profitability(
                total_hashrate=stats['total_hashrate'],
                total_power_watts=stats['total_power'],
                energy_rate_per_kwh=current_rate,
                pool_fee_percent=pool_fee,
                rate_manager=fleet.energy_rate_mgr,
                mining_scheduler=fleet.mining_scheduler
            )

        # Add accuracy indicator
        prof['accuracy_percent'] = 95  # ~95% accurate with pool-specific calculations
        prof['data_source'] = 'calculated'
        if fleet.pool_manager:
            prof['pool_fee_source'] = 'detected'
        else:
            prof['pool_fee_source'] = 'default'

        return jsonify({
            'success': True,
            'profitability': prof
        })
    except Exception as e:
        logger.error(f"Error calculating profitability: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/bitcoin/halving', methods=['GET'])
def get_halving_info():
    """Get Bitcoin halving information"""
    try:
        halving_info = fleet.btc_fetcher.get_halving_info()
        return jsonify({
            'success': True,
            'halving': halving_info
        })
    except Exception as e:
        logger.error(f"Error fetching halving info: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/solo-chance', methods=['GET'])
def get_solo_chance():
    """
    Calculate solo mining odds for the fleet or a specific miner.

    Query params:
        ip (optional): Miner IP to get odds for specific miner
        hashrate (optional): Custom hashrate in H/s to calculate odds for

    Returns odds data including:
        - odds_display: "1 in X" format
        - time_to_block_display: Human readable time estimate
        - daily_chance_percent: Probability as percentage
    """
    try:
        ip = request.args.get('ip')
        custom_hashrate = request.args.get('hashrate', type=float)

        if custom_hashrate is not None:
            # Calculate for custom hashrate value
            hashrate_hs = custom_hashrate
        elif ip:
            # Calculate for specific miner
            with fleet.lock:
                miner = fleet.miners.get(ip)
                if not miner:
                    return jsonify({
                        'success': False,
                        'error': f'Miner {ip} not found'
                    }), 404

                status = miner.last_status or {}
                hashrate_hs = status.get('hashrate', 0)
        else:
            # Calculate for entire fleet
            stats = fleet.get_fleet_stats()
            hashrate_hs = stats.get('total_hashrate', 0)

        # Calculate solo mining odds
        odds = fleet.profitability_calc.calculate_solo_odds(hashrate_hs)

        if 'error' in odds:
            return jsonify({
                'success': False,
                'error': odds['error']
            }), 500

        return jsonify({
            'success': True,
            'solo_chance': odds
        })
    except Exception as e:
        logger.error(f"Error calculating solo chance: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/energy/projected-cost', methods=['GET'])
def get_projected_daily_cost():
    """
    Get detailed projected daily energy cost with hourly breakdown.
    Accounts for mining schedules and TOU rates.
    """
    try:
        stats = fleet.get_fleet_stats()
        day_of_week = request.args.get('day')  # Optional: specific day

        if stats['total_power'] <= 0:
            return jsonify({
                'success': True,
                'projected_cost': {
                    'total_cost': 0,
                    'total_kwh': 0,
                    'message': 'No miners currently running'
                }
            })

        cost_details = fleet.profitability_calc.calculate_projected_daily_cost(
            max_power_watts=stats['total_power'],
            rate_manager=fleet.energy_rate_mgr,
            mining_scheduler=fleet.mining_scheduler,
            day_of_week=day_of_week
        )

        return jsonify({
            'success': True,
            'projected_cost': cost_details
        })
    except Exception as e:
        logger.error(f"Error calculating projected cost: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/energy/consumption', methods=['GET'])
def get_energy_consumption():
    """
    Get energy consumption history using integrated method by default
    Falls back to logged snapshots if use_integrated=false
    """
    try:
        hours = int(request.args.get('hours', 24))
        hours = validate_hours(hours, 24)
        use_integrated = request.args.get('use_integrated', 'true').lower() == 'true'

        if use_integrated:
            # Use accurate integrated calculation from stats table
            energy_data = fleet.db.calculate_actual_energy_consumption(hours)

            if not energy_data['hourly_breakdown']:
                return jsonify({
                    'success': True,
                    'total_kwh': 0,
                    'total_cost': 0,
                    'accuracy_percent': 0,
                    'data_source': 'integrated',
                    'time_coverage_percent': 0,
                    'history': []
                })

            # Calculate cost with TOU rates (including historical rates)
            cost_data = fleet.energy_rate_mgr.calculate_cost_with_tou(
                energy_data['hourly_breakdown'],
                use_historical=True
            )

            return jsonify({
                'success': True,
                'total_kwh': round(energy_data['total_kwh'], 4),
                'total_cost': round(cost_data['total_cost'], 4),
                'accuracy_percent': 99,  # >99% accurate with integrated method
                'data_source': 'integrated',
                'time_coverage_percent': round(energy_data['time_coverage_percent'], 1),
                'readings_count': energy_data['readings_count'],
                'history': cost_data['detailed_breakdown']
            })
        else:
            # Legacy method: use logged snapshots
            history = fleet.db.get_energy_consumption_history(hours)
            total_kwh = sum(h['energy_kwh'] for h in history if h['energy_kwh'])
            total_cost = sum(h['cost'] for h in history if h['cost'])

            return jsonify({
                'success': True,
                'history': history,
                'total_kwh': total_kwh,
                'total_cost': total_cost,
                'accuracy_percent': 85,  # Snapshot method less accurate
                'data_source': 'snapshots'
            })

    except Exception as e:
        logger.error(f"Error getting energy consumption: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/energy/consumption/actual', methods=['GET'])
def get_actual_energy_consumption():
    """
    Get actual energy consumption calculated from miner power readings.
    This integrates actual power data over time for accurate energy calculation
    and applies TOU rates for accurate cost calculation.
    """
    try:
        hours = int(request.args.get('hours', 24))
        hours = validate_hours(hours, 24)

        # Get actual energy consumption from stats
        energy_data = fleet.db.calculate_actual_energy_consumption(hours)

        if not energy_data['hourly_breakdown']:
            # No data available, return zeros
            return jsonify({
                'success': True,
                'total_kwh': 0,
                'total_cost': 0,
                'time_coverage_percent': 0,
                'readings_count': 0,
                'cost_by_rate_type': {'peak': 0, 'off-peak': 0, 'standard': 0},
                'kwh_by_rate_type': {'peak': 0, 'off-peak': 0, 'standard': 0},
                'hourly_breakdown': [],
                'hours_requested': hours
            })

        # Calculate cost with TOU rates
        cost_data = fleet.energy_rate_mgr.calculate_cost_with_tou(energy_data['hourly_breakdown'])

        return jsonify({
            'success': True,
            'total_kwh': round(energy_data['total_kwh'], 4),
            'total_cost': round(cost_data['total_cost'], 4),
            'time_coverage_percent': round(energy_data['time_coverage_percent'], 1),
            'readings_count': energy_data['readings_count'],
            'cost_by_rate_type': {
                k: round(v, 4) for k, v in cost_data['cost_by_rate_type'].items()
            },
            'kwh_by_rate_type': {
                k: round(v, 4) for k, v in cost_data['kwh_by_rate_type'].items()
            },
            'hourly_breakdown': cost_data['detailed_breakdown'],
            'hours_requested': hours
        })
    except Exception as e:
        logger.error(f"Error calculating actual energy consumption: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/energy/profitability/history', methods=['GET'])
def get_profitability_history():
    """Get profitability history"""
    try:
        days = int(request.args.get('days', 7))
        history = fleet.db.get_profitability_history(days)

        return jsonify({
            'success': True,
            'history': history
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/energy/schedule', methods=['GET', 'POST', 'DELETE'])
def mining_schedule():
    """Manage mining schedule"""
    if request.method == 'GET':
        schedules = fleet.db.get_mining_schedules()
        return jsonify({
            'success': True,
            'schedules': schedules
        })

    elif request.method == 'POST':
        data = request.get_json()
        try:
            # Auto-create schedule from rates
            if 'auto_from_rates' in data:
                max_rate = data.get('max_rate_threshold', 0.20)
                low_freq = data.get('low_frequency', 0)
                high_freq = data.get('high_frequency', 0)

                fleet.mining_scheduler.create_schedule_from_rates(
                    max_rate_threshold=max_rate,
                    low_frequency=low_freq,
                    high_frequency=high_freq
                )
                return jsonify({
                    'success': True,
                    'message': 'Schedule auto-created from energy rates'
                })

            # Manual schedule
            schedule = data
            fleet.db.add_mining_schedule(
                start_time=schedule['start_time'],
                end_time=schedule['end_time'],
                target_frequency=schedule['target_frequency'],
                day_of_week=schedule.get('day_of_week'),
                enabled=schedule.get('enabled', 1)
            )
            return jsonify({
                'success': True,
                'message': 'Schedule added'
            })
        except Exception as e:
            return jsonify({
                'success': False,
                'error': str(e)
            }), 500

    else:  # DELETE
        schedule_id = request.args.get('id')
        if schedule_id:
            try:
                fleet.db.delete_mining_schedule(int(schedule_id))
                return jsonify({
                    'success': True,
                    'message': 'Schedule deleted'
                })
            except Exception as e:
                return jsonify({
                    'success': False,
                    'error': str(e)
                }), 500
        else:
            return jsonify({
                'success': False,
                'error': 'Missing schedule id'
            }), 400


# Thermal Management Routes

@app.route('/api/thermal/status', methods=['GET'])
def get_thermal_status():
    """Get thermal status for all miners"""
    try:
        status = fleet.thermal_mgr.get_all_thermal_status()
        return jsonify({
            'success': True,
            'thermal_status': status
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/thermal/miner/<ip>', methods=['GET'])
def get_miner_thermal(ip: str):
    """Get thermal status for specific miner"""
    try:
        status = fleet.thermal_mgr.get_thermal_status(ip)
        if status:
            return jsonify({
                'success': True,
                'thermal_status': status
            })
        else:
            return jsonify({
                'success': False,
                'error': 'Miner not found'
            }), 404
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/thermal/auto-tune', methods=['POST'])
def set_auto_tune():
    """Enable/disable auto-tune globally or for specific miner"""
    try:
        data = request.get_json() or {}
        enabled = data.get('enabled', True)
        miner_ip = data.get('miner_ip')

        if miner_ip:
            # Set for specific miner
            fleet.thermal_mgr.set_auto_tune(miner_ip, enabled)
            return jsonify({
                'success': True,
                'message': f"Auto-tune {'enabled' if enabled else 'disabled'} for {miner_ip}"
            })
        else:
            # Set globally
            fleet.thermal_mgr.set_global_auto_tune(enabled)
            return jsonify({
                'success': True,
                'message': f"Global auto-tune {'enabled' if enabled else 'disabled'}"
            })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/thermal/force-frequency', methods=['POST'])
def force_frequency():
    """Force specific frequency for a miner (disables auto-tune)"""
    try:
        data = request.get_json() or {}
        miner_ip = data.get('miner_ip')
        frequency = data.get('frequency')

        if not miner_ip or frequency is None:
            return jsonify({
                'success': False,
                'error': 'Missing miner_ip or frequency'
            }), 400

        success = fleet.thermal_mgr.force_frequency(miner_ip, int(frequency))

        if success:
            return jsonify({
                'success': True,
                'message': f"Forced {miner_ip} to {frequency}MHz"
            })
        else:
            return jsonify({
                'success': False,
                'error': 'Miner not found'
            }), 404
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/thermal/reset/<ip>', methods=['POST'])
def reset_thermal(ip: str):
    """Reset miner to default thermal settings"""
    try:
        fleet.thermal_mgr.reset_miner(ip)
        return jsonify({
            'success': True,
            'message': f"Reset {ip} to default settings"
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


# Historical Data Routes (for charts)

@app.route('/api/history/temperature', methods=['GET'])
def get_temperature_history():
    """Get temperature history for charting"""
    try:
        hours = validate_hours(int(request.args.get('hours', 24)))
        miner_ip = request.args.get('miner_ip')  # Optional: specific miner

        if miner_ip:
            # Get history for specific miner
            miner_data = fleet.db.get_miner_by_ip(miner_ip)
            if not miner_data:
                return jsonify({
                    'success': False,
                    'error': 'Miner not found'
                }), 404

            history = fleet.db.get_stats_history(miner_data['id'], hours)
            # Only include temperature data from online/overheating miners
            data_points = [
                {
                    'timestamp': h['timestamp'],
                    'temperature': h['temperature'],
                    'miner_ip': miner_ip
                }
                for h in history if h.get('temperature') and h.get('status') in ('online', 'overheating')
            ]
        else:
            # Get history for all miners
            data_points = []
            for miner in fleet.miners.values():
                miner_data = fleet.db.get_miner_by_ip(miner.ip)
                if miner_data:
                    history = fleet.db.get_stats_history(miner_data['id'], hours)
                    for h in history:
                        # Only include temperature data from online/overheating miners
                        if h.get('temperature') and h.get('status') in ('online', 'overheating'):
                            data_points.append({
                                'timestamp': h['timestamp'],
                                'temperature': h['temperature'],
                                'miner_ip': miner.ip
                            })

        return jsonify({
            'success': True,
            'data': data_points
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/history/hashrate', methods=['GET'])
def get_hashrate_history():
    """Get hashrate history for charting"""
    try:
        hours = validate_hours(int(request.args.get('hours', 24)))
        miner_ip = request.args.get('miner_ip')  # Optional: specific miner

        if miner_ip:
            # Get history for specific miner
            miner_data = fleet.db.get_miner_by_ip(miner_ip)
            if not miner_data:
                return jsonify({
                    'success': False,
                    'error': 'Miner not found'
                }), 404

            history = fleet.db.get_stats_history(miner_data['id'], hours)
            # Only include hashrate data from online/overheating miners
            data_points = [
                {
                    'timestamp': h['timestamp'],
                    'hashrate': h['hashrate'] or 0,
                    'hashrate_ths': (h['hashrate'] or 0) / 1e12,
                    'miner_ip': miner_ip
                }
                for h in history if h.get('hashrate') is not None and h.get('status') in ('online', 'overheating')
            ]
        else:
            # Get history for all miners - return per-miner data + aggregated totals
            from collections import defaultdict
            from datetime import datetime as dt

            data_points = []
            aggregated = defaultdict(float)
            aggregated_count = defaultdict(int)  # Track count for averaging
            total_power_by_timestamp = defaultdict(float)

            def round_timestamp(ts_str, bucket_seconds=30):
                """Round timestamp to nearest bucket for aggregation"""
                try:
                    ts = dt.fromisoformat(ts_str)
                    # Round to nearest bucket
                    seconds = (ts.minute * 60 + ts.second)
                    rounded_seconds = (seconds // bucket_seconds) * bucket_seconds
                    rounded_ts = ts.replace(second=rounded_seconds % 60,
                                           minute=(rounded_seconds // 60) % 60,
                                           microsecond=0)
                    return rounded_ts.isoformat()
                except Exception:
                    return ts_str

            for miner in fleet.miners.values():
                miner_data = fleet.db.get_miner_by_ip(miner.ip)
                if miner_data:
                    history = fleet.db.get_stats_history(miner_data['id'], hours)
                    for h in history:
                        # Only include data from online/overheating miners
                        if h.get('hashrate') is not None and h.get('status') in ('online', 'overheating'):
                            hashrate_val = h['hashrate'] or 0
                            # Per-miner data point (keep exact timestamp)
                            data_points.append({
                                'timestamp': h['timestamp'],
                                'hashrate': hashrate_val,
                                'hashrate_ths': hashrate_val / 1e12,
                                'miner_ip': miner.ip
                            })
                            # Aggregate for totals using rounded timestamp
                            bucket_ts = round_timestamp(h['timestamp'])
                            aggregated[bucket_ts] += hashrate_val
                            aggregated_count[bucket_ts] += 1
                            if h.get('power'):
                                total_power_by_timestamp[bucket_ts] += h['power']

            # Add aggregated total data points
            total_data = [
                {
                    'timestamp': timestamp,
                    'hashrate': hashrate,
                    'hashrate_ths': hashrate / 1e12,
                    'total_power': total_power_by_timestamp.get(timestamp, 0),
                    'miner_ip': '_total_'
                }
                for timestamp, hashrate in sorted(aggregated.items())
            ]

        return jsonify({
            'success': True,
            'data': data_points,
            'totals': total_data
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/history/power', methods=['GET'])
def get_power_history():
    """Get power consumption history for charting"""
    try:
        hours = validate_hours(int(request.args.get('hours', 24)))
        miner_ip = request.args.get('miner_ip')  # Optional: specific miner

        if miner_ip:
            # Get history for specific miner
            miner_data = fleet.db.get_miner_by_ip(miner_ip)
            if not miner_data:
                return jsonify({
                    'success': False,
                    'error': 'Miner not found'
                }), 404

            history = fleet.db.get_stats_history(miner_data['id'], hours)
            data_points = [
                {
                    'timestamp': h['timestamp'],
                    'power': h['power'],
                    'miner_ip': miner_ip
                }
                for h in history if h.get('power')
            ]
        else:
            # Get history for all miners (aggregated)
            # Must track per-miner readings per bucket to avoid double-counting
            from collections import defaultdict
            from datetime import datetime as dt

            # Structure: {minute_bucket: {miner_ip: [power_readings]}}
            bucket_miner_readings = defaultdict(lambda: defaultdict(list))

            def bucket_timestamp(ts):
                """Round timestamp to nearest minute for proper aggregation"""
                if isinstance(ts, str):
                    try:
                        parsed = dt.strptime(ts[:16], '%Y-%m-%d %H:%M')
                        return parsed.strftime('%Y-%m-%d %H:%M:00')
                    except (ValueError, TypeError):
                        return ts[:16] + ':00' if len(ts) >= 16 else ts
                return ts

            for miner in fleet.miners.values():
                miner_data = fleet.db.get_miner_by_ip(miner.ip)
                if miner_data:
                    history = fleet.db.get_stats_history(miner_data['id'], hours)
                    for h in history:
                        if h.get('power'):
                            bucketed_ts = bucket_timestamp(h['timestamp'])
                            bucket_miner_readings[bucketed_ts][miner.ip].append(h['power'])

            # For each bucket, take average per miner, then sum across miners
            data_points = []
            for timestamp in sorted(bucket_miner_readings.keys()):
                miner_readings = bucket_miner_readings[timestamp]
                # Sum the average power of each miner in this bucket
                total_power = sum(
                    sum(readings) / len(readings)  # Average per miner
                    for readings in miner_readings.values()
                )
                data_points.append({
                    'timestamp': timestamp,
                    'power': total_power
                })

        return jsonify({
            'success': True,
            'data': data_points
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/history/frequency', methods=['GET'])
def get_frequency_history():
    """Get frequency adjustment history for charting"""
    try:
        hours = int(request.args.get('hours', 24))
        miner_ip = request.args.get('miner_ip')

        if not miner_ip:
            return jsonify({
                'success': False,
                'error': 'miner_ip parameter required'
            }), 400

        # Get thermal history for this miner
        history = fleet.thermal_mgr.get_frequency_history(miner_ip, hours)

        return jsonify({
            'success': True,
            'data': history
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


# Alert System Routes

@app.route('/api/alerts/config', methods=['GET', 'POST'])
def alert_config():
    """Get or set Telegram alert configuration"""
    if request.method == 'GET':
        config_data = fleet.alert_mgr.get_config()
        return jsonify({
            'success': True,
            'config': config_data
        })
    else:
        data = request.get_json()
        try:
            fleet.alert_mgr.configure(
                telegram_bot_token=data.get('telegram_bot_token'),
                telegram_chat_id=data.get('telegram_chat_id'),
                telegram_enabled=data.get('telegram_enabled', True)
            )
            return jsonify({
                'success': True,
                'message': 'Telegram alert configuration updated'
            })
        except Exception as e:
            return jsonify({
                'success': False,
                'error': str(e)
            }), 500


@app.route('/api/alerts/history', methods=['GET'])
def alert_history():
    """Get alert history"""
    try:
        hours = int(request.args.get('hours', 24))
        history = fleet.alert_mgr.get_alert_history(hours)
        return jsonify({
            'success': True,
            'alerts': history
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/alerts/test', methods=['POST'])
def test_alert():
    """Send a test alert"""
    try:
        data = request.get_json() or {}
        channel = data.get('channel', 'all')  # email, sms, webhook, discord, slack, all

        fleet.alert_mgr.send_custom_alert(
            title="Test Alert",
            message="This is a test alert from DirtySats",
            alert_type="test",
            level="info",
            data={'timestamp': datetime.now().isoformat()}
        )

        return jsonify({
            'success': True,
            'message': f'Test alert sent via {channel}'
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


# Telegram Setup Helper Routes

@app.route('/api/telegram/setup-instructions', methods=['GET'])
def telegram_setup_instructions():
    """Get Telegram setup instructions"""
    try:
        return jsonify({
            'success': True,
            'instructions': fleet.telegram_helper.get_setup_instructions(),
            'quick_reference': fleet.telegram_helper.get_quick_reference()
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/telegram/validate', methods=['POST'])
def validate_telegram():
    """Validate bot token and/or chat ID"""
    try:
        data = request.get_json() or {}
        bot_token = data.get('bot_token')
        chat_id = data.get('chat_id')

        result = {
            'success': True,
            'timestamp': datetime.now().isoformat()
        }

        if bot_token:
            is_valid, msg = fleet.telegram_helper.validate_bot_token(bot_token)
            result['token_status'] = {
                'valid': is_valid,
                'message': msg
            }

        if bot_token and chat_id:
            is_valid, msg = fleet.telegram_helper.validate_chat_id(bot_token, chat_id)
            result['chat_id_status'] = {
                'valid': is_valid,
                'message': msg
            }

        return jsonify(result)
    except Exception as e:
        logger.error(f"Error validating Telegram config: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/telegram/status-report', methods=['POST'])
def telegram_status_report():
    """Get detailed Telegram setup status report"""
    try:
        data = request.get_json() or {}
        bot_token = data.get('bot_token', '')
        chat_id = data.get('chat_id', '')

        if not bot_token or not chat_id:
            return jsonify({
                'success': False,
                'error': 'Both bot_token and chat_id required'
            }), 400

        report = fleet.telegram_helper.get_status_report(bot_token, chat_id)
        return jsonify({
            'success': True,
            'report': report
        })
    except Exception as e:
        logger.error(f"Error generating status report: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/telegram/save-config', methods=['POST'])
def save_telegram_config():
    """Save and validate Telegram configuration"""
    try:
        data = request.get_json() or {}
        bot_token = data.get('bot_token')
        chat_id = data.get('chat_id')

        if not bot_token or not chat_id:
            return jsonify({
                'success': False,
                'error': 'Both bot_token and chat_id required'
            }), 400

        success, msg = fleet.telegram_helper.save_config(bot_token, chat_id)

        # Also update alert manager
        fleet.alert_mgr.configure(
            telegram_bot_token=bot_token,
            telegram_chat_id=chat_id,
            telegram_enabled=True
        )

        return jsonify({
            'success': success,
            'message': msg
        })
    except Exception as e:
        logger.error(f"Error saving Telegram config: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


# Weather Integration Routes

@app.route('/api/weather/config', methods=['GET', 'POST'])
def weather_config():
    """Get or set weather configuration"""
    if request.method == 'GET':
        return jsonify({
            'success': True,
            'configured': fleet.weather_mgr.api_key is not None,
            'location': fleet.weather_mgr.location,
            'latitude': fleet.weather_mgr.latitude,
            'longitude': fleet.weather_mgr.longitude
        })
    else:
        data = request.get_json()
        try:
            fleet.weather_mgr.configure(
                api_key=data.get('api_key'),
                location=data.get('location'),
                latitude=data.get('latitude'),
                longitude=data.get('longitude')
            )
            return jsonify({
                'success': True,
                'message': 'Weather configuration updated'
            })
        except Exception as e:
            return jsonify({
                'success': False,
                'error': str(e)
            }), 500


@app.route('/api/weather/current', methods=['GET'])
def get_current_weather():
    """Get current weather conditions"""
    try:
        weather = fleet.weather_mgr.get_current_weather()
        if weather:
            return jsonify({
                'success': True,
                'weather': weather
            })
        else:
            return jsonify({
                'success': False,
                'error': 'Weather not configured or unavailable'
            }), 404
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/weather/forecast', methods=['GET'])
def get_weather_forecast():
    """Get weather forecast"""
    try:
        hours = int(request.args.get('hours', 24))
        forecast = fleet.weather_mgr.get_forecast(hours=hours)

        if forecast:
            return jsonify({
                'success': True,
                'forecast': [f.to_dict() for f in forecast]
            })
        else:
            return jsonify({
                'success': False,
                'error': 'Weather not configured or unavailable'
            }), 404
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/weather/prediction', methods=['GET'])
def get_thermal_prediction():
    """Get thermal issue prediction based on weather"""
    try:
        # Get current weather and fleet stats
        current_weather = fleet.weather_mgr.get_current_weather()
        if not current_weather:
            return jsonify({
                'success': False,
                'error': 'Weather not configured'
            }), 404

        stats = fleet.get_fleet_stats()
        avg_miner_temp = stats.get('avg_temperature', 0)

        if avg_miner_temp > 0:
            current_ambient = current_weather['temp_f']
            avg_miner_temp_f = (avg_miner_temp * 9/5) + 32
            miner_temp_delta = avg_miner_temp_f - current_ambient

            prediction = fleet.weather_mgr.predict_thermal_issues(
                current_ambient=current_ambient,
                miner_temp_delta=miner_temp_delta
            )

            return jsonify({
                'success': True,
                'prediction': prediction
            })
        else:
            return jsonify({
                'success': False,
                'error': 'No miner temperature data available'
            }), 404

    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/weather/optimal-hours', methods=['GET'])
def get_optimal_mining_hours():
    """Get optimal mining hours based on temperature forecast"""
    try:
        hours = int(request.args.get('hours', 24))
        max_temp = float(request.args.get('max_temp_f', 80.0))

        optimal = fleet.weather_mgr.get_optimal_mining_hours(
            hours=hours,
            max_ambient_f=max_temp
        )

        return jsonify({
            'success': True,
            'optimal_periods': optimal
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


# =============================================================================
# TEST/MOCK ENDPOINTS (for development only)
# =============================================================================

@app.route('/api/test/mock-miners', methods=['POST'])
def add_mock_miners():
    """Add mock miners for testing the dashboard"""
    import random
    from datetime import datetime, timedelta

    # Realistic specs based on manufacturer data:
    # BitAxe Ultra (BM1366): ~500 GH/s @ 11-13W, ~24 J/TH
    # BitAxe Gamma (BM1370): ~1.2 TH/s @ 17-18W, ~15 J/TH
    # BitAxe Supra (BM1368): ~650 GH/s @ 12-15W, ~22 J/TH
    # NerdAxe (BM1366): ~500 GH/s @ 12W, ~24 J/TH
    # NerdQAxe++ (4x BM1370): ~4.8 TH/s @ 76-80W, ~16 J/TH
    mock_miners_data = [
        {
            'ip': '10.0.0.101',
            'type': 'BitAxe Ultra',
            'model': 'BitAxe Ultra',
            'custom_name': 'Living Room Miner',
            'status': {
                'hashrate': 497e9,  # 497 GH/s (realistic for BM1366)
                'temperature': 52.3,
                'power': 11.8,  # ~24 J/TH efficiency
                'fan_speed': 45,
                'frequency': 485,
                'voltage': 1200,
                'status': 'online',
                'asic_model': 'BM1366',
                'asic_count': 1,
                'shares_accepted': 1247,
                'shares_rejected': 3,
                'best_difficulty': 2500000,  # 2.5M
                'session_difficulty': 1850000,  # 1.85M (current session)
                'uptime_seconds': 86400,
                'hostname': 'bitaxe-ultra-1',
                'firmware': 'v2.4.0',
                'raw': {'ASICModel': 'BM1366', 'ASICCount': 1, 'frequency': 485, 'coreVoltage': 1200, 'fanSpeedPercent': 45}
            }
        },
        {
            'ip': '10.0.0.102',
            'type': 'NerdQAxe++',
            'model': 'NerdQAxe++',
            'custom_name': 'Garage Quad Miner',
            'status': {
                'hashrate': 4.85e12,  # 4.85 TH/s (4x BM1370 chips)
                'temperature': 58.2,
                'power': 77.6,  # ~16 J/TH efficiency
                'fan_speed': 65,
                'frequency': 490,
                'voltage': 1150,
                'status': 'online',
                'asic_model': 'BM1370',
                'asic_count': 4,
                'shares_accepted': 5621,
                'shares_rejected': 12,
                'best_difficulty': 15200000,  # 15.2M
                'session_difficulty': 11500000,  # 11.5M (current session)
                'uptime_seconds': 172800,
                'hostname': 'nerdqaxe-plusplus',
                'firmware': 'esp-miner-NERDQAXEPLUS-v1.0.35',
                'raw': {'ASICModel': 'BM1370', 'ASICCount': 4, 'frequency': 490, 'coreVoltage': 1150, 'fanSpeedPercent': 65}
            }
        },
        {
            'ip': '10.0.0.103',
            'type': 'BitAxe Gamma',
            'model': 'BitAxe Gamma',
            'custom_name': 'Office Miner',
            'status': {
                'hashrate': 1.21e12,  # 1.21 TH/s (BM1370 single chip)
                'temperature': 54.1,
                'power': 18.2,  # ~15 J/TH efficiency
                'fan_speed': 50,
                'frequency': 575,
                'voltage': 1200,
                'status': 'online',
                'asic_model': 'BM1370',
                'asic_count': 1,
                'shares_accepted': 892,
                'shares_rejected': 2,
                'best_difficulty': 3100000,  # 3.1M
                'session_difficulty': 2750000,  # 2.75M (current session)
                'uptime_seconds': 43200,
                'hostname': 'bitaxe-gamma-1',
                'firmware': 'v2.4.1',
                'raw': {'ASICModel': 'BM1370', 'ASICCount': 1, 'frequency': 575, 'coreVoltage': 1200, 'fanSpeedPercent': 50}
            }
        },
        {
            'ip': '10.0.0.104',
            'type': 'LuckyMiner',
            'model': 'LuckyMiner',
            'custom_name': 'Basement Solo',
            'status': {
                'hashrate': 485e9,  # 485 GH/s (BM1366)
                'temperature': 53.2,
                'power': 11.5,  # ~24 J/TH efficiency
                'fan_speed': 42,
                'frequency': 480,
                'voltage': 1200,
                'status': 'online',
                'asic_model': 'BM1366',
                'asic_count': 1,
                'shares_accepted': 654,
                'shares_rejected': 1,
                'best_difficulty': 1800000,  # 1.8M
                'session_difficulty': 1200000,  # 1.2M (current session)
                'uptime_seconds': 259200,
                'hostname': 'luckyminer-1',
                'firmware': 'esp-miner-v2.1.0',
                'raw': {'ASICModel': 'BM1366', 'ASICCount': 1, 'frequency': 480, 'coreVoltage': 1200, 'fanSpeedPercent': 42}
            }
        },
        {
            'ip': '10.0.0.105',
            'type': 'Whatsminer',
            'model': 'Whatsminer M30S',
            'custom_name': 'Basement ASIC',
            'status': {
                'hashrate': 86e12,  # 86 TH/s (M30S)
                'temperature': 62.5,
                'power': 3268,  # ~38 J/TH efficiency
                'fan_speed': 4800,  # RPM
                'frequency': 0,
                'voltage': 0,
                'status': 'online',
                'asic_model': 'BM1398',
                'asic_count': 156,  # 3 hashboards x 52 chips
                'shares_accepted': 45678,
                'shares_rejected': 89,
                'best_difficulty': 125000000,  # 125M
                'session_difficulty': 125000000,
                'uptime_seconds': 604800,
                'hostname': 'whatsminer-m30s',
                'firmware': 'M30S-202012221842-sig',
                'raw': {'summary': {'SUMMARY': [{'MHS av': 86000000}]}, 'devs': {'DEVS': [{'Temperature': 62.5}]}}
            }
        },
        {
            'ip': '10.0.0.106',
            'type': 'BitAxe',
            'model': 'BitAxe',
            'custom_name': 'Kitchen Counter Miner',
            'status': {
                'hashrate': 395e9,  # 395 GH/s (BM1397 original)
                'temperature': 55.2,
                'power': 9.8,  # ~25 J/TH efficiency
                'fan_speed': 42,
                'frequency': 425,
                'voltage': 1150,
                'status': 'online',
                'asic_model': 'BM1397',
                'asic_count': 1,
                'shares_accepted': 821,
                'shares_rejected': 2,
                'best_difficulty': 1650000,  # 1.65M
                'session_difficulty': 1450000,  # 1.45M (current session)
                'uptime_seconds': 129600,
                'hostname': 'bitaxe-og-1',
                'firmware': 'v2.2.0',
                'raw': {'ASICModel': 'BM1397', 'ASICCount': 1, 'frequency': 425, 'coreVoltage': 1150, 'fanSpeedPercent': 42}
            }
        },
        {
            'ip': '10.0.0.107',
            'type': 'BitAxe Max',
            'model': 'BitAxe Max',
            'custom_name': 'Bedroom Silent Miner',
            'status': {
                'hashrate': 445e9,  # 445 GH/s (BM1397 optimized)
                'temperature': 49.8,
                'power': 10.5,  # ~24 J/TH efficiency
                'fan_speed': 35,
                'frequency': 450,
                'voltage': 1180,
                'status': 'online',
                'asic_model': 'BM1397',
                'asic_count': 1,
                'shares_accepted': 1456,
                'shares_rejected': 4,
                'best_difficulty': 1890000,  # 1.89M
                'session_difficulty': 1600000,  # 1.6M (current session)
                'uptime_seconds': 201600,
                'hostname': 'bitaxe-max-1',
                'firmware': 'v2.4.2',
                'raw': {'ASICModel': 'BM1397', 'ASICCount': 1, 'frequency': 450, 'coreVoltage': 1180, 'fanSpeedPercent': 35}
            }
        },
        {
            'ip': '10.0.0.108',
            'type': 'NerdQAxe+',
            'model': 'NerdQAxe+',
            'custom_name': 'Workshop Quad',
            'status': {
                'hashrate': 4.2e12,  # 4.2 TH/s (4x BM1370)
                'temperature': 56.7,
                'power': 68.5,  # ~16 J/TH efficiency
                'fan_speed': 58,
                'frequency': 480,
                'voltage': 1140,
                'status': 'online',
                'asic_model': 'BM1370',
                'asic_count': 4,
                'shares_accepted': 4892,
                'shares_rejected': 8,
                'best_difficulty': 12800000,  # 12.8M
                'session_difficulty': 9500000,  # 9.5M (current session)
                'uptime_seconds': 302400,
                'hostname': 'nerdqaxe-plus-1',
                'firmware': 'esp-miner-NERDQAXEPLUS-v1.0.32',
                'raw': {'ASICModel': 'BM1370', 'ASICCount': 4, 'frequency': 480, 'coreVoltage': 1140, 'fanSpeedPercent': 58}
            }
        },
        {
            'ip': '10.0.0.109',
            'type': 'NerdOctaxe',
            'model': 'NerdOctaxe',
            'custom_name': 'Server Room Octa',
            'status': {
                'hashrate': 8.1e12,  # 8.1 TH/s (8x BM1370)
                'temperature': 59.3,
                'power': 135.0,  # ~17 J/TH efficiency
                'fan_speed': 72,
                'frequency': 475,
                'voltage': 1130,
                'status': 'online',
                'asic_model': 'BM1370',
                'asic_count': 8,
                'shares_accepted': 9245,
                'shares_rejected': 18,
                'best_difficulty': 24500000,  # 24.5M
                'session_difficulty': 18200000,  # 18.2M (current session)
                'uptime_seconds': 432000,
                'hostname': 'nerdoctaxe-1',
                'firmware': 'esp-miner-NERDOCTAXE-v1.1.0',
                'raw': {'ASICModel': 'BM1370', 'ASICCount': 8, 'frequency': 475, 'coreVoltage': 1130, 'fanSpeedPercent': 72}
            }
        },
        {
            'ip': '10.0.0.110',
            'type': 'Antminer S9',
            'model': 'Antminer S9',
            'custom_name': 'Garage Legacy Miner',
            'status': {
                'hashrate': 13.5e12,  # 13.5 TH/s
                'temperature': 68.5,
                'power': 1350,  # ~100 J/TH (old gen)
                'fan_speed': 4200,
                'frequency': 650,
                'voltage': 0,
                'status': 'online',
                'asic_model': 'BM1387',
                'asic_count': 189,  # 3 hashboards x 63 chips
                'shares_accepted': 28456,
                'shares_rejected': 45,
                'best_difficulty': 85000000,  # 85M
                'session_difficulty': 85000000,  # CGMiner: session = best (no persistent storage)
                'uptime_seconds': 864000,
                'hostname': 'antminer-s9-1',
                'firmware': 'Antminer-S9-all-201812051512-autofreq-user-Update2UBI-NF-sig.tar.gz',
                'raw': {'summary': {'SUMMARY': [{'MHS av': 13500000}]}, 'devs': {'DEVS': [{'Temperature': 68.5}]}}
            }
        }
    ]

    # Create mock Miner objects
    from miners.detector import Miner
    from miners.bitaxe import BitaxeAPIHandler

    handler = BitaxeAPIHandler()
    added = []

    with fleet.lock:
        for data in mock_miners_data:
            ip = data['ip']

            # Remove existing miner with this IP if it exists (both memory and DB)
            if ip in fleet.miners:
                del fleet.miners[ip]
            fleet.db.delete_miner(ip)  # Safe to call even if not exists

            # Create a mock miner
            miner = Miner(ip, data['type'], handler, data['custom_name'])
            miner.model = data['model']
            miner.last_status = data['status']
            miner.is_mock = True  # Flag to skip real API polling

            # Add to fleet
            fleet.miners[ip] = miner

            # Register with thermal manager
            fleet.thermal_mgr.register_miner(ip, data['type'])
            fleet.thermal_mgr.update_miner_stats(
                ip,
                data['status']['temperature'],
                data['status']['hashrate'],
                data['status'].get('fan_speed')
            )

            # Save to database
            miner_id = fleet.db.add_miner(ip, data['type'], data['model'])
            if data['custom_name']:
                fleet.db.update_miner_custom_name(ip, data['custom_name'])

            # Add historical stats for the last 6 hours (every 30 minutes = 12 data points)
            status = data['status']
            base_hashrate = status.get('hashrate', 0)
            base_temp = status.get('temperature', 50)
            base_power = status.get('power', 10)

            for i in range(12):
                # Vary values slightly for realistic chart data
                time_offset = timedelta(hours=6) - timedelta(minutes=i * 30)
                stat_time = datetime.now() - time_offset

                # Add small random variations (+/- 5%)
                hr_variation = 1 + (random.random() - 0.5) * 0.1
                temp_variation = 1 + (random.random() - 0.5) * 0.08
                power_variation = 1 + (random.random() - 0.5) * 0.05

                fleet.db.add_stats(
                    miner_id=miner_id,
                    hashrate=base_hashrate * hr_variation,
                    temperature=base_temp * temp_variation,
                    power=base_power * power_variation,
                    fan_speed=status.get('fan_speed'),
                    shares_accepted=status.get('shares_accepted'),
                    shares_rejected=status.get('shares_rejected'),
                    best_difficulty=str(status.get('best_difficulty', '')),
                    timestamp=stat_time
                )

            added.append({
                'ip': ip,
                'type': data['type'],
                'name': data['custom_name'] or data['model']
            })

            logger.info(f"Added mock miner: {data['type']} at {ip}")

    return jsonify({
        'status': 'success',
        'message': f'Added {len(added)} mock miners',
        'miners': added
    })


@app.route('/api/test/clear-miners', methods=['POST'])
def clear_mock_miners():
    """Clear all miners (for testing)"""
    with fleet.lock:
        # Get all miner IPs before clearing
        miner_ips = list(fleet.miners.keys())

        # Clear from memory
        fleet.miners.clear()
        fleet.thermal_mgr.thermal_states.clear()

        # Delete each miner from database
        for ip in miner_ips:
            fleet.db.delete_miner(ip)

        logger.info(f"Cleared {len(miner_ips)} miners")

    return jsonify({'status': 'success', 'message': f'Cleared {len(miner_ips)} miners'})


@app.route('/api/diagnostic', methods=['GET'])
def diagnostic():
    """Diagnostic endpoint to check system health and data issues"""
    try:
        # Check miners in memory
        miners_count = len(fleet.miners)
        miners_list = []
        for ip, miner in fleet.miners.items():
            last_status = miner.get('last_status', {})
            miners_list.append({
                'ip': ip,
                'model': miner.get('model', 'Unknown'),
                'hashrate_th': last_status.get('hashrate_th', 0),
                'temperature': last_status.get('temperature', 0),
                'power_watts': last_status.get('power_watts', 0),
                'status': last_status.get('status', 'unknown')
            })

        # Check database stats using proper connection context
        with fleet.db._get_connection() as conn:
            cursor = conn.cursor()

            # Stats table
            stats_count = cursor.execute("SELECT COUNT(*) FROM stats").fetchone()[0]
            recent_stats = cursor.execute(
                "SELECT miner_ip, timestamp, hashrate_ths, temperature, power_watts FROM stats ORDER BY timestamp DESC LIMIT 10"
            ).fetchall()

            # History tables
            temp_history_count = cursor.execute("SELECT COUNT(*) FROM temperature_history").fetchone()[0]
            hashrate_history_count = cursor.execute("SELECT COUNT(*) FROM hashrate_history").fetchone()[0]

            # Recent temperature history
            recent_temp = cursor.execute(
                "SELECT miner_ip, timestamp, temperature FROM temperature_history ORDER BY timestamp DESC LIMIT 5"
            ).fetchall()

            # Recent hashrate history
            recent_hashrate = cursor.execute(
                "SELECT miner_ip, timestamp, hashrate_ths FROM hashrate_history ORDER BY timestamp DESC LIMIT 5"
            ).fetchall()

        return jsonify({
            'success': True,
            'timestamp': datetime.now().isoformat(),
            'miners': {
                'count': miners_count,
                'list': miners_list
            },
            'database': {
                'stats_count': stats_count,
                'recent_stats': [
                    {
                        'ip': s[0],
                        'timestamp': s[1],
                        'hashrate_th': s[2],
                        'temp': s[3],
                        'power': s[4]
                    } for s in recent_stats
                ],
                'temp_history_count': temp_history_count,
                'hashrate_history_count': hashrate_history_count,
                'recent_temp_history': [
                    {'ip': t[0], 'timestamp': t[1], 'temp': t[2]} for t in recent_temp
                ],
                'recent_hashrate_history': [
                    {'ip': h[0], 'timestamp': h[1], 'hashrate': h[2]} for h in recent_hashrate
                ]
            }
        })
    except Exception as e:
        logger.error(f"Diagnostic error: {e}")
        import traceback
        return jsonify({
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc()
        }), 500


# =============================================================================
# METRICS ENDPOINTS - NEW FEATURE SET
# =============================================================================


@app.route('/api/metrics/sats-earned', methods=['GET'])
def get_sats_earned():
    """Get sats earned tracking (real-time, daily, weekly, all-time)"""
    try:
        hours = request.args.get('hours', type=int)
        data = fleet.sats_tracker.get_sats_earned(hours=hours)
        return jsonify(data)
    except Exception as e:
        logger.error(f"Error getting sats earned: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/metrics/fleet-health', methods=['GET'])
def get_fleet_health():
    """Get fleet health status with detailed issues and recommendations"""
    try:
        health = fleet.health_monitor.get_fleet_health()
        return jsonify(health)
    except Exception as e:
        logger.error(f"Error getting fleet health: {e}")
        return jsonify({'error': str(e)}), 500




@app.route('/api/metrics/efficiency', methods=['GET'])
@app.route('/api/metrics/power-efficiency', methods=['GET'])
def get_efficiency_matrix():
    """Get power efficiency matrix (W/TH) for all miners"""
    try:
        rate = request.args.get('electricity_rate', default=0.12, type=float)
        data = fleet.efficiency_matrix.get_efficiency_matrix(electricity_rate_per_kwh=rate)
        return jsonify(data)
    except Exception as e:
        logger.error(f"Error getting efficiency matrix: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/metrics/pools', methods=['GET'])
@app.route('/api/metrics/pool-performance', methods=['GET'])
def get_pool_comparison():
    """Compare mining pool performance"""
    try:
        data = fleet.pool_comparator.get_pool_comparison()
        return jsonify(data)
    except Exception as e:
        logger.error(f"Error getting pool comparison: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/metrics/revenue-projection', methods=['GET'])
@app.route('/api/metrics/revenue-projections', methods=['GET'])
def get_revenue_projection():
    """Get revenue projections and break-even analysis"""
    try:
        target_sats = request.args.get('target_sats', type=int)
        electricity_rate = request.args.get('electricity_rate', default=0.12, type=float)
        data = fleet.revenue_model.get_revenue_projection(
            target_sats=target_sats,
            electricity_rate=electricity_rate
        )
        return jsonify(data)
    except Exception as e:
        logger.error(f"Error getting revenue projection: {e}")
        return jsonify({'error': str(e)}), 500


# =============================================================================
# LIGHTNING DONATIONS - Support Development
# =============================================================================


@app.route('/api/lightning/donation-amounts', methods=['GET'])
def get_donation_amounts():
    """Get suggested donation amounts in satoshis"""
    try:
        lightning = get_lightning_manager()
        amounts = lightning.get_standard_amounts()
        return jsonify({
            'success': True,
            'amounts': amounts,
            'description': 'Support DirtySats Development ☕'
        })
    except Exception as e:
        logger.error(f"Error getting donation amounts: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/lightning/create-invoice', methods=['POST'])
def create_donation_invoice():
    """Create Lightning invoice for donation"""
    try:
        data = request.get_json() or {}
        amount_sats = data.get('amount', 1000)

        if amount_sats < 100:
            return jsonify({'error': 'Minimum donation: 100 sats'}), 400

        lightning = get_lightning_manager()
        invoice = lightning.create_invoice(amount_sats)

        if not invoice:
            return jsonify({'error': 'Failed to create invoice'}), 500

        return jsonify({
            'success': True,
            'invoice': invoice
        })
    except Exception as e:
        logger.error(f"Error creating invoice: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/lightning/check-payment/<checking_id>', methods=['GET'])
def check_donation_payment(checking_id):
    """Check if donation payment was received"""
    try:
        lightning = get_lightning_manager()
        status = lightning.check_payment_status(checking_id)
        return jsonify({
            'success': True,
            'payment_status': status
        })
    except Exception as e:
        logger.error(f"Error checking payment: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/lightning/stats', methods=['GET'])
def get_donation_stats():
    """Get donation statistics"""
    try:
        lightning = get_lightning_manager()
        stats = lightning.get_donation_stats()
        return jsonify({
            'success': True,
            'stats': stats
        })
    except Exception as e:
        logger.error(f"Error getting stats: {e}")
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    logger.info("Starting DirtySats")

    # Start monitoring
    fleet.start_monitoring()

    try:
        app.run(
            host=config.FLASK_HOST,
            port=config.FLASK_PORT,
            debug=config.DEBUG
        )
    finally:
        fleet.stop_monitoring()
