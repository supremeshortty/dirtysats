"""
Pool Manager - Detects and manages pool configurations for miners
"""
import logging
import re
from typing import Dict, List, Optional
from datetime import datetime

logger = logging.getLogger(__name__)


class PoolManager:
    """Manage pool configurations and detect pool settings from miners"""

    # Pool detection patterns
    POOL_PATTERNS = {
        'Braiins Pool': {
            'url_patterns': [
                r'stratum.*braiins\.com',
                r'.*\.braiins\.com',
            ],
            'fee_percent': 2.5,  # FPPS+ includes transaction fees
            'pool_type': 'FPPS+',
            'default_port': 3333
        },
        'Ocean': {
            'url_patterns': [
                r'.*ocean\.xyz',
                r'.*\.ocean\.xyz',
            ],
            'fee_percent': 2.0,  # Standard 2% fee
            'pool_type': 'TIDES',
            'default_port': 3334
        },
        'Public Pool': {
            'url_patterns': [
                r'.*public-pool\.io',
                r'pool\.public-pool\.io',
            ],
            'fee_percent': 0.0,  # No fee (solo mining option)
            'pool_type': 'SOLO',  # Can also be PPLNS
            'default_port': 21496
        },
        'Foundry USA': {
            'url_patterns': [
                r'.*foundry.*',
                r'.*foundryusa.*',
            ],
            'fee_percent': 0.0,  # Private pool
            'pool_type': 'FPPS',
            'default_port': 3333
        },
        'F2Pool': {
            'url_patterns': [
                r'.*f2pool\.com',
                r'stratum.*\.f2pool\.com',
            ],
            'fee_percent': 2.5,
            'pool_type': 'PPS+',
            'default_port': 3333
        },
        'Slush Pool': {
            'url_patterns': [
                r'.*slushpool\.com',
                r'stratum.*\.slushpool\.com',
            ],
            'fee_percent': 2.0,
            'pool_type': 'Score',
            'default_port': 3333
        },
        'AntPool': {
            'url_patterns': [
                r'.*antpool\.com',
                r'stratum.*\.antpool\.com',
            ],
            'fee_percent': 2.5,
            'pool_type': 'FPPS',
            'default_port': 3333
        },
        'ViaBTC': {
            'url_patterns': [
                r'.*viabtc\.com',
                r'stratum.*\.viabtc\.com',
            ],
            'fee_percent': 4.0,  # PPS+ default model
            'pool_type': 'PPS+',
            'default_port': 3333
        },
        'Poolin': {
            'url_patterns': [
                r'.*poolin\.com',
                r'stratum.*\.poolin\.com',
            ],
            'fee_percent': 2.5,
            'pool_type': 'FPPS',
            'default_port': 3333
        },
        'Luxor': {
            'url_patterns': [
                r'.*luxor\.tech',
                r'.*\.luxor\.tech',
            ],
            'fee_percent': 0.0,  # Varies by plan
            'pool_type': 'FPPS',
            'default_port': 3333
        },
        'BTC.com': {
            'url_patterns': [
                r'.*btc\.com',
                r'stratum.*\.btc\.com',
            ],
            'fee_percent': 1.5,
            'pool_type': 'FPPS',
            'default_port': 3333
        },
        'MARA Pool': {
            'url_patterns': [
                r'.*mara.*pool',
                r'.*marathondigital.*',
            ],
            'fee_percent': 0.0,  # Private/enterprise
            'pool_type': 'FPPS',
            'default_port': 3333
        },
        'Binance Pool': {
            'url_patterns': [
                r'.*binance.*pool',
                r'pool\.binance\.com',
            ],
            'fee_percent': 2.5,
            'pool_type': 'FPPS',
            'default_port': 3333
        },
        'Solo CK Pool': {
            'url_patterns': [
                r'solo\.ckpool\.org',
                r'.*ckpool.*solo',
            ],
            'fee_percent': 2.0,  # 2% solo mining fee
            'pool_type': 'SOLO',
            'default_port': 3333
        },
        'Localhost (Solo)': {
            'url_patterns': [
                r'localhost',
                r'127\.0\.0\.1',
                r'192\.168\..*',
                r'10\..*',
            ],
            'fee_percent': 0.0,
            'pool_type': 'SOLO',
            'default_port': 8332
        },
        'EMCD': {
            'url_patterns': [r'.*emcd\.io'],
            'fee_percent': 1.5,
            'pool_type': 'FPPS',
            'default_port': 3333
        },
        'NiceHash': {
            'url_patterns': [r'.*nicehash\.com'],
            'fee_percent': 2.0,
            'pool_type': 'PPS',
            'default_port': 3334
        },
        'Kano CKPool': {
            'url_patterns': [r'.*kano\.is'],
            'fee_percent': 0.9,
            'pool_type': 'PPLNS',
            'default_port': 3333
        },
        'SpiderPool': {
            'url_patterns': [r'.*spiderpool\.com'],
            'fee_percent': 2.0,
            'pool_type': 'FPPS',
            'default_port': 3333
        },
        'Rawpool': {
            'url_patterns': [r'.*rawpool\.com'],
            'fee_percent': 3.5,
            'pool_type': 'FPPS',
            'default_port': 3333
        },
        'SigmaPool': {
            'url_patterns': [r'.*sigmapool\.com'],
            'fee_percent': 1.0,
            'pool_type': 'PPS+',
            'default_port': 3333
        },
        'Mining Dutch': {
            'url_patterns': [r'.*mining-dutch\.nl'],
            'fee_percent': 2.0,
            'pool_type': 'PPLNS',
            'default_port': 3333
        },
        'LuckPool': {
            'url_patterns': [r'.*luckpool\.net'],
            'fee_percent': 1.0,
            'pool_type': 'PPLNS',
            'default_port': 3333
        },
        'CKPool': {
            'url_patterns': [r'pool\.ckpool\.org'],
            'fee_percent': 1.0,
            'pool_type': 'PPLNS',
            'default_port': 3333
        },
        'BitAxe Pool': {
            'url_patterns': [r'.*pool\.bitaxe\.org'],
            'fee_percent': 1.0,
            'pool_type': 'PPLNS',
            'default_port': 3333
        },
        'Zpool': {
            'url_patterns': [r'.*zpool\.ca'],
            'fee_percent': 2.0,
            'pool_type': 'PPS',
            'default_port': 3333
        },
        'Cruxpool': {
            'url_patterns': [r'.*cruxpool\.com'],
            'fee_percent': 1.0,
            'pool_type': 'PPS',
            'default_port': 3333
        },
        'TrustPool': {
            'url_patterns': [r'.*trustpool\.cc'],
            'fee_percent': 1.0,
            'pool_type': 'PPS+',
            'default_port': 3333
        },
        'BitFuFu': {
            'url_patterns': [r'.*bitfufu\.com'],
            'fee_percent': 2.5,
            'pool_type': 'PPS+',
            'default_port': 3333
        },
        'Hashlabs': {
            'url_patterns': [r'.*hashlabs\.io'],
            'fee_percent': 2.0,
            'pool_type': 'FPPS',
            'default_port': 3333
        },
        'Solo Mining Pool': {
            'url_patterns': [r'.*solomining\.io'],
            'fee_percent': 2.0,
            'pool_type': 'SOLO',
            'default_port': 3333
        },
        'SoloPool.org': {
            'url_patterns': [r'.*solopool\.org'],
            'fee_percent': 2.0,
            'pool_type': 'SOLO',
            'default_port': 3333
        },
        'Kryptex': {
            'url_patterns': [r'.*kryptex\.network'],
            'fee_percent': 3.0,
            'pool_type': 'PPS+',
            'default_port': 3333
        },
        'DEMAND Pool': {
            'url_patterns': [r'.*dmnd\.work'],
            'fee_percent': 0.0,
            'pool_type': 'SOLO',
            'default_port': 3333
        },
        'ECOS Pool': {
            'url_patterns': [r'.*ecos\.am'],
            'fee_percent': 0.25,
            'pool_type': 'FPPS',
            'default_port': 3333
        },
    }

    def __init__(self, db, miners_dict: Dict):
        """
        Initialize pool manager

        Args:
            db: Database instance
            miners_dict: Dictionary of miner instances (ip -> miner object)
        """
        self.db = db
        self.miners = miners_dict

    def detect_pool_from_url(self, pool_url: str, allow_unknown: bool = True) -> Optional[Dict]:
        """
        Detect pool name and configuration from URL

        Args:
            pool_url: Pool URL (e.g., "stratum+tcp://stratum.braiins.com:3333")
            allow_unknown: If True, returns conservative defaults for unknown pools

        Returns:
            Dict with pool_name, fee_percent, pool_type, is_known, or None if not recognized
        """
        if not pool_url:
            return None

        # Normalize URL for pattern matching
        url_lower = pool_url.lower()

        # Try to match known pools
        for pool_name, pool_config in self.POOL_PATTERNS.items():
            for pattern in pool_config['url_patterns']:
                if re.search(pattern, url_lower, re.IGNORECASE):
                    return {
                        'pool_name': pool_name,
                        'fee_percent': pool_config['fee_percent'],
                        'pool_type': pool_config['pool_type'],
                        'default_port': pool_config['default_port'],
                        'is_known': True
                    }

        # Unknown pool - return conservative defaults if allowed
        if allow_unknown:
            # Extract hostname from URL for display
            hostname = pool_url
            try:
                # Try to extract just the hostname
                match = re.search(r'://([^:/]+)', pool_url)
                if match:
                    hostname = match.group(1)
            except:
                pass

            logger.warning(f"Unknown pool detected: {pool_url}")
            logger.info("Add pool details to pool_config table for accurate tracking")

            return {
                'pool_name': f'Custom Pool ({hostname})',
                'fee_percent': 2.5,  # Conservative default (typical pool fee)
                'pool_type': 'PPS',  # Assume standard PPS
                'default_port': 3333,
                'is_known': False,
                'requires_configuration': True
            }

        return None

    def extract_pool_info_from_url(self, pool_url: str) -> Dict:
        """
        Extract pool host, port, and protocol from URL

        Args:
            pool_url: Full pool URL

        Returns:
            Dict with host, port, protocol
        """
        # Parse stratum+tcp://host:port or similar formats
        match = re.match(r'(stratum\+tcp|stratum\+ssl|stratum)://([^:]+):(\d+)', pool_url)

        if match:
            protocol, host, port = match.groups()
            return {
                'protocol': protocol,
                'host': host,
                'port': int(port),
                'url': pool_url
            }

        # Try without protocol
        match = re.match(r'([^:]+):(\d+)', pool_url)
        if match:
            host, port = match.groups()
            return {
                'protocol': 'stratum+tcp',
                'host': host,
                'port': int(port),
                'url': f'stratum+tcp://{host}:{port}'
            }

        # Return as-is if can't parse
        return {
            'protocol': 'stratum+tcp',
            'host': pool_url,
            'port': 3333,
            'url': pool_url
        }

    def detect_and_save_pool_configs(self, force_update: bool = False):
        """
        Detect pool configurations from all miners and save to database

        Args:
            force_update: If True, updates even if config already exists
        """
        logger.info("Detecting pool configurations from miners...")
        pools_detected = 0
        pools_updated = 0

        for miner_ip, miner in self.miners.items():
            try:
                # Get pool information from miner
                pool_info = self._get_miner_pool_info(miner)

                if not pool_info:
                    logger.debug(f"No pool info available for {miner_ip}")
                    continue

                # Process each pool (primary + failovers)
                for pool_data in pool_info:
                    pool_index = pool_data.get('index', 0)
                    pool_url = pool_data.get('url')

                    if not pool_url:
                        continue

                    # Check if already exists
                    existing = self.db.get_pool_config(miner_ip=miner_ip)
                    if existing and not force_update:
                        logger.debug(f"Pool config already exists for {miner_ip}, skipping")
                        continue

                    # Detect pool from URL
                    pool_config = self.detect_pool_from_url(pool_url)
                    if not pool_config:
                        continue

                    # Extract URL components
                    url_info = self.extract_pool_info_from_url(pool_url)

                    # Get best difficulty from miner stats (for share calculation)
                    pool_difficulty = pool_data.get('difficulty')

                    # Save to database
                    self.db.add_pool_config(
                        miner_ip=miner_ip,
                        pool_index=pool_index,
                        pool_name=pool_config['pool_name'],
                        pool_url=url_info['url'],
                        pool_port=url_info['port'],
                        stratum_user=pool_data.get('user', ''),
                        stratum_password=pool_data.get('password', 'x'),
                        fee_percent=pool_config['fee_percent'],
                        pool_type=pool_config['pool_type'],
                        pool_difficulty=pool_difficulty
                    )

                    if existing:
                        pools_updated += 1
                        logger.info(f"Updated pool config: {miner_ip} -> {pool_config['pool_name']}")
                    else:
                        pools_detected += 1
                        logger.info(f"Detected new pool: {miner_ip} -> {pool_config['pool_name']}")

            except Exception as e:
                logger.error(f"Error detecting pool for {miner_ip}: {e}")

        logger.info(f"Pool detection complete: {pools_detected} new, {pools_updated} updated")
        return {'detected': pools_detected, 'updated': pools_updated}

    def _get_miner_pool_info(self, miner) -> Optional[List[Dict]]:
        """
        Get pool information from a miner instance via its API handler

        Args:
            miner: Miner instance with api_handler and ip attributes

        Returns:
            List of pool dicts with url, user, password, difficulty, index
        """
        try:
            if not hasattr(miner, 'api_handler') or not hasattr(miner, 'ip'):
                return None

            pool_result = miner.api_handler.get_pools(miner.ip)
            if not pool_result or 'pools' not in pool_result:
                return None

            pools = []
            for idx, pool in enumerate(pool_result['pools']):
                url = pool.get('url', '')
                if url:
                    pools.append({
                        'index': idx,
                        'url': url,
                        'user': pool.get('user', ''),
                        'password': pool.get('password', 'x'),
                        'difficulty': pool.get('difficulty'),
                        'status': pool.get('status')
                    })

            return pools if pools else None

        except Exception as e:
            logger.error(f"Error getting pool info from miner {getattr(miner, 'ip', '?')}: {e}")
            return None

    def update_pool_difficulties(self):
        """Update pool difficulties from current miner stats"""
        logger.debug("Updating pool difficulties from miner stats...")
        updated = 0

        for miner_ip, miner in self.miners.items():
            try:
                if hasattr(miner, 'get_stats'):
                    stats = miner.get_stats()
                    if stats:
                        # Get best difficulty from miner
                        best_diff = stats.get('best_difficulty', stats.get('best_share'))

                        if best_diff and best_diff > 0:
                            # Update all pool configs for this miner
                            pool_configs = self.db.get_pool_config(miner_ip=miner_ip)
                            for pool in pool_configs:
                                self.db.update_pool_difficulty(
                                    miner_ip=miner_ip,
                                    pool_index=pool['pool_index'],
                                    pool_difficulty=best_diff
                                )
                                updated += 1

            except Exception as e:
                logger.error(f"Error updating pool difficulty for {miner_ip}: {e}")

        logger.debug(f"Updated {updated} pool difficulty values")
        return updated

    def get_pool_config_for_miner(self, miner_ip: str) -> Optional[Dict]:
        """
        Get pool configuration for a specific miner (primary pool only)

        Args:
            miner_ip: Miner IP address

        Returns:
            Dict with pool configuration or None
        """
        configs = self.db.get_pool_config(miner_ip=miner_ip)
        if configs:
            # Return primary pool (index 0)
            for config in configs:
                if config['pool_index'] == 0:
                    return config
            # Fallback to first pool
            return configs[0]
        return None

    def get_all_pool_configs(self) -> List[Dict]:
        """Get all pool configurations"""
        return self.db.get_pool_config()

    def calculate_sats_from_shares(self, shares_accepted: int, pool_difficulty: float = None,
                                   pool_fee_percent: float = None, pool_type: str = None,
                                   network_difficulty: float = None) -> Dict:
        """
        Calculate estimated sats earned from accepted shares

        Universal calculation that works for all pool types including solo mining.

        Args:
            shares_accepted: Number of accepted shares
            pool_difficulty: Pool's share difficulty (if known, otherwise estimated)
            pool_fee_percent: Pool fee percentage (e.g., 2.5 for 2.5%)
            pool_type: Pool payout type (FPPS, FPPS+, PPS, PPLNS, SOLO, etc.)
            network_difficulty: Network difficulty (for solo mining calculations)

        Returns:
            Dict with 'sats', 'confidence', 'method', 'notes'
        """
        if shares_accepted <= 0:
            return {
                'sats': 0,
                'confidence': 100,
                'method': 'zero_shares',
                'notes': 'No shares accepted'
            }

        # Current block subsidy (3.125 BTC as of 2024 halving)
        block_reward_btc = 3.125
        block_reward_sats = int(block_reward_btc * 100_000_000)

        # Default values if not provided
        if pool_difficulty is None:
            pool_difficulty = 5000  # Typical pool difficulty
            confidence = 60
            method = 'estimated_difficulty'
        else:
            confidence = 90
            method = 'known_difficulty'

        if pool_fee_percent is None:
            pool_fee_percent = 2.5  # Conservative default
            confidence = min(confidence, 70)

        # Handle different pool types
        if pool_type and pool_type.upper() == 'SOLO':
            # Solo mining: only get paid if you find a block
            # Shares don't directly translate to sats, need to track blocks found
            return {
                'sats': 0,
                'confidence': 0,
                'method': 'solo_mining',
                'notes': 'Solo mining earnings only from blocks found. Use block count instead of shares.'
            }

        elif pool_type and pool_type.upper() in ['PPLNS', 'PROP']:
            # PPLNS/Proportional: Variance-based, depends on pool luck
            # Calculate expected value but note high variance
            shares_per_block = (2**32) * pool_difficulty
            share_value_sats = block_reward_sats / shares_per_block
            gross_sats = shares_accepted * share_value_sats
            net_sats = gross_sats * (1 - pool_fee_percent / 100)

            return {
                'sats': int(net_sats),
                'confidence': 50,  # High variance with PPLNS
                'method': 'pplns_expected_value',
                'notes': f'PPLNS has high variance. Actual earnings depend on pool luck. Fee: {pool_fee_percent}%'
            }

        elif pool_type and pool_type.upper() in ['FPPS+', 'FPPS']:
            # Full Pay Per Share (Plus): Most predictable
            # FPPS+ includes transaction fees in payout
            shares_per_block = (2**32) * pool_difficulty
            share_value_sats = block_reward_sats / shares_per_block
            gross_sats = shares_accepted * share_value_sats
            net_sats = gross_sats * (1 - pool_fee_percent / 100)

            # FPPS+ pools already include tx fees in their payout structure
            # so we don't add extra multiplier
            return {
                'sats': int(net_sats),
                'confidence': confidence,
                'method': 'fpps_calculation',
                'notes': f'{pool_type} pool. Fee: {pool_fee_percent}%. Tx fees included in payout.'
            }

        elif pool_type and pool_type.upper() == 'PPS':
            # Pay Per Share: Standard calculation
            shares_per_block = (2**32) * pool_difficulty
            share_value_sats = block_reward_sats / shares_per_block
            gross_sats = shares_accepted * share_value_sats
            net_sats = gross_sats * (1 - pool_fee_percent / 100)

            return {
                'sats': int(net_sats),
                'confidence': confidence,
                'method': 'pps_calculation',
                'notes': f'PPS pool. Fee: {pool_fee_percent}%. Block subsidy only (no tx fees).'
            }

        elif pool_type and pool_type.upper() == 'TIDES':
            # Ocean's TIDES: Transparent Index of Distinct Extended Shares
            # Similar to FPPS+ but with Bitcoin Core template
            shares_per_block = (2**32) * pool_difficulty
            share_value_sats = block_reward_sats / shares_per_block
            gross_sats = shares_accepted * share_value_sats
            net_sats = gross_sats * (1 - pool_fee_percent / 100)

            return {
                'sats': int(net_sats),
                'confidence': confidence,
                'method': 'tides_calculation',
                'notes': f'TIDES pool. Fee: {pool_fee_percent}%. Uses Bitcoin Core templates.'
            }

        else:
            # Unknown pool type: use generic PPS calculation
            shares_per_block = (2**32) * pool_difficulty
            share_value_sats = block_reward_sats / shares_per_block
            gross_sats = shares_accepted * share_value_sats
            net_sats = gross_sats * (1 - pool_fee_percent / 100)

            return {
                'sats': int(net_sats),
                'confidence': max(50, confidence - 20),
                'method': 'generic_calculation',
                'notes': f'Unknown pool type. Using generic calculation. Fee: {pool_fee_percent}%'
            }
