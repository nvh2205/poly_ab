-- Migration 004: Add size columns for parent and parentUpper
-- 
-- Reason: 
-- - Store size available at best bid/ask for parent and parentUpper markets
-- - This helps track liquidity and execution feasibility
-- - Children sizes are stored in the snapshot JSONB field
--
-- This migration adds size columns for parent and parentUpper markets

-- Add parent size columns
ALTER TABLE arb_signals 
ADD COLUMN parent_best_bid_size DECIMAL(18, 8) NULL;

ALTER TABLE arb_signals 
ADD COLUMN parent_best_ask_size DECIMAL(18, 8) NULL;

-- Add parentUpper size columns
ALTER TABLE arb_signals 
ADD COLUMN parent_upper_best_bid_size DECIMAL(18, 8) NULL;

ALTER TABLE arb_signals 
ADD COLUMN parent_upper_best_ask_size DECIMAL(18, 8) NULL;

-- Add comments for documentation
COMMENT ON COLUMN arb_signals.parent_best_bid_size IS 'Size available at parent best bid price';
COMMENT ON COLUMN arb_signals.parent_best_ask_size IS 'Size available at parent best ask price';
COMMENT ON COLUMN arb_signals.parent_upper_best_bid_size IS 'Size available at parentUpper best bid price (for 2-way arbitrage)';
COMMENT ON COLUMN arb_signals.parent_upper_best_ask_size IS 'Size available at parentUpper best ask price (for 2-way arbitrage)';

