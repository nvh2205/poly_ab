-- Migration: Add arb_real_trades table
-- Description: Store real trade execution results for arbitrage signals
-- Date: 2026-01-11

-- Create arb_real_trades table
CREATE TABLE IF NOT EXISTS arb_real_trades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    signal_id UUID NOT NULL REFERENCES arb_signals(id) ON DELETE CASCADE,
    success BOOLEAN NOT NULL DEFAULT FALSE,
    order_ids JSONB,
    error TEXT,
    total_cost DECIMAL(18, 8),
    expected_pnl DECIMAL(18, 8),
    timestamp_ms BIGINT NOT NULL
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_arb_real_trades_signal_id ON arb_real_trades(signal_id);
CREATE INDEX IF NOT EXISTS idx_arb_real_trades_created_at ON arb_real_trades(created_at);
CREATE INDEX IF NOT EXISTS idx_arb_real_trades_success ON arb_real_trades(success);

-- Add comment
COMMENT ON TABLE arb_real_trades IS 'Stores real trade execution results for arbitrage signals';
COMMENT ON COLUMN arb_real_trades.signal_id IS 'Foreign key to arb_signals table';
COMMENT ON COLUMN arb_real_trades.success IS 'Whether the trade execution was successful';
COMMENT ON COLUMN arb_real_trades.order_ids IS 'Array of Polymarket order IDs (JSON)';
COMMENT ON COLUMN arb_real_trades.error IS 'Error message if trade failed';
COMMENT ON COLUMN arb_real_trades.total_cost IS 'Total cost of the trade in USDC';
COMMENT ON COLUMN arb_real_trades.expected_pnl IS 'Expected PnL from the trade in USDC';
COMMENT ON COLUMN arb_real_trades.timestamp_ms IS 'Timestamp in milliseconds when trade was executed';
