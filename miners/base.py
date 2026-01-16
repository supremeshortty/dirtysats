"""
Base abstract class for miner API handlers
"""
from abc import ABC, abstractmethod
from typing import Dict, Optional


class MinerAPIHandler(ABC):
    """Abstract base class for all miner API implementations"""

    @abstractmethod
    def get_status(self, ip: str) -> Dict:
        """
        Get current status from miner

        Args:
            ip: Miner IP address

        Returns:
            Dict with standardized fields:
                - hashrate: float (hashes per second)
                - temperature: float (celsius)
                - power: float (watts)
                - fan_speed: int (percentage or RPM)
                - model: str (miner model)
                - status: str (online/offline/error)
                - raw: dict (original API response)
        """
        pass

    @abstractmethod
    def apply_settings(self, ip: str, settings: Dict) -> bool:
        """
        Apply settings to miner

        Args:
            ip: Miner IP address
            settings: Dictionary of settings to apply

        Returns:
            True if successful, False otherwise
        """
        pass

    @abstractmethod
    def restart(self, ip: str) -> bool:
        """
        Restart miner

        Args:
            ip: Miner IP address

        Returns:
            True if restart command sent successfully
        """
        pass

    @abstractmethod
    def detect(self, ip: str) -> bool:
        """
        Check if this handler can communicate with the miner at this IP

        Args:
            ip: IP address to check

        Returns:
            True if this miner type is detected
        """
        pass

    def get_pools(self, ip: str) -> Optional[Dict]:
        """
        Get pool configuration from miner

        Args:
            ip: Miner IP address

        Returns:
            Dict with pool information:
                - pools: list of pool dicts with url, user, password
                - active_pool: currently active pool index
            None if not supported or error
        """
        return None

    def set_pools(self, ip: str, pools: list) -> bool:
        """
        Set pool configuration on miner

        Args:
            ip: Miner IP address
            pools: List of pool dicts with url, user, password

        Returns:
            True if successful, False otherwise
        """
        return False
