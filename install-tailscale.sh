#!/bin/bash
# Tailscale Installation Script for Raspberry Pi
# Provides secure remote access to your mining dashboard

set -e

echo "=================================="
echo "Tailscale Installation for DirtySats"
echo "=================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running on Raspberry Pi
if [ ! -f /etc/rpi-issue ]; then
    echo -e "${YELLOW}Warning: This doesn't appear to be a Raspberry Pi${NC}"
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

echo "Step 1: Installing Tailscale..."
echo "================================"
echo ""

# Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh

echo ""
echo -e "${GREEN}✓ Tailscale installed successfully${NC}"
echo ""

echo "Step 2: Starting Tailscale..."
echo "================================"
echo ""
echo "This will open a browser window or show you a URL."
echo "You'll need to authenticate with your Google, Microsoft, or GitHub account."
echo ""
read -p "Press Enter to continue..."

# Start Tailscale and authenticate
sudo tailscale up

echo ""
echo -e "${GREEN}✓ Tailscale is now running${NC}"
echo ""

# Get Tailscale IP
TAILSCALE_IP=$(tailscale ip -4)

echo "=================================="
echo "Installation Complete!"
echo "=================================="
echo ""
echo -e "${GREEN}Your Tailscale IP: ${TAILSCALE_IP}${NC}"
echo ""
echo "Next Steps:"
echo "1. Install Tailscale on your phone/computer:"
echo "   - iOS/Android: Download 'Tailscale' from App Store/Play Store"
echo "   - Mac: brew install --cask tailscale"
echo "   - Windows: Download from https://tailscale.com/download"
echo ""
echo "2. Sign in with the SAME account you just used"
echo ""
echo "3. Access your mining dashboard from anywhere:"
echo -e "   ${GREEN}http://${TAILSCALE_IP}:5001${NC}"
echo ""
echo "4. (Optional) Set up a machine name for easier access:"
echo "   sudo tailscale set --hostname mining-dashboard"
echo "   Then access via: http://mining-dashboard:5001"
echo ""
echo "=================================="
echo ""

# Ask if they want to set a hostname
read -p "Would you like to set a friendly hostname now? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    read -p "Enter hostname (e.g., mining-dashboard): " HOSTNAME
    sudo tailscale set --hostname "$HOSTNAME"
    echo ""
    echo -e "${GREEN}✓ Hostname set to: ${HOSTNAME}${NC}"
    echo -e "You can now access via: ${GREEN}http://${HOSTNAME}:5001${NC}"
    echo ""
fi

echo "Useful Commands:"
echo "  tailscale status    - Check Tailscale status"
echo "  tailscale ip        - Show your Tailscale IP"
echo "  tailscale up        - Start Tailscale"
echo "  tailscale down      - Stop Tailscale"
echo ""
echo -e "${GREEN}Setup complete! Enjoy remote access to your mining fleet.${NC}"
