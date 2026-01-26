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

# Detect docker compose command (docker-compose or docker compose)
if command -v docker-compose &> /dev/null; then
    DOCKER_COMPOSE="docker-compose"
elif docker compose version &> /dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
else
    DOCKER_COMPOSE=""
fi

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
    if [ -z "$DOCKER_COMPOSE" ]; then
        error "docker compose is not available. Please install Docker and Docker Compose."
    fi

    log "Docker Compose services restart requested (./deploy.sh services)..."
    cd "$PROJECT_DIR"
    
    $DOCKER_COMPOSE restart
    log "Docker Compose services restarted successfully"
    echo ""
    $DOCKER_COMPOSE ps
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

if ! command -v cargo &> /dev/null || ! command -v rustc &> /dev/null; then
    error "Rust toolchain (cargo, rustc) is required for native-core module. Install via: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
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

if [ -n "$DOCKER_COMPOSE" ] && [ -f "docker-compose.yml" ]; then
    if $DOCKER_COMPOSE ps | grep -q "Up"; then
        info "Docker Compose services are running"
        $DOCKER_COMPOSE ps
    else
        warning "Docker Compose services are not running. Starting them..."
        $DOCKER_COMPOSE up -d
        log "Docker Compose services started"
    fi
else
    warning "Docker Compose or docker-compose.yml not found. Skipping service check."
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

# Step 4: Install dependencies (only if package.json changed)
log "Step 4: Checking dependencies..."
PACKAGE_HASH_FILE=".package.hash"
CURRENT_HASH=$(md5sum package.json 2>/dev/null | cut -d' ' -f1 || md5 -q package.json 2>/dev/null)

if [ -f "$PACKAGE_HASH_FILE" ]; then
    PREVIOUS_HASH=$(cat "$PACKAGE_HASH_FILE")
    if [ "$CURRENT_HASH" = "$PREVIOUS_HASH" ] && [ -d "node_modules" ]; then
        info "Dependencies are up to date. Skipping npm install..."
    else
        log "Dependencies changed. Running npm install..."
        npm install
        echo "$CURRENT_HASH" > "$PACKAGE_HASH_FILE"
    fi
else
    log "Installing dependencies (npm install)..."
    npm install
    echo "$CURRENT_HASH" > "$PACKAGE_HASH_FILE"
fi

# Step 5: Build native-core module (if Rust sources changed)
log "Step 5: Building native-core module..."
NATIVE_CORE_DIR="$PROJECT_DIR/native-core"
NATIVE_CARGO_HASH_FILE="$NATIVE_CORE_DIR/.cargo.hash"

if [ -d "$NATIVE_CORE_DIR" ] && [ -f "$NATIVE_CORE_DIR/Cargo.toml" ]; then
    cd "$NATIVE_CORE_DIR"
    
    # Check if Cargo.toml or src changed
    CARGO_HASH=$(cat Cargo.toml src/*.rs 2>/dev/null | md5sum 2>/dev/null | cut -d' ' -f1 || cat Cargo.toml src/*.rs 2>/dev/null | md5 -q 2>/dev/null)
    
    NEEDS_BUILD=false
    if [ -f "$NATIVE_CARGO_HASH_FILE" ]; then
        PREVIOUS_CARGO_HASH=$(cat "$NATIVE_CARGO_HASH_FILE")
        if [ "$CARGO_HASH" != "$PREVIOUS_CARGO_HASH" ]; then
            NEEDS_BUILD=true
            log "Native-core source changed. Rebuilding..."
        else
            # Also check if .node binary exists for current platform
            PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
            ARCH=$(uname -m)
            if [ "$ARCH" = "x86_64" ]; then ARCH="x64"; fi
            if [ "$ARCH" = "aarch64" ]; then ARCH="arm64"; fi
            
            NODE_FILE=$(ls native-core.${PLATFORM}-${ARCH}.node 2>/dev/null || ls native-core.*.node 2>/dev/null | head -1)
            if [ -z "$NODE_FILE" ]; then
                NEEDS_BUILD=true
                log "Native binary not found for $PLATFORM-$ARCH. Building..."
            else
                info "Native-core is up to date. Skipping build..."
            fi
        fi
    else
        NEEDS_BUILD=true
        log "First time building native-core..."
    fi
    
    if [ "$NEEDS_BUILD" = true ]; then
        # Install napi-rs CLI if needed
        if ! command -v napi &> /dev/null; then
            log "Installing @napi-rs/cli..."
            npm install -g @napi-rs/cli
        fi
        
        # Install dependencies and build
        npm install
        npm run build
        
        if [ $? -eq 0 ]; then
            echo "$CARGO_HASH" > "$NATIVE_CARGO_HASH_FILE"
            log "Native-core built successfully"
        else
            error "Failed to build native-core module"
        fi
    fi
    
    cd "$PROJECT_DIR"
else
    warning "native-core directory not found. Skipping native build."
fi

echo ""

# Step 6: Build application
log "Step 6: Building NestJS application..."
npm run build

# Step 7: Wait for services to be healthy
if [ -n "$DOCKER_COMPOSE" ] && [ -f "docker-compose.yml" ]; then
    log "Step 7: Waiting for Docker services to be healthy..."
    sleep 3
    
    # Check if services are up
    if $DOCKER_COMPOSE ps | grep -q "Up"; then
        info "Docker services are healthy"
    else
        warning "Some Docker services may not be running properly"
        $DOCKER_COMPOSE ps
    fi
fi

echo ""

# Step 8: Restart PM2 application (start if missing)
log "Step 8: Restarting PM2 application..."
if pm2 describe "$PM2_APP_NAME" > /dev/null 2>&1; then
    log "PM2 app exists. Restarting..."
    pm2 restart "$PM2_APP_NAME"
    log "PM2 app restarted successfully"
else
    log "PM2 app not found. Starting new instance..."
    if [ -f "ecosystem.config.js" ]; then
        log "Using ecosystem.config.js..."
        pm2 start ecosystem.config.js --env production
    else
        log "No ecosystem.config.js found. Starting with npm..."
        pm2 start npm --name "$PM2_APP_NAME" -- run start:prod
    fi
    log "PM2 app started successfully"
fi

# Save PM2 process list and show list
log "Saving PM2 process list..."
pm2 save --force

# Step 9: Show status and recent logs
log "Step 9: Deployment completed successfully!"
echo ""
log "PM2 status:"
pm2 status "$PM2_APP_NAME"

echo ""
if [ -n "$DOCKER_COMPOSE" ] && [ -f "docker-compose.yml" ]; then
    log "Docker Compose services status:"
    $DOCKER_COMPOSE ps
fi

echo ""
log "Recent logs (last 20 lines):"
pm2 logs "$PM2_APP_NAME" --lines 20 --nostream

