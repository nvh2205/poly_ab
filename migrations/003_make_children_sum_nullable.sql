-- Migration 003: Make children_sum_ask and children_sum_bid nullable
-- 
-- Reason: 
-- - SELL_PARENT_BUY_CHILDREN strategy only uses children_sum_ask (children_sum_bid is N/A)
-- - BUY_PARENT_SELL_CHILDREN strategy only uses children_sum_bid (children_sum_ask is N/A)
-- - Binary chill strategies may use different combinations
--
-- This migration allows one of the fields to be NULL depending on the strategy

-- Make children_sum_ask nullable
ALTER TABLE arb_signals 
ALTER COLUMN children_sum_ask DROP NOT NULL;

-- Make children_sum_bid nullable
ALTER TABLE arb_signals 
ALTER COLUMN children_sum_bid DROP NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN arb_signals.children_sum_ask IS 'Sum of ask prices for children markets. NULL for strategies that only use bid prices (e.g., BUY_PARENT_SELL_CHILDREN)';
COMMENT ON COLUMN arb_signals.children_sum_bid IS 'Sum of bid prices for children markets. NULL for strategies that only use ask prices (e.g., SELL_PARENT_BUY_CHILDREN)';

