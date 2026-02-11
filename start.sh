#!/bin/bash
# Start script for DirtySats - Bitcoin Mining Fleet Manager

# Activate virtual environment
source venv/bin/activate

# Start the application
echo "Starting DirtySats..."
echo "Dashboard will be available at: http://localhost:5001"
echo "Press Ctrl+C to stop"
echo ""

python3 app.py
