#!/bin/bash

# Deployment script for EC2
# This script manages Docker Compose services (DB, Redis) and PM2 application

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
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

info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

# Handle PM2-only restart: ./deploy.sh app
if [ "$TARGET" = "app" ]; then
    if ! command -v pm2 &> /dev/null; then
        error "pm2 is not installed. Please install pm2 first."
    fi

    log "PM2 restart requested (./deploy.sh app)..."
    log "Restarting PM2 app: $PM2_APP_NAME"

    if pm2 restart "$PM2_APP_NAME"; then
        log "PM2 app restarted successfully"
        pm2 status "$PM2_APP_NAME"
        exit 0
    else
        error "Failed to restart PM2 app: $PM2_APP_NAME. Check pm2 list and try again."
    fi
fi

# Handle services-only restart: ./deploy.sh services
if [ "$TARGET" = "services" ]; then
    if ! command -v docker &> /dev/null || ! command -v docker-compose &> /dev/null; then
        error "docker or docker-compose is not installed."
    fi

    log "Docker Compose services restart requested (./deploy.sh services)..."
    cd "$PROJECT_DIR"
    
    docker-compose restart
    log "Docker Compose services restarted successfully"
    echo ""
    docker-compose ps
    exit 0
fi

# Check required tools
if ! command -v git &> /dev/null; then
    error "git is not installed. Please install git first."
fi

if ! command -v pm2 &> /dev/null; then
    error "pm2 is not installed. Please install pm2 first."
fi

if ! command -v node &> /dev/null || ! command -v npm &> /dev/null; then
    error "node and npm are required. Please install them first."
fi

if ! command -v docker &> /dev/null; then
    warning "docker is not installed. Docker Compose services won't be managed."
fi

log "Starting deployment process..."
log "Project directory: $PROJECT_DIR"
log "Branch: $BRANCH"

# Step 1: Check Docker Compose services status
log "Step 1: Checking Docker Compose services..."
cd "$PROJECT_DIR"

if command -v docker &> /dev/null && [ -f "docker-compose.yml" ]; then
    if docker-compose ps | grep -q "Up"; then
        info "Docker Compose services are running"
        docker-compose ps
    else
        warning "Docker Compose services are not running. Starting them..."
        docker-compose up -d
        log "Docker Compose services started"
    fi
else
    warning "Docker or docker-compose.yml not found. Skipping service check."
fi

echo ""

# Step 2: Check current branch and status
log "Step 2: Checking git status..."

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

# Step 3: Pull latest code from main branch
log "Step 3: Pulling latest code from $BRANCH branch..."
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

# Step 4: Install dependencies (only if package-lock.json changed)
log "Step 4: Checking dependencies..."
PACKAGE_LOCK_HASH_FILE=".package-lock.hash"
CURRENT_HASH=$(md5sum package-lock.json 2>/dev/null | cut -d' ' -f1 || md5 -q package-lock.json 2>/dev/null)

if [ -f "$PACKAGE_LOCK_HASH_FILE" ]; then
    PREVIOUS_HASH=$(cat "$PACKAGE_LOCK_HASH_FILE")
    if [ "$CURRENT_HASH" = "$PREVIOUS_HASH" ] && [ -d "node_modules" ]; then
        info "Dependencies are up to date. Skipping npm ci..."
    else
        log "Dependencies changed. Running npm ci..."
        npm ci
        echo "$CURRENT_HASH" > "$PACKAGE_LOCK_HASH_FILE"
    fi
else
    log "Installing dependencies (npm ci)..."
    npm ci
    echo "$CURRENT_HASH" > "$PACKAGE_LOCK_HASH_FILE"
fi

# Step 5: Build application
log "Step 5: Building application..."
npm run build

# Step 6: Wait for services to be healthy
if command -v docker &> /dev/null && [ -f "docker-compose.yml" ]; then
    log "Step 6: Waiting for Docker services to be healthy..."
    sleep 3
    
    # Check if services are up
    if docker-compose ps | grep -q "Up"; then
        info "Docker services are healthy"
    else
        warning "Some Docker services may not be running properly"
        docker-compose ps
    fi
fi

echo ""

# Step 7: Restart PM2 application (start if missing)
log "Step 7: Restarting PM2 application..."
if pm2 describe "$PM2_APP_NAME" > /dev/null 2>&1; then
    pm2 restart "$PM2_APP_NAME"
    log "PM2 app restarted successfully"
else
    log "PM2 app not found. Starting new instance..."
    if [ -f "ecosystem.config.js" ]; then
        pm2 start ecosystem.config.js --only "$PM2_APP_NAME" --env production
    else
        pm2 start npm --name "$PM2_APP_NAME" -- run start:prod
    fi
    log "PM2 app started successfully"
fi

# Save PM2 process list
pm2 save

# Step 8: Show status and recent logs
log "Step 8: Deployment completed successfully!"
echo ""
log "PM2 status:"
pm2 status "$PM2_APP_NAME"

echo ""
if command -v docker &> /dev/null && [ -f "docker-compose.yml" ]; then
    log "Docker Compose services status:"
    docker-compose ps
fi

echo ""
log "Recent logs (last 20 lines):"
pm2 logs "$PM2_APP_NAME" --lines 20 --nostream

