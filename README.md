# Home Mining Fleet Manager

A production-ready Bitcoin mining fleet management system for home-scale miners on local networks. Supports **Bitaxe**, **Antminer**, **Whatsminer**, **Avalon**, and other ASIC miners with network connectivity.

## Features

### Multi-Miner Support
- **Bitaxe** (ESP32 API)
- **Antminer S9/S19** (CGMiner API)
- **Whatsminer** (CGMiner API)
- **Avalon** (CGMiner API)
- Mixed fleet support (multiple miner types simultaneously)

### Core Capabilities
- **Auto-Discovery**: Fast parallel network scanning (30-60 seconds)
- **Auto-Detection**: Automatic miner type identification
- **Real-Time Monitoring**: Updates every 15 seconds
- **Web Dashboard**: Modern, responsive UI with auto-refresh
- **Data Persistence**: SQLite database for miner list and historical stats
- **REST API**: Full API access for automation

### Dashboard Features
- Total fleet hashrate and power consumption
- Per-miner statistics (hashrate, temperature, power, fan speed)
- Online/offline status monitoring
- Miner type indicators
- Remote restart capability
- Fleet management (add/remove miners)

## Requirements

- **Raspberry Pi** (or any Linux system)
- **Python 3.7+**
- Local network with miners (default: 10.0.0.0/24)
- Miners with network connectivity

## Quick Start

### Installation

```bash
git clone https://github.com/yourusername/home-mining-fleet-manager.git
cd home-mining-fleet-manager
chmod +x install.sh
./install.sh
```

### Running

```bash
# Start the application
chmod +x start.sh
./start.sh

# Or manually:
source venv/bin/activate
python3 app.py
```

### Access Dashboard

Open your browser to: **http://localhost:5000**

Or from another device on your network: **http://<raspberry-pi-ip>:5000**

## Usage

### 1. Discover Miners

Click the **"Discover Miners"** button on the dashboard to scan your network. The system will:
- Scan all IPs in your subnet (default: 10.0.0.0/24)
- Detect miner types automatically
- Display all found miners on the dashboard

Discovery typically takes 30-60 seconds.

### 2. Monitor Fleet

The dashboard automatically refreshes every 5 seconds and shows:
- **Fleet Statistics**: Total miners, online/offline count, total hashrate, power, avg temperature
- **Individual Miners**: Per-miner hashrate, temperature, power, fan speed
- **Miner Types**: Visual indicators for different miner models

### 3. Manage Miners

- **Restart**: Click "Restart" on any miner card to reboot it
- **Remove**: Click "Remove" to delete a miner from the fleet
- **Re-discover**: Run discovery again to find new miners

## Configuration

Edit `config.py` to customize settings:

```python
# Network settings
NETWORK_SUBNET = "10.0.0.0/24"  # Your network subnet
DISCOVERY_TIMEOUT = 2           # Seconds per IP during discovery
DISCOVERY_THREADS = 20          # Parallel discovery threads

# Monitoring
UPDATE_INTERVAL = 15            # Seconds between status updates

# Flask
FLASK_HOST = "0.0.0.0"         # Listen on all interfaces
FLASK_PORT = 5000              # Web server port
```

## API Documentation

### Get All Miners
```bash
GET /api/miners
```
Returns list of all miners with current status.

### Get Fleet Statistics
```bash
GET /api/stats
```
Returns aggregated fleet statistics.

### Discover Miners
```bash
POST /api/discover
Content-Type: application/json

{
  "subnet": "10.0.0.0/24"  # Optional
}
```
Trigger network discovery.

### Restart Miner
```bash
POST /api/miner/<ip>/restart
```
Send restart command to specific miner.

### Delete Miner
```bash
DELETE /api/miner/<ip>
```
Remove miner from fleet.

## Supported Miner Types

### Bitaxe (ESP32 API)
- **Detection**: `/api/system/info` endpoint
- **Features**: Hashrate, temperature, power, fan speed, frequency
- **Actions**: Status monitoring, settings changes, restart

### Antminer/Whatsminer/Avalon (CGMiner API)
- **Detection**: CGMiner JSON-RPC on port 4028
- **Features**: Hashrate, temperature, fan speed, pool stats
- **Actions**: Status monitoring, restart
- **Note**: Power consumption not directly available from API

## Architecture

### Strategy Pattern Design
```
MinerDetector (Factory)
    │
    ├─> BitaxeAPIHandler (ESP32 API)
    └─> CGMinerAPIHandler (CGMiner API)

Each miner has:
    - Miner instance (data)
    - APIHandler (protocol-specific logic)
```

### Key Components
- **`app.py`**: Flask application and FleetManager
- **`miners/`**: Miner type implementations
  - `base.py`: Abstract base class
  - `bitaxe.py`: Bitaxe ESP32 API
  - `cgminer.py`: CGMiner API (Antminer/Whatsminer/Avalon)
  - `detector.py`: Auto-detection factory
- **`database/`**: SQLite operations
- **`templates/`**: Web dashboard HTML
- **`static/`**: CSS and JavaScript

### Parallel Processing
- **Discovery**: ThreadPoolExecutor with 20 workers
- **Monitoring**: Parallel status updates for all miners
- **Speed**: Updates complete fleet in 2-3 seconds

## Troubleshooting

### No miners found during discovery
1. Check network subnet in `config.py`
2. Verify miners are powered on and connected to network
3. Check firewall settings on Raspberry Pi
4. Try accessing miner web interface manually to verify connectivity

### Miner showing offline
1. Verify miner is powered on
2. Check network connectivity
3. Try pinging the miner IP
4. Check miner API is enabled (some miners require API to be enabled)

### Dashboard not loading
1. Check Flask is running: `python3 app.py`
2. Verify port 5000 is not blocked
3. Check browser console for JavaScript errors
4. Try accessing from localhost first: `http://localhost:5000`

### CGMiner API not responding
1. Some miners require enabling the API in settings
2. Verify port 4028 is open
3. Check miner documentation for API configuration

## Testing

Run unit tests:

```bash
source venv/bin/activate
python3 -m pytest tests/
```

Or run individual test files:

```bash
python3 tests/test_miners.py
python3 tests/test_database.py
```

Tests use mock API responses and don't require actual hardware.

## Adding New Miner Types

To add support for a new miner type:

1. Create handler in `miners/your_miner.py`:
```python
from .base import MinerAPIHandler

class YourMinerAPIHandler(MinerAPIHandler):
    def detect(self, ip: str) -> bool:
        # Detection logic

    def get_status(self, ip: str) -> Dict:
        # Return standardized status dict

    # Implement other required methods
```

2. Register in `miners/detector.py`:
```python
self.handlers = [
    (config.MINER_TYPES['BITAXE'], BitaxeAPIHandler()),
    (config.MINER_TYPES['YOUR_MINER'], YourMinerAPIHandler()),
    # ...
]
```

3. Add to `config.py`:
```python
MINER_TYPES = {
    'YOUR_MINER': 'Your Miner',
    # ...
}
```

## Performance

- **Discovery**: 30-60 seconds for 254 IPs (10.0.0.0/24)
- **Monitoring**: 2-3 seconds to update all miners
- **Dashboard Refresh**: Every 5 seconds (configurable)
- **Background Updates**: Every 15 seconds (configurable)

## Security Considerations

- **Local Network Only**: Designed for home networks, not exposed to internet
- **No Authentication**: Add reverse proxy with auth if needed
- **API Access**: No rate limiting by default
- **Database**: SQLite file - backup regularly for data persistence

## Database Schema

### Miners Table
```sql
- id: INTEGER PRIMARY KEY
- ip: TEXT UNIQUE
- miner_type: TEXT
- model: TEXT
- discovered_at: TIMESTAMP
- last_seen: TIMESTAMP
```

### Stats Table
```sql
- id: INTEGER PRIMARY KEY
- miner_id: INTEGER
- timestamp: TIMESTAMP
- hashrate: REAL
- temperature: REAL
- power: REAL
- fan_speed: INTEGER
- status: TEXT
```

## Contributing

This project follows simple, maintainable design principles:
- Keep handlers isolated and testable
- Use parallel processing for network operations
- Graceful error handling (offline miners shouldn't crash the app)
- Test before committing

## License

MIT License - See LICENSE file for details

## Roadmap

### Phase 2 (Future)
- [ ] Auto-tuning (temperature-based frequency adjustment)
- [ ] Scheduling (time-based mining on/off)
- [ ] Energy monitoring (cost tracking)
- [ ] Pool configuration management
- [ ] Email/Telegram alerts
- [ ] Historical charts
- [ ] Export data (CSV/JSON)

### Phase 3 (Future)
- [ ] Multi-subnet support
- [ ] Authentication/authorization
- [ ] Mobile app
- [ ] Cloud sync
- [ ] Advanced analytics

## Support

For issues, feature requests, or questions:
- Open an issue on GitHub
- Check troubleshooting section above
- Review miner-specific documentation

## Acknowledgments

Built for the home mining community. Supports any wall-outlet powered Bitcoin ASIC miner.

**Philosophy**: "Working and simple beats feature-rich and broken"