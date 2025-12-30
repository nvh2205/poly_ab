#!/bin/bash
# Setup script for Python virtual environment

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/venv"
ACTIVATE_SCRIPT="$VENV_DIR/bin/activate"

echo "=========================================="
echo "Python Virtual Environment Setup"
echo "=========================================="

# Check if venv already exists
if [ -d "$VENV_DIR" ]; then
    echo "✓ Virtual environment already exists at: $VENV_DIR"
else
    echo "Creating virtual environment..."
    python3 -m venv "$VENV_DIR"
    echo "✓ Virtual environment created at: $VENV_DIR"
fi

# Activate venv
echo ""
echo "Activating virtual environment..."
source "$ACTIVATE_SCRIPT"

# Upgrade pip
echo "Upgrading pip..."
pip install --upgrade pip > /dev/null 2>&1 || pip install --upgrade pip
echo "✓ pip upgraded"

# Install requirements
echo ""
echo "Installing Python dependencies..."
if [ -f "$SCRIPT_DIR/analysis/requirements.txt" ]; then
    pip install -r "$SCRIPT_DIR/analysis/requirements.txt"
    echo "✓ Dependencies installed"
else
    echo "⚠ Warning: requirements.txt not found at analysis/requirements.txt"
fi

echo ""
echo "=========================================="
echo "Setup Complete!"
echo "=========================================="
echo ""
echo "To activate the virtual environment in the future, run:"
echo "  source $VENV_DIR/bin/activate"
echo ""
echo "Or use the activate script:"
echo "  source $SCRIPT_DIR/activate.sh"
echo ""
echo "To deactivate, run:"
echo "  deactivate"
echo ""

