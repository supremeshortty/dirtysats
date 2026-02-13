"""
Lightning Network Integration for DirtySats

Enables satoshi donations to support development.
Uses LNBits API for receiving payments.
"""
import logging
import os
import requests
from typing import Dict, Optional
from datetime import datetime

logger = logging.getLogger(__name__)


class LightningDonationManager:
    """
    Manages Lightning donations for DirtySats development.
    Integrates with LNBits for payment receiving.
    """

    def __init__(self, lnbits_url: str = None, lnbits_key: str = None):
        """
        Initialize Lightning manager.
        
        Args:
            lnbits_url: LNBits instance URL (e.g., https://lnbits.example.com)
            lnbits_key: LNBits admin key for receiving payments
        """
        # LNBits configuration
        self.lnbits_url = lnbits_url or os.environ.get("LNBITS_URL") or "https://legend.lnbits.com"
        self.lnbits_key = lnbits_key or os.environ.get("LNBITS_KEY")
        
        # Donation settings
        self.donation_amounts = [500, 1000, 5000, 21000]  # sats
        self.donation_description = "Support DirtySats Development ☕"

    def create_invoice(self, amount_sats: int, description: str = None) -> Optional[Dict]:
        """
        Create a Lightning invoice for donations.
        
        Args:
            amount_sats: Amount in satoshis
            description: Invoice description
        
        Returns:
            {
                'payment_request': 'lnbc...',
                'checking_id': 'payment_id',
                'amount': amount_sats,
                'created_at': timestamp
            }
        """
        if not self.lnbits_key:
            logger.warning("LNBits key not configured")
            return None

        try:
            url = f"{self.lnbits_url}/api/v1/payments"
            headers = {"X-Api-Key": self.lnbits_key}
            payload = {
                "out": False,  # Receiving payment
                "amount": amount_sats,
                "memo": description or self.donation_description,
            }

            response = requests.post(url, json=payload, headers=headers, timeout=10)
            response.raise_for_status()

            data = response.json()
            return {
                "payment_request": data.get("payment_request"),
                "checking_id": data.get("checking_id"),
                "amount": amount_sats,
                "description": description or self.donation_description,
                "created_at": datetime.utcnow().isoformat(),
            }

        except Exception as e:
            logger.error(f"Failed to create Lightning invoice: {e}")
            return None

    def check_payment_status(self, checking_id: str) -> Dict:
        """
        Check if a Lightning payment has been received.
        
        Args:
            checking_id: Payment ID from invoice
        
        Returns:
            {
                'paid': bool,
                'amount': sats,
                'timestamp': datetime
            }
        """
        if not self.lnbits_key:
            logger.warning("LNBits key not configured")
            return {"paid": False}

        try:
            url = f"{self.lnbits_url}/api/v1/payments/{checking_id}"
            headers = {"X-Api-Key": self.lnbits_key}

            response = requests.get(url, headers=headers, timeout=10)
            response.raise_for_status()

            data = response.json()
            return {
                "paid": data.get("paid", False),
                "amount": data.get("amount"),
                "timestamp": datetime.utcnow().isoformat(),
            }

        except Exception as e:
            logger.error(f"Failed to check payment status: {e}")
            return {"paid": False}

    def get_donation_stats(self) -> Dict:
        """
        Get donation statistics (mock for now).
        """
        return {
            "total_donations_sats": 0,
            "total_donors": 0,
            "average_donation": 0,
            "target_monthly": 500000,  # 500K sats/month goal
            "current_month": 0,
        }

    def get_standard_amounts(self) -> list:
        """Get suggested donation amounts in sats."""
        return self.donation_amounts


# Global instance
lightning_manager = None


def init_lightning(lnbits_url: str = None, lnbits_key: str = None):
    """Initialize global Lightning manager."""
    global lightning_manager
    lightning_manager = LightningDonationManager(lnbits_url, lnbits_key)
    return lightning_manager


def get_lightning_manager() -> LightningDonationManager:
    """Get global Lightning manager."""
    global lightning_manager
    if lightning_manager is None:
        lightning_manager = LightningDonationManager()
    return lightning_manager
