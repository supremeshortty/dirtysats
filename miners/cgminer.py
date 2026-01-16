"""
CGMiner API Handler (Antminer, Whatsminer, Avalon, etc.)
"""
import socket
import json
import logging
from typing import Dict
from .base import MinerAPIHandler
import config

logger = logging.getLogger(__name__)


class CGMinerAPIHandler(MinerAPIHandler):
    """Handler for CGMiner-based miners (Antminer, Whatsminer, Avalon)"""

    def __init__(self):
        self.timeout = config.CGMINER_API_TIMEOUT
        self.port = config.CGMINER_PORT

    def _send_command(self, ip: str, command: str) -> Dict:
        """Send command to CGMiner API"""
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

            sock.close()

            # Parse response
            return json.loads(response.decode())

        except socket.timeout:
            logger.warning(f"Timeout sending command '{command}' to {ip}")
            return {'error': 'timeout'}
        except Exception as e:
            logger.error(f"Error sending command '{command}' to {ip}: {e}")
            return {'error': str(e)}

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

                if 'DEVS' in devs and devs['DEVS']:
                    dev = devs['DEVS'][0]
                    temp = dev.get('Temperature', 0)
                    fan_speed = dev.get('Fan Speed In', 0)

                # Detect miner model from version
                version = self._send_command(ip, 'version')
                model = 'CGMiner'
                if 'VERSION' in version and version['VERSION']:
                    desc = version['VERSION'][0].get('Description', '')
                    if 'Antminer' in desc:
                        model = 'Antminer'
                    elif 'Whatsminer' in desc:
                        model = 'Whatsminer'
                    elif 'Avalon' in desc:
                        model = 'Avalon'

                # Convert MHS to H/s
                hashrate_mhs = data.get('MHS av', 0)
                hashrate = hashrate_mhs * 1_000_000  # Convert to H/s

                return {
                    'hashrate': float(hashrate),
                    'temperature': float(temp),
                    'power': 0,  # CGMiner doesn't provide power directly
                    'fan_speed': int(fan_speed),
                    'model': model,
                    'status': 'online',
                    # Mining statistics
                    'shares_accepted': int(data.get('Accepted', 0)),
                    'shares_rejected': int(data.get('Rejected', 0)),
                    'best_difficulty': float(data.get('Best Share', 0)),
                    'uptime_seconds': int(data.get('Elapsed', 0)),
                    'raw': {
                        'summary': summary,
                        'devs': devs
                    }
                }

        except Exception as e:
            logger.error(f"Error getting status from CGMiner at {ip}: {e}")
            return {'status': 'error', 'error': str(e)}

    def apply_settings(self, ip: str, settings: Dict) -> bool:
        """Apply settings to CGMiner (limited support)"""
        logger.warning("CGMiner settings modification not fully implemented")
        # CGMiner API has limited write capabilities
        # This would need miner-specific implementation
        return False

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
