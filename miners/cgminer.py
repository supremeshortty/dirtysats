"""
CGMiner API Handler (Antminer, Whatsminer, Avalon, etc.)
"""
import socket
import json
import logging
import re
from typing import Dict, Optional, Tuple
from .base import MinerAPIHandler
import config

logger = logging.getLogger(__name__)


class CGMinerAPIHandler(MinerAPIHandler):
    """Handler for CGMiner-based miners (Antminer, Whatsminer, Avalon)"""

    def __init__(self):
        self.timeout = config.CGMINER_API_TIMEOUT
        self.port = config.CGMINER_PORT

    def _parse_avalon_stats(self, stats_str: str) -> Optional[Dict]:
        """
        Parse Avalon miner stats from MM ID string

        Example format: "...OTemp[56] TMax[97] TAvg[89] Fan1[2040] FanR[41%] PS[0 0 27535 4 0 3626 129]..."

        Returns dict with: temp, temp_max, fan_rpm, fan_percent, chip_type, power
        """
        try:
            result = {}

            # Temperature - use TAvg (average chip temp) as main temp
            if match := re.search(r'TAvg\[(\d+)\]', stats_str):
                result['temp'] = int(match.group(1))

            # Max temperature
            if match := re.search(r'TMax\[(\d+)\]', stats_str):
                result['temp_max'] = int(match.group(1))

            # Outer/operating temperature as backup
            if 'temp' not in result:
                if match := re.search(r'OTemp\[(\d+)\]', stats_str):
                    result['temp'] = int(match.group(1))

            # Fan RPM
            if match := re.search(r'Fan1\[(\d+)\]', stats_str):
                result['fan_rpm'] = int(match.group(1))

            # Fan percentage
            if match := re.search(r'FanR\[(\d+)%\]', stats_str):
                result['fan_percent'] = int(match.group(1))

            # Chip type/core
            if match := re.search(r'Core\[([^\]]+)\]', stats_str):
                result['chip_type'] = match.group(1)

            # Power - PS field format: PS[v1 v2 power v4 v5 v6 v7]
            # The third value appears to be power in milliwatts
            if match := re.search(r'PS\[(\d+)\s+(\d+)\s+(\d+)', stats_str):
                power_mw = int(match.group(3))
                result['power'] = power_mw / 1000.0  # Convert to watts

            # Model/Version
            if match := re.search(r'Ver\[([^\]]+)\]', stats_str):
                model_str = match.group(1)
                # Extract just the model name (e.g., "Nano3s" from "Nano3s-25021401_56abae7")
                if '-' in model_str:
                    result['model'] = model_str.split('-')[0]
                else:
                    result['model'] = model_str

            return result if result else None

        except Exception as e:
            logger.debug(f"Error parsing Avalon stats: {e}")
            return None

    def _send_command(self, ip: str, command: str) -> Dict:
        """Send command to CGMiner API"""
        sock = None
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(self.timeout)
            sock.connect((ip, self.port))

            # CGMiner expects JSON command
            request = json.dumps({"command": command})
            sock.sendall(request.encode())

            # Receive response
            response = b''
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                response += chunk

            # Parse response (strip null bytes that some miners append)
            response_str = response.decode().rstrip('\x00')
            return json.loads(response_str)

        except socket.timeout:
            logger.warning(f"Timeout sending command '{command}' to {ip}")
            return {'error': 'timeout'}
        except Exception as e:
            logger.error(f"Error sending command '{command}' to {ip}: {e}")
            return {'error': str(e)}
        finally:
            if sock:
                try:
                    sock.close()
                except Exception:
                    pass

    def detect(self, ip: str) -> bool:
        """Check if this is a CGMiner-based miner"""
        try:
            result = self._send_command(ip, 'version')
            # CGMiner response has STATUS and version info
            if 'STATUS' in result or 'VERSION' in result:
                return True
        except Exception as e:
            logger.debug(f"CGMiner detection failed for {ip}: {e}")
        return False

    def get_status(self, ip: str) -> Dict:
        """Get status from CGMiner API"""
        try:
            # Get summary for overall stats
            summary = self._send_command(ip, 'summary')

            if 'error' in summary:
                return {'status': 'offline', 'error': summary['error']}

            # Parse CGMiner summary response
            if 'SUMMARY' in summary:
                data = summary['SUMMARY'][0] if summary['SUMMARY'] else {}

                # Get device details for temperature
                devs = self._send_command(ip, 'devs')
                temp = 0
                fan_speed = 0
                chip_type = None
                power = 0

                if 'DEVS' in devs and devs['DEVS']:
                    dev = devs['DEVS'][0]
                    temp = dev.get('Temperature', 0)
                    fan_speed = dev.get('Fan Speed In', 0)

                # Detect miner model from version
                version = self._send_command(ip, 'version')
                model = 'CGMiner'
                is_avalon = False

                if 'VERSION' in version and version['VERSION']:
                    version_data = version['VERSION'][0]
                    desc = version_data.get('Description', '')
                    prod = version_data.get('PROD', '')

                    if 'Antminer' in desc:
                        model = 'Antminer'
                    elif 'Whatsminer' in desc:
                        model = 'Whatsminer'
                    elif 'Avalon' in desc or 'Avalon' in prod:
                        model = 'Avalon'
                        is_avalon = True
                        # Get more specific model from PROD field
                        if prod:
                            model = prod  # e.g., "Avalon Nano3s"

                # For Avalon miners, parse detailed stats from STATS command
                if is_avalon:
                    try:
                        stats = self._send_command(ip, 'stats')
                        if 'STATS' in stats and stats['STATS']:
                            # Find the miner stats (not pool stats)
                            for stat in stats['STATS']:
                                if 'MM ID0' in stat:
                                    avalon_data = self._parse_avalon_stats(stat['MM ID0'])
                                    if avalon_data:
                                        temp = avalon_data.get('temp', temp)
                                        fan_speed = avalon_data.get('fan_percent', fan_speed)
                                        chip_type = avalon_data.get('chip_type')
                                        power = avalon_data.get('power', power)
                                        # Use more specific model if available
                                        if 'model' in avalon_data:
                                            model = avalon_data['model']
                                    break
                    except Exception as e:
                        logger.debug(f"Could not parse Avalon stats for {ip}: {e}")

                # Convert MHS to H/s
                hashrate_mhs = data.get('MHS av', 0)
                hashrate = hashrate_mhs * 1_000_000  # Convert to H/s

                result = {
                    'hashrate': float(hashrate),
                    'temperature': float(temp),
                    'power': float(power),
                    'fan_speed': int(fan_speed),
                    'model': model,
                    'status': 'online',
                    # Mining statistics
                    'shares_accepted': int(data.get('Accepted', 0)),
                    'shares_rejected': int(data.get('Rejected', 0)),
                    'best_difficulty': float(data.get('Best Share', 0)),
                    'session_difficulty': float(data.get('Best Share', 0)),  # CGMiner only tracks since boot
                    'uptime_seconds': int(data.get('Elapsed', 0)),
                    'raw': {
                        'summary': summary,
                        'devs': devs
                    }
                }

                # Add chip type if available (for Avalon miners)
                if chip_type:
                    result['asic_model'] = chip_type

                return result

            return {'status': 'error', 'error': 'Invalid CGMiner summary response'}

        except Exception as e:
            logger.error(f"Error getting status from CGMiner at {ip}: {e}")
            return {'status': 'error', 'error': str(e)}

    def apply_settings(self, ip: str, settings: Dict) -> bool:
        """Apply settings to CGMiner (limited support)"""
        logger.warning("CGMiner settings modification not fully implemented")
        # CGMiner API has limited write capabilities
        # This would need miner-specific implementation
        return False

    def get_pools(self, ip: str) -> Optional[Dict]:
        """Get pool configuration from CGMiner API"""
        try:
            result = self._send_command(ip, 'pools')
            if 'error' in result:
                return None

            pool_list = result.get('POOLS', [])
            pools = []
            active_pool = 0

            for pool in pool_list:
                url = pool.get('URL', '')
                user = pool.get('User', '')
                # Track which pool is active (Status: "Alive" + Stratum Active)
                if pool.get('Stratum Active', False) or pool.get('Status') == 'Alive':
                    if pool.get('Stratum Active', False):
                        active_pool = len(pools)
                pools.append({
                    'url': url,
                    'user': user,
                    'password': 'x'
                })

            return {
                'pools': pools,
                'active_pool': active_pool
            }
        except Exception as e:
            logger.error(f"Failed to get pools from CGMiner at {ip}: {e}")
            return None

    def restart(self, ip: str) -> bool:
        """Restart CGMiner"""
        try:
            result = self._send_command(ip, 'restart')
            if 'error' not in result:
                logger.info(f"Restart command sent to CGMiner at {ip}")
                return True
            return False
        except Exception as e:
            logger.error(f"Failed to restart CGMiner at {ip}: {e}")
            return False
