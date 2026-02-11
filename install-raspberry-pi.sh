#!/bin/bash
# Raspberry Pi Installation and Setup Script for DirtySats
# This script will install and configure the fleet manager to run as a system service

set -e

echo "========================================="
echo "DirtySats - Raspberry Pi Setup"
echo "========================================="
echo ""

# Check if running on Linux
if [[ "$OSTYPE" != "linux-gnu"* ]]; then
    echo "Warning: This script is designed for Raspberry Pi (Linux)"
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Get installation directory
INSTALL_DIR="$HOME/home-mining-fleet-manager"
if [ -d "$INSTALL_DIR" ]; then
    echo "Installation directory already exists: $INSTALL_DIR"
    read -p "Continue with existing directory? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
else
    echo "Installation directory: $INSTALL_DIR"
fi

# Check Python version
echo "[1/8] Checking Python version..."
python3 --version || {
    echo "Error: Python 3 is required but not found"
    echo "Install with: sudo apt update && sudo apt install python3 python3-venv python3-pip"
    exit 1
}

# Create installation directory if needed
echo "[2/8] Setting up directory..."
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Copy files if running from different location
if [ "$PWD" != "$(dirname "$(readlink -f "$0")")" ]; then
    echo "Copying files to $INSTALL_DIR..."
    cp -r "$(dirname "$(readlink -f "$0")")"/* "$INSTALL_DIR/"
fi

# Create logs directory
echo "[3/8] Creating logs directory..."
mkdir -p logs

# Create virtual environment
echo "[4/8] Creating virtual environment..."
if [ ! -d "venv" ]; then
    python3 -m venv venv
    echo "Virtual environment created"
else
    echo "Virtual environment already exists"
fi

# Activate virtual environment
echo "[5/8] Installing dependencies..."
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

# Initialize database
echo "[6/8] Initializing database..."
python3 -c "from database import Database; import config; Database(config.DATABASE_PATH)" || echo "Database already exists"

# Install systemd service
echo "[7/8] Installing systemd service..."
SERVICE_FILE="fleet-manager.service"
TEMP_SERVICE="/tmp/fleet-manager.service"

# Replace placeholders in service file with actual values
sed "s|__INSTALL_DIR__|$INSTALL_DIR|g" "$SERVICE_FILE" > "$TEMP_SERVICE"
sed -i "s|__USER__|$USER|g" "$TEMP_SERVICE"

sudo cp "$TEMP_SERVICE" /etc/systemd/system/fleet-manager.service
sudo systemctl daemon-reload
sudo systemctl enable fleet-manager.service

echo "[8/8] Setting up log rotation..."
sudo tee /etc/logrotate.d/fleet-manager > /dev/null <<EOF
$INSTALL_DIR/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 0644 $USER $USER
}
EOF

echo ""
echo "========================================="
echo "Installation Complete!"
echo "========================================="
echo ""
echo "The fleet manager is now installed as a system service."
echo ""
echo "Useful commands:"
echo "  Start service:    sudo systemctl start fleet-manager"
echo "  Stop service:     sudo systemctl stop fleet-manager"
echo "  Restart service:  sudo systemctl restart fleet-manager"
echo "  Check status:     sudo systemctl status fleet-manager"
echo "  View logs:        sudo journalctl -u fleet-manager -f"
echo "  View app logs:    tail -f $INSTALL_DIR/logs/fleet-manager.log"
echo ""
echo "The service will automatically start on boot."
echo ""
echo "Access the dashboard at: http://$(hostname -I | awk '{print $1}'):5001"
echo ""
echo "Starting the service now..."
sudo systemctl start fleet-manager

echo ""
echo "Checking service status..."
sleep 2
sudo systemctl status fleet-manager --no-pager
echo ""
echo "Setup complete! The fleet manager is now running."
