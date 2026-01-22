"""
Miner detection and management
"""
import logging
from typing import Optional, Dict
from .base import MinerAPIHandler
from .bitaxe import BitaxeAPIHandler
from .cgminer import CGMinerAPIHandler
import config

logger = logging.getLogger(__name__)


class Miner:
    """Represents a single miner with its API handler"""

    def __init__(self, ip: str, miner_type: str, api_handler: MinerAPIHandler, custom_name: str = None):
        self.ip = ip
        self.type = miner_type
        self.api_handler = api_handler
        self.last_status = None
        self.model = None
        self.custom_name = custom_name

    def update_status(self) -> Dict:
        """Update and return current status"""
        self.last_status = self.api_handler.get_status(self.ip)
        if 'model' in self.last_status:
            self.model = self.last_status['model']
        return self.last_status

    def apply_settings(self, settings: Dict) -> bool:
        """Apply settings to this miner"""
        return self.api_handler.apply_settings(self.ip, settings)

    def restart(self) -> bool:
        """Restart this miner"""
        return self.api_handler.restart(self.ip)

    def to_dict(self) -> Dict:
        """Convert to dictionary for JSON serialization"""
        return {
            'ip': self.ip,
            'type': self.type,
            'model': self.model,
            'custom_name': self.custom_name,
            'last_status': self.last_status
        }


class MinerDetector:
    """Factory for detecting and creating Miner instances"""

    def __init__(self):
        self.esp_miner_handler = BitaxeAPIHandler()
        self.cgminer_handler = CGMinerAPIHandler()

    def detect(self, ip: str) -> Optional[Miner]:
        """
        Detect miner type at given IP and return Miner instance

        Args:
            ip: IP address to probe

        Returns:
            Miner instance if detected, None otherwise
        """
        logger.debug(f"Detecting miner at {ip}")

        # Try ESP-Miner devices first (BitAxe, NerdQAxe, etc.) - fastest API
        try:
            result = self.esp_miner_handler.detect_type(ip)
            if result:
                type_key, display_name, raw_data = result
                logger.info(f"Detected {display_name} at {ip}")
                miner = Miner(ip, display_name, self.esp_miner_handler)
                miner.model = display_name
                # Store the type key for later use
                miner.type_key = type_key
                # Get full status
                miner.update_status()
                return miner
        except Exception as e:
            logger.debug(f"ESP-Miner detection error at {ip}: {e}")

        # Try CGMiner-based devices (Antminer, Whatsminer, Avalon)
        try:
            if self.cgminer_handler.detect(ip):
                # Get initial status to determine specific miner type
                status = self.cgminer_handler.get_status(ip)
                if status and status.get('status') == 'online':
                    # Use the detected model as the miner type
                    miner_type = status.get('model', config.MINER_TYPES['ANTMINER'])
                    logger.info(f"Detected {miner_type} at {ip}")
                    miner = Miner(ip, miner_type, self.cgminer_handler)
                    # Status already fetched, store it
                    miner.last_status = status
                    if 'model' in status:
                        miner.model = status['model']
                    return miner
        except Exception as e:
            logger.debug(f"CGMiner detection error at {ip}: {e}")

        logger.debug(f"No miner detected at {ip}")
        return None

    def scan_network(self, subnet: str = "10.0.0.0/24") -> list:
        """
        Scan network for miners (stub - use parallel scanner in main app)

        Args:
            subnet: Network subnet to scan

        Returns:
            List of Miner instances
        """
        # This is a placeholder - actual parallel scanning
        # should be done in the main application using ThreadPoolExecutor
        logger.warning("Use FleetManager.discover_miners() for network scanning")
        return []
