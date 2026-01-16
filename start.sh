#!/bin/bash
# Start script for Home Mining Fleet Manager

# Activate virtual environment
source venv/bin/activate

# Start the application
echo "Starting Home Mining Fleet Manager..."
echo "Dashboard will be available at: http://localhost:5000"
echo "Press Ctrl+C to stop"
echo ""

python3 app.py
