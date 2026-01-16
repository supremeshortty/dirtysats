"""
Mock API responses for testing without hardware
"""

# Bitaxe ESP32 API mock responses
BITAXE_SYSTEM_INFO = {
    "hashRate": 1100000000000,  # 1.1 TH/s
    "temp": 65.2,
    "power": 90.5,
    "frequency": 550,
    "fanspeed": 80,
    "ASICModel": "BM1397",
    "boardVersion": "204",
    "runningTime": 86400
}

BITAXE_SYSTEM_INFO_OFFLINE = {
    "error": "Connection timeout"
}

# CGMiner API mock responses
CGMINER_VERSION = {
    "STATUS": [{"STATUS": "S", "When": 1234567890}],
    "VERSION": [{
        "Description": "Antminer S9",
        "CGMiner": "4.10.0",
        "API": "3.7"
    }]
}

CGMINER_SUMMARY = {
    "STATUS": [{"STATUS": "S", "When": 1234567890}],
    "SUMMARY": [{
        "MHS av": 13500000,  # 13.5 TH/s in MH/s
        "Accepted": 1234,
        "Rejected": 5,
        "Hardware Errors": 0,
        "Utility": 123.45,
        "Elapsed": 86400
    }]
}

CGMINER_DEVS = {
    "STATUS": [{"STATUS": "S", "When": 1234567890}],
    "DEVS": [{
        "Temperature": 65.0,
        "Fan Speed In": 3400,
        "Fan Speed Out": 3200,
        "MHS av": 4500000,
        "Status": "Alive"
    }]
}

WHATSMINER_VERSION = {
    "STATUS": [{"STATUS": "S", "When": 1234567890}],
    "VERSION": [{
        "Description": "Whatsminer M30S",
        "CGMiner": "4.11.1",
        "API": "3.7"
    }]
}

# Error responses
TIMEOUT_ERROR = {
    "error": "timeout"
}

CONNECTION_ERROR = {
    "error": "Connection refused"
}
