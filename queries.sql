-- NOTE: This file now contains ClickHouse queries for `market_orderbooks_analytics`

-- Query: Get latest orderbook for a specific asset
SELECT
    asset_id,
    market_hash,
    market_slug,
    market_id,
    timestamp,
    best_bid,
    best_ask,
    spread,
    price
FROM market_orderbooks_analytics
WHERE asset_id = 'YOUR_ASSET_ID'
ORDER BY timestamp DESC
LIMIT 1;

-- Query: Get orderbook history for an asset in a time range (unix seconds -> DateTime64)
SELECT
    asset_id,
    market_hash,
    market_slug,
    market_id,
    timestamp,
    best_bid,
    best_ask,
    spread,
    price
FROM market_orderbooks_analytics
WHERE asset_id = 'YOUR_ASSET_ID'
  AND timestamp BETWEEN toDateTime64(1700000000, 3) AND toDateTime64(1700100000, 3)
ORDER BY timestamp DESC;

-- Query: Count records per asset
SELECT
    asset_id,
    count() as record_count,
    min(timestamp) as first_seen,
    max(timestamp) as last_seen
FROM market_orderbooks_analytics
GROUP BY asset_id
ORDER BY record_count DESC;

-- Query: Get top bid/ask for latest orderbook (precomputed)
SELECT
    asset_id,
    market_hash,
    market_slug,
    market_id,
    timestamp,
    best_bid,
    best_ask,
    spread,
    price
FROM market_orderbooks_analytics
WHERE asset_id = 'YOUR_ASSET_ID'
ORDER BY timestamp DESC
LIMIT 1;

-- Query: Data volume statistics
SELECT
    toDate(timestamp) as date,
    count() as records,
    uniqExact(asset_id) as unique_assets
FROM market_orderbooks_analytics
GROUP BY date
ORDER BY date DESC;

-- Query: Find assets with most activity (last 1 hour)
SELECT
    asset_id,
    count() as updates,
    max(timestamp) as last_update,
    uniqExact(market_slug) as markets
FROM market_orderbooks_analytics
WHERE timestamp > now() - INTERVAL 1 HOUR
GROUP BY asset_id
ORDER BY updates DESC
LIMIT 10;

-- Query: Database maintenance - Delete old data (older than 30 days)
-- ALTER TABLE market_orderbooks_analytics DELETE WHERE timestamp < now() - INTERVAL 30 DAY;

-- Query: Storage overview
-- SELECT
--   table,
--   formatReadableSize(sum(bytes)) AS size,
--   sum(rows) AS rows
-- FROM system.parts
-- WHERE database = currentDatabase() AND table = 'market_orderbooks_analytics' AND active
-- GROUP BY table;

