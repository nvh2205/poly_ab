# Worker vs API Mode Architecture

## Tổng quan

Dự án này sử dụng kiến trúc **tách biệt hoàn toàn** giữa API và Worker:
- **API Mode**: Chạy HTTP server, WebSocket, xử lý trading signals, **chỉ ADD jobs** vào queue
- **Worker Mode**: **Chỉ xử lý Bull Queue jobs** (mint tokens, manage positions)

⚠️ **QUAN TRỌNG**: API **KHÔNG** consume queue. Bạn **PHẢI** chạy Worker để jobs được xử lý!

Cả hai mode sử dụng **cùng source code, database, và Redis**.

## Tại sao tách Worker?

1. **Trading Latency Thấp Hơn**: API không share CPU/memory với queue processing
2. **Isolation**: Worker có thể restart độc lập mà không ảnh hưởng trading
3. **Scaling**: Có thể chạy nhiều workers để xử lý queue nhanh hơn
4. **Resource Management**: Tách biệt resources cho critical path (trading) và non-critical (minting)

## Cách chạy

### Development

```bash
# Terminal 1: API (chỉ add jobs, không consume)
npm run start:dev

# Terminal 2: Worker (consume và xử lý jobs)
npm run start:worker
```

### Production

```bash
# Build cả hai
npm run build

# Chạy API
npm run start:prod

# Chạy Worker (terminal/process khác) - BẮT BUỘC!
npm run start:worker:prod
```

## Environment Variables

Cả API và Worker đều cần các env vars sau (có thể dùng chung file .env):

```env
# Database (BẮT BUỘC GIỐNG NHAU)
DB_HOST=localhost
DB_PORT=5483
DB_USERNAME=polymarket
DB_PASSWORD=polymarket123
DB_DATABASE=polymarket_db

# Redis (BẮT BUỘC GIỐNG NHAU - để share queue)
REDIS_HOST=localhost
REDIS_PORT=6430

# Polymarket credentials (Worker cần để thực hiện mint)
POLY_PRIVATE_KEY=...
POLY_API_KEY=...
POLY_API_SECRET=...
POLY_API_PASSPHRASE=...
```

## Kiến trúc

```
┌─────────────────────────────────────────────────────────────────┐
│                           Redis                                  │
│                    (Bull Queue Storage)                          │
└─────────────────────────────────────────────────────────────────┘
         │                                         │
    ┌────▼────┐                              ┌─────▼────┐
    │   API   │                              │  Worker  │
    │  Mode   │                              │   Mode   │
    ├─────────┤                              ├──────────┤
    │ HTTP    │                              │ Queue    │
    │ Server  │ ──── addToQueue() ──────────▶│ Processor│
    │         │                              │          │
    │ Trading │                              │ Mint     │
    │ Engine  │                              │ Position │
    └────┬────┘                              └────┬─────┘
         │                                        │
         └──────────────┬────────────────────────┘
                        │
                   ┌────▼────┐
                   │PostgreSQL│
                   │ Database │
                   └──────────┘
```

## Files chính

| File | Mô tả |
|------|-------|
| `src/main.ts` | Entry point cho API mode |
| `src/app.module.ts` | Module cho API mode (full features) |
| `src/worker.main.ts` | Entry point cho Worker mode |
| `src/worker.module.ts` | Module cho Worker mode (minimal - chỉ queue processors) |

## Queue được xử lý bởi Worker

1. **mint-queue**: Mint tokens sau khi SELL thành công
   - Processor: `MintQueueProcessor`
   - Job data: `{ assetId, size, createdAt }`

2. **manage-position**: Check và retry orders failed
   - Processor: `ManagePositionProcessor`  
   - Job data: `{ tradeId, originalOrders, createdAt }`

## PM2 Configuration

```javascript
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'poly-api',
      script: 'dist/main.js',
      instances: 1,
      env: {
        NODE_ENV: 'production',
        PORT: 8015,
      },
    },
    {
      name: 'poly-worker',
      script: 'dist/worker.main.js',
      instances: 1,
      env: {
        NODE_ENV: 'production',
        APP_MODE: 'worker',
      },
    },
  ],
};
```

## Docker Compose (Optional)

```yaml
version: '3.8'
services:
  api:
    build: .
    command: node dist/main.js
    ports:
      - "8015:8015"
    environment:
      - NODE_ENV=production
    depends_on:
      - redis
      - postgres

  worker:
    build: .
    command: node dist/worker.main.js
    environment:
      - NODE_ENV=production
      - APP_MODE=worker
    depends_on:
      - redis
      - postgres
```

## Troubleshooting

### Worker không process jobs
- Kiểm tra Redis connection (cùng host/port với API)
- Kiểm tra console logs của worker
- Verify queue stats: `redis-cli keys "bull:*"`

### Jobs stuck
```bash
# Xem queue stats qua API
curl http://localhost:8015/strategy/mint-queue/stats
```

### Restart worker
```bash
pm2 restart poly-worker
```
