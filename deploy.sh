#!/bin/bash

# Deployment script for Polymarket High-Performance Bot
set -e  # Dừng ngay nếu có lỗi

# --- CONFIG ---
PM2_APP_NAME="polymarket-ab"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRANCH="main"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[$(date +'%H:%M:%S')]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; exit 1; }

# --- 1. UPDATE CODE ---
log "Step 1: Pulling latest code..."
cd "$PROJECT_DIR"
git fetch origin
git checkout "$BRANCH"
git pull origin "$BRANCH"

# =================================================================
# BƯỚC 2: BUILD NATIVE CORE TRƯỚC (QUAN TRỌNG)
# =================================================================
log "Step 2: Building Native Core (Optimized Release)..."
cd "$PROJECT_DIR/native-core"

# Xóa build cũ để đảm bảo sạch sẽ
rm -rf target index.node *.node 

# Cài dependencies cho module native
npm install --silent

# --- TỐI ƯU HÓA CPU (CHÌA KHÓA GIẢM LATENCY) ---
# 1. --release: Bật tối ưu hóa trình biên dịch
# 2. RUSTFLAGS="-C target-cpu=native": Bắt Rust dùng tập lệnh AVX/AES của chính CPU Server này
log "--> Compiling Rust with Host CPU Optimizations..."
export RUSTFLAGS="-C target-cpu=native"
npm run build -- --release

# Kiểm tra file binary
if ls *.node 1> /dev/null 2>&1; then
    log "--> Build Native Success!"
else
    error "Build Native thất bại! Không tìm thấy file .node"
fi

# =================================================================
# BƯỚC 3: INSTALL & BUILD MAIN APP
# =================================================================
log "Step 3: Installing & Building Main App..."
cd "$PROJECT_DIR"

# QUAN TRỌNG: Xóa module native trong node_modules để ép npm link lại bản mới vừa build
rm -rf node_modules/native-core
rm -rf node_modules/.cache

# Bây giờ mới cài App -> Nó sẽ link file .node xịn vào
npm install

log "--> Building NestJS..."
npm run build

# =================================================================
# BƯỚC 4: RESTART PM2 (Performance Tuning)
# =================================================================
log "Step 4: Restarting Server..."

# Tăng Thread Pool lên 64 để tránh nghẽn khi xử lý Crypto/Sign
export UV_THREADPOOL_SIZE=64
export NODE_ENV=production

if pm2 describe "$PM2_APP_NAME" > /dev/null 2>&1; then
    pm2 restart "$PM2_APP_NAME" --update-env
else
    pm2 start dist/main.js --name "$PM2_APP_NAME"
fi

log "✅ DEPLOYMENT SUCCESSFUL!"
pm2 logs "$PM2_APP_NAME" --lines 10 --nostream