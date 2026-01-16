# Quick Start Guide

## 5-Minute Setup

### 1. Install
```bash
git clone <your-repo-url>
cd home-mining-fleet-manager
./install.sh
```

### 2. Start
```bash
./start.sh
```

### 3. Access
Open browser: **http://localhost:5000**

### 4. Discover
Click **"Discover Miners"** button

### 5. Monitor
Dashboard auto-refreshes - you're done!

---

## What You'll See

### Dashboard Displays:
- **Total Miners**: How many miners detected
- **Online/Offline**: Status counts
- **Total Hashrate**: Combined hashing power
- **Total Power**: Combined power consumption
- **Avg Temperature**: Fleet average

### Per-Miner Cards:
- Miner type (Bitaxe, Antminer, etc.)
- IP address
- Hashrate
- Temperature
- Power consumption
- Fan speed
- Restart/Remove buttons

---

## Common Configurations

### Change Network Subnet
Edit `config.py`:
```python
NETWORK_SUBNET = "192.168.1.0/24"  # Change to your network
```

### Change Update Speed
Edit `config.py`:
```python
UPDATE_INTERVAL = 10  # Faster updates (seconds)
```

### Access from Other Devices
The dashboard is accessible from any device on your network at:
```
http://<raspberry-pi-ip>:5000
```

Find your Pi's IP with: `hostname -I`

---

## Troubleshooting One-Liners

### Miners not found?
```bash
# Check your network subnet
ip addr show

# Test if miners respond
ping <miner-ip>

# Try Bitaxe API manually
curl http://<bitaxe-ip>/api/system/info

# Try CGMiner API manually (Antminer/Whatsminer)
echo '{"command":"version"}' | nc <miner-ip> 4028
```

### Dashboard not loading?
```bash
# Check if Flask is running
ps aux | grep python

# Check port 5000
netstat -tulpn | grep 5000

# View logs
# (they'll show in terminal where you ran ./start.sh)
```

### Want to reset everything?
```bash
# Stop the app (Ctrl+C)
# Delete database
rm fleet.db

# Restart
./start.sh
# Click "Discover Miners" again
```

---

## Architecture Quick Reference

```
home-mining-fleet-manager/
├── app.py                 # Flask app + FleetManager
├── config.py              # All settings
├── requirements.txt       # Python dependencies
├── install.sh            # Setup script
├── start.sh              # Run script
│
├── miners/               # Miner type handlers
│   ├── base.py          # Abstract interface
│   ├── bitaxe.py        # Bitaxe ESP32 API
│   ├── cgminer.py       # Antminer/Whatsminer/Avalon
│   └── detector.py      # Auto-detection
│
├── database/            # SQLite operations
│   └── db.py
│
├── templates/           # Web UI
│   └── dashboard.html
│
├── static/             # CSS/JS
│   ├── style.css
│   └── script.js
│
└── tests/              # Unit tests
    ├── test_miners.py
    └── test_database.py
```

---

## API Quick Reference

### Get all miners
```bash
curl http://localhost:5000/api/miners
```

### Get fleet stats
```bash
curl http://localhost:5000/api/stats
```

### Discover miners
```bash
curl -X POST http://localhost:5000/api/discover
```

### Restart a miner
```bash
curl -X POST http://localhost:5000/api/miner/10.0.0.100/restart
```

### Delete a miner
```bash
curl -X DELETE http://localhost:5000/api/miner/10.0.0.100
```

---

## Performance Expectations

| Operation | Time |
|-----------|------|
| Discovery (254 IPs) | 30-60 sec |
| Update all miners | 2-3 sec |
| Dashboard refresh | 5 sec |
| Background updates | 15 sec |

---

## Next Steps

- ✅ **Phase 1**: You're done! Monitor your fleet
- 🔜 **Phase 2**: Auto-tuning, scheduling, energy monitoring
- 🔜 **Phase 3**: Advanced features (see README)

---

**Pro Tip**: Keep this terminal open to see real-time logs of what the fleet manager is doing!
