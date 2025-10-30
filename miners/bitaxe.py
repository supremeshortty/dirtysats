"""
Bitaxe ESP32 API Handler
"""
import requests
import logging
from typing import Dict
from .base import MinerAPIHandler
import config

logger = logging.getLogger(__name__)


class BitaxeAPIHandler(MinerAPIHandler):
    """Handler for Bitaxe miners using ESP32 API"""

    def __init__(self):
        self.timeout = config.BITAXE_API_TIMEOUT

    def detect(self, ip: str) -> bool:
        """Check if this is a Bitaxe miner"""
        try:
            response = requests.get(
                f"http://{ip}/api/system/info",
                timeout=self.timeout
            )
            if response.status_code == 200:
                data = response.json()
                # Bitaxe has specific fields like ASICModel
                if 'ASICModel' in data or 'power' in data:
                    return True
        except Exception as e:
            logger.debug(f"Bitaxe detection failed for {ip}: {e}")
        return False

    def get_status(self, ip: str) -> Dict:
        """Get status from Bitaxe API"""
        try:
            response = requests.get(
                f"http://{ip}/api/system/info",
                timeout=self.timeout
            )
            response.raise_for_status()
            data = response.json()

            # Parse Bitaxe response format
            return {
                'hashrate': float(data.get('hashRate', 0)),
                'temperature': float(data.get('temp', 0)),
                'power': float(data.get('power', 0)),
                'fan_speed': int(data.get('fanspeed', 0)),
                'model': data.get('ASICModel', 'Bitaxe'),
                'frequency': data.get('frequency', 0),
                'status': 'online',
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
