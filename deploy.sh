#!/bin/bash

# Deployment script for EC2
# This script pulls code from main branch, builds the app, and restarts PM2

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
BRANCH="main"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PM2_APP_NAME="polymarket-ab"
TARGET=${1:-""}

# Logging function
log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
    exit 1
}

warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

# Handle PM2-only restart: ./deploy app
if [ "$TARGET" = "app" ]; then
    if ! command -v pm2 &> /dev/null; then
        error "pm2 is not installed. Please install pm2 first."
    fi

    log "PM2 restart requested (./deploy app)..."
    log "Restarting PM2 app: $PM2_APP_NAME"

    if pm2 restart "$PM2_APP_NAME"; then
        log "PM2 app restarted successfully"
        exit 0
    else
        error "Failed to restart PM2 app: $PM2_APP_NAME. Check pm2 list and try again."
    fi
fi

# Check if git and pm2 are available
if ! command -v git &> /dev/null; then
    error "git is not installed. Please install git first."
fi

if ! command -v pm2 &> /dev/null; then
    error "pm2 is not installed. Please install pm2 first."
fi

if ! command -v node &> /dev/null || ! command -v npm &> /dev/null; then
    error "node and npm are required. Please install them first."
fi

log "Starting deployment process..."
log "Project directory: $PROJECT_DIR"
log "Branch: $BRANCH"

# Step 1: Check current branch and status
log "Step 1: Checking git status..."
cd "$PROJECT_DIR"

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
log "Current branch: $CURRENT_BRANCH"

if [ -n "$(git status --porcelain)" ]; then
    warning "You have uncommitted changes. They will be stashed."
    read -p "Continue? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        error "Deployment cancelled by user"
    fi
    git stash
    log "Uncommitted changes stashed"
fi

# Step 2: Pull latest code from main branch
log "Step 2: Pulling latest code from $BRANCH branch..."
git fetch origin

# Check if we need to switch branch
if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
    log "Switching to $BRANCH branch..."
    git checkout "$BRANCH"
fi

# Pull latest changes
git pull origin "$BRANCH"
log "Code updated successfully"
log "Latest commit: $(git rev-parse --short HEAD)"
log "Commit message: $(git log -1 --pretty=%B)"

# Step 3: Install dependencies
log "Step 3: Installing dependencies (npm ci)..."
npm ci

# Step 4: Build application
log "Step 4: Building application..."
npm run build

# Step 5: Restart PM2 application (start if missing)
log "Step 5: Restarting PM2 application..."
if pm2 describe "$PM2_APP_NAME" > /dev/null 2>&1; then
    pm2 restart "$PM2_APP_NAME"
else
    pm2 start ecosystem.config.js --only "$PM2_APP_NAME" --env production
fi

# Step 6: Show status and recent logs
log "Step 6: Deployment completed successfully!"
echo ""
log "PM2 status:"
pm2 status "$PM2_APP_NAME"

echo ""
log "Recent logs (last 20 lines):"
pm2 logs "$PM2_APP_NAME" --lines 20

