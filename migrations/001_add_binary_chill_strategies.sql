-- Migration: Add new binary chill strategies to arb_signals table
-- Date: 2026-01-03
-- Description: Add BUY_PARENT_NO_SELL_CHILD_YES and BUY_PARENT_NO_SELL_CHILD_NO strategies

-- Step 1: Alter the strategy enum to include new values
-- Note: PostgreSQL doesn't support directly altering enums, so we need to use a workaround

-- First, check if the new values already exist
DO $$ 
BEGIN
    -- Add BUY_PARENT_NO_SELL_CHILD_YES if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON e.enumtypid = t.oid
        WHERE t.typname = 'arb_signals_strategy_enum'
        AND e.enumlabel = 'BUY_PARENT_NO_SELL_CHILD_YES'
    ) THEN
        ALTER TYPE arb_signals_strategy_enum ADD VALUE 'BUY_PARENT_NO_SELL_CHILD_YES';
    END IF;

    -- Add BUY_PARENT_NO_SELL_CHILD_NO if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON e.enumtypid = t.oid
        WHERE t.typname = 'arb_signals_strategy_enum'
        AND e.enumlabel = 'BUY_PARENT_NO_SELL_CHILD_NO'
    ) THEN
        ALTER TYPE arb_signals_strategy_enum ADD VALUE 'BUY_PARENT_NO_SELL_CHILD_NO';
    END IF;
END $$;

-- Step 2: Add comments for documentation
COMMENT ON COLUMN arb_signals.strategy IS 
'Arbitrage strategy type:
- SELL_PARENT_BUY_CHILDREN: Unbundling (short parent, long children)
- BUY_PARENT_SELL_CHILDREN: Bundling (long parent, short children)
- BUY_CHILD_YES_SELL_PARENT_NO: Binary complement arbitrage - buy YES(child <X), sell NO(parent >X)
- BUY_PARENT_NO_SELL_CHILD_YES: Binary complement arbitrage - buy NO(parent >X), sell YES(child <X)
- BUY_CHILD_YES_SELL_PARENT_YES: Binary same-direction arbitrage - buy YES(child >X), sell YES(parent >X)
- BUY_PARENT_NO_SELL_CHILD_NO: Binary same-direction arbitrage - buy NO(parent >X), sell NO(child >X)';

-- Verify the migration
SELECT enumlabel 
FROM pg_enum e
JOIN pg_type t ON e.enumtypid = t.oid
WHERE t.typname = 'arb_signals_strategy_enum'
ORDER BY e.enumsortorder;

