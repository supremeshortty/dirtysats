#!/bin/bash
# Deploy DirtySats to Raspberry Pi
# Usage: ./deploy-to-pi.sh [pi-ip] [pi-username]

PI_IP="${1:-10.0.0.12}"
PI_USER="${2:-pi}"
PI_HOST="$PI_USER@$PI_IP"
INSTALL_DIR="/home/$PI_USER/home-mining-fleet-manager-main"

echo "========================================="
echo "DirtySats Deployment to Raspberry Pi"
echo "========================================="
echo "Target: $PI_HOST"
echo "Install Dir: $INSTALL_DIR"
echo ""

# Check if Pi is reachable
echo "🔍 Checking if Pi is reachable..."
if ! ping -c 1 $PI_IP > /dev/null 2>&1; then
    echo "❌ Error: Cannot reach $PI_IP"
    exit 1
fi
echo "✅ Pi is reachable"
echo ""

# Test SSH connection
echo "🔍 Testing SSH connection..."
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes $PI_HOST "echo 'SSH OK'" 2>/dev/null | grep -q "SSH OK"; then
    echo "⚠️  SSH key authentication not set up"
    echo "You'll be prompted for password for each command"
    echo ""
fi

# Stop the existing service
echo "🛑 Stopping existing DirtySats service..."
ssh $PI_HOST "sudo systemctl stop fleet-manager 2>/dev/null || pkill -f 'python.*app.py' || true"
echo "✅ Service stopped"
echo ""

# Pull latest code
echo "📥 Pulling latest code from GitHub..."
ssh $PI_HOST "cd $INSTALL_DIR && git fetch origin && git reset --hard origin/main"
echo "✅ Code updated"
echo ""

# Install/update dependencies (if needed)
echo "📦 Checking Python dependencies..."
ssh $PI_HOST "cd $INSTALL_DIR && source venv/bin/activate && pip install -q -r requirements.txt 2>/dev/null || true"
echo "✅ Dependencies checked"
echo ""

# Restart the service
echo "🚀 Starting DirtySats service..."
ssh $PI_HOST "sudo systemctl restart fleet-manager 2>/dev/null || (cd $INSTALL_DIR && source venv/bin/activate && nohup python3 app.py > /tmp/dirtysats.log 2>&1 &)"
sleep 3
echo "✅ Service started"
echo ""

# Check if it's running
echo "🔍 Verifying service status..."
if ssh $PI_HOST "curl -s http://localhost:5001/ | head -1" | grep -q "DOCTYPE"; then
    echo "✅ Dashboard is running!"
    echo ""
    echo "========================================="
    echo "✅ DEPLOYMENT SUCCESSFUL!"
    echo "========================================="
    echo ""
    echo "Dashboard accessible at:"
    echo "  http://$PI_IP:5001"
    echo ""
    echo "From any device on your network:"
    echo "  http://$PI_IP:5001"
    echo ""
    echo "To check logs:"
    echo "  ssh $PI_HOST 'tail -f /tmp/dirtysats.log'"
    echo ""
    echo "To check service status:"
    echo "  ssh $PI_HOST 'sudo systemctl status fleet-manager'"
    echo ""
else
    echo "⚠️  Warning: Service may not be running correctly"
    echo "Check logs with: ssh $PI_HOST 'tail -100 /tmp/dirtysats.log'"
fi
