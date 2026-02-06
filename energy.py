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


class UtilityRateService:
    """
    Service to fetch utility rate data from the OpenEI Utility Rate Database (URDB).
    This provides access to real, up-to-date utility rates for most US utilities.

    API Documentation: https://openei.org/wiki/Utility_Rate_Database

    Note: OpenEI requires a free API key. Get one at: https://openei.org/services/api/signup
    Set it via the OPENEI_API_KEY environment variable or pass it to the constructor.
    """

    # OpenEI API endpoints
    # /utility_rates uses version 7, /utility_companies uses version 'latest' (max v3)
    API_BASE_URL = "https://api.openei.org/utility_rates"
    UTILITY_SEARCH_URL = "https://api.openei.org/utility_companies"

    def __init__(self, api_key: str = None, db=None):
        import os
        self._db = db
        self._cache = {}
        self._cache_time = {}
        self.cache_duration = 3600  # Cache for 1 hour

        # Try to get API key from: 1) parameter, 2) database, 3) environment variable, 4) config
        self.api_key = api_key
        if not self.api_key and db:
            self.api_key = db.get_setting('openei_api_key')
        if not self.api_key:
            self.api_key = os.environ.get('OPENEI_API_KEY')
        if not self.api_key:
            self.api_key = getattr(config, 'OPENEI_API_KEY', None)

        if self.api_key:
            logger.info("OpenEI API key configured")
        else:
            logger.info("No OpenEI API key configured. Users can add one via the dashboard.")

    def search_utilities(self, query: str, limit: int = 20) -> List[Dict]:
        """
        Search for utilities by name using OpenEI's API endpoints.

        Strategy:
        1. Fetch the utility companies list and filter by query (the /utility_companies
           endpoint does NOT support a 'search' parameter - it returns all companies,
           so we filter client-side).
        2. Search the /utility_rates endpoint with ratesforutility for broader matching.
        3. Try address-based search if the query looks like a location.

        Args:
            query: Utility name or partial name to search for
            limit: Maximum results to return

        Returns:
            List of utilities with name and EIA ID

        Raises:
            ValueError: If no API key is configured
        """
        if not self.api_key:
            raise ValueError(
                "OpenEI API key required. Get a free key at: https://openei.org/services/api/signup "
                "and set the OPENEI_API_KEY environment variable."
            )

        try:
            utilities = {}
            query_lower = query.lower()

            # Expand brand names to subsidiary names for OpenEI lookups.
            # OpenEI uses legal subsidiary names (e.g. "Northern States Power Co")
            # rather than brand names (e.g. "Xcel Energy").
            subsidiary_names = BRAND_TO_SUBSIDIARIES.get(query_lower, [])
            subsidiary_names_lower = [s.lower() for s in subsidiary_names]
            if subsidiary_names:
                logger.info(f"Brand '{query}' expanded to {len(subsidiary_names)} subsidiaries: {subsidiary_names}")

            # Strategy 1: Fetch utility companies list and filter locally.
            # The /utility_companies endpoint only supports version 'latest' (up to v3),
            # NOT version 7, and has NO 'search' parameter.
            try:
                params = {
                    'version': 'latest',
                    'format': 'json',
                    'api_key': self.api_key,
                }
                logger.info(f"OpenEI: Fetching utility companies list, filtering for '{query}'")
                response = requests.get(self.UTILITY_SEARCH_URL, params=params, timeout=20)
                logger.info(f"OpenEI utility_companies response status: {response.status_code}")

                if response.status_code == 200:
                    data = response.json()
                    # Response format varies: can be a flat list, or an object with 'items'
                    # or 'result' key. Try multiple field names for utility name.
                    if isinstance(data, list):
                        items = data
                    elif isinstance(data, dict):
                        items = data.get('items', data.get('result', data.get('results', [])))
                    else:
                        items = []

                    logger.info(f"OpenEI: utility_companies returned {len(items)} total items")
                    if items and len(items) > 0:
                        sample = items[0]
                        logger.info(f"OpenEI: sample item keys: {list(sample.keys()) if isinstance(sample, dict) else type(sample)}")

                    for item in items:
                        if not isinstance(item, dict):
                            continue
                        # Try multiple field names for the utility name
                        utility_name = (
                            item.get('label', '') or
                            item.get('utility_name', '') or
                            item.get('name', '') or
                            item.get('utility', '')
                        )
                        if not utility_name:
                            continue
                        name_lower = utility_name.lower()
                        # Match if original query is in the name, OR if the name
                        # matches any known subsidiary of the searched brand
                        is_match = query_lower in name_lower
                        if not is_match and subsidiary_names_lower:
                            is_match = any(
                                sub in name_lower or name_lower in sub
                                for sub in subsidiary_names_lower
                            )
                        if is_match:
                            if utility_name not in utilities:
                                utilities[utility_name] = {
                                    'utility_name': utility_name,
                                    'eia_id': (
                                        item.get('eiaid', '') or
                                        item.get('eia_id', '') or
                                        item.get('id', '')
                                    ),
                                    'state': item.get('state', '') or item.get('st', ''),
                                }
                    logger.info(f"OpenEI: utility_companies matched {len(utilities)} for '{query}'")
                elif response.status_code == 401 or response.status_code == 403:
                    logger.error(f"OpenEI API key rejected (HTTP {response.status_code}). Check your API key.")
                    raise ValueError("OpenEI API key is invalid or expired. Please check your API key.")
                else:
                    logger.warning(f"OpenEI utility_companies returned HTTP {response.status_code}")
                    try:
                        err_data = response.json()
                        logger.warning(f"OpenEI error response: {err_data}")
                    except Exception:
                        logger.warning(f"OpenEI error body: {response.text[:500]}")
            except ValueError:
                raise
            except Exception as e:
                logger.warning(f"Utility companies endpoint failed: {e}")

            # Strategy 2: Search the rates endpoint with ratesforutility
            # Search for the original query, plus each subsidiary name if brand was expanded
            rate_search_terms = [query] + subsidiary_names
            for search_term in rate_search_terms:
                if len(utilities) >= limit:
                    break
                try:
                    params = {
                        'version': '7',
                        'format': 'json',
                        'api_key': self.api_key,
                        'ratesforutility': search_term,
                        'detail': 'minimal',
                        'limit': 500
                    }
                    logger.info(f"OpenEI: Searching rates endpoint for utility '{search_term}'")
                    response = requests.get(self.API_BASE_URL, params=params, timeout=15)
                    logger.info(f"OpenEI utility_rates response status: {response.status_code}")

                    if response.status_code == 200:
                        data = response.json()
                        if 'error' not in data:
                            for item in data.get('items', []):
                                utility_name = item.get('utility', '')
                                if utility_name and utility_name not in utilities:
                                    utilities[utility_name] = {
                                        'utility_name': utility_name,
                                        'eia_id': item.get('eiaid', ''),
                                        'state': item.get('state', ''),
                                    }
                            logger.info(f"OpenEI: rates endpoint found {len(data.get('items', []))} rate items for '{search_term}'")
                        else:
                            logger.warning(f"OpenEI rates endpoint returned error: {data.get('error')}")
                    else:
                        logger.warning(f"OpenEI rates endpoint returned HTTP {response.status_code}")
                except Exception as e:
                    logger.warning(f"Rates endpoint search failed for '{search_term}': {e}")

            # Strategy 3: Try address-based search if query looks like a location
            if not utilities and (len(query.split()) <= 3 or any(c.isdigit() for c in query)):
                try:
                    params = {
                        'version': '7',
                        'format': 'json',
                        'api_key': self.api_key,
                        'address': query,
                        'detail': 'minimal',
                        'limit': 100
                    }
                    logger.info(f"OpenEI: Trying address-based search for '{query}'")
                    response = requests.get(self.API_BASE_URL, params=params, timeout=15)

                    if response.status_code == 200:
                        data = response.json()
                        if 'error' not in data:
                            for item in data.get('items', []):
                                utility_name = item.get('utility', '')
                                if utility_name and utility_name not in utilities:
                                    utilities[utility_name] = {
                                        'utility_name': utility_name,
                                        'eia_id': item.get('eiaid', ''),
                                        'state': item.get('state', ''),
                                    }
                            logger.info(f"OpenEI: address search found {len(data.get('items', []))} items")
                except Exception as e:
                    logger.warning(f"Address-based search failed: {e}")

            if not utilities:
                logger.warning(f"OpenEI search returned no results for '{query}' across all strategies")

            result = list(utilities.values())[:limit]
            # If we matched via brand-to-subsidiary mapping, tag results with the brand name
            if subsidiary_names and result:
                for r in result:
                    r['brand_name'] = query
            logger.info(f"OpenEI search for '{query}' found {len(result)} unique utilities total")
            return result

        except ValueError:
            raise
        except requests.exceptions.RequestException as e:
            logger.error(f"Network error searching utilities: {e}")
            raise ValueError(f"Network error: Unable to reach OpenEI API. Please check your internet connection and try again.")
        except Exception as e:
            logger.error(f"Error searching utilities: {e}")
            raise ValueError(f"Error searching utilities: {str(e)}")

    def get_utility_rates(self, utility_name: str = None, eia_id: str = None,
                         sector: str = 'Residential') -> List[Dict]:
        """
        Get all rate plans for a utility.

        Args:
            utility_name: Name of the utility
            eia_id: EIA ID of the utility (more precise)
            sector: Rate sector (Residential, Commercial, Industrial)

        Returns:
            List of rate plans with basic info
        """
        cache_key = f"rates_{utility_name}_{eia_id}_{sector}"
        if cache_key in self._cache:
            cache_age = (datetime.now() - self._cache_time.get(cache_key, datetime.min)).total_seconds()
            if cache_age < self.cache_duration:
                return self._cache[cache_key]

        try:
            params = {
                'version': '7',
                'format': 'json',
                'sector': sector,
                'detail': 'minimal',
                'limit': 100
            }

            # Only add API key if we have one
            if self.api_key:
                params['api_key'] = self.api_key

            if eia_id:
                params['eia'] = eia_id
            elif utility_name:
                params['ratesforutility'] = utility_name

            response = requests.get(self.API_BASE_URL, params=params, timeout=15)
            response.raise_for_status()
            data = response.json()

            rates = []
            for item in data.get('items', []):
                # Check if this is a TOU rate
                is_tou = bool(item.get('energyweekdayschedule') or item.get('energyweekendschedule'))

                rates.append({
                    'label': item.get('label', ''),
                    'name': item.get('name', ''),
                    'utility': item.get('utility', ''),
                    'startdate': item.get('startdate', ''),
                    'enddate': item.get('enddate', ''),
                    'description': item.get('description', ''),
                    'is_default': item.get('is_default', False),
                    'approved': item.get('approved', False),
                    'is_tou': is_tou
                })

            # Cache results
            self._cache[cache_key] = rates
            self._cache_time[cache_key] = datetime.now()

            logger.info(f"Found {len(rates)} rate plans for {utility_name or eia_id}")
            return rates

        except requests.exceptions.RequestException as e:
            logger.error(f"Network error fetching utility rates: {e}")
            return []
        except Exception as e:
            logger.error(f"Error fetching utility rates: {e}")
            return []

    def get_rate_details(self, rate_label: str) -> Optional[Dict]:
        """
        Get full details for a specific rate plan including TOU schedules.

        Args:
            rate_label: The unique rate label/ID from the URDB

        Returns:
            Full rate details including TOU schedule
        """
        cache_key = f"rate_detail_{rate_label}"
        if cache_key in self._cache:
            cache_age = (datetime.now() - self._cache_time.get(cache_key, datetime.min)).total_seconds()
            if cache_age < self.cache_duration:
                return self._cache[cache_key]

        try:
            params = {
                'version': '7',
                'format': 'json',
                'detail': 'full',
                'getpage': rate_label
            }

            # Only add API key if we have one
            if self.api_key:
                params['api_key'] = self.api_key

            response = requests.get(self.API_BASE_URL, params=params, timeout=15)
            response.raise_for_status()
            data = response.json()

            items = data.get('items', [])
            if not items:
                logger.warning(f"No rate details found for label: {rate_label}")
                return None

            rate_data = items[0]

            # Cache results
            self._cache[cache_key] = rate_data
            self._cache_time[cache_key] = datetime.now()

            logger.info(f"Loaded rate details for: {rate_data.get('name', rate_label)}")
            return rate_data

        except requests.exceptions.RequestException as e:
            logger.error(f"Network error fetching rate details: {e}")
            return None
        except Exception as e:
            logger.error(f"Error fetching rate details: {e}")
            return None

    def parse_tou_schedule(self, rate_data: Dict, month: int = None) -> List[Dict]:
        """
        Parse the OpenEI TOU schedule format into our simple format.

        The OpenEI format uses:
        - energyweekdayschedule: 12x24 matrix (month x hour) of period indices
        - energyweekendschedule: same for weekends
        - energyratestructure: Array of rate periods with actual rates

        Args:
            rate_data: Full rate data from get_rate_details()
            month: Month to get schedule for (1-12). If None, uses current month.

        Returns:
            List of rate periods in our format:
            [{'start_time': 'HH:MM', 'end_time': 'HH:MM', 'rate_per_kwh': float, 'rate_type': str}]
        """
        if month is None:
            month = datetime.now().month

        # Get schedule matrices (12 months x 24 hours)
        weekday_schedule = rate_data.get('energyweekdayschedule', [])
        weekend_schedule = rate_data.get('energyweekendschedule', [])
        rate_structure = rate_data.get('energyratestructure', [])

        if not weekday_schedule or not rate_structure:
            # No TOU schedule - try to get flat rate
            flat_rate = self._get_flat_rate(rate_data)
            if flat_rate:
                return [{
                    'start_time': '00:00',
                    'end_time': '23:59',
                    'rate_per_kwh': flat_rate,
                    'rate_type': 'standard',
                    'day_of_week': None
                }]
            return []

        # Get the schedule for the specified month (0-indexed in the data)
        month_idx = month - 1
        if month_idx >= len(weekday_schedule):
            month_idx = 0

        weekday_hours = weekday_schedule[month_idx] if weekday_schedule else []
        weekend_hours = weekend_schedule[month_idx] if weekend_schedule else weekday_hours

        # Parse weekday schedule into time ranges
        rates = []
        rates.extend(self._parse_hourly_schedule(weekday_hours, rate_structure, None))

        # If weekend schedule is different, add those too
        if weekend_hours != weekday_hours:
            weekend_rates = self._parse_hourly_schedule(weekend_hours, rate_structure, 'weekend')
            # Mark weekday rates
            for r in rates:
                if r.get('day_of_week') is None:
                    r['day_of_week'] = 'weekday'
            rates.extend(weekend_rates)

        return rates

    def _parse_hourly_schedule(self, hourly_periods: List[int],
                               rate_structure: List, day_type: str = None) -> List[Dict]:
        """
        Parse a 24-hour period list into time ranges with rates.

        Args:
            hourly_periods: List of 24 period indices (0-23 hours)
            rate_structure: The energyratestructure array
            day_type: 'weekday', 'weekend', or None for all days

        Returns:
            List of rate periods
        """
        if not hourly_periods or len(hourly_periods) != 24:
            return []

        rates = []
        current_period = hourly_periods[0]
        start_hour = 0

        for hour in range(1, 25):
            # Check if period changed or we're at the end
            period_at_hour = hourly_periods[hour] if hour < 24 else -1

            if period_at_hour != current_period:
                # Period ended, create a rate entry
                rate_info = self._get_rate_from_structure(rate_structure, current_period)

                if rate_info:
                    end_time = '23:59' if hour == 24 else f'{hour:02d}:00'
                    rates.append({
                        'start_time': f'{start_hour:02d}:00',
                        'end_time': end_time,
                        'rate_per_kwh': rate_info['rate'],
                        'rate_type': rate_info['type'],
                        'day_of_week': day_type
                    })

                start_hour = hour
                current_period = period_at_hour

        return rates

    def _get_rate_from_structure(self, rate_structure: List, period_idx: int) -> Optional[Dict]:
        """
        Get the rate for a specific period from the rate structure.

        Args:
            rate_structure: The energyratestructure array
            period_idx: The period index

        Returns:
            Dict with 'rate' and 'type'
        """
        if period_idx >= len(rate_structure):
            return None

        period = rate_structure[period_idx]
        if not period:
            return None

        # Get the first tier's rate (tier 0)
        # More complex implementations could handle multiple tiers
        tier = period[0] if period else {}

        rate = tier.get('rate', 0)
        adj = tier.get('adj', 0)
        total_rate = rate + adj

        # Determine rate type based on relative rates
        # This is a heuristic - highest rate period is "peak", lowest is "off-peak"
        all_rates = []
        for p in rate_structure:
            if p and p[0]:
                r = p[0].get('rate', 0) + p[0].get('adj', 0)
                all_rates.append(r)

        if len(all_rates) > 1:
            max_rate = max(all_rates)
            min_rate = min(all_rates)
            if total_rate >= max_rate * 0.9:
                rate_type = 'peak'
            elif total_rate <= min_rate * 1.1:
                rate_type = 'off-peak'
            else:
                rate_type = 'standard'
        else:
            rate_type = 'standard'

        return {'rate': total_rate, 'type': rate_type}

    def _get_flat_rate(self, rate_data: Dict) -> Optional[float]:
        """
        Try to extract a flat rate from rate data without TOU schedule.
        """
        # Check for simple flat rate
        rate_structure = rate_data.get('energyratestructure', [])
        if rate_structure and rate_structure[0]:
            tier = rate_structure[0][0] if rate_structure[0] else {}
            rate = tier.get('rate', 0) + tier.get('adj', 0)
            if rate > 0:
                return rate

        # Check fixedchargeunits or other fields
        return None

    def get_rates_for_app(self, rate_label: str, month: int = None) -> Dict:
        """
        Get rate data formatted for use in the app.

        Args:
            rate_label: The URDB rate label
            month: Month for seasonal rates (1-12)

        Returns:
            Dict with 'success', 'rates' (our format), and metadata
        """
        rate_data = self.get_rate_details(rate_label)

        if not rate_data:
            return {
                'success': False,
                'error': 'Rate plan not found'
            }

        rates = self.parse_tou_schedule(rate_data, month)

        if not rates:
            return {
                'success': False,
                'error': 'No rate schedule found for this plan'
            }

        return {
            'success': True,
            'rates': rates,
            'utility': rate_data.get('utility', ''),
            'plan_name': rate_data.get('name', ''),
            'description': rate_data.get('description', ''),
            'start_date': rate_data.get('startdate', ''),
            'end_date': rate_data.get('enddate', ''),
            'approved': rate_data.get('approved', False),
            'source': 'OpenEI URDB'
        }


class BitcoinDataFetcher:
    """Fetch Bitcoin price, network difficulty, and block height"""

    # Halving constants
    HALVING_INTERVAL = 210_000  # Blocks between halvings
    INITIAL_SUBSIDY = 50  # Initial block reward in BTC

    # Halving schedule reference (for informational purposes):
    # Epoch 0: Blocks 0-209,999        -> 50 BTC      (2009-2012)
    # Epoch 1: Blocks 210,000-419,999  -> 25 BTC      (2012-2016)
    # Epoch 2: Blocks 420,000-629,999  -> 12.5 BTC    (2016-2020)
    # Epoch 3: Blocks 630,000-839,999  -> 6.25 BTC    (2020-2024)
    # Epoch 4: Blocks 840,000-1,049,999 -> 3.125 BTC  (2024-2028) <- Current
    # Epoch 5: Blocks 1,050,000-1,259,999 -> 1.5625 BTC (2028-2032)
    # Epoch 6: Blocks 1,260,000-1,469,999 -> 0.78125 BTC (2032-2036)

    def __init__(self):
        self.btc_price_cache = None
        self.btc_price_cache_time = None
        self.difficulty_cache = None
        self.difficulty_cache_time = None
        self.block_height_cache = None
        self.block_height_cache_time = None
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

    def get_block_height(self) -> Optional[int]:
        """Get current Bitcoin block height"""
        # Check cache
        if self.block_height_cache and self.block_height_cache_time:
            age = (datetime.now() - self.block_height_cache_time).total_seconds()
            if age < self.cache_duration:
                return self.block_height_cache

        try:
            # Blockchain.info API (free)
            response = requests.get(
                "https://blockchain.info/q/getblockcount",
                timeout=5
            )
            response.raise_for_status()
            block_height = int(response.text)

            # Cache result
            self.block_height_cache = block_height
            self.block_height_cache_time = datetime.now()

            logger.info(f"Fetched block height: {block_height:,}")
            return block_height

        except Exception as e:
            logger.error(f"Error fetching block height: {e}")
            # Return cached value if available
            return self.block_height_cache

    def get_halving_epoch(self, block_height: int = None) -> int:
        """
        Get the current halving epoch (0-indexed).
        Epoch 0 = blocks 0-209,999 (50 BTC)
        Epoch 4 = blocks 840,000-1,049,999 (3.125 BTC) <- Current as of 2024
        """
        if block_height is None:
            block_height = self.get_block_height()
            if block_height is None:
                return 4  # Default to current epoch if unable to fetch

        return block_height // self.HALVING_INTERVAL

    def get_block_subsidy(self, block_height: int = None) -> float:
        """
        Calculate the block subsidy for a given block height.
        Subsidy = 50 / (2 ^ epoch) BTC
        """
        epoch = self.get_halving_epoch(block_height)
        subsidy = self.INITIAL_SUBSIDY / (2 ** epoch)
        return subsidy

    def get_blocks_until_halving(self, block_height: int = None) -> int:
        """Get number of blocks until the next halving"""
        if block_height is None:
            block_height = self.get_block_height()
            if block_height is None:
                return 0

        next_halving_block = ((block_height // self.HALVING_INTERVAL) + 1) * self.HALVING_INTERVAL
        return next_halving_block - block_height

    def get_halving_info(self) -> dict:
        """Get comprehensive halving information"""
        block_height = self.get_block_height()
        if block_height is None:
            return {
                'error': 'Unable to fetch block height',
                'current_subsidy': 3.125,  # Fallback
                'epoch': 4
            }

        epoch = self.get_halving_epoch(block_height)
        current_subsidy = self.get_block_subsidy(block_height)
        blocks_until_halving = self.get_blocks_until_halving(block_height)
        next_subsidy = current_subsidy / 2

        # Estimate time until halving (average 10 min per block)
        minutes_until_halving = blocks_until_halving * 10
        days_until_halving = minutes_until_halving / (60 * 24)

        return {
            'block_height': block_height,
            'epoch': epoch,
            'current_subsidy': current_subsidy,
            'next_subsidy': next_subsidy,
            'blocks_until_halving': blocks_until_halving,
            'estimated_days_until_halving': round(days_until_halving, 1),
            'next_halving_block': ((epoch + 1) * self.HALVING_INTERVAL)
        }


class ProfitabilityCalculator:
    """Calculate mining profitability

    IMPORTANT: Revenue calculations are ESTIMATES based on solo mining math.
    Actual pool earnings may differ significantly due to:
    - Pool fee structures (FPPS, PPS, PPLNS)
    - Transaction fees included in block rewards
    - Pool luck and variance
    - Network hashrate fluctuations

    For accurate earnings tracking, compare with your pool's reported earnings.
    """

    def __init__(self, btc_fetcher: BitcoinDataFetcher, pool_manager=None):
        self.btc_fetcher = btc_fetcher
        self.pool_manager = pool_manager
        # Default pool fee (2% is typical for most pools)
        self.default_pool_fee_percent = 2.0
        # NOTE: tx_fee_multiplier removed - use pool-specific calculations instead
        # FPPS+ pools like Braiins include tx fees in their fee structure
        # Cache for block subsidy (updated when block height is fetched)
        self._cached_block_subsidy = None

    def get_block_subsidy(self) -> float:
        """
        Get current block subsidy based on block height.
        Automatically adjusts when halvings occur.
        """
        # Get fresh subsidy from btc_fetcher (which caches block height)
        subsidy = self.btc_fetcher.get_block_subsidy()
        if subsidy is not None:
            if self._cached_block_subsidy != subsidy:
                logger.info(f"Block subsidy: {subsidy} BTC")
                self._cached_block_subsidy = subsidy
            return subsidy

        # Fallback to cached value or default (epoch 4 = 3.125 BTC)
        return self._cached_block_subsidy or 3.125

    def calculate_btc_per_day(self, hashrate_th: float, difficulty: float = None,
                             pool_fee_percent: float = None) -> float:
        """
        Calculate estimated BTC mined per day (after pool fees)

        Args:
            hashrate_th: Hashrate in TH/s
            difficulty: Network difficulty (fetched if not provided)
            pool_fee_percent: Pool fee percentage (auto-detected from pool_manager if available)

        Returns:
            Estimated BTC per day after pool fees
        """
        if difficulty is None:
            difficulty = self.btc_fetcher.get_network_difficulty()
            if difficulty is None:
                return 0.0

        # Get current block subsidy (automatically adjusts for halvings)
        block_subsidy = self.get_block_subsidy()

        # Formula: BTC per day = (hashrate_hs * 86400 * block_subsidy) / (difficulty * 2^32)
        #
        # Derivation:
        # - Probability of finding a block with one hash = 1 / (difficulty * 2^32)
        # - Hashes per day = hashrate_hs * 86400
        # - Expected blocks per day = hashrate_hs * 86400 / (difficulty * 2^32)
        # - Expected BTC per day = blocks_per_day * block_subsidy
        #
        # This is equivalent to: your_share_of_network * daily_btc_mined
        # where daily_btc_mined ≈ 144 blocks * block_subsidy
        hashrate_hs = hashrate_th * 1e12  # Convert TH/s to H/s
        btc_per_day = (hashrate_hs * 86400 * block_subsidy) / (difficulty * 2**32)

        # Apply pool fee if specified or auto-detected
        if pool_fee_percent is None and self.pool_manager:
            # Get pool fee from pool manager
            pool_configs = self.pool_manager.get_all_pool_configs()
            if pool_configs:
                pool_fee_percent = pool_configs[0].get('fee_percent') or self.default_pool_fee_percent
            else:
                pool_fee_percent = self.default_pool_fee_percent
        elif pool_fee_percent is None:
            pool_fee_percent = self.default_pool_fee_percent

        # Ensure we have a valid fee (defensive programming)
        if pool_fee_percent is None or pool_fee_percent < 0:
            pool_fee_percent = self.default_pool_fee_percent

        # Subtract pool fee (FPPS+ pools like Braiins include tx fees in their payout structure)
        # So we just subtract the fee percentage from gross revenue
        btc_per_day *= (1 - pool_fee_percent / 100)

        return btc_per_day

    def calculate_solo_odds(self, hashrate_hs: float, difficulty: float = None) -> dict:
        """
        Calculate solo mining odds using the solochance.org API for accuracy.

        Calls https://api.solochance.org/getSoloChanceCalculations with the fleet
        hashrate to get exact odds matching solochance.org. Falls back to local
        calculation if the API is unreachable.

        Args:
            hashrate_hs: Hashrate in H/s (hashes per second)
            difficulty: Network difficulty (used only for local fallback)

        Returns:
            Dictionary with solo mining odds metrics for all timeframes
        """
        if hashrate_hs <= 0:
            return self._empty_solo_odds(difficulty)

        # Try solochance.org API first for exact matching numbers
        try:
            result = self._fetch_solochance_api(hashrate_hs)
            if result:
                return result
        except Exception as e:
            logger.warning(f"SoloChance API failed, using local calculation: {e}")

        # Fallback to local calculation
        return self._calculate_solo_odds_local(hashrate_hs, difficulty)

    def _fetch_solochance_api(self, hashrate_hs: float) -> dict:
        """Fetch solo mining odds from solochance.org API."""
        # Convert H/s to the best unit for the API
        hashrate_ths = hashrate_hs / 1e12
        if hashrate_ths >= 0.001:
            api_hashrate = hashrate_ths
            api_unit = 'TH'
        else:
            api_hashrate = hashrate_hs / 1e9
            api_unit = 'GH'

        url = (
            f"https://api.solochance.org/getSoloChanceCalculations"
            f"?currency=BTC&hashrate={api_hashrate}&hashrateUnit={api_unit}"
        )
        response = requests.get(url, timeout=8)
        response.raise_for_status()
        data = response.json()

        if 'blockChanceText' not in data:
            return None

        # Parse "1 in X chance" text to extract odds number
        def _parse_odds_text(text):
            if not text:
                return 0
            # "1 in 895,223,646 chance" -> 895223646
            parts = text.replace(',', '').split()
            for i, p in enumerate(parts):
                if p == 'in' and i + 1 < len(parts):
                    try:
                        return int(parts[i + 1])
                    except ValueError:
                        pass
            return 0

        block_odds = _parse_odds_text(data.get('blockChanceText', ''))
        day_odds = _parse_odds_text(data.get('dayChanceText', ''))

        # Compute time estimate from day chance
        chance_per_day = data.get('dayChance', 0)
        if chance_per_day and chance_per_day > 0:
            time_to_block_days = 1 / chance_per_day
            time_to_block_years = time_to_block_days / 365
        elif day_odds > 0:
            time_to_block_days = day_odds
            time_to_block_years = time_to_block_days / 365
        else:
            time_to_block_days = float('inf')
            time_to_block_years = float('inf')

        # Format time estimate
        if time_to_block_years >= 1:
            time_estimate_display = f"{int(time_to_block_years):,} years"
        elif time_to_block_days >= 30:
            time_estimate_display = f"{int(time_to_block_days / 30):,} months"
        elif time_to_block_days >= 1:
            time_estimate_display = f"{int(time_to_block_days):,} days"
        else:
            time_estimate_display = f"{int(time_to_block_days * 24):,} hours"

        # Strip " chance" suffix from display text for cleaner UI
        def _clean(text):
            return text.replace(' chance', '') if text else 'N/A'

        return {
            'hashrate_hs': hashrate_hs,
            'source': 'solochance.org',
            'network_hashrate_text': data.get('networkHashrateText', ''),
            'chance_per_block': data.get('blockChance', 0),
            'chance_per_block_odds': block_odds,
            'chance_per_block_display': _clean(data.get('blockChanceText', 'N/A')),
            'chance_per_hour': data.get('hourChance', 0),
            'chance_per_hour_odds': _parse_odds_text(data.get('hourChanceText', '')),
            'chance_per_hour_display': _clean(data.get('hourChanceText', 'N/A')),
            'chance_per_day': data.get('dayChance', 0),
            'chance_per_day_odds': day_odds,
            'chance_per_day_display': _clean(data.get('dayChanceText', 'N/A')),
            'chance_per_week': data.get('weekChance', 0),
            'chance_per_week_odds': _parse_odds_text(data.get('weekChanceText', '')),
            'chance_per_week_display': _clean(data.get('weekChanceText', 'N/A')),
            'chance_per_month': data.get('monthChance', 0),
            'chance_per_month_odds': _parse_odds_text(data.get('monthChanceText', '')),
            'chance_per_month_display': _clean(data.get('monthChanceText', 'N/A')),
            'chance_per_year': data.get('yearChance', 0),
            'chance_per_year_odds': _parse_odds_text(data.get('yearChanceText', '')),
            'chance_per_year_display': _clean(data.get('yearChanceText', 'N/A')),
            'time_to_block_days': time_to_block_days,
            'time_to_block_years': time_to_block_years,
            'time_estimate_display': time_estimate_display
        }

    def _empty_solo_odds(self, difficulty=None) -> dict:
        """Return empty solo odds for zero hashrate."""
        return {
            'hashrate_hs': 0,
            'chance_per_block': 0, 'chance_per_block_odds': 0, 'chance_per_block_display': 'N/A',
            'chance_per_hour': 0, 'chance_per_hour_odds': 0, 'chance_per_hour_display': 'N/A',
            'chance_per_day': 0, 'chance_per_day_odds': 0, 'chance_per_day_display': 'N/A',
            'chance_per_week': 0, 'chance_per_week_odds': 0, 'chance_per_week_display': 'N/A',
            'chance_per_month': 0, 'chance_per_month_odds': 0, 'chance_per_month_display': 'N/A',
            'chance_per_year': 0, 'chance_per_year_odds': 0, 'chance_per_year_display': 'N/A',
            'time_to_block_days': float('inf'), 'time_to_block_years': float('inf'),
            'time_estimate_display': 'Never'
        }

    def _calculate_solo_odds_local(self, hashrate_hs: float, difficulty: float = None) -> dict:
        """Local fallback calculation when solochance.org API is unreachable."""
        if difficulty is None:
            difficulty = self.btc_fetcher.get_network_difficulty()
            if difficulty is None:
                return {'error': 'Unable to fetch network difficulty'}

        two_32 = difficulty * (2**32)

        chance_per_block = (hashrate_hs * 600) / two_32
        chance_per_block_odds = int(1 / chance_per_block) if chance_per_block > 0 else float('inf')
        chance_per_hour = (hashrate_hs * 3600) / two_32
        chance_per_hour_odds = int(1 / chance_per_hour) if chance_per_hour > 0 else float('inf')
        chance_per_day = (hashrate_hs * 86400) / two_32
        chance_per_day_odds = int(1 / chance_per_day) if chance_per_day > 0 else float('inf')
        chance_per_week = (hashrate_hs * 604800) / two_32
        chance_per_week_odds = max(1, int(1 / chance_per_week)) if chance_per_week > 0 else float('inf')
        chance_per_month = (hashrate_hs * 2592000) / two_32
        chance_per_month_odds = max(1, int(1 / chance_per_month)) if chance_per_month > 0 else float('inf')
        chance_per_year = (hashrate_hs * 31536000) / two_32
        chance_per_year_odds = max(1, int(1 / chance_per_year)) if chance_per_year > 0 else float('inf')

        time_to_block_days = 1 / chance_per_day if chance_per_day > 0 else float('inf')
        time_to_block_years = time_to_block_days / 365

        def _fmt(odds_val):
            if odds_val == float('inf'):
                return 'N/A'
            return f"1 in {max(1, odds_val):,}"

        if time_to_block_years >= 1:
            time_estimate_display = f"{int(time_to_block_years):,} years"
        elif time_to_block_days >= 30:
            time_estimate_display = f"{int(time_to_block_days / 30):,} months"
        elif time_to_block_days >= 1:
            time_estimate_display = f"{int(time_to_block_days):,} days"
        else:
            time_estimate_display = f"{int(time_to_block_days * 24):,} hours"

        return {
            'hashrate_hs': hashrate_hs,
            'source': 'local',
            'chance_per_block': chance_per_block, 'chance_per_block_odds': chance_per_block_odds,
            'chance_per_block_display': _fmt(chance_per_block_odds),
            'chance_per_hour': chance_per_hour, 'chance_per_hour_odds': chance_per_hour_odds,
            'chance_per_hour_display': _fmt(chance_per_hour_odds),
            'chance_per_day': chance_per_day, 'chance_per_day_odds': chance_per_day_odds,
            'chance_per_day_display': _fmt(chance_per_day_odds),
            'chance_per_week': chance_per_week, 'chance_per_week_odds': chance_per_week_odds,
            'chance_per_week_display': _fmt(chance_per_week_odds),
            'chance_per_month': chance_per_month, 'chance_per_month_odds': chance_per_month_odds,
            'chance_per_month_display': _fmt(chance_per_month_odds),
            'chance_per_year': chance_per_year, 'chance_per_year_odds': chance_per_year_odds,
            'chance_per_year_display': _fmt(chance_per_year_odds),
            'time_to_block_days': time_to_block_days, 'time_to_block_years': time_to_block_years,
            'time_estimate_display': time_estimate_display
        }

    def calculate_power_at_frequency(self, max_power_watts: float, target_frequency: int,
                                     max_frequency: int = 600) -> float:
        """
        Calculate power consumption at a given frequency.

        Power doesn't scale linearly with frequency due to base power consumption
        (fans, controllers, etc). This models a realistic power curve.

        Args:
            max_power_watts: Power at maximum frequency
            target_frequency: Target frequency in MHz (0 = off)
            max_frequency: Maximum frequency in MHz (default 600 for BitAxe)

        Returns:
            Estimated power consumption in watts
        """
        if target_frequency <= 0:
            return 0  # Miners off

        if target_frequency >= max_frequency or max_frequency <= 0:
            return max_power_watts  # Full power

        # Power model: power = base_power + variable_power * freq_ratio
        # Base power is typically 20-30% of max (for fans, controller, etc)
        # Variable power scales with frequency
        BASE_POWER_RATIO = 0.25  # 25% base power when running

        freq_ratio = target_frequency / max_frequency
        power = max_power_watts * (BASE_POWER_RATIO + (1 - BASE_POWER_RATIO) * freq_ratio)

        return power

    def calculate_projected_daily_cost(self, max_power_watts: float,
                                       rate_manager: 'EnergyRateManager',
                                       mining_scheduler: 'MiningScheduler',
                                       max_frequency: int = 600,
                                       day_of_week: str = None) -> Dict:
        """
        Calculate projected daily energy cost accounting for:
        - Mining schedules (when miners run at what frequency)
        - TOU rates (different rates at different hours)
        - Power scaling with frequency

        Args:
            max_power_watts: Current fleet power at max frequency
            rate_manager: EnergyRateManager instance
            mining_scheduler: MiningScheduler instance
            max_frequency: Maximum miner frequency (default 600 MHz)
            day_of_week: Day to calculate for (default: today)

        Returns:
            Dict with total cost, breakdown by hour, and summary stats
        """
        if day_of_week is None:
            day_of_week = datetime.now().strftime("%A")

        # Get schedules and rates for each hour
        hourly_schedules = mining_scheduler.get_24h_schedule(day_of_week)
        hourly_rates = rate_manager.get_24h_rates(day_of_week)

        # Calculate cost for each hour
        hourly_breakdown = []
        total_cost = 0
        total_kwh = 0
        cost_by_rate_type = {'peak': 0, 'off-peak': 0, 'standard': 0}
        kwh_by_rate_type = {'peak': 0, 'off-peak': 0, 'standard': 0}
        rates_by_type = {'peak': None, 'off-peak': None, 'standard': None}  # Track actual $/kWh rates

        hours_full_power = 0
        hours_reduced = 0
        hours_off = 0

        for hour in range(24):
            schedule = hourly_schedules[hour]
            rate_info = hourly_rates[hour]

            target_freq = schedule['target_frequency']
            rate = rate_info['rate']
            rate_type = rate_info['rate_type']

            # Calculate power for this hour
            if target_freq == 0 and schedule['schedule_id'] is not None:
                # Explicitly scheduled to be off
                power_watts = 0
                hours_off += 1
                mining_status = 'off'
            elif target_freq == 0:
                # No schedule = full power (target_freq 0 means "unchanged/max")
                power_watts = max_power_watts
                hours_full_power += 1
                mining_status = 'full'
            elif target_freq >= max_frequency:
                power_watts = max_power_watts
                hours_full_power += 1
                mining_status = 'full'
            else:
                power_watts = self.calculate_power_at_frequency(
                    max_power_watts, target_freq, max_frequency
                )
                hours_reduced += 1
                mining_status = 'reduced'

            # Calculate energy and cost for this hour
            kwh = power_watts / 1000  # 1 hour at this power
            cost = kwh * rate

            total_cost += cost
            total_kwh += kwh

            # Track by rate type
            if rate_type in cost_by_rate_type:
                cost_by_rate_type[rate_type] += cost
                kwh_by_rate_type[rate_type] += kwh
                # Store the actual rate value ($/kWh) for this type
                if rates_by_type[rate_type] is None:
                    rates_by_type[rate_type] = rate

            hourly_breakdown.append({
                'hour': hour,
                'power_watts': round(power_watts, 1),
                'kwh': round(kwh, 4),
                'rate': rate,
                'rate_type': rate_type,
                'cost': round(cost, 4),
                'target_frequency': target_freq,
                'mining_status': mining_status
            })

        return {
            'total_cost': round(total_cost, 4),
            'total_kwh': round(total_kwh, 4),
            'cost_by_rate_type': {k: round(v, 4) for k, v in cost_by_rate_type.items()},
            'kwh_by_rate_type': {k: round(v, 4) for k, v in kwh_by_rate_type.items()},
            'rates_by_type': {k: round(v, 4) if v else None for k, v in rates_by_type.items()},  # Actual $/kWh rates
            'hours_full_power': hours_full_power,
            'hours_reduced': hours_reduced,
            'hours_off': hours_off,
            'day_of_week': day_of_week,
            'max_power_watts': max_power_watts,
            'hourly_breakdown': hourly_breakdown
        }

    def calculate_profitability(self, total_hashrate: float, total_power_watts: float,
                               energy_rate_per_kwh: float, btc_price: float = None,
                               difficulty: float = None, pool_fee_percent: float = None,
                               rate_manager: 'EnergyRateManager' = None,
                               mining_scheduler: 'MiningScheduler' = None) -> Dict:
        """
        Calculate comprehensive profitability metrics with accurate pool calculations

        Args:
            total_hashrate: Total fleet hashrate in H/s
            total_power_watts: Total fleet power consumption in watts
            energy_rate_per_kwh: Current energy rate in $/kWh
            btc_price: BTC price in USD (fetched if not provided)
            difficulty: Network difficulty (fetched if not provided)
            pool_fee_percent: Pool fee percentage (0-100). Auto-detected from pool_manager if not provided

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

        # Calculate BTC mined per day using accurate pool-specific method
        # This already accounts for pool fees (FPPS+ includes tx fees in payout structure)
        btc_per_day = self.calculate_btc_per_day(hashrate_th, difficulty, pool_fee_percent)

        # For display purposes, calculate gross (what would be earned solo)
        block_subsidy = self.get_block_subsidy()
        hashrate_hs = hashrate_th * 1e12
        btc_per_day_gross = (hashrate_hs * 86400 * block_subsidy) / (difficulty * 2**32)

        # Pool detection is handled by app.py's get_profitability() which passes
        # the detected fee via pool_fee_percent. Here we just apply defaults.
        pool_type = None
        pool_name = None
        pool_fee_detected = False
        if pool_fee_percent is None or pool_fee_percent < 0:
            pool_fee_percent = self.default_pool_fee_percent

        pool_fee_decimal = pool_fee_percent / 100
        pool_fee_btc = btc_per_day_gross * pool_fee_decimal

        # Calculate revenue
        revenue_per_day_gross = btc_per_day_gross * btc_price
        revenue_per_day = btc_per_day * btc_price
        pool_fee_usd = pool_fee_btc * btc_price

        # Calculate energy consumption and cost
        # If rate_manager and mining_scheduler are provided, use comprehensive calculation
        # that accounts for TOU rates and mining schedules
        energy_cost_details = None
        if rate_manager is not None and mining_scheduler is not None:
            # Use comprehensive projected cost calculation
            energy_cost_details = self.calculate_projected_daily_cost(
                max_power_watts=total_power_watts,
                rate_manager=rate_manager,
                mining_scheduler=mining_scheduler
            )
            energy_kwh_per_day = energy_cost_details['total_kwh']
            energy_cost_per_day = energy_cost_details['total_cost']
        else:
            # Simple calculation (current power * 24 hours * current rate)
            energy_kwh_per_day = (total_power_watts / 1000) * 24
            energy_cost_per_day = energy_kwh_per_day * energy_rate_per_kwh

        # Calculate profit (after pool fees and energy costs)
        profit_per_day = revenue_per_day - energy_cost_per_day

        # Calculate efficiency metrics
        profit_margin = (profit_per_day / revenue_per_day * 100) if revenue_per_day > 0 else 0
        break_even_btc_price = (energy_cost_per_day / btc_per_day) if btc_per_day > 0 else 0

        # Get halving info
        halving_info = self.btc_fetcher.get_halving_info()
        block_subsidy = halving_info.get('current_subsidy', 3.125)

        result = {
            'btc_price': btc_price,
            'network_difficulty': difficulty,
            'total_hashrate_ths': hashrate_th,
            'total_power_watts': total_power_watts,
            # BTC earnings
            'btc_per_day_gross': btc_per_day_gross,
            'btc_per_day': btc_per_day,  # Net after pool fees
            # Revenue
            'revenue_per_day_gross': revenue_per_day_gross,
            'revenue_per_day': revenue_per_day,  # Net after pool fees
            # Pool fees
            'pool_fee_percent': pool_fee_percent,
            'pool_fee_btc': pool_fee_btc,
            'pool_fee_usd': pool_fee_usd,
            # Energy
            'energy_kwh_per_day': energy_kwh_per_day,
            'energy_cost_per_day': energy_cost_per_day,
            # Profit
            'profit_per_day': profit_per_day,
            'profit_margin': profit_margin,
            'break_even_btc_price': break_even_btc_price,
            'is_profitable': profit_per_day > 0,
            # Block subsidy / halving info
            'block_subsidy': block_subsidy,
            'block_height': halving_info.get('block_height'),
            'blocks_until_halving': halving_info.get('blocks_until_halving'),
            'days_until_halving': halving_info.get('estimated_days_until_halving'),
            # Metadata
            'pool_type': pool_type if pool_type else 'PPS',
            'pool_name': pool_name,
            'includes_tx_fees': pool_type in ('FPPS', 'FPPS+', 'PPS+') if pool_type else True,
            'pool_fee_detected': pool_fee_detected,
            'is_estimate': True,
            'estimate_note': f'Pool earnings based on {pool_type or "PPS"} calculation. Pool fee: {pool_fee_percent}%.'
        }

        # Add detailed energy cost breakdown if available
        if energy_cost_details:
            result['energy_cost_details'] = {
                'cost_by_rate_type': energy_cost_details['cost_by_rate_type'],
                'kwh_by_rate_type': energy_cost_details['kwh_by_rate_type'],
                'rates_by_type': energy_cost_details.get('rates_by_type', {}),  # Actual $/kWh rates
                'hours_full_power': energy_cost_details['hours_full_power'],
                'hours_reduced': energy_cost_details['hours_reduced'],
                'hours_off': energy_cost_details['hours_off'],
                'uses_schedule': True
            }
        else:
            result['energy_cost_details'] = {
                'uses_schedule': False,
                'calculation_method': 'simple'  # power * 24h * single_rate
            }

        return result


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
        """
        Check if current time is within start-end range.
        Start time is inclusive, end time is exclusive (except for 23:59 which is treated as end of day).
        This prevents boundary overlap issues where 14:00 would match both "00:00-14:00" and "14:00-19:00".
        """
        try:
            current_dt = datetime.strptime(current, "%H:%M").time()
            start_dt = datetime.strptime(start, "%H:%M").time()
            end_dt = datetime.strptime(end, "%H:%M").time()

            # Special case: 23:59 means "end of day" so include it
            end_is_eod = (end == "23:59")

            if start_dt <= end_dt:
                # Normal range (e.g., 09:00 to 17:00)
                # Start is inclusive, end is exclusive (unless end of day)
                if end_is_eod:
                    return start_dt <= current_dt <= end_dt
                else:
                    return start_dt <= current_dt < end_dt
            else:
                # Range crosses midnight (e.g., 22:00 to 06:00)
                # Start is inclusive, end is exclusive
                if end_is_eod:
                    return current_dt >= start_dt or current_dt <= end_dt
                else:
                    return current_dt >= start_dt or current_dt < end_dt
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
                rate_type=rate.get('rate_type', 'standard'),
                season=rate.get('season', 'all')
            )

    def get_rate_for_timestamp(self, timestamp: datetime) -> float:
        """
        Get the energy rate that was in effect at a specific timestamp.

        Args:
            timestamp: datetime object

        Returns:
            Rate in $/kWh
        """
        time_str = timestamp.strftime("%H:%M")
        day_name = timestamp.strftime("%A")  # Monday, Tuesday, etc.

        rates = self.db.get_energy_rates()

        for rate in rates:
            # Check if day matches (if specified)
            if rate['day_of_week'] and rate['day_of_week'] != day_name:
                continue

            if self._time_in_range(time_str, rate['start_time'], rate['end_time']):
                return rate['rate_per_kwh']

        # Return default rate if no match
        config_data = self.db.get_energy_config()
        if config_data and config_data.get('default_rate'):
            return config_data['default_rate']

        return 0.12  # Default fallback

    def get_rate_info_for_hour(self, hour: int, day_of_week: str = None) -> Dict:
        """
        Get rate information for a specific hour.

        Args:
            hour: Hour of day (0-23)
            day_of_week: Day name (e.g., "Monday"). If None, uses current day.

        Returns:
            Dict with rate, rate_type, and source
        """
        if day_of_week is None:
            day_of_week = datetime.now().strftime("%A")

        time_str = f"{hour:02d}:00"
        rates = self.db.get_energy_rates()

        for rate in rates:
            if rate['day_of_week'] and rate['day_of_week'] != day_of_week:
                continue

            if self._time_in_range(time_str, rate['start_time'], rate['end_time']):
                return {
                    'rate': rate['rate_per_kwh'],
                    'rate_type': rate.get('rate_type', 'standard'),
                    'source': 'schedule'
                }

        # Default rate
        config_data = self.db.get_energy_config()
        default_rate = config_data.get('default_rate', 0.12) if config_data else 0.12

        return {
            'rate': default_rate,
            'rate_type': 'standard',
            'source': 'default'
        }

    def get_24h_rates(self, day_of_week: str = None) -> List[Dict]:
        """
        Get rates for all 24 hours of a day.

        Returns:
            List of 24 dicts with rate info for each hour
        """
        if day_of_week is None:
            day_of_week = datetime.now().strftime("%A")

        return [
            {'hour': hour, **self.get_rate_info_for_hour(hour, day_of_week)}
            for hour in range(24)
        ]

    def calculate_cost_with_tou(self, hourly_breakdown: List[Dict], use_historical: bool = True) -> Dict:
        """
        Calculate energy cost using actual TOU rates for each hour.
        Uses historical rates from energy_rates_history if available.

        Args:
            hourly_breakdown: List of {'hour': '2024-01-19 14:00', 'kwh': 0.5, 'readings': 10}
            use_historical: If True, attempts to use historical rates for accuracy

        Returns:
            Dict with total_cost, breakdown by rate type, weighted_avg_rate, and details
        """
        total_cost = 0
        cost_by_rate_type = {'peak': 0, 'off-peak': 0, 'standard': 0}
        kwh_by_rate_type = {'peak': 0, 'off-peak': 0, 'standard': 0}
        detailed_breakdown = []

        rates = self.db.get_energy_rates()

        for entry in hourly_breakdown:
            hour_str = entry['hour']  # Format: '2024-01-19 14:00'
            kwh = entry['kwh']

            try:
                hour_dt = datetime.strptime(hour_str, '%Y-%m-%d %H:%M')
            except ValueError:
                continue

            # Try to get historical rate first if enabled
            rate = None
            rate_type = 'standard'
            rate_source = 'current'

            if use_historical:
                historical_rate_data = self.db.get_historical_rate(hour_dt)
                if historical_rate_data:
                    rate = historical_rate_data.get('rate_per_kwh')
                    rate_type = historical_rate_data.get('rate_type', 'standard')
                    rate_source = 'historical'

            # Fallback to current rates if no historical rate found
            if rate is None:
                time_str = hour_dt.strftime("%H:%M")
                day_name = hour_dt.strftime("%A")

                for r in rates:
                    if r['day_of_week'] and r['day_of_week'] != day_name:
                        continue
                    if self._time_in_range(time_str, r['start_time'], r['end_time']):
                        rate = r['rate_per_kwh']
                        rate_type = r.get('rate_type', 'standard')
                        break

            # Final fallback to default rate
            if rate is None:
                config_data = self.db.get_energy_config()
                rate = config_data.get('default_rate', 0.12) if config_data else 0.12
                rate_type = 'standard'
                rate_source = 'default'

            # Calculate cost for this hour
            cost = kwh * rate
            total_cost += cost

            # Track by rate type
            if rate_type in cost_by_rate_type:
                cost_by_rate_type[rate_type] += cost
                kwh_by_rate_type[rate_type] += kwh

            detailed_breakdown.append({
                'hour': hour_str,
                'kwh': kwh,
                'rate': rate,
                'rate_type': rate_type,
                'rate_source': rate_source,
                'cost': cost
            })

        # Calculate weighted average rate
        total_kwh = sum(kwh_by_rate_type.values())
        weighted_avg_rate = total_cost / total_kwh if total_kwh > 0 else 0

        return {
            'total_cost': total_cost,
            'cost_by_rate_type': cost_by_rate_type,
            'kwh_by_rate_type': kwh_by_rate_type,
            'weighted_avg_rate': weighted_avg_rate,
            'detailed_breakdown': detailed_breakdown
        }


class MiningScheduler:
    """Automated mining schedule based on energy rates"""

    def __init__(self, db, rate_manager: EnergyRateManager, btc_fetcher=None, profitability_calc=None):
        self.db = db
        self.rate_manager = rate_manager
        self.btc_fetcher = btc_fetcher
        self.profitability_calc = profitability_calc

    def get_schedule_for_hour(self, hour: int, day_of_week: str = None) -> Optional[Dict]:
        """
        Get the mining schedule that applies to a specific hour.

        Args:
            hour: Hour of day (0-23)
            day_of_week: Day name (e.g., "Monday"). If None, uses current day.

        Returns:
            Schedule dict or None if no schedule applies
        """
        if day_of_week is None:
            day_of_week = datetime.now().strftime("%A")

        time_str = f"{hour:02d}:00"
        schedules = self.db.get_mining_schedules()

        for schedule in schedules:
            # Check if day matches
            if schedule['day_of_week'] and schedule['day_of_week'] != day_of_week:
                continue

            # Check if time is in range
            if self.rate_manager._time_in_range(
                time_str,
                schedule['start_time'],
                schedule['end_time']
            ):
                return schedule

        return None  # No schedule = full power mining

    def get_24h_schedule(self, day_of_week: str = None) -> List[Dict]:
        """
        Get the schedule for all 24 hours of a day.

        Returns:
            List of 24 dicts, one per hour, with schedule info
        """
        if day_of_week is None:
            day_of_week = datetime.now().strftime("%A")

        hourly_schedule = []
        for hour in range(24):
            schedule = self.get_schedule_for_hour(hour, day_of_week)
            if schedule:
                hourly_schedule.append({
                    'hour': hour,
                    'target_frequency': schedule['target_frequency'],
                    'is_mining': schedule['target_frequency'] > 0,
                    'schedule_id': schedule['id']
                })
            else:
                # No schedule = full power (frequency 0 means "max/unchanged")
                hourly_schedule.append({
                    'hour': hour,
                    'target_frequency': 0,  # 0 = max frequency
                    'is_mining': True,
                    'schedule_id': None
                })

        return hourly_schedule

    def check_profitability_gate(self, total_hashrate_hs: float, total_power_watts: float) -> Tuple[bool, Dict]:
        """Check if mining revenue exceeds energy cost at current rate.
        Returns (is_profitable, margin_details)"""
        if not self.btc_fetcher or not self.profitability_calc:
            return True, {'reason': 'profitability_calc_unavailable'}

        btc_price = self.btc_fetcher.get_btc_price()
        difficulty = self.btc_fetcher.get_network_difficulty()
        if not btc_price or not difficulty:
            return True, {'reason': 'market_data_unavailable'}

        hashrate_th = total_hashrate_hs / 1e12
        if hashrate_th <= 0 or total_power_watts <= 0:
            return True, {'reason': 'no_active_miners'}

        btc_per_day = self.profitability_calc.calculate_btc_per_day(hashrate_th, difficulty)
        revenue_per_day = btc_per_day * btc_price
        energy_rate = self.rate_manager.get_current_rate()
        cost_per_day = (total_power_watts / 1000) * 24 * energy_rate
        profit = revenue_per_day - cost_per_day

        return profit > 0, {
            'revenue_per_day': round(revenue_per_day, 4),
            'cost_per_day': round(cost_per_day, 4),
            'profit_per_day': round(profit, 4),
            'btc_price': btc_price,
            'energy_rate': energy_rate
        }

    def check_btc_price_floor(self) -> Tuple[bool, float, float]:
        """Check if BTC price is above user-configured floor.
        Returns (above_floor, current_price, floor_price)"""
        import json
        floor_setting = self.db.get_setting('btc_price_floor')
        floor_price = float(floor_setting) if floor_setting else 0

        if floor_price <= 0:
            return True, 0, 0  # Disabled

        if not self.btc_fetcher:
            return True, 0, floor_price

        current_price = self.btc_fetcher.get_btc_price() or 0
        return current_price >= floor_price, current_price, floor_price

    def check_difficulty_change(self) -> Tuple[bool, Dict]:
        """Check if network difficulty changed significantly.
        Returns (changed_significantly, details)"""
        if not self.btc_fetcher:
            return False, {}

        threshold_setting = self.db.get_setting('difficulty_alert_threshold')
        threshold = float(threshold_setting) if threshold_setting else 5.0

        current_diff = self.btc_fetcher.get_network_difficulty()
        if not current_diff:
            return False, {}

        last_known = self.db.get_setting('last_known_difficulty')
        if not last_known:
            self.db.set_setting('last_known_difficulty', str(current_diff))
            return False, {'current': current_diff, 'previous': None}

        last_diff = float(last_known)
        if last_diff <= 0:
            self.db.set_setting('last_known_difficulty', str(current_diff))
            return False, {}

        change_pct = abs(current_diff - last_diff) / last_diff * 100
        if change_pct >= threshold:
            self.db.set_setting('last_known_difficulty', str(current_diff))
            return True, {
                'current': current_diff,
                'previous': last_diff,
                'change_pct': round(change_pct, 2),
                'threshold': threshold
            }

        return False, {
            'current': current_diff,
            'previous': last_diff,
            'change_pct': round(change_pct, 2),
            'threshold': threshold
        }

    def should_mine_now(self, total_hashrate_hs: float = 0, total_power_watts: float = 0) -> Tuple[bool, int, str]:
        """
        Enhanced check: BTC price floor, profitability gate, then TOU schedule.

        Returns:
            Tuple of (should_mine, target_frequency, reason_string)
        """
        # Gate 1: BTC price floor
        import json
        auto_controls_raw = self.db.get_setting('profitability_auto_pause')
        profitability_auto_pause = auto_controls_raw == 'true' or auto_controls_raw == '1'

        above_floor, current_price, floor_price = self.check_btc_price_floor()
        if not above_floor and floor_price > 0:
            return False, 0, f"BTC price ${current_price:,.0f} below floor ${floor_price:,.0f}"

        # Gate 2: Profitability gate
        if profitability_auto_pause and total_hashrate_hs > 0 and total_power_watts > 0:
            is_profitable, margin = self.check_profitability_gate(total_hashrate_hs, total_power_watts)
            if not is_profitable:
                return False, 0, f"Unprofitable: ${margin.get('profit_per_day', 0):.4f}/day"

        # Gate 3: TOU schedule
        schedules = self.db.get_mining_schedules()

        if not schedules:
            return True, 0, "No schedule configured"

        now = datetime.now()
        current_time = now.strftime("%H:%M")
        current_day = now.strftime("%A")

        for schedule in schedules:
            if schedule['day_of_week'] and schedule['day_of_week'] != current_day:
                continue

            if self.rate_manager._time_in_range(
                current_time,
                schedule['start_time'],
                schedule['end_time']
            ):
                target_freq = schedule['target_frequency']
                should_mine = target_freq > 0
                reason = f"Schedule: freq={target_freq}" if should_mine else "Schedule: mining paused"
                return should_mine, target_freq, reason

        return True, 0, "Default: full power"

    def get_24h_visual_schedule(self, day_of_week: str = None) -> List[Dict]:
        """Get enriched 24h data combining schedule + rate info + profitability status for the timeline"""
        if day_of_week is None:
            day_of_week = datetime.now().strftime("%A")

        current_hour = datetime.now().hour
        hourly_data = []

        for hour in range(24):
            schedule = self.get_schedule_for_hour(hour, day_of_week)
            rate_info = self.rate_manager.get_rate_info_for_hour(hour, day_of_week)

            if schedule:
                target_freq = schedule['target_frequency']
                is_mining = target_freq > 0
                status = 'full' if target_freq == 0 else ('reduced' if is_mining else 'off')
            else:
                target_freq = 0
                is_mining = True
                status = 'full'

            hourly_data.append({
                'hour': hour,
                'is_current': hour == current_hour,
                'target_frequency': target_freq,
                'is_mining': is_mining,
                'status': status,  # 'full', 'reduced', 'off'
                'rate': rate_info.get('rate', 0),
                'rate_type': rate_info.get('rate_type', 'standard'),
                'hour_label': f"{hour:02d}:00"
            })

        return hourly_data

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


class StrategyOptimizer:
    """Generate personalized mining strategies based on real fleet data and market conditions"""

    def __init__(self, db, btc_fetcher: BitcoinDataFetcher, profitability_calc: ProfitabilityCalculator,
                 rate_manager: EnergyRateManager, mining_scheduler: MiningScheduler):
        self.db = db
        self.btc_fetcher = btc_fetcher
        self.profitability_calc = profitability_calc
        self.rate_manager = rate_manager
        self.mining_scheduler = mining_scheduler

    def _estimate_at_frequency(self, freq: int, max_freq: int, max_hashrate_hs: float,
                                max_power_watts: float) -> Tuple[float, float]:
        """Estimate hashrate and power at a given frequency."""
        if freq <= 0:
            return 0, 0
        freq_ratio = min(freq / max_freq, 1.0) if max_freq > 0 else 1.0
        hashrate = max_hashrate_hs * freq_ratio
        power = self.profitability_calc.calculate_power_at_frequency(max_power_watts, freq, max_freq)
        return hashrate, power

    def generate_strategies(self, fleet_hashrate_hs: float, fleet_power_watts: float,
                            min_frequency: int, max_frequency: int) -> List[Dict]:
        """Generate 3 personalized strategies based on real data."""
        btc_price = self.btc_fetcher.get_btc_price() or 0
        difficulty = self.btc_fetcher.get_network_difficulty() or 1
        block_subsidy = self.btc_fetcher.get_block_subsidy() or 3.125
        rates_24h = self.rate_manager.get_24h_rates()

        if fleet_hashrate_hs <= 0 or fleet_power_watts <= 0 or btc_price <= 0:
            return []

        freq_step = max(10, (max_frequency - min_frequency) // 20) if max_frequency > min_frequency else 10
        strategies = []

        # === Strategy 1: Maximum Profit ===
        max_profit_plan = []
        for hour_info in rates_24h:
            hour = hour_info['hour']
            rate = hour_info['rate']
            best_freq = 0
            best_profit = float('-inf')

            for freq in range(min_frequency, max_frequency + 1, freq_step):
                hr_hs, hr_power = self._estimate_at_frequency(freq, max_frequency, fleet_hashrate_hs, fleet_power_watts)
                hr_th = hr_hs / 1e12
                revenue = (hr_hs * 3600 * block_subsidy) / (difficulty * (2**32)) * btc_price
                cost = (hr_power / 1000) * rate
                profit = revenue - cost

                if profit > best_profit:
                    best_profit = profit
                    best_freq = freq

            # If all unprofitable, turn off
            if best_profit < 0:
                max_profit_plan.append({
                    'hour': hour, 'frequency': 0, 'profit': 0,
                    'revenue': 0, 'cost': 0, 'rate': rate
                })
            else:
                hr_hs, hr_power = self._estimate_at_frequency(best_freq, max_frequency, fleet_hashrate_hs, fleet_power_watts)
                revenue = (hr_hs * 3600 * block_subsidy) / (difficulty * (2**32)) * btc_price
                cost = (hr_power / 1000) * rate
                max_profit_plan.append({
                    'hour': hour, 'frequency': best_freq,
                    'profit': round(revenue - cost, 6), 'revenue': round(revenue, 6),
                    'cost': round(cost, 6), 'rate': rate
                })

        strategies.append(self._build_strategy('Maximum Profit', max_profit_plan, btc_price))

        # === Strategy 2: Maximum Hashrate ===
        max_hash_plan = []
        for hour_info in rates_24h:
            hour = hour_info['hour']
            rate = hour_info['rate']
            hr_hs = fleet_hashrate_hs
            revenue = (hr_hs * 3600 * block_subsidy) / (difficulty * (2**32)) * btc_price
            cost = (fleet_power_watts / 1000) * rate
            max_hash_plan.append({
                'hour': hour, 'frequency': max_frequency,
                'profit': round(revenue - cost, 6), 'revenue': round(revenue, 6),
                'cost': round(cost, 6), 'rate': rate
            })

        strategies.append(self._build_strategy('Maximum Hashrate', max_hash_plan, btc_price))

        # === Strategy 3: Balanced ===
        avg_rate = sum(h['rate'] for h in rates_24h) / 24 if rates_24h else 0.12
        balanced_plan = []
        reduced_freq = min_frequency + int((max_frequency - min_frequency) * 0.6)

        for hour_info in rates_24h:
            hour = hour_info['hour']
            rate = hour_info['rate']

            # Off-peak: max freq. Peak (rate > 110% avg): reduced freq
            if rate <= avg_rate * 1.1:
                freq = max_frequency
            else:
                freq = reduced_freq

            hr_hs, hr_power = self._estimate_at_frequency(freq, max_frequency, fleet_hashrate_hs, fleet_power_watts)
            revenue = (hr_hs * 3600 * block_subsidy) / (difficulty * (2**32)) * btc_price
            cost = (hr_power / 1000) * rate
            balanced_plan.append({
                'hour': hour, 'frequency': freq,
                'profit': round(revenue - cost, 6), 'revenue': round(revenue, 6),
                'cost': round(cost, 6), 'rate': rate
            })

        strategies.append(self._build_strategy('Balanced', balanced_plan, btc_price))

        return strategies

    def _build_strategy(self, name: str, hourly_plan: List[Dict], btc_price: float) -> Dict:
        """Build strategy summary with projections."""
        daily_revenue = sum(h['revenue'] for h in hourly_plan)
        daily_cost = sum(h['cost'] for h in hourly_plan)
        daily_profit = daily_revenue - daily_cost
        mining_hours = sum(1 for h in hourly_plan if h['frequency'] > 0)
        btc_per_day = daily_revenue / btc_price if btc_price > 0 else 0

        return {
            'name': name,
            'hourly_plan': hourly_plan,
            'mining_hours': mining_hours,
            'projections': {
                'daily': {'revenue': round(daily_revenue, 4), 'cost': round(daily_cost, 4),
                          'profit': round(daily_profit, 4), 'btc': round(btc_per_day, 8),
                          'sats': round(btc_per_day * 1e8)},
                'weekly': {'revenue': round(daily_revenue * 7, 4), 'cost': round(daily_cost * 7, 4),
                           'profit': round(daily_profit * 7, 4), 'btc': round(btc_per_day * 7, 8),
                           'sats': round(btc_per_day * 7 * 1e8)},
                'monthly': {'revenue': round(daily_revenue * 30, 4), 'cost': round(daily_cost * 30, 4),
                            'profit': round(daily_profit * 30, 4), 'btc': round(btc_per_day * 30, 8),
                            'sats': round(btc_per_day * 30 * 1e8)}
            }
        }

    def apply_strategy(self, strategy_name: str, hourly_plan: List[Dict]):
        """Apply a strategy as a mining schedule by grouping consecutive hours with same frequency."""
        # Clear existing schedules
        for schedule in self.db.get_mining_schedules():
            self.db.delete_mining_schedule(schedule['id'])

        if not hourly_plan:
            return

        # Group consecutive hours with same frequency into time blocks
        blocks = []
        current_block = {'start_hour': hourly_plan[0]['hour'], 'frequency': hourly_plan[0]['frequency']}

        for i in range(1, len(hourly_plan)):
            if hourly_plan[i]['frequency'] == current_block['frequency']:
                continue  # Same frequency, extend block
            else:
                current_block['end_hour'] = hourly_plan[i - 1]['hour']
                blocks.append(current_block)
                current_block = {'start_hour': hourly_plan[i]['hour'], 'frequency': hourly_plan[i]['frequency']}

        # Close last block
        current_block['end_hour'] = hourly_plan[-1]['hour']
        blocks.append(current_block)

        # Create schedule entries
        for block in blocks:
            start_time = f"{block['start_hour']:02d}:00"
            end_hour = (block['end_hour'] + 1) % 24
            end_time = "23:59" if end_hour == 0 else f"{end_hour:02d}:00"

            self.db.add_mining_schedule(
                start_time=start_time,
                end_time=end_time,
                target_frequency=block['frequency'],
                day_of_week=None,
                enabled=1
            )

        logger.info(f"Applied strategy '{strategy_name}' with {len(blocks)} schedule blocks")


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

# Brand name to subsidiary mapping for OpenEI API searches.
# OpenEI uses legal subsidiary names, not brand names. This mapping allows
# users to search by familiar brand names (e.g. "Xcel Energy") and still
# find the correct utility companies in the API.
BRAND_TO_SUBSIDIARIES = {
    "xcel energy": [
        "Northern States Power Co - Minnesota",
        "Northern States Power Co - Wisconsin",
        "Public Service Company of Colorado",
        "Southwestern Public Service Company"
    ],
    "duke energy": [
        "Duke Energy Carolinas, LLC",
        "Duke Energy Progress, LLC",
        "Duke Energy Florida, LLC",
        "Duke Energy Indiana, LLC",
        "Duke Energy Ohio, Inc.",
        "Duke Energy Kentucky, Inc."
    ],
    "nextera energy": [
        "Florida Power & Light Co",
        "Gulf Power Company"
    ],
    "dominion energy": [
        "Virginia Electric & Power Co",
        "Dominion Energy South Carolina"
    ],
    "southern company": [
        "Alabama Power Company",
        "Georgia Power Company",
        "Mississippi Power Company",
        "Gulf Power Company"
    ],
    "entergy": [
        "Entergy Arkansas, LLC",
        "Entergy Louisiana, LLC",
        "Entergy Mississippi, LLC",
        "Entergy New Orleans, LLC",
        "Entergy Texas, Inc."
    ],
    "eversource": [
        "Eversource Energy",
        "NSTAR Electric Company",
        "Connecticut Light & Power",
        "Public Service Co of New Hampshire"
    ],
    "pg&e": [
        "Pacific Gas & Electric Co"
    ],
    "pacific gas": [
        "Pacific Gas & Electric Co"
    ],
    "sce": [
        "Southern California Edison Co"
    ],
    "southern california edison": [
        "Southern California Edison Co"
    ],
    "consumers energy": [
        "Consumers Energy Company"
    ],
    "dte energy": [
        "DTE Electric Company"
    ],
    "alliant energy": [
        "Interstate Power & Light Co",
        "Wisconsin Power & Light Co"
    ],
    "we energies": [
        "Wisconsin Electric Power Co"
    ],
    "ameren": [
        "Ameren Illinois Co",
        "Ameren Missouri"
    ],
    "ppl": [
        "PPL Electric Utilities Corp",
        "Louisville Gas & Electric Co",
        "Kentucky Utilities Co"
    ],
    "firstenergy": [
        "Ohio Edison Co",
        "The Cleveland Electric Illuminating Co",
        "The Toledo Edison Co",
        "Jersey Central Power & Light Co",
        "Metropolitan Edison Co",
        "Pennsylvania Electric Co",
        "Monongahela Power Co",
        "Potomac Edison Co",
        "West Penn Power Co"
    ],
    "aep": [
        "Appalachian Power Co",
        "Indiana Michigan Power Co",
        "Ohio Power Co",
        "Public Service Co of Oklahoma",
        "Southwestern Electric Power Co"
    ],
    "conedison": [
        "Consolidated Edison Co of New York"
    ],
    "con edison": [
        "Consolidated Edison Co of New York"
    ],
    "national grid": [
        "National Grid - New York",
        "National Grid - Massachusetts",
        "Narragansett Electric Co"
    ],
    "centerpoint": [
        "CenterPoint Energy Houston Electric"
    ],
    "oncor": [
        "Oncor Electric Delivery Company"
    ],
    "puget sound energy": [
        "Puget Sound Energy"
    ],
    "pse": [
        "Puget Sound Energy"
    ],
    "rocky mountain power": [
        "PacifiCorp - Rocky Mountain Power"
    ],
    "pacificorp": [
        "PacifiCorp"
    ],
    "avista": [
        "Avista Corporation"
    ],
    "idaho power": [
        "Idaho Power Company"
    ],
    "austin energy": [
        "Austin Energy"
    ],
    "salt river project": [
        "Salt River Project"
    ],
    "srp": [
        "Salt River Project"
    ],
    "aps": [
        "Arizona Public Service Company"
    ],
    "arizona public service": [
        "Arizona Public Service Company"
    ],
    "tucson electric": [
        "Tucson Electric Power Co"
    ],
    "tep": [
        "Tucson Electric Power Co"
    ],
    "nv energy": [
        "Nevada Power Company",
        "Sierra Pacific Power Company"
    ],
    "cleco": [
        "Cleco Power LLC"
    ],
    "empire district": [
        "The Empire District Electric Co"
    ],
    "oge energy": [
        "Oklahoma Gas & Electric Co"
    ],
    "evergy": [
        "Evergy Kansas Central",
        "Evergy Metro"
    ],
    "midamerican": [
        "MidAmerican Energy Company"
    ],
}
