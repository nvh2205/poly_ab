# Strategy Module - API & Retention

This module implements arbitrage detection, paper trading, and data retention for Polymarket range-based markets.

## API Endpoints

### 1. Get Overall Statistics

```
GET /strategy/stats
```

Returns overall statistics for signals and paper trades.

**Response:**
```json
{
  "signals": {
    "total": 1234,
    "executable": 567,
    "recent": [...]
  },
  "paperTrades": {
    "totalTrades": 567,
    "totalPnlAbs": 12.34,
    "avgPnlBps": 45.67,
    "winRate": 0.78,
    "avgLatencyMs": 52
  }
}
```

### 2. Get Range Groups

```
GET /strategy/groups
```

Returns list of active range groups with signal counts.

**Response:**
```json
{
  "total": 5,
  "groups": [
    {
      "groupKey": "bitcoin-price-on-december-29",
      "eventSlug": "bitcoin-price-on-december-29",
      "crypto": "BTC",
      "childrenCount": 10,
      "parentsCount": 2,
      "signalCount": 123
    }
  ]
}
```

### 3. Get Arbitrage Signals

```
GET /strategy/signals?limit=100&groupKey=bitcoin-price-on-december-29
```

Returns arbitrage signals with optional filtering.

**Query Parameters:**
- `limit` (optional, default: 100, max: 1000) - Number of signals to return
- `groupKey` (optional) - Filter by specific group

**Response:**
```json
{
  "total": 1234,
  "limit": 100,
  "groupKey": "bitcoin-price-on-december-29",
  "signals": [
    {
      "id": "uuid",
      "createdAt": "2025-12-30T10:00:00Z",
      "groupKey": "bitcoin-price-on-december-29",
      "strategy": "SELL_PARENT_BUY_CHILDREN",
      "profitAbs": 0.05,
      "profitBps": 50,
      "isExecutable": true,
      ...
    }
  ]
}
```

### 4. Get Paper Trades

```
GET /strategy/paper-trades?limit=100&groupKey=bitcoin-price-on-december-29
```

Returns paper trade results with optional filtering.

**Query Parameters:**
- `limit` (optional, default: 100, max: 1000) - Number of trades to return
- `groupKey` (optional) - Filter by specific group

**Response:**
```json
{
  "total": 567,
  "limit": 100,
  "groupKey": "bitcoin-price-on-december-29",
  "trades": [
    {
      "id": "uuid",
      "signalId": "uuid",
      "createdAt": "2025-12-30T10:00:00Z",
      "filledSize": 100,
      "pnlAbs": 0.045,
      "pnlBps": 48.5,
      "latencyMs": 52,
      ...
    }
  ]
}
```

### 5. Get Group Summary

```
GET /strategy/signals/:groupKey/summary
```

Returns summary statistics for a specific group.

**Response:**
```json
{
  "groupKey": "bitcoin-price-on-december-29",
  "signalCount": 123,
  "avgProfitBps": 45.67,
  "maxProfitBps": 120.5,
  "strategies": [
    {
      "name": "SELL_PARENT_BUY_CHILDREN",
      "count": 80,
      "avgProfitBps": 48.2
    },
    {
      "name": "BUY_PARENT_SELL_CHILDREN",
      "count": 43,
      "avgProfitBps": 41.3
    }
  ]
}
```

### 6. Get Retention Statistics

```
GET /strategy/retention/stats
```

Returns current retention policy and database statistics.

**Response:**
```json
{
  "retentionDays": 7,
  "maxRecordsPerGroup": 10000,
  "cleanupEnabled": true,
  "totalSignals": 1234,
  "totalPaperTrades": 567,
  "oldestSignalDate": "2025-12-23T10:00:00Z",
  "newestSignalDate": "2025-12-30T10:00:00Z"
}
```

### 7. Trigger Manual Cleanup

```
POST /strategy/retention/cleanup
```

Manually trigger retention cleanup (runs the same logic as daily cron).

**Response:**
```json
{
  "success": true,
  "message": "Manual cleanup completed successfully"
}
```

## Environment Configuration

### Arbitrage Engine

```bash
# Minimum profit thresholds
ARB_MIN_PROFIT_BPS=5          # Minimum profit in basis points (default: 5)
ARB_MIN_PROFIT_ABS=0          # Minimum absolute profit (default: 0)

# Performance tuning
ARB_SCAN_THROTTLE_MS=200      # Throttle between scans (default: 200ms)
ARB_COOLDOWN_MS=1000          # Cooldown between same signal (default: 1000ms)
```

### Paper Trading

```bash
PAPER_TRADE_SIZE=100          # Default trade size (default: 100)
PAPER_TRADE_LATENCY_MS=50     # Simulated latency (default: 50ms)
```

### Retention & Cleanup

```bash
# Retention policy
ARB_RETENTION_DAYS=7          # Keep records for N days (default: 7)
ARB_MAX_RECORDS_PER_GROUP=10000  # Max records per group (default: 10000)
ARB_CLEANUP_ENABLED=true      # Enable automatic cleanup (default: true)
```

## Retention Policy

The retention cleanup service runs automatically:
- **Schedule**: Daily at 3:00 AM (configurable via cron expression)
- **Age-based cleanup**: Deletes signals and paper trades older than `ARB_RETENTION_DAYS`
- **Count-based cleanup**: Keeps only top `ARB_MAX_RECORDS_PER_GROUP` records per group

### Cleanup Logic

1. **By Age**: Deletes all records older than retention period
   - Paper trades are deleted first (foreign key constraint)
   - Then signals are deleted

2. **By Count**: For each group exceeding max records
   - Keeps newest N records
   - Deletes oldest records beyond the limit

### Manual Cleanup

You can trigger cleanup manually via API:

```bash
curl -X POST http://localhost:3000/strategy/retention/cleanup
```

Or disable automatic cleanup:

```bash
ARB_CLEANUP_ENABLED=false
```

## Database Schema

### arb_signals

Stores detected arbitrage opportunities.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| created_at | timestamp | Creation time |
| group_key | varchar | Range group identifier |
| event_slug | varchar | Event slug |
| crypto | varchar | Cryptocurrency symbol |
| strategy | enum | SELL_PARENT_BUY_CHILDREN or BUY_PARENT_SELL_CHILDREN |
| parent_market_id | varchar | Parent market ID |
| parent_asset_id | varchar | Parent asset/token ID |
| range_i | int | Start index of range |
| range_j | int | End index of range |
| parent_best_bid | decimal | Parent best bid price |
| parent_best_ask | decimal | Parent best ask price |
| children_sum_ask | decimal | Sum of children ask prices |
| children_sum_bid | decimal | Sum of children bid prices |
| profit_abs | decimal | Absolute profit |
| profit_bps | decimal | Profit in basis points |
| is_executable | boolean | Whether signal is executable |
| reason | text | Reason if not executable |
| snapshot | jsonb | Full market snapshot |
| timestamp_ms | bigint | Original timestamp |

**Indexes**: group_key, crypto, parent_market_id, parent_asset_id, created_at

### arb_paper_trades

Stores paper trade execution results.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| created_at | timestamp | Creation time |
| signal_id | uuid | Foreign key to arb_signals |
| filled_size | decimal | Trade size |
| entry | jsonb | Entry details |
| fills | jsonb | Fill details |
| pnl_abs | decimal | Absolute P&L |
| pnl_bps | decimal | P&L in basis points |
| latency_ms | int | Simulated latency |
| timestamp_ms | bigint | Original timestamp |

**Indexes**: signal_id, created_at

**Foreign Key**: signal_id → arb_signals(id) ON DELETE CASCADE

## Usage Examples

### Monitor Active Arbitrage

```bash
# Get current stats
curl http://localhost:3000/strategy/stats

# Get all groups
curl http://localhost:3000/strategy/groups

# Get recent signals for a specific group
curl "http://localhost:3000/strategy/signals?groupKey=bitcoin-price-on-december-29&limit=50"
```

### Analyze Performance

```bash
# Get paper trade results
curl "http://localhost:3000/strategy/paper-trades?limit=100"

# Get group-specific summary
curl "http://localhost:3000/strategy/signals/bitcoin-price-on-december-29/summary"
```

### Manage Retention

```bash
# Check retention stats
curl http://localhost:3000/strategy/retention/stats

# Trigger manual cleanup
curl -X POST http://localhost:3000/strategy/retention/cleanup
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  StrategyController                      │
│  (API endpoints for querying signals & paper trades)    │
└───────────────────┬─────────────────────────────────────┘
                    │
        ┌───────────┼───────────┐
        │           │           │
        ▼           ▼           ▼
┌──────────┐  ┌──────────┐  ┌──────────────────┐
│ ArbSignal│  │ArbPaper  │  │ RetentionCleanup │
│Repository│  │Trade     │  │    Service       │
│          │  │Repository│  │  (Cron: 3AM)     │
└──────────┘  └──────────┘  └──────────────────┘
     │             │                  │
     └─────────────┴──────────────────┘
                   │
            ┌──────▼──────┐
            │  PostgreSQL  │
            │   Database   │
            └─────────────┘
```

## Notes

- All timestamps are stored in UTC
- Decimal fields use precision 18, scale 8 for prices
- JSONB fields store complex objects (snapshot, entry, fills)
- Foreign key CASCADE ensures paper trades are deleted with signals
- Indexes optimize common query patterns (by group, by date, by crypto)

