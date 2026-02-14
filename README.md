<p align="center">
  <img src="static/logo.png" alt="DirtySats Logo" width="400">
</p>

<p align="center">
  <strong>Bitcoin Mining Fleet Manager</strong><br>
  <em>Stack sats, track stats</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Status-Active-brightgreen" alt="Status">
  <img src="https://img.shields.io/badge/Python-3.10+-blue" alt="Python">
  <img src="https://img.shields.io/badge/License-MIT-yellow" alt="License">
</p>

---

A production-ready Bitcoin mining fleet management dashboard for home-scale miners. Monitor, optimize, and manage your mining operation with real-time data, energy cost tracking, and profitability analysis.

## Features

### Fleet Management
- **Auto-Discovery**: Fast parallel network scanning finds all miners in 30-60 seconds
- **Multi-Miner Support**: Bitaxe, NerdQAxe, Antminer, Whatsminer, Avalon, and more
- **Real-Time Monitoring**: Live updates every 5 seconds with auto-refresh
- **Miner Groups**: Organize miners by location (Garage, Office, etc.)
- **Remote Control**: Restart miners, adjust frequency, control fan speeds
- **Custom Naming**: Rename miners for easy identification

### Energy & Profitability
- **Live Profitability**: Real-time profit/loss calculations based on your energy rates
- **Time-of-Use (TOU) Rates**: Support for peak/off-peak electricity pricing
- **OpenEI Integration**: Search and apply official utility rates from the OpenEI database
- **Energy Consumption Tracking**: Historical kWh usage with cost breakdowns
- **Break-Even Calculator**: See the BTC price needed to break even
- **Key Metrics**:
  - Sats/kWh (mining efficiency)
  - $/TH/day (hosting cost comparison)
  - J/TH (energy efficiency)

### Automated Mining Control
- **Peak Hour Management**: Automatically turn off or reduce power during expensive electricity
- **Off-Peak Optimization**: Run at maximum power when electricity is cheapest
- **Rate Threshold Override**: Emergency shutoff when rates exceed your limit
- **Visual Controls**: Easy radio-button interface with frequency sliders

### Strategy Optimizer
- Compare mining strategies based on your actual energy rates:
  - **Off-Peak Only**: Mine only during cheapest hours
  - **Conservative**: Turn off during peak, reduce otherwise
  - **24/7 Maximum**: Full power all day
  - **Smart Scheduling**: Reduce during peak, maximize during off-peak
- One-click apply for any strategy

### Charts & Analytics
- **Fleet Performance**: Combined hashrate and temperature over time
- **Power Consumption**: Historical power usage graphs
- **Profitability Trend**: Daily profit/loss visualization
- **Mining Efficiency**: J/TH tracking over time
- **Share Statistics**: Accepted vs rejected shares
- **Energy History**: kWh consumption with cost breakdown

### Alerts & Notifications
- **Telegram Integration**: Get alerts on your phone
- **Overheat Warnings**: Automatic notifications when miners run hot
- **Offline Detection**: Know immediately when a miner goes down
- **Auto-Recovery**: Automatic reboot when miners cool down after overheating

### Remote Access
- **Tailscale Integration**: Securely access your dashboard from anywhere in the world
- **No Port Forwarding**: Zero router configuration needed
- **End-to-End Encrypted**: Secure VPN connection between your devices
- **Works on Cellular**: Check your miners from anywhere with internet
- **Mobile Friendly**: Access from iPhone, Android, or any device
- **Free for Personal Use**: Up to 100 devices on free tier

### Pool Directory & Configuration
- **Pool Directory**: Browse 47+ mining pools with fees, payout methods, and status
- **Smart Pool Config**: Auto-formats pool URLs per miner type (Bitaxe, NerdQAxe, CGMiner)
- **Per-Miner Pool Management**: Configure primary and fallback pools for each miner
- **Draft Preservation**: Edit pool settings without losing changes during auto-refresh

### Additional Features
- **Solo Mining Odds**: Calculate your chance of finding a block
- **Data Export**: Export miners, history, and profitability data (CSV/JSON)
- **Dark/Light Theme**: Toggle between visual modes
- **Mobile Responsive**: Full responsive layout for phones, tablets, and desktop
- **Lightning Donations**: Support development via Lightning Network
- **Optional Authentication**: Enable HTTP Basic Auth via environment variables

## Supported Miners

### ESP-Miner Devices (Full Support)
- **BitAxe** (Ultra, Supra, Gamma, Max)
- **NerdQAxe** / **NerdQAxe++**
- **NerdAxe**
- **Hex**
- Other ESP32-based miners

### CGMiner Devices (Full Support)
- **Avalon Nano 3S** (A3197S chip) - Full thermal management with 75°C target temp
- **Antminer** S9, S19, etc.
- **Whatsminer** M30, M50, etc.
- **Avalon** miners (traditional large models)
- Any miner with CGMiner API on port 4028

## Requirements

- **Python 3.10+**
- **Local network** with miners
- **Optional**: OpenEI API key for utility rate lookup

## Quick Start

### Option 1: Raspberry Pi (Recommended for 24/7 Operation)

Perfect for running continuously without keeping your computer on.

#### 1. Flash SD Card (New Raspberry Pi)

**Download Raspberry Pi Imager:**
- Mac/PC: https://www.raspberrypi.com/software/
- Or use command: `brew install --cask raspberry-pi-imager` (Mac)

**Flash the SD card:**
1. Insert SD card into your computer (16GB+ recommended)
2. Open Raspberry Pi Imager
3. Click **"Choose Device"** → Select your Raspberry Pi model (Pi 3, 4, or 5)
4. Click **"Choose OS"** → Select "Raspberry Pi OS (64-bit)" recommended
5. Click **"Choose Storage"** → Select your SD card
6. Click **"Next"** → Click **"Edit Settings"**

**Configure settings (IMPORTANT):**
- **General Tab:**
  - Set hostname: `raspberrypi` (or your choice)
  - Set username and password (remember these!)
  - Configure WiFi SSID and password
  - Set locale settings (timezone, keyboard)
- **Services Tab:**
  - ✅ Enable SSH
  - Use password authentication
- Click **"Save"** → Click **"Yes"** to apply settings
- Click **"Yes"** to erase and write to SD card

**Wait for completion** (5-10 minutes), then eject the SD card.

#### 2. Boot Raspberry Pi

1. Insert SD card into Raspberry Pi
2. Connect power supply
3. Wait 1-2 minutes for first boot
4. Pi will automatically connect to WiFi

#### 3. Find Your Raspberry Pi's IP Address

**From your Mac/PC terminal:**
```bash
# Method 1: Try default hostname
ping raspberrypi.local

# Method 2: Scan your network
nmap -sn 192.168.1.0/24  # Adjust subnet to match your network

# Method 3: Check your router's DHCP client list
```

#### 4. Transfer Files to Raspberry Pi

**Clone or download this repository on your Mac/PC, then:**

```bash
# Navigate to the project directory
cd /path/to/dirtysats

# Transfer files to Pi (replace with your Pi's IP)
scp -r * username@your-pi-ip:~/home-mining-fleet-manager
```

#### 5. Install on Raspberry Pi

**SSH into your Pi:**
```bash
ssh username@your-pi-ip
```

**Run the installation script:**
```bash
cd ~/home-mining-fleet-manager
./install-raspberry-pi.sh
```

The script will:
- ✅ Install Python dependencies
- ✅ Create virtual environment
- ✅ Initialize database
- ✅ Set up systemd service
- ✅ Enable auto-start on boot
- ✅ Configure log rotation
- ✅ Start the service

**That's it!** The fleet manager is now running 24/7.

#### 6. Access Your Dashboard

From any device on your network:
```
http://your-pi-ip:5001
```

#### Managing the Service

```bash
# Check status
sudo systemctl status fleet-manager

# View live logs
sudo journalctl -u fleet-manager -f

# Restart service
sudo systemctl restart fleet-manager

# Stop service
sudo systemctl stop fleet-manager
```

### Option 2: Laptop/Desktop (Quick Testing)

For running on your Mac/PC (not 24/7).

**Installation:**

```bash
git clone https://github.com/supremeshortty/dirtysats.git
cd dirtysats
pip install -r requirements.txt
```

**Running:**

```bash
python3 app.py
```

**Access Dashboard:**

Open your browser to: **http://localhost:5001**

Or from another device: **http://<your-ip>:5001**

## Updating Your Raspberry Pi

After making changes to the code on your development machine, push updates to your Pi:

### Setup Credentials (One-Time)

```bash
cd /path/to/dirtysats
cp pi-config.sh.template pi-config.sh
nano pi-config.sh  # Add your Pi's credentials
```

**Your `pi-config.sh` will contain:**
```bash
PI_USER="your_username"
PI_HOST="your_pi_ip"
PI_PASSWORD="your_password"
PI_DIR="~/home-mining-fleet-manager"
```

**🔒 Security Note:** `pi-config.sh` is excluded from git and will never be committed to GitHub.

### Push Updates

**Update Pi from your Mac/PC:**
```bash
./update-pi.sh
```

This will:
- Transfer all files to the Pi
- Update dependencies if needed
- Restart the service
- Verify it's running

See `UPDATE_WORKFLOW.md` for detailed update instructions.

## Configuration

Edit `config.py` to customize:

```python
# Network
NETWORK_SUBNET = "10.0.0.0/24"    # Your network subnet
DISCOVERY_TIMEOUT = 2             # Seconds per IP
DISCOVERY_THREADS = 20            # Parallel scan threads

# Monitoring
UPDATE_INTERVAL = 30              # Seconds between updates

# Flask
FLASK_HOST = "0.0.0.0"
FLASK_PORT = 5001

# Thermal Management
OVERHEAT_AUTO_REBOOT = True       # Auto-reboot after cooldown
OVERHEAT_RECOVERY_TEMP = 38       # Temperature to trigger reboot

# OpenEI (optional - for utility rate lookup)
OPENEI_API_KEY = "your-api-key"   # Get free key at openei.org
```

## Dashboard Tabs

### Fleet Tab
- Fleet statistics (miners, hashrate, shares, efficiency)
- Performance chart with hashrate and temperature
- Miner cards with live stats and controls
- Group filtering and selection mode

### Energy Tab
- **Utility Rate Configuration**: Search OpenEI or enter rates manually
- **Current Status**: Period indicator, current rate, energy/cost today
- **Energy Consumption History**: Bar chart with daily/weekly/monthly views
- **Profitability**: Complete breakdown with all key metrics
- **Rate Schedule**: View your configured TOU rates
- **Automated Mining Control**: Set up automatic frequency adjustments
- **Strategy Optimizer**: Compare and apply mining strategies

### Charts Tab
- Historical data visualization
- Multiple chart types with time range selectors
- Export functionality

### Alerts Tab
- Telegram bot configuration
- Alert history

### Pools Tab
- Per-miner pool configuration with primary/fallback pools
- Pool Directory with 47+ pools, filterable by status, fees, and payout method
- Smart URL formatting per miner type

## API Endpoints

### Fleet Management
```
GET  /api/miners              # List all miners
GET  /api/stats               # Fleet statistics
POST /api/discover            # Scan network for miners
POST /api/miner/<ip>/restart  # Restart a miner
DELETE /api/miner/<ip>        # Remove a miner
```

### Energy & Profitability
```
GET  /api/energy/rates              # Current rate schedule
POST /api/energy/rates              # Apply rate preset
GET  /api/energy/profitability      # Current profitability
GET  /api/energy/consumption/actual # Actual energy consumption
```

### History & Analytics
```
GET /api/history/hashrate?hours=24    # Hashrate history
GET /api/history/temperature?hours=24 # Temperature history
GET /api/history/power?hours=24       # Power history
```

### Export
```
GET /api/export/miners?format=csv
GET /api/export/history?format=csv
GET /api/export/profitability?format=csv
```

## Architecture

```
DirtySats/
├── app.py                   # Flask app, API routes, FleetManager
├── config.py                # Configuration settings
├── energy.py                # Energy rate management & profitability
├── alerts.py                # Alert system & notifications
├── thermal.py               # Thermal management & auto-recovery
├── metrics.py               # Historical metrics & analytics
├── pool_manager.py          # Pool detection & configuration
├── lightning.py             # Lightning Network donations (LNBits)
├── telegram_setup_helper.py # Telegram bot setup wizard
├── requirements.txt         # Python dependencies
├── database/
│   └── db.py                # SQLite operations & schema
├── miners/
│   ├── base.py              # Abstract base class
│   ├── bitaxe.py            # ESP-Miner API handler (Bitaxe, NerdQAxe, etc.)
│   ├── cgminer.py           # CGMiner API handler (Antminer, Whatsminer, Avalon)
│   └── detector.py          # Auto-detection factory
├── templates/
│   └── dashboard.html       # Main dashboard template
├── static/
│   ├── script.js            # Frontend JavaScript
│   ├── style.css            # Styling (responsive, dark/light themes)
│   ├── mining_pools.json    # Pool directory data (47+ pools)
│   └── logo.png             # DirtySats logo
└── tests/
    ├── test_miners.py       # Miner handler tests
    ├── test_database.py     # Database tests
    └── mock_responses.py    # Test fixtures
```

## Recent Updates

### Responsive Layout & Mobile Support
- Full responsive design for mobile, tablet, and desktop
- Sidebar auto-hides on narrow screens, content uses full width
- Scrollable tab navigation on small screens

### Security & Stability Audit
- XSS protection across miner cards, alerts, pool config, and group modals
- Optional HTTP Basic Auth (set `DIRTYSATS_USERNAME` and `DIRTYSATS_PASSWORD` env vars)
- Thread-safe monitoring startup, capped thread pools
- Hardened JSON parsing across all API endpoints
- Pool credential redaction in API responses
- Test endpoints gated behind `ENABLE_TEST_ENDPOINTS` env var

### Pool Configuration Improvements
- Smart URL formatting per miner type (Bitaxe expects full stratum URL, NerdQAxe expects host-only)
- Draft preservation during auto-refresh — form fields hold focus while editing
- Pool Directory with 47+ pools, sortable and filterable

### Avalon Nano 3S Support
- Full CGMiner API support with null byte parsing fix
- Accurate stats parsing: temperature, fan speed, power, chip type (A3197S)
- Custom thermal profile optimized for 75°C target temperature
- Proper auto-detection instead of generic "Antminer" label

## Documentation

Detailed guides available:

- **[RASPBERRY_PI_SETUP.md](RASPBERRY_PI_SETUP.md)** - Complete Raspberry Pi setup and management guide
- **[UPDATE_WORKFLOW.md](UPDATE_WORKFLOW.md)** - How to keep your Pi updated with latest code
- **[SECURITY.md](SECURITY.md)** - Security best practices and credential management
- **[CREDENTIALS_SETUP.md](CREDENTIALS_SETUP.md)** - Setting up secure credential configuration
- **[QUICK_REFERENCE.md](QUICK_REFERENCE.md)** - Quick command reference
- **[QUICKSTART.md](QUICKSTART.md)** - 5-minute quick start guide
- **[TELEGRAM_SETUP.md](TELEGRAM_SETUP.md)** - Setting up Telegram alerts
- **[TAILSCALE_SETUP.md](TAILSCALE_SETUP.md)** - Remote access setup with Tailscale VPN
- **[POOL_CONFIGURATION_GUIDE.md](POOL_CONFIGURATION_GUIDE.md)** - Pool setup and configuration guide
- **[SPONSORS.md](SPONSORS.md)** - Project sponsors and supporters

## Troubleshooting

### No miners found
1. Verify network subnet in `config.py`
2. Check miners are powered on and connected
3. Try pinging miner IPs manually
4. Ensure no firewall blocking ports 80/4028

### Avalon Nano 3S not detected
1. Ensure miner is connected to the same network
2. Try accessing miner web interface (should show QR code for Avalon Family app)
3. CGMiner API runs on port 4028 (should be accessible automatically)
4. After scanning, remove and re-scan if it shows as generic "Antminer"

### Miner showing offline
1. Check physical connection
2. Verify miner web interface is accessible
3. Restart the miner
4. Check API is enabled (some miners require this)

### Energy rates not working
1. Get a free API key from [OpenEI](https://openei.org/services/api/signup)
2. Add key to `config.py` or environment variable
3. Or use manual rate entry instead

### Dashboard slow/unresponsive
1. Reduce number of miners polled
2. Increase UPDATE_INTERVAL in config
3. Check network latency to miners

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Submit a pull request

## License

MIT License - See LICENSE file

## Support Development

If DirtySats helps your mining operation, consider supporting development:

- **Lightning**: Via the Donate button in the dashboard
- **GitHub**: Star the repository

## Acknowledgments

Built for the home mining community. Special thanks to the BitAxe and open-source mining communities.

---

**DirtySats** - *Stack sats, track stats*
