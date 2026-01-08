-- Migration 005: Add total_cost column to arb_paper_trades
-- Purpose: store total buy-side cost for each paper trade simulation

ALTER TABLE arb_paper_trades
ADD COLUMN total_cost DECIMAL(18, 8) NULL;

COMMENT ON COLUMN arb_paper_trades.total_cost IS 'Total cost spent on buy legs in paper trade';
