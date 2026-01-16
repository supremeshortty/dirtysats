#!/bin/bash
# Installation script for Home Mining Fleet Manager

set -e

echo "========================================="
echo "Home Mining Fleet Manager - Installation"
echo "========================================="
echo ""

# Check Python version
echo "[1/5] Checking Python version..."
python3 --version || {
    echo "Error: Python 3 is required but not found"
    exit 1
}

# Create virtual environment
echo "[2/5] Creating virtual environment..."
if [ ! -d "venv" ]; then
    python3 -m venv venv
    echo "Virtual environment created"
else
    echo "Virtual environment already exists"
fi

# Activate virtual environment
echo "[3/5] Activating virtual environment..."
source venv/bin/activate

# Install dependencies
echo "[4/5] Installing dependencies..."
pip install --upgrade pip
pip install -r requirements.txt

# Initialize database
echo "[5/5] Initializing database..."
python3 -c "from database import Database; import config; Database(config.DATABASE_PATH)"

echo ""
echo "========================================="
echo "Installation complete!"
echo "========================================="
echo ""
echo "To start the fleet manager:"
echo "  1. Activate virtual environment: source venv/bin/activate"
echo "  2. Run the application: python3 app.py"
echo "  3. Open browser to: http://localhost:5000"
echo ""
echo "Or run directly:"
echo "  ./start.sh"
echo ""
