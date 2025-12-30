#!/bin/bash

# Deployment script for EC2
# This script pulls code from main branch, builds Docker image, and restarts the app

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
BRANCH="main"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${PROJECT_DIR}/docker-compose.yml"

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

# Check if we're in the right directory
if [ ! -f "$COMPOSE_FILE" ]; then
    error "docker-compose.yml not found in $PROJECT_DIR"
fi

# Check if git is available
if ! command -v git &> /dev/null; then
    error "git is not installed. Please install git first."
fi

# Check if docker is available
if ! command -v docker &> /dev/null; then
    error "docker is not installed. Please install docker first."
fi

# Check if docker-compose is available
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    error "docker-compose is not installed. Please install docker-compose first."
fi

# Determine docker-compose command
if docker compose version &> /dev/null; then
    DOCKER_COMPOSE="docker compose"
else
    DOCKER_COMPOSE="docker-compose"
fi

# Function to check and free port
check_and_free_port() {
    local port=$1
    local service=$2
    
    if command -v lsof &> /dev/null; then
        local pid=$(lsof -ti :$port 2>/dev/null)
        if [ -n "$pid" ]; then
            local process=$(ps -p $pid -o comm= 2>/dev/null || echo "unknown")
            warning "Port $port ($service) is in use by PID $pid ($process)"
            
            # Check if it's a Docker container by checking process name
            if echo "$process" | grep -q "docker"; then
                log "Port $port is used by Docker, will be handled by docker-compose down..."
            else
                # Try to kill the process (non-interactive, use sudo if needed)
                log "Attempting to free port $port..."
                if kill $pid 2>/dev/null; then
                    log "✓ Port $port freed successfully"
                elif sudo kill $pid 2>/dev/null; then
                    log "✓ Port $port freed successfully (with sudo)"
                else
                    warning "Cannot free port $port automatically. Please run: ./free-port.sh $port"
                fi
                sleep 1
            fi
        fi
    fi
}

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

# Step 3: Check and free ports
log "Step 3: Checking for port conflicts..."
check_and_free_port 5482 "PostgreSQL"
check_and_free_port 6429 "Redis"
check_and_free_port 8173 "ClickHouse HTTP"
check_and_free_port 9050 "ClickHouse Native"
check_and_free_port 3050 "App"

# Step 4: Stop existing containers
log "Step 4: Stopping existing containers..."
$DOCKER_COMPOSE down 2>/dev/null || warning "No existing containers to stop"
$DOCKER_COMPOSE stop app 2>/dev/null || warning "App container not running"

# Step 5: Build Docker image
log "Step 5: Building Docker image..."
$DOCKER_COMPOSE build --no-cache app
log "Docker image built successfully"

# Step 6: Start services (ensure dependencies are up)
log "Step 6: Starting dependencies (postgres, redis, clickhouse)..."
$DOCKER_COMPOSE up -d postgres redis clickhouse

# Wait for dependencies to be ready
log "Waiting for dependencies to be ready..."
sleep 5

# Check if postgres is ready
log "Checking PostgreSQL connection..."
for i in {1..30}; do
    if $DOCKER_COMPOSE exec -T postgres pg_isready -U polymarket > /dev/null 2>&1; then
        log "PostgreSQL is ready"
        break
    fi
    if [ $i -eq 30 ]; then
        error "PostgreSQL failed to start after 30 attempts"
    fi
    sleep 2
done

# Check if redis is ready
log "Checking Redis connection..."
for i in {1..30}; do
    if $DOCKER_COMPOSE exec -T redis redis-cli ping > /dev/null 2>&1; then
        log "Redis is ready"
        break
    fi
    if [ $i -eq 30 ]; then
        error "Redis failed to start after 30 attempts"
    fi
    sleep 2
done

# Step 7: Start/restart app
log "Step 7: Starting app container..."
$DOCKER_COMPOSE up -d app

# Step 8: Wait for app to be healthy
log "Step 8: Waiting for app to be healthy..."
for i in {1..60}; do
    if $DOCKER_COMPOSE exec -T app node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})" > /dev/null 2>&1; then
        log "App is healthy and running"
        break
    fi
    if [ $i -eq 60 ]; then
        warning "App health check timeout. Please check logs manually."
        log "Showing app logs:"
        $DOCKER_COMPOSE logs --tail=50 app
        exit 1
    fi
    sleep 2
done

# Step 9: Show status
log "Step 9: Deployment completed successfully!"
echo ""
log "Container status:"
$DOCKER_COMPOSE ps

echo ""
log "App logs (last 20 lines):"
$DOCKER_COMPOSE logs --tail=20 app

echo ""
log "Deployment Summary:"
log "  - Code pulled from: $BRANCH"
log "  - Latest commit: $(git rev-parse --short HEAD)"
log "  - App container: $(docker ps --filter name=poly_app --format '{{.Status}}')"
log ""
log "To view logs: docker-compose logs -f app"
log "To check status: docker-compose ps"
log "To restart app: docker-compose restart app"

