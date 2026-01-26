#!/bin/bash

# ==============================================================================
# POLYMARKET HIGH-PERFORMANCE DEPLOY SCRIPT
# Features: Smart Caching, CPU Optimization, Dependency Relinking
# ==============================================================================

set -e  # Dừng ngay nếu có lỗi

# --- CẤU HÌNH ---
PM2_APP_NAME="polymarket-ab"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRANCH="main"
NATIVE_DIR="$PROJECT_DIR/native-core"

# Màu sắc
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

# Helpers
log() { echo -e "${GREEN}[$(date +'%H:%M:%S')]${NC} $1"; }
info() { echo -e "${BLUE}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; exit 1; }

# Detect Docker
if command -v docker-compose &> /dev/null; then DOCKER_CMD="docker-compose";
elif docker compose version &> /dev/null 2>&1; then DOCKER_CMD="docker compose";
else DOCKER_CMD=""; fi

TARGET=${1:-""}

# --- XỬ LÝ QUICK COMMANDS ---
if [ "$TARGET" = "app" ]; then
    log "🚀 Quick Restart PM2..."
    export UV_THREADPOOL_SIZE=64
    pm2 restart "$PM2_APP_NAME" --update-env
    exit 0
fi

if [ "$TARGET" = "services" ]; then
    log "🐳 Restarting Docker Services..."
    cd "$PROJECT_DIR"
    $DOCKER_CMD restart && exit 0
fi

# ==============================================================================
# BƯỚC 1: CẬP NHẬT CODE
# ==============================================================================
log "Step 1: Pulling latest code..."
cd "$PROJECT_DIR"

if [ -n "$(git status --porcelain)" ]; then
    warn "Uncommitted changes detected. Stashing..."
    git stash
fi

git fetch origin
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
    git checkout "$BRANCH"
fi
git pull origin "$BRANCH"

# ==============================================================================
# BƯỚC 2: BUILD NATIVE CORE (SMART CHECK)
# Chỉ build khi code Rust thay đổi. Tự động tối ưu CPU.
# ==============================================================================
log "Step 2: Checking Native Core..."
NATIVE_CHANGED=false

if [ -d "$NATIVE_DIR" ]; then
    cd "$NATIVE_DIR"
    
    # 1. Tính Hash của toàn bộ source Rust và config
    # Sử dụng find để quét đệ quy tất cả file .rs
    CURRENT_NATIVE_HASH=$(find src Cargo.toml package.json -type f -print0 | sort -z | xargs -0 md5sum | md5sum | cut -d' ' -f1)
    HASH_FILE=".build.hash"
    
    # 2. So sánh với hash cũ
    NEEDS_BUILD=true
    if [ -f "$HASH_FILE" ] && [ -f "index.node" ]; then
        if [ "$CURRENT_NATIVE_HASH" == "$(cat $HASH_FILE)" ]; then
            NEEDS_BUILD=false
            info "--> Native Core chưa thay đổi. Skipping build."
        fi
    fi

    # 3. Build (Nếu cần)
    if [ "$NEEDS_BUILD" = true ]; then
        warn "--> Code Rust thay đổi (hoặc lần đầu chạy). Đang build Native Core..."
        
        npm install --silent
        
        # --- QUAN TRỌNG: TỐI ƯU CHO CPU SERVER (Fix lỗi latency 1.3s) ---
        export RUSTFLAGS="-C target-cpu=native"
        npm run build -- --release
        
        echo "$CURRENT_NATIVE_HASH" > "$HASH_FILE"
        NATIVE_CHANGED=true
        log "--> ✅ Native Core built success!"
    fi
    cd "$PROJECT_DIR"
else
    warn "Không tìm thấy thư mục native-core. Bỏ qua."
fi

# ==============================================================================
# BƯỚC 3: CÀI ĐẶT DEPENDENCIES (SMART CHECK)
# Chỉ cài lại khi package.json đổi HOẶC Native vừa build lại
# ==============================================================================
log "Step 3: Checking App Dependencies..."

PKG_HASH_FILE=".package.hash"
CURRENT_PKG_HASH=$(md5sum package.json | cut -d' ' -f1)
NEEDS_INSTALL=false

# Check package.json thay đổi
if [ ! -f "$PKG_HASH_FILE" ] || [ "$CURRENT_PKG_HASH" != "$(cat $PKG_HASH_FILE 2>/dev/null)" ]; then
    NEEDS_INSTALL=true
    info "--> package.json thay đổi."
fi

# Check Native thay đổi -> Bắt buộc cài lại để link file binary mới
if [ "$NATIVE_CHANGED" = true ]; then
    NEEDS_INSTALL=true
    warn "--> Native Core thay đổi. Cần link lại dependencies..."
    # Xóa link cũ để đảm bảo npm link đúng file mới
    rm -rf node_modules/native-core
    rm -rf node_modules/.cache
fi

if [ "$NEEDS_INSTALL" = true ]; then
    log "--> Running npm install..."
    npm install
    echo "$CURRENT_PKG_HASH" > "$PKG_HASH_FILE"
else
    info "--> Dependencies up-to-date. Skipping install."
fi

# ==============================================================================
# BƯỚC 4: BUILD NESTJS APP (SMART CHECK)
# Chỉ build khi folder src/ thay đổi
# ==============================================================================
log "Step 4: Checking NestJS Build..."

SRC_HASH_FILE=".src.hash"
# Tính hash folder src + tsconfig.json
CURRENT_SRC_HASH=$(find src -type f -print0 | sort -z | xargs -0 md5sum | md5sum | cut -d' ' -f1)

NEEDS_APP_BUILD=true
# Nếu logic phía trên yêu cầu install (do đổi deps/native) thì BẮT BUỘC build lại app
# Nếu không, chỉ kiểm tra xem src có thay đổi không
if [ -f "$SRC_HASH_FILE" ] && [ -d "dist" ] && [ "$NEEDS_INSTALL" = false ]; then
    if [ "$CURRENT_SRC_HASH" == "$(cat $SRC_HASH_FILE)" ]; then
        NEEDS_APP_BUILD=false
        info "--> App Source chưa thay đổi. Skipping build."
    fi
fi

if [ "$NEEDS_APP_BUILD" = true ]; then
    log "--> Building NestJS App..."
    npm run build
    echo "$CURRENT_SRC_HASH" > "$SRC_HASH_FILE"
fi

# ==============================================================================
# BƯỚC 5: RESTART SERVICES & PM2
# ==============================================================================
log "Step 5: Finishing Deployment..."

# Docker Check
if [ -n "$DOCKER_CMD" ] && [ -f "docker-compose.yml" ]; then
    # Chỉ start nếu chưa chạy (giảm lag)
    if ! $DOCKER_CMD ps --services --filter "status=running" | grep -q .; then
        log "--> Starting Docker Services..."
        $DOCKER_CMD up -d
    fi
fi

# PM2 Restart (Tuning)
log "--> Restarting PM2..."

# Tăng Thread Pool lên 64 (QUAN TRỌNG cho Native/Crypto)
export UV_THREADPOOL_SIZE=64
export NODE_ENV=production

if pm2 describe "$PM2_APP_NAME" > /dev/null 2>&1; then
    # Update env mới nhất
    pm2 restart "$PM2_APP_NAME" --update-env
else
    if [ -f "ecosystem.config.js" ]; then
        pm2 start ecosystem.config.js --env production
    else
        pm2 start dist/main.js --name "$PM2_APP_NAME"
    fi
fi

pm2 save --force > /dev/null
log "✅ DEPLOYMENT COMPLETED SUCCESSFULLY!"
echo ""
pm2 logs "$PM2_APP_NAME" --lines 10 --nostream