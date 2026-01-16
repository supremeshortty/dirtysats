"""
ESP-Miner API Handler (BitAxe, NerdQAxe, LuckyMiner, etc.)
"""
import requests
import logging
from typing import Dict, Optional, Tuple
from .base import MinerAPIHandler
import config

logger = logging.getLogger(__name__)


class BitaxeAPIHandler(MinerAPIHandler):
    """Handler for ESP-Miner based devices (BitAxe, NerdQAxe, LuckyMiner, etc.)"""

    def __init__(self):
        self.timeout = config.BITAXE_API_TIMEOUT

    def _classify_device(self, data: Dict) -> Tuple[str, str]:
        """
        Classify the exact device type based on multiple factors.

        Returns:
            Tuple of (miner_type_key, display_name)
        """
        # Extract identification fields
        asic_model = data.get('ASICModel', data.get('asicModel', ''))
        asic_count = data.get('ASICCount', data.get('asicCount', 1))
        firmware = data.get('version', '')
        device_model = data.get('deviceModel', '')
        board_version = data.get('boardVersion', '')
        hostname = data.get('hostname', '')

        firmware_upper = firmware.upper()
        hostname_upper = hostname.upper()
        board_upper = board_version.upper()

        # Method 1: Check firmware version string (most reliable for NerdQAxe)
        if 'NERDQAXEPLUS' in firmware_upper or 'NERDQAXE++' in firmware_upper:
            return ('NERDQAXE_PLUSPLUS', config.MINER_TYPES['NERDQAXE_PLUSPLUS'])
        if 'NERDOCTAXE' in firmware_upper:
            return ('NERDOCTAXE', config.MINER_TYPES['NERDOCTAXE'])
        if 'NERDQAXE' in firmware_upper:
            return ('NERDQAXE_PLUS', config.MINER_TYPES['NERDQAXE_PLUS'])
        if 'NERDAXE' in firmware_upper:
            return ('NERDAXE', config.MINER_TYPES['NERDAXE'])
        if 'LUCKYMINER' in firmware_upper:
            return ('LUCKYMINER', config.MINER_TYPES['LUCKYMINER'])

        # Method 2: Check hostname (often set to device type)
        if 'NERDQAXE++' in hostname_upper or 'NERDQAXEPLUS' in hostname_upper:
            return ('NERDQAXE_PLUSPLUS', config.MINER_TYPES['NERDQAXE_PLUSPLUS'])
        if 'NERDOCTAXE' in hostname_upper:
            return ('NERDOCTAXE', config.MINER_TYPES['NERDOCTAXE'])
        if 'NERDQAXE' in hostname_upper:
            return ('NERDQAXE_PLUS', config.MINER_TYPES['NERDQAXE_PLUS'])
        if 'NERDAXE' in hostname_upper:
            return ('NERDAXE', config.MINER_TYPES['NERDAXE'])

        # Method 3: Check board version
        if 'NERDQAXE' in board_upper or 'NERD' in board_upper:
            if asic_count >= 6:
                return ('NERDOCTAXE', config.MINER_TYPES['NERDOCTAXE'])
            elif asic_count >= 4:
                return ('NERDQAXE_PLUSPLUS', config.MINER_TYPES['NERDQAXE_PLUSPLUS'])
            else:
                return ('NERDAXE', config.MINER_TYPES['NERDAXE'])

        # Method 4: Use ASIC model + count lookup from config
        lookup_key = (asic_model, asic_count)
        if lookup_key in config.ESP_MINER_PROFILES:
            type_key = config.ESP_MINER_PROFILES[lookup_key]
            return (type_key, config.MINER_TYPES[type_key])

        # Method 5: Handle unknown multi-chip devices (likely NerdQAxe variant)
        if asic_count >= 6:
            return ('NERDOCTAXE', f'NerdOctaxe ({asic_count}x {asic_model})')
        elif asic_count >= 4:
            return ('NERDQAXE_PLUSPLUS', f'NerdQAxe++ ({asic_count}x {asic_model})')
        elif asic_count > 1:
            return ('NERDQAXE_PLUS', f'NerdQAxe+ ({asic_count}x {asic_model})')

        # Method 6: Fall back to BitAxe with device model suffix
        model_map = {
            'max': ('BITAXE_MAX', config.MINER_TYPES['BITAXE_MAX']),
            'ultra': ('BITAXE_ULTRA', config.MINER_TYPES['BITAXE_ULTRA']),
            'supra': ('BITAXE_SUPRA', config.MINER_TYPES['BITAXE_SUPRA']),
            'gamma': ('BITAXE_GAMMA', config.MINER_TYPES['BITAXE_GAMMA']),
        }

        device_model_lower = device_model.lower()
        if device_model_lower in model_map:
            return model_map[device_model_lower]

        # Default: generic BitAxe
        return ('BITAXE', config.MINER_TYPES['BITAXE'])

    def detect(self, ip: str) -> bool:
        """Check if this is an ESP-Miner based device"""
        try:
            response = requests.get(
                f"http://{ip}/api/system/info",
                timeout=self.timeout
            )
            if response.status_code == 200:
                data = response.json()
                # ESP-Miner devices have specific fields like ASICModel or power
                if 'ASICModel' in data or 'asicModel' in data or 'power' in data:
                    return True
        except Exception as e:
            logger.debug(f"ESP-Miner detection failed for {ip}: {e}")
        return False

    def detect_type(self, ip: str) -> Optional[Tuple[str, str, Dict]]:
        """
        Detect and classify the specific device type.

        Returns:
            Tuple of (type_key, display_name, raw_data) or None if not detected
        """
        try:
            response = requests.get(
                f"http://{ip}/api/system/info",
                timeout=self.timeout
            )
            if response.status_code == 200:
                data = response.json()
                if 'ASICModel' in data or 'asicModel' in data or 'power' in data:
                    type_key, display_name = self._classify_device(data)
                    logger.info(f"Classified {ip} as {display_name} (ASICCount={data.get('ASICCount', 1)}, firmware={data.get('version', 'unknown')})")
                    return (type_key, display_name, data)
        except Exception as e:
            logger.debug(f"ESP-Miner type detection failed for {ip}: {e}")
        return None

    def get_status(self, ip: str) -> Dict:
        """Get status from ESP-Miner API"""
        try:
            response = requests.get(
                f"http://{ip}/api/system/info",
                timeout=self.timeout
            )
            response.raise_for_status()
            data = response.json()

            # ESP-Miner API returns hashRate in GH/s, convert to H/s
            hashrate_ghs = float(data.get('hashRate', 0))
            hashrate_hs = hashrate_ghs * 1e9  # Convert GH/s to H/s

            # Classify the device
            type_key, display_name = self._classify_device(data)

            # Parse response format
            return {
                'hashrate': hashrate_hs,
                'temperature': float(data.get('temp', 0)),
                'power': float(data.get('power', 0)),
                'fan_speed': int(data.get('fanspeed', data.get('fanSpeed', 0))),
                'model': display_name,
                'miner_type': type_key,
                'frequency': data.get('frequency', 0),
                'voltage': data.get('coreVoltage', data.get('voltage', 0)),
                'status': 'online',
                # ASIC info
                'asic_model': data.get('ASICModel', data.get('asicModel', '')),
                'asic_count': data.get('ASICCount', data.get('asicCount', 1)),
                # Mining statistics
                'shares_accepted': int(data.get('sharesAccepted', data.get('shares', 0))),
                'shares_rejected': int(data.get('sharesRejected', 0)),
                'best_difficulty': data.get('bestDiff', data.get('bestDifficulty', 0)),
                'session_difficulty': data.get('sessionDiff', 0),
                'uptime_seconds': int(data.get('uptimeSeconds', data.get('runningTime', 0))),
                # Device info
                'hostname': data.get('hostname', ''),
                'firmware': data.get('version', ''),
                'board_version': data.get('boardVersion', ''),
                'raw': data
            }

        except requests.exceptions.Timeout:
            logger.warning(f"Timeout getting status from Bitaxe at {ip}")
            return {'status': 'offline', 'error': 'timeout'}
        except requests.exceptions.RequestException as e:
            logger.error(f"Error getting status from Bitaxe at {ip}: {e}")
            return {'status': 'error', 'error': str(e)}
        except Exception as e:
            logger.error(f"Unexpected error with Bitaxe at {ip}: {e}")
            return {'status': 'error', 'error': str(e)}

    def apply_settings(self, ip: str, settings: Dict) -> bool:
        """Apply settings to Bitaxe"""
        try:
            response = requests.patch(
                f"http://{ip}/api/system",
                json=settings,
                timeout=self.timeout
            )
            response.raise_for_status()
            logger.info(f"Applied settings to Bitaxe at {ip}")
            return True
        except Exception as e:
            logger.error(f"Failed to apply settings to Bitaxe at {ip}: {e}")
            return False

    def restart(self, ip: str) -> bool:
        """Restart Bitaxe"""
        try:
            response = requests.post(
                f"http://{ip}/api/system/restart",
                timeout=self.timeout
            )
            response.raise_for_status()
            logger.info(f"Restart command sent to Bitaxe at {ip}")
            return True
        except Exception as e:
            logger.error(f"Failed to restart Bitaxe at {ip}: {e}")
            return False

    def get_pools(self, ip: str) -> Dict:
        """Get pool configuration from Bitaxe"""
        try:
            response = requests.get(
                f"http://{ip}/api/system/info",
                timeout=self.timeout
            )
            response.raise_for_status()
            data = response.json()

            # Bitaxe supports 3 pools
            pools = []
            for i in range(3):
                pool_url = data.get(f'stratumURL' if i == 0 else f'stratumURL{i}', '')
                pool_port = data.get(f'stratumPort' if i == 0 else f'stratumPort{i}', 3333)
                pool_user = data.get(f'stratumUser' if i == 0 else f'stratumUser{i}', '')
                pool_pass = data.get(f'stratumPassword' if i == 0 else f'stratumPassword{i}', 'x')

                if pool_url:
                    pools.append({
                        'url': f"{pool_url}:{pool_port}",
                        'user': pool_user,
                        'password': pool_pass
                    })

            return {
                'pools': pools,
                'active_pool': 0  # Bitaxe doesn't expose which pool is active
            }

        except Exception as e:
            logger.error(f"Failed to get pools from Bitaxe at {ip}: {e}")
            return None

    def set_pools(self, ip: str, pools: list) -> bool:
        """Set pool configuration on Bitaxe"""
        try:
            settings = {}

            # Update up to 3 pools
            for i, pool in enumerate(pools[:3]):
                if i >= 3:
                    break

                # Parse pool URL and port
                pool_url = pool.get('url', '')
                if ':' in pool_url:
                    url_parts = pool_url.rsplit(':', 1)
                    pool_host = url_parts[0]
                    pool_port = int(url_parts[1]) if url_parts[1].isdigit() else 3333
                else:
                    pool_host = pool_url
                    pool_port = 3333

                # Set pool fields
                if i == 0:
                    settings['stratumURL'] = pool_host
                    settings['stratumPort'] = pool_port
                    settings['stratumUser'] = pool.get('user', '')
                    settings['stratumPassword'] = pool.get('password', 'x')
                else:
                    settings[f'stratumURL{i}'] = pool_host
                    settings[f'stratumPort{i}'] = pool_port
                    settings[f'stratumUser{i}'] = pool.get('user', '')
                    settings[f'stratumPassword{i}'] = pool.get('password', 'x')

            # Apply settings
            response = requests.patch(
                f"http://{ip}/api/system",
                json=settings,
                timeout=self.timeout
            )
            response.raise_for_status()
            logger.info(f"Updated pool configuration on Bitaxe at {ip}")
            return True

        except Exception as e:
            logger.error(f"Failed to set pools on Bitaxe at {ip}: {e}")
            return False
