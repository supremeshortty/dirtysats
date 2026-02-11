"""
DirtySats - Bitcoin Mining Fleet Manager Configuration
"""
import os

# Network settings
NETWORK_SUBNET = "10.0.0.0/24"
DISCOVERY_TIMEOUT = 2  # seconds per IP
DISCOVERY_THREADS = 20  # parallel scan threads

# Monitoring settings
UPDATE_INTERVAL = 30  # seconds between status updates
STATUS_TIMEOUT = 3  # seconds per miner status check

# Alert settings
ALERT_COOLDOWN = 900  # seconds between repeated alerts for same issue (default: 15 min)

# Overheat recovery settings
OVERHEAT_AUTO_REBOOT = True  # Automatically reboot miners when they cool down after overheating
OVERHEAT_RECOVERY_TEMP = 38  # Temperature (°C) at which to reboot overheated miners

# Database
DATABASE_PATH = os.path.join(os.path.dirname(__file__), "fleet.db")

# OpenEI API Key (for utility rate search)
# Get a free key at: https://openei.org/services/api/signup
# Can also be set via OPENEI_API_KEY environment variable
OPENEI_API_KEY = os.environ.get('OPENEI_API_KEY', None)

# Flask settings
FLASK_HOST = "0.0.0.0"
FLASK_PORT = 5001
DEBUG = os.environ.get('FLASK_DEBUG', 'false').lower() == 'true'

# Miner API settings
BITAXE_API_TIMEOUT = 2
CGMINER_API_TIMEOUT = 2
CGMINER_PORT = 4028

# Supported miner types
MINER_TYPES = {
    # ESP-Miner based devices (BitAxe family)
    "BITAXE": "BitAxe",
    "BITAXE_MAX": "BitAxe Max",
    "BITAXE_ULTRA": "BitAxe Ultra",
    "BITAXE_SUPRA": "BitAxe Supra",
    "BITAXE_GAMMA": "BitAxe Gamma",
    # ESP-Miner based devices (NerdQAxe family)
    "NERDAXE": "NerdAxe",
    "NERDQAXE_PLUS": "NerdQAxe+",
    "NERDQAXE_PLUSPLUS": "NerdQAxe++",
    "NERDOCTAXE": "NerdOctaxe",
    # ESP-Miner based devices (other)
    "LUCKYMINER": "LuckyMiner",
    # Traditional ASIC miners
    "ANTMINER": "Antminer",
    "WHATSMINER": "Whatsminer",
    "AVALON": "Avalon",
    "UNKNOWN": "Unknown"
}

# Device profiles: (ASIC model, ASIC count) -> device type
ESP_MINER_PROFILES = {
    # Single-chip devices (BitAxe family)
    ('BM1397', 1): 'BITAXE_MAX',
    ('BM1366', 1): 'BITAXE_ULTRA',
    ('BM1368', 1): 'BITAXE_SUPRA',
    ('BM1370', 1): 'BITAXE_GAMMA',
    # Multi-chip devices (NerdQAxe family)
    ('BM1366', 4): 'NERDQAXE_PLUS',
    ('BM1368', 4): 'NERDQAXE_PLUS',
    ('BM1370', 4): 'NERDQAXE_PLUSPLUS',
    # Larger configurations
    ('BM1370', 6): 'NERDOCTAXE',
    ('BM1370', 8): 'NERDOCTAXE',
}

# ESP-Miner type keys (for checking if a miner supports ESP-Miner API)
ESP_MINER_TYPES = {
    'BITAXE', 'BITAXE_MAX', 'BITAXE_ULTRA', 'BITAXE_SUPRA', 'BITAXE_GAMMA',
    'NERDAXE', 'NERDQAXE_PLUS', 'NERDQAXE_PLUSPLUS', 'NERDOCTAXE', 'LUCKYMINER'
}

def is_esp_miner(miner_type: str) -> bool:
    """Check if a miner type is ESP-Miner based (BitAxe, NerdQAxe, etc.)"""
    # Check by type key
    if miner_type in ESP_MINER_TYPES:
        return True
    # Check by display name (for backwards compatibility)
    miner_upper = miner_type.upper()
    return any(name in miner_upper for name in ['BITAXE', 'NERDAXE', 'NERDQAXE', 'NERDOCTAXE', 'LUCKYMINER'])

def get_thermal_profile_key(miner_type: str) -> str:
    """Get the thermal profile key for a miner type"""
    miner_upper = miner_type.upper()

    # NerdQAxe family (multi-chip) - check most specific first
    if 'NERDOCTAXE' in miner_upper or 'OCTAXE' in miner_upper:
        return 'NerdOctaxe'
    if 'NERDQAXE++' in miner_upper or 'QAXE++' in miner_upper:
        return 'NerdQAxePP'
    if 'NERDQAXE' in miner_upper or 'QAXE' in miner_upper:
        return 'NerdQAxe'
    if 'NERDAXE' in miner_upper:
        return 'NerdAxe'

    # BitAxe family - check most specific first
    if 'HEX' in miner_upper:
        return 'BitAxeHex'
    if 'GAMMA' in miner_upper or 'BM1370' in miner_upper:
        return 'BitAxeGamma'
    if 'SUPRA' in miner_upper or 'BM1368' in miner_upper:
        return 'BitAxeSupra'
    if 'ULTRA' in miner_upper or 'BM1366' in miner_upper:
        return 'BitAxeUltra'
    if 'MAX' in miner_upper or 'BM1397' in miner_upper:
        return 'BitAxeMax'
    if 'BITAXE' in miner_upper:
        return 'BitAxe'

    # LuckyMiner
    if 'LUCKYMINER' in miner_upper or 'LUCKY' in miner_upper:
        return 'LuckyMiner'

    # Traditional ASIC miners
    if 'ANTMINER' in miner_upper:
        return 'Antminer'
    if 'WHATSMINER' in miner_upper:
        return 'Whatsminer'

    # Avalon - check specific models first
    if 'NANO3S' in miner_upper or 'NANO 3S' in miner_upper:
        return 'AvalonNano3s'
    if 'AVALON' in miner_upper:
        return 'Avalon'

    return 'Unknown'
