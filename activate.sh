#!/bin/bash
# Quick activation script for virtual environment

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/venv"
ACTIVATE_SCRIPT="$VENV_DIR/bin/activate"

if [ ! -d "$VENV_DIR" ]; then
    echo "Error: Virtual environment not found at $VENV_DIR"
    echo "Please run ./setup_venv.sh first"
    exit 1
fi

source "$ACTIVATE_SCRIPT"
echo "✓ Virtual environment activated"
echo "Current Python: $(which python)"
echo "Current pip: $(which pip)"
echo ""
echo "To deactivate, run: deactivate"

