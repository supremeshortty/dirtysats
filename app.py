"""
Home Mining Fleet Manager - Main Application
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
    ENERGY_COMPANY_PRESETS
)

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Flask app
app = Flask(__name__)


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

        self.last_energy_log_time = None
        self.last_profitability_log_time = None

        # Load miners from database
        self._load_miners_from_db()

    def _load_miners_from_db(self):
        """Load known miners from database"""
        logger.info("Loading miners from database...")
        miners_data = self.db.get_all_miners()
        for miner_data in miners_data:
            ip = miner_data['ip']
            # Try to recreate Miner instance
            miner = self.detector.detect(ip)
            if miner:
                with self.lock:
                    self.miners[ip] = miner
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
        network = ipaddress.IPv4Network(subnet, strict=False)

        discovered = []

        def check_ip(ip_str: str) -> Miner:
            """Check single IP for miner"""
            miner = self.detector.detect(ip_str)
            if miner:
                logger.info(f"Found miner at {ip_str}")
            return miner

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
                status = miner.update_status()
                if status.get('status') == 'online':
                    # Save stats to database
                    miner_data = self.db.get_miner_by_ip(miner.ip)
                    if miner_data:
                        self.db.add_stats(
                            miner_data['id'],
                            hashrate=status.get('hashrate'),
                            temperature=status.get('temperature'),
                            power=status.get('power'),
                            fan_speed=status.get('fan_speed'),
                            status='online'
                        )
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

    def _apply_mining_schedule(self):
        """Apply mining schedule (frequency control based on time/rates)"""
        try:
            should_mine, target_frequency = self.mining_scheduler.should_mine_now()

            if target_frequency > 0:  # 0 means no change
                logger.info(f"Applying schedule: target_frequency={target_frequency}")
                with self.lock:
                    for miner in self.miners.values():
                        # Only apply to Bitaxe miners (support frequency control)
                        if miner.type == 'Bitaxe' and miner.last_status:
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
                    # Save to database
                    self.db.add_profitability_log(
                        btc_price=prof['btc_price'],
                        network_difficulty=prof['network_difficulty'],
                        total_hashrate=prof['total_hashrate_ths'],
                        estimated_btc_per_day=prof['btc_per_day'],
                        energy_cost_per_day=prof['energy_cost_per_day'],
                        profit_per_day=prof['profit_per_day']
                    )

                    logger.info(f"Profitability: ${prof['profit_per_day']:.2f}/day " +
                              f"({prof['profit_margin']:.1f}% margin)")

            self.last_profitability_log_time = now

        except Exception as e:
            logger.error(f"Error logging profitability: {e}")

    def start_monitoring(self):
        """Start background monitoring thread"""
        if self.monitoring_active:
            logger.warning("Monitoring already active")
            return

        self.monitoring_active = True

        def monitor_loop():
            logger.info("Monitoring thread started")
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

    def get_fleet_stats(self) -> Dict:
        """Get aggregated fleet statistics"""
        with self.lock:
            online_count = 0
            total_hashrate = 0
            total_power = 0
            avg_temp = 0
            temp_count = 0

            for miner in self.miners.values():
                if miner.last_status and miner.last_status.get('status') == 'online':
                    online_count += 1
                    total_hashrate += miner.last_status.get('hashrate', 0)
                    total_power += miner.last_status.get('power', 0)
                    if miner.last_status.get('temperature'):
                        avg_temp += miner.last_status['temperature']
                        temp_count += 1

            return {
                'total_miners': len(self.miners),
                'online_miners': online_count,
                'offline_miners': len(self.miners) - online_count,
                'total_hashrate': total_hashrate,
                'total_power': total_power,
                'avg_temperature': avg_temp / temp_count if temp_count > 0 else 0,
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
    stats = fleet.get_fleet_stats()
    return jsonify({
        'success': True,
        'stats': stats
    })


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
                    fleet.db.set_energy_config(
                        location=preset['location'],
                        energy_company=preset_name
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


@app.route('/api/energy/presets', methods=['GET'])
def energy_presets():
    """Get available energy company presets"""
    return jsonify({
        'success': True,
        'presets': list(ENERGY_COMPANY_PRESETS.keys())
    })


@app.route('/api/energy/profitability', methods=['GET'])
def get_profitability():
    """Calculate current profitability"""
    try:
        stats = fleet.get_fleet_stats()
        current_rate = fleet.energy_rate_mgr.get_current_rate()

        prof = fleet.profitability_calc.calculate_profitability(
            total_hashrate=stats['total_hashrate'],
            total_power_watts=stats['total_power'],
            energy_rate_per_kwh=current_rate
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


if __name__ == '__main__':
    logger.info("Starting Home Mining Fleet Manager")

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
