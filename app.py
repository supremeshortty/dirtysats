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
        self.profitability_calc = ProfitabilityCalculator(self.btc_fetcher)
        self.energy_rate_mgr = EnergyRateManager(self.db)
        self.mining_scheduler = MiningScheduler(self.db, self.energy_rate_mgr)
        self.utility_rate_service = UtilityRateService(db=self.db)

        self.last_energy_log_time = None
        self.last_profitability_log_time = None

        # Thermal management
        self.thermal_mgr = ThermalManager(self.db)

        # Alert system
        self.alert_mgr = AlertManager(self.db)

        # Weather integration
        self.weather_mgr = WeatherManager(self.db)

        # Track miner states for alert deduplication
        self.miner_alert_states = {}  # ip -> {'last_offline_alert': timestamp, 'last_temp_alert': timestamp}

        # Track miners that need auto-reboot after overheat recovery
        self.overheat_recovery_states = {}  # ip -> {'overheated_at': timestamp}

        # Load miners from database
        self._load_miners_from_db()

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
        """Log energy consumption every 15 minutes"""
        now = datetime.now()

        if self.last_energy_log_time:
            minutes_elapsed = (now - self.last_energy_log_time).total_seconds() / 60
            if minutes_elapsed < 15:
                return

        try:
            # Get current fleet stats
            stats = self.get_fleet_stats()
            total_power = stats['total_power']  # Watts

            if total_power > 0:
                # Get current energy rate
                current_rate = self.energy_rate_mgr.get_current_rate()

                # Calculate energy consumed in last 15 minutes (or since last log)
                if self.last_energy_log_time:
                    hours_elapsed = (now - self.last_energy_log_time).total_seconds() / 3600
                else:
                    hours_elapsed = 0.25  # Assume 15 minutes

                energy_kwh = (total_power / 1000) * hours_elapsed
                cost = energy_kwh * current_rate

                # Save to database
                self.db.add_energy_consumption(
                    total_power_watts=total_power,
                    energy_kwh=energy_kwh,
                    cost=cost,
                    current_rate=current_rate
                )

                logger.debug(f"Logged energy: {energy_kwh:.3f} kWh at ${current_rate:.3f}/kWh = ${cost:.2f}")

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
            return [miner.to_dict() for miner in self.miners.values()]


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


@app.route('/api/pools', methods=['GET'])
def get_all_pools():
    """Get pool configuration for all miners"""
    pools_data = []

    with fleet.lock:
        for ip, miner in fleet.miners.items():
            pools_info = miner.api_handler.get_pools(ip)
            if pools_info:
                pools_data.append({
                    'ip': ip,
                    'model': miner.model,
                    'type': miner.type,
                    'pools': pools_info.get('pools', []),
                    'active_pool': pools_info.get('active_pool', 0)
                })

    return jsonify({
        'success': True,
        'miners': pools_data
    })


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
    """Calculate current profitability with TOU rates and mining schedule support"""
    try:
        stats = fleet.get_fleet_stats()
        current_rate = fleet.energy_rate_mgr.get_current_rate()

        # Get optional parameters
        pool_fee = request.args.get('pool_fee', type=float)
        include_tx_fees = request.args.get('include_tx_fees', 'true').lower() == 'true'
        # Option to use simple calculation (without schedule/TOU)
        use_simple = request.args.get('simple', 'false').lower() == 'true'

        if use_simple:
            # Simple calculation without schedule/TOU consideration
            prof = fleet.profitability_calc.calculate_profitability(
                total_hashrate=stats['total_hashrate'],
                total_power_watts=stats['total_power'],
                energy_rate_per_kwh=current_rate,
                pool_fee_percent=pool_fee,
                include_tx_fees=include_tx_fees
            )
        else:
            # Full calculation with TOU rates and mining schedules
            prof = fleet.profitability_calc.calculate_profitability(
                total_hashrate=stats['total_hashrate'],
                total_power_watts=stats['total_power'],
                energy_rate_per_kwh=current_rate,
                pool_fee_percent=pool_fee,
                include_tx_fees=include_tx_fees,
                rate_manager=fleet.energy_rate_mgr,
                mining_scheduler=fleet.mining_scheduler
            )

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
    """Get energy consumption history"""
    try:
        hours = int(request.args.get('hours', 24))
        history = fleet.db.get_energy_consumption_history(hours)

        # Calculate totals
        total_kwh = sum(h['energy_kwh'] for h in history if h['energy_kwh'])
        total_cost = sum(h['cost'] for h in history if h['cost'])

        return jsonify({
            'success': True,
            'history': history,
            'total_kwh': total_kwh,
            'total_cost': total_cost
        })
    except Exception as e:
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
            from collections import defaultdict
            aggregated = defaultdict(float)

            for miner in fleet.miners.values():
                miner_data = fleet.db.get_miner_by_ip(miner.ip)
                if miner_data:
                    history = fleet.db.get_stats_history(miner_data['id'], hours)
                    for h in history:
                        if h.get('power'):
                            aggregated[h['timestamp']] += h['power']

            data_points = [
                {
                    'timestamp': timestamp,
                    'power': power
                }
                for timestamp, power in sorted(aggregated.items())
            ]

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
                'uptime_seconds': 43200,
                'hostname': 'bitaxe-gamma-1',
                'firmware': 'v2.4.1',
                'raw': {'ASICModel': 'BM1370', 'ASICCount': 1, 'frequency': 575, 'coreVoltage': 1200, 'fanSpeedPercent': 50}
            }
        },
        {
            'ip': '10.0.0.104',
            'type': 'NerdAxe',
            'model': 'NerdAxe',
            'custom_name': 'Basement Solo',
            'status': {
                'hashrate': 502e9,  # 502 GH/s (BM1366)
                'temperature': 51.8,
                'power': 12.0,  # ~24 J/TH efficiency
                'fan_speed': 40,
                'frequency': 490,
                'voltage': 1200,
                'status': 'online',
                'asic_model': 'BM1366',
                'asic_count': 1,
                'shares_accepted': 654,
                'shares_rejected': 1,
                'best_difficulty': 1800000,  # 1.8M
                'uptime_seconds': 259200,
                'hostname': 'nerdaxe-1',
                'firmware': 'v1.2.0',
                'raw': {'ASICModel': 'BM1366', 'ASICCount': 1, 'frequency': 490, 'coreVoltage': 1200, 'fanSpeedPercent': 40}
            }
        },
        {
            'ip': '10.0.0.105',
            'type': 'BitAxe Supra',
            'model': 'BitAxe Supra',
            'custom_name': None,  # No custom name
            'status': {
                'hashrate': 658e9,  # 658 GH/s (BM1368)
                'temperature': 53.5,
                'power': 14.5,  # ~22 J/TH efficiency
                'fan_speed': 48,
                'frequency': 525,
                'voltage': 1200,
                'status': 'online',
                'asic_model': 'BM1368',
                'asic_count': 1,
                'shares_accepted': 1102,
                'shares_rejected': 5,
                'best_difficulty': 2200000,  # 2.2M
                'uptime_seconds': 7200,
                'hostname': 'bitaxe-supra',
                'firmware': 'v2.3.0',
                'raw': {'ASICModel': 'BM1368', 'ASICCount': 1, 'frequency': 525, 'coreVoltage': 1200, 'fanSpeedPercent': 48}
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
