"""
Energy Management Module

Handles energy rates, Bitcoin price/difficulty fetching, profitability calculations,
and automated frequency control based on time-of-use pricing.
"""
import requests
import logging
from datetime import datetime, time as dt_time
from typing import Dict, List, Optional, Tuple
import config

logger = logging.getLogger(__name__)


class BitcoinDataFetcher:
    """Fetch Bitcoin price and network difficulty"""

    def __init__(self):
        self.btc_price_cache = None
        self.btc_price_cache_time = None
        self.difficulty_cache = None
        self.difficulty_cache_time = None
        self.cache_duration = 300  # 5 minutes

    def get_btc_price(self) -> Optional[float]:
        """Get current Bitcoin price in USD"""
        # Check cache
        if self.btc_price_cache and self.btc_price_cache_time:
            age = (datetime.now() - self.btc_price_cache_time).total_seconds()
            if age < self.cache_duration:
                return self.btc_price_cache

        try:
            # CoinGecko API (free, no API key needed)
            response = requests.get(
                "https://api.coingecko.com/api/v3/simple/price",
                params={"ids": "bitcoin", "vs_currencies": "usd"},
                timeout=5
            )
            response.raise_for_status()
            data = response.json()
            price = data['bitcoin']['usd']

            # Cache result
            self.btc_price_cache = price
            self.btc_price_cache_time = datetime.now()

            logger.info(f"Fetched BTC price: ${price:,.2f}")
            return price

        except Exception as e:
            logger.error(f"Error fetching BTC price: {e}")
            # Return cached value if available
            return self.btc_price_cache

    def get_network_difficulty(self) -> Optional[float]:
        """Get current Bitcoin network difficulty"""
        # Check cache
        if self.difficulty_cache and self.difficulty_cache_time:
            age = (datetime.now() - self.difficulty_cache_time).total_seconds()
            if age < self.cache_duration:
                return self.difficulty_cache

        try:
            # Blockchain.info API (free)
            response = requests.get(
                "https://blockchain.info/q/getdifficulty",
                timeout=5
            )
            response.raise_for_status()
            difficulty = float(response.text)

            # Cache result
            self.difficulty_cache = difficulty
            self.difficulty_cache_time = datetime.now()

            logger.info(f"Fetched network difficulty: {difficulty:,.0f}")
            return difficulty

        except Exception as e:
            logger.error(f"Error fetching network difficulty: {e}")
            # Return cached value if available
            return self.difficulty_cache


class ProfitabilityCalculator:
    """Calculate mining profitability"""

    def __init__(self, btc_fetcher: BitcoinDataFetcher):
        self.btc_fetcher = btc_fetcher

    def calculate_btc_per_day(self, hashrate_th: float, difficulty: float = None) -> float:
        """
        Calculate estimated BTC mined per day

        Args:
            hashrate_th: Hashrate in TH/s
            difficulty: Network difficulty (fetched if not provided)

        Returns:
            Estimated BTC per day
        """
        if difficulty is None:
            difficulty = self.btc_fetcher.get_network_difficulty()
            if difficulty is None:
                return 0.0

        # Formula: BTC per day = (hashrate_h/s * 86400) / (difficulty * 2^32)
        hashrate_hs = hashrate_th * 1e12  # Convert TH/s to H/s
        btc_per_day = (hashrate_hs * 86400) / (difficulty * 2**32)

        return btc_per_day

    def calculate_profitability(self, total_hashrate: float, total_power_watts: float,
                               energy_rate_per_kwh: float, btc_price: float = None,
                               difficulty: float = None) -> Dict:
        """
        Calculate comprehensive profitability metrics

        Args:
            total_hashrate: Total fleet hashrate in H/s
            total_power_watts: Total fleet power consumption in watts
            energy_rate_per_kwh: Current energy rate in $/kWh
            btc_price: BTC price in USD (fetched if not provided)
            difficulty: Network difficulty (fetched if not provided)

        Returns:
            Dictionary with profitability metrics
        """
        # Get BTC price
        if btc_price is None:
            btc_price = self.btc_fetcher.get_btc_price()
            if btc_price is None:
                return {'error': 'Unable to fetch BTC price'}

        # Get network difficulty
        if difficulty is None:
            difficulty = self.btc_fetcher.get_network_difficulty()
            if difficulty is None:
                return {'error': 'Unable to fetch network difficulty'}

        # Convert hashrate to TH/s
        hashrate_th = total_hashrate / 1e12

        # Calculate BTC mined per day
        btc_per_day = self.calculate_btc_per_day(hashrate_th, difficulty)

        # Calculate revenue
        revenue_per_day = btc_per_day * btc_price

        # Calculate energy consumption
        energy_kwh_per_day = (total_power_watts / 1000) * 24  # kWh per day
        energy_cost_per_day = energy_kwh_per_day * energy_rate_per_kwh

        # Calculate profit
        profit_per_day = revenue_per_day - energy_cost_per_day

        # Calculate efficiency metrics
        profit_margin = (profit_per_day / revenue_per_day * 100) if revenue_per_day > 0 else 0
        break_even_btc_price = (energy_cost_per_day / btc_per_day) if btc_per_day > 0 else 0

        return {
            'btc_price': btc_price,
            'network_difficulty': difficulty,
            'total_hashrate_ths': hashrate_th,
            'total_power_watts': total_power_watts,
            'btc_per_day': btc_per_day,
            'revenue_per_day': revenue_per_day,
            'energy_kwh_per_day': energy_kwh_per_day,
            'energy_cost_per_day': energy_cost_per_day,
            'profit_per_day': profit_per_day,
            'profit_margin': profit_margin,
            'break_even_btc_price': break_even_btc_price,
            'is_profitable': profit_per_day > 0
        }


class EnergyRateManager:
    """Manage time-of-use energy rates"""

    def __init__(self, db):
        self.db = db

    def get_current_rate(self) -> float:
        """Get current energy rate based on time of day"""
        now = datetime.now()
        current_time = now.strftime("%H:%M")
        current_day = now.strftime("%A")  # Monday, Tuesday, etc.

        rates = self.db.get_energy_rates()

        # Find matching rate for current time
        for rate in rates:
            # Check if day matches (if specified)
            if rate['day_of_week'] and rate['day_of_week'] != current_day:
                continue

            # Check if time is in range
            start = rate['start_time']
            end = rate['end_time']

            if self._time_in_range(current_time, start, end):
                return rate['rate_per_kwh']

        # Return default rate if no match
        config_data = self.db.get_energy_config()
        if config_data and 'default_rate' in config_data:
            return config_data['default_rate']

        return 0.12  # Default fallback rate (US average)

    def _time_in_range(self, current: str, start: str, end: str) -> bool:
        """Check if current time is within start-end range"""
        try:
            current_dt = datetime.strptime(current, "%H:%M").time()
            start_dt = datetime.strptime(start, "%H:%M").time()
            end_dt = datetime.strptime(end, "%H:%M").time()

            if start_dt <= end_dt:
                # Normal range (e.g., 09:00 to 17:00)
                return start_dt <= current_dt <= end_dt
            else:
                # Range crosses midnight (e.g., 22:00 to 06:00)
                return current_dt >= start_dt or current_dt <= end_dt
        except Exception as e:
            logger.error(f"Error checking time range: {e}")
            return False

    def get_rate_schedule(self) -> List[Dict]:
        """Get full rate schedule"""
        return self.db.get_energy_rates()

    def set_tou_rates(self, rates: List[Dict]):
        """
        Set time-of-use rates

        Args:
            rates: List of rate dictionaries with keys:
                - start_time: "HH:MM"
                - end_time: "HH:MM"
                - rate_per_kwh: float
                - day_of_week: str (optional)
                - rate_type: str (peak/off-peak/standard)
        """
        # Clear existing rates
        self.db.delete_all_energy_rates()

        # Add new rates
        for rate in rates:
            self.db.add_energy_rate(
                start_time=rate['start_time'],
                end_time=rate['end_time'],
                rate_per_kwh=rate['rate_per_kwh'],
                day_of_week=rate.get('day_of_week'),
                rate_type=rate.get('rate_type', 'standard')
            )

        logger.info(f"Set {len(rates)} TOU rates")


class MiningScheduler:
    """Automated mining schedule based on energy rates"""

    def __init__(self, db, rate_manager: EnergyRateManager):
        self.db = db
        self.rate_manager = rate_manager

    def should_mine_now(self) -> Tuple[bool, int]:
        """
        Check if miners should be running now and at what frequency

        Returns:
            Tuple of (should_mine, target_frequency)
        """
        schedules = self.db.get_mining_schedules()

        if not schedules:
            # No schedule configured, always mine at max
            return True, 0  # 0 means no change

        now = datetime.now()
        current_time = now.strftime("%H:%M")
        current_day = now.strftime("%A")

        for schedule in schedules:
            # Check if day matches
            if schedule['day_of_week'] and schedule['day_of_week'] != current_day:
                continue

            # Check if time is in range
            if self.rate_manager._time_in_range(
                current_time,
                schedule['start_time'],
                schedule['end_time']
            ):
                target_freq = schedule['target_frequency']
                should_mine = target_freq > 0
                return should_mine, target_freq

        # Default: mine at full speed
        return True, 0

    def create_schedule_from_rates(self, max_rate_threshold: float,
                                   low_frequency: int = 0,
                                   high_frequency: int = 0):
        """
        Auto-create mining schedule based on energy rates

        Args:
            max_rate_threshold: Don't mine when rate exceeds this ($/kWh)
            low_frequency: Frequency during high-rate periods (0 = off)
            high_frequency: Frequency during low-rate periods (0 = max)
        """
        rates = self.rate_manager.get_rate_schedule()

        # Clear existing schedules
        for schedule in self.db.get_mining_schedules():
            self.db.delete_mining_schedule(schedule['id'])

        # Create schedules based on rates
        for rate in rates:
            target_freq = low_frequency if rate['rate_per_kwh'] > max_rate_threshold else high_frequency

            self.db.add_mining_schedule(
                start_time=rate['start_time'],
                end_time=rate['end_time'],
                target_frequency=target_freq,
                day_of_week=rate.get('day_of_week'),
                enabled=1
            )

        logger.info(f"Created {len(rates)} schedule entries from rate data")


# Preset energy company rates
ENERGY_COMPANY_PRESETS = {
    # Major National/Regional Providers
    "Xcel Energy (Colorado)": {
        "location": "Colorado (Denver, Boulder, Fort Collins, Evergreen)",
        # NOTE: These rates are ESTIMATES and may not match your actual bill.
        # Xcel rates vary by plan, season, and tier. Verify at:
        # https://co.my.xcelenergy.com/s/rates-and-regulations
        # Check your bill for accurate rates and update these values accordingly.
        "rates": [
            {"start_time": "00:00", "end_time": "14:00", "rate_per_kwh": 0.09, "rate_type": "off-peak"},
            {"start_time": "14:00", "end_time": "19:00", "rate_per_kwh": 0.17, "rate_type": "peak"},
            {"start_time": "19:00", "end_time": "23:59", "rate_per_kwh": 0.09, "rate_type": "off-peak"},
        ]
    },
    "Xcel Energy (Minnesota)": {
        "location": "Minnesota (Minneapolis, St. Paul)",
        "rates": [
            {"start_time": "00:00", "end_time": "09:00", "rate_per_kwh": 0.08, "rate_type": "off-peak"},
            {"start_time": "09:00", "end_time": "21:00", "rate_per_kwh": 0.14, "rate_type": "peak"},
            {"start_time": "21:00", "end_time": "23:59", "rate_per_kwh": 0.08, "rate_type": "off-peak"},
        ]
    },
    "Xcel Energy (Texas)": {
        "location": "Texas (Lubbock, Amarillo)",
        "rates": [
            {"start_time": "00:00", "end_time": "14:00", "rate_per_kwh": 0.10, "rate_type": "off-peak"},
            {"start_time": "14:00", "end_time": "19:00", "rate_per_kwh": 0.16, "rate_type": "peak"},
            {"start_time": "19:00", "end_time": "23:59", "rate_per_kwh": 0.10, "rate_type": "off-peak"},
        ]
    },

    # California
    "PG&E (California)": {
        "location": "California (San Francisco, Sacramento, North CA)",
        "rates": [
            {"start_time": "00:00", "end_time": "15:00", "rate_per_kwh": 0.32, "rate_type": "off-peak"},
            {"start_time": "15:00", "end_time": "21:00", "rate_per_kwh": 0.52, "rate_type": "peak"},
            {"start_time": "21:00", "end_time": "23:59", "rate_per_kwh": 0.32, "rate_type": "off-peak"},
        ]
    },
    "SCE (Southern California Edison)": {
        "location": "California (Los Angeles, Orange County)",
        "rates": [
            {"start_time": "00:00", "end_time": "16:00", "rate_per_kwh": 0.30, "rate_type": "off-peak"},
            {"start_time": "16:00", "end_time": "21:00", "rate_per_kwh": 0.48, "rate_type": "peak"},
            {"start_time": "21:00", "end_time": "23:59", "rate_per_kwh": 0.30, "rate_type": "off-peak"},
        ]
    },
    "SDG&E (San Diego Gas & Electric)": {
        "location": "California (San Diego)",
        "rates": [
            {"start_time": "00:00", "end_time": "16:00", "rate_per_kwh": 0.35, "rate_type": "off-peak"},
            {"start_time": "16:00", "end_time": "21:00", "rate_per_kwh": 0.58, "rate_type": "peak"},
            {"start_time": "21:00", "end_time": "23:59", "rate_per_kwh": 0.35, "rate_type": "off-peak"},
        ]
    },

    # New York
    "ConEd (Consolidated Edison)": {
        "location": "New York (NYC, Westchester)",
        "rates": [
            {"start_time": "00:00", "end_time": "08:00", "rate_per_kwh": 0.18, "rate_type": "off-peak"},
            {"start_time": "08:00", "end_time": "20:00", "rate_per_kwh": 0.25, "rate_type": "peak"},
            {"start_time": "20:00", "end_time": "23:59", "rate_per_kwh": 0.18, "rate_type": "off-peak"},
        ]
    },
    "NYSEG (New York State Electric & Gas)": {
        "location": "New York (Upstate, Rochester, Syracuse)",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.16, "rate_type": "standard"},
        ]
    },

    # Texas
    "Oncor (Texas)": {
        "location": "Texas (Dallas, Fort Worth)",
        "rates": [
            {"start_time": "00:00", "end_time": "14:00", "rate_per_kwh": 0.11, "rate_type": "off-peak"},
            {"start_time": "14:00", "end_time": "19:00", "rate_per_kwh": 0.18, "rate_type": "peak"},
            {"start_time": "19:00", "end_time": "23:59", "rate_per_kwh": 0.11, "rate_type": "off-peak"},
        ]
    },
    "CenterPoint Energy (Texas)": {
        "location": "Texas (Houston)",
        "rates": [
            {"start_time": "00:00", "end_time": "14:00", "rate_per_kwh": 0.10, "rate_type": "off-peak"},
            {"start_time": "14:00", "end_time": "19:00", "rate_per_kwh": 0.17, "rate_type": "peak"},
            {"start_time": "19:00", "end_time": "23:59", "rate_per_kwh": 0.10, "rate_type": "off-peak"},
        ]
    },
    "AEP Texas": {
        "location": "Texas (Corpus Christi, South TX)",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.12, "rate_type": "standard"},
        ]
    },

    # Florida
    "FPL (Florida Power & Light)": {
        "location": "Florida (Miami, Fort Lauderdale, West Palm Beach)",
        "rates": [
            {"start_time": "00:00", "end_time": "12:00", "rate_per_kwh": 0.11, "rate_type": "off-peak"},
            {"start_time": "12:00", "end_time": "21:00", "rate_per_kwh": 0.15, "rate_type": "peak"},
            {"start_time": "21:00", "end_time": "23:59", "rate_per_kwh": 0.11, "rate_type": "off-peak"},
        ]
    },
    "Duke Energy Florida": {
        "location": "Florida (Tampa, St. Petersburg, Orlando)",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.12, "rate_type": "standard"},
        ]
    },

    # Georgia
    "Georgia Power": {
        "location": "Georgia (Atlanta, Savannah)",
        "rates": [
            {"start_time": "00:00", "end_time": "14:00", "rate_per_kwh": 0.10, "rate_type": "off-peak"},
            {"start_time": "14:00", "end_time": "19:00", "rate_per_kwh": 0.16, "rate_type": "peak"},
            {"start_time": "19:00", "end_time": "23:59", "rate_per_kwh": 0.10, "rate_type": "off-peak"},
        ]
    },

    # North/South Carolina
    "Duke Energy Carolinas": {
        "location": "North Carolina, South Carolina (Charlotte, Raleigh)",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.11, "rate_type": "standard"},
        ]
    },

    # Illinois
    "ComEd (Commonwealth Edison)": {
        "location": "Illinois (Chicago)",
        "rates": [
            {"start_time": "00:00", "end_time": "13:00", "rate_per_kwh": 0.09, "rate_type": "off-peak"},
            {"start_time": "13:00", "end_time": "19:00", "rate_per_kwh": 0.15, "rate_type": "peak"},
            {"start_time": "19:00", "end_time": "23:59", "rate_per_kwh": 0.09, "rate_type": "off-peak"},
        ]
    },

    # Ohio
    "AEP Ohio": {
        "location": "Ohio (Columbus)",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.10, "rate_type": "standard"},
        ]
    },
    "Duke Energy Ohio": {
        "location": "Ohio (Cincinnati)",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.11, "rate_type": "standard"},
        ]
    },

    # Michigan
    "DTE Energy": {
        "location": "Michigan (Detroit)",
        "rates": [
            {"start_time": "00:00", "end_time": "11:00", "rate_per_kwh": 0.12, "rate_type": "off-peak"},
            {"start_time": "11:00", "end_time": "19:00", "rate_per_kwh": 0.18, "rate_type": "peak"},
            {"start_time": "19:00", "end_time": "23:59", "rate_per_kwh": 0.12, "rate_type": "off-peak"},
        ]
    },

    # Pennsylvania
    "PECO Energy": {
        "location": "Pennsylvania (Philadelphia)",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.13, "rate_type": "standard"},
        ]
    },

    # Washington
    "Seattle City Light": {
        "location": "Washington (Seattle)",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.11, "rate_type": "standard"},
        ]
    },
    "Puget Sound Energy": {
        "location": "Washington (Bellevue, Tacoma)",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.10, "rate_type": "standard"},
        ]
    },

    # Oregon
    "Portland General Electric": {
        "location": "Oregon (Portland)",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.11, "rate_type": "standard"},
        ]
    },

    # Nevada
    "NV Energy": {
        "location": "Nevada (Las Vegas, Reno)",
        "rates": [
            {"start_time": "00:00", "end_time": "13:00", "rate_per_kwh": 0.10, "rate_type": "off-peak"},
            {"start_time": "13:00", "end_time": "19:00", "rate_per_kwh": 0.16, "rate_type": "peak"},
            {"start_time": "19:00", "end_time": "23:59", "rate_per_kwh": 0.10, "rate_type": "off-peak"},
        ]
    },

    # Arizona
    "APS (Arizona Public Service)": {
        "location": "Arizona (Phoenix)",
        "rates": [
            {"start_time": "00:00", "end_time": "15:00", "rate_per_kwh": 0.10, "rate_type": "off-peak"},
            {"start_time": "15:00", "end_time": "20:00", "rate_per_kwh": 0.18, "rate_type": "peak"},
            {"start_time": "20:00", "end_time": "23:59", "rate_per_kwh": 0.10, "rate_type": "off-peak"},
        ]
    },

    # Utah
    "Rocky Mountain Power (Utah)": {
        "location": "Utah (Salt Lake City)",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.10, "rate_type": "standard"},
        ]
    },

    # Idaho
    "Idaho Power": {
        "location": "Idaho (Boise)",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.09, "rate_type": "standard"},
        ]
    },

    # Montana
    "NorthWestern Energy (Montana)": {
        "location": "Montana (Billings, Missoula)",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.11, "rate_type": "standard"},
        ]
    },

    # Wyoming
    "Rocky Mountain Power (Wyoming)": {
        "location": "Wyoming (Cheyenne)",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.09, "rate_type": "standard"},
        ]
    },

    # ========== CANADA ==========
    "Hydro-Québec (Canada)": {
        "location": "Quebec, Canada",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.07, "rate_type": "standard"},
        ]
    },
    "BC Hydro (Canada)": {
        "location": "British Columbia, Canada",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.09, "rate_type": "standard"},
        ]
    },
    "Ontario Hydro (Canada)": {
        "location": "Ontario, Canada",
        "rates": [
            {"start_time": "00:00", "end_time": "07:00", "rate_per_kwh": 0.08, "rate_type": "off-peak"},
            {"start_time": "07:00", "end_time": "19:00", "rate_per_kwh": 0.13, "rate_type": "peak"},
            {"start_time": "19:00", "end_time": "23:59", "rate_per_kwh": 0.08, "rate_type": "off-peak"},
        ]
    },
    "Alberta Electric (Canada)": {
        "location": "Alberta, Canada",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.10, "rate_type": "standard"},
        ]
    },

    # ========== EUROPE ==========
    "EDF (France)": {
        "location": "France",
        "rates": [
            {"start_time": "00:00", "end_time": "06:00", "rate_per_kwh": 0.15, "rate_type": "off-peak"},
            {"start_time": "06:00", "end_time": "22:00", "rate_per_kwh": 0.20, "rate_type": "peak"},
            {"start_time": "22:00", "end_time": "23:59", "rate_per_kwh": 0.15, "rate_type": "off-peak"},
        ]
    },
    "E.ON (Germany)": {
        "location": "Germany",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.32, "rate_type": "standard"},
        ]
    },
    "Enel (Italy)": {
        "location": "Italy",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.28, "rate_type": "standard"},
        ]
    },
    "Iberdrola (Spain)": {
        "location": "Spain",
        "rates": [
            {"start_time": "00:00", "end_time": "08:00", "rate_per_kwh": 0.12, "rate_type": "off-peak"},
            {"start_time": "08:00", "end_time": "22:00", "rate_per_kwh": 0.18, "rate_type": "peak"},
            {"start_time": "22:00", "end_time": "23:59", "rate_per_kwh": 0.12, "rate_type": "off-peak"},
        ]
    },
    "British Gas (UK)": {
        "location": "United Kingdom",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.24, "rate_type": "standard"},
        ]
    },
    "EDF Energy (UK)": {
        "location": "United Kingdom",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.25, "rate_type": "standard"},
        ]
    },
    "Vattenfall (Sweden)": {
        "location": "Sweden",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.14, "rate_type": "standard"},
        ]
    },
    "Fortum (Norway/Finland)": {
        "location": "Norway, Finland",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.11, "rate_type": "standard"},
        ]
    },

    # ========== ASIA-PACIFIC ==========
    "China State Grid": {
        "location": "China",
        "rates": [
            {"start_time": "00:00", "end_time": "08:00", "rate_per_kwh": 0.06, "rate_type": "off-peak"},
            {"start_time": "08:00", "end_time": "22:00", "rate_per_kwh": 0.09, "rate_type": "peak"},
            {"start_time": "22:00", "end_time": "23:59", "rate_per_kwh": 0.06, "rate_type": "off-peak"},
        ]
    },
    "TEPCO (Japan)": {
        "location": "Tokyo, Japan",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.21, "rate_type": "standard"},
        ]
    },
    "KEPCO (South Korea)": {
        "location": "South Korea",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.10, "rate_type": "standard"},
        ]
    },
    "AGL Energy (Australia)": {
        "location": "Australia",
        "rates": [
            {"start_time": "00:00", "end_time": "07:00", "rate_per_kwh": 0.18, "rate_type": "off-peak"},
            {"start_time": "07:00", "end_time": "21:00", "rate_per_kwh": 0.28, "rate_type": "peak"},
            {"start_time": "21:00", "end_time": "23:59", "rate_per_kwh": 0.18, "rate_type": "off-peak"},
        ]
    },
    "Origin Energy (Australia)": {
        "location": "Australia",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.25, "rate_type": "standard"},
        ]
    },
    "Contact Energy (New Zealand)": {
        "location": "New Zealand",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.17, "rate_type": "standard"},
        ]
    },
    "Singapore Power": {
        "location": "Singapore",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.18, "rate_type": "standard"},
        ]
    },

    # ========== MIDDLE EAST ==========
    "DEWA (Dubai)": {
        "location": "Dubai, UAE",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.10, "rate_type": "standard"},
        ]
    },
    "Saudi Electricity Company": {
        "location": "Saudi Arabia",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.05, "rate_type": "standard"},
        ]
    },

    # ========== LATIN AMERICA ==========
    "CFE (Mexico)": {
        "location": "Mexico",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.08, "rate_type": "standard"},
        ]
    },
    "Enel Chile": {
        "location": "Chile",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.14, "rate_type": "standard"},
        ]
    },
    "Eletrobras (Brazil)": {
        "location": "Brazil",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.11, "rate_type": "standard"},
        ]
    },

    # ========== AFRICA ==========
    "Eskom (South Africa)": {
        "location": "South Africa",
        "rates": [
            {"start_time": "00:00", "end_time": "06:00", "rate_per_kwh": 0.06, "rate_type": "off-peak"},
            {"start_time": "06:00", "end_time": "22:00", "rate_per_kwh": 0.11, "rate_type": "peak"},
            {"start_time": "22:00", "end_time": "23:59", "rate_per_kwh": 0.06, "rate_type": "off-peak"},
        ]
    },

    # ========== ICELAND (Popular for Mining) ==========
    "Landsvirkjun (Iceland)": {
        "location": "Iceland",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.04, "rate_type": "standard"},
        ]
    },

    # Custom Entry
    "Custom (Manual Entry)": {
        "location": "Custom Location",
        "rates": [
            {"start_time": "00:00", "end_time": "23:59", "rate_per_kwh": 0.12, "rate_type": "standard"},
        ]
    }
}
