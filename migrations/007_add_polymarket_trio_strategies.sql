-- Migration: Add Polymarket trio strategies to arb_signals table
-- Date: 2026-02-15
-- Description: Add POLYMARKET_TRIANGLE_BUY and POLYMARKET_COMPLEMENT_BUY strategies

DO $$ 
BEGIN
    -- Add POLYMARKET_TRIANGLE_BUY if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON e.enumtypid = t.oid
        WHERE t.typname = 'arb_signals_strategy_enum'
        AND e.enumlabel = 'POLYMARKET_TRIANGLE_BUY'
    ) THEN
        ALTER TYPE arb_signals_strategy_enum ADD VALUE 'POLYMARKET_TRIANGLE_BUY';
    END IF;

    -- Add POLYMARKET_COMPLEMENT_BUY if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON e.enumtypid = t.oid
        WHERE t.typname = 'arb_signals_strategy_enum'
        AND e.enumlabel = 'POLYMARKET_COMPLEMENT_BUY'
    ) THEN
        ALTER TYPE arb_signals_strategy_enum ADD VALUE 'POLYMARKET_COMPLEMENT_BUY';
    END IF;
END $$;

-- Verify the migration
SELECT enumlabel 
FROM pg_enum e
JOIN pg_type t ON e.enumtypid = t.oid
WHERE t.typname = 'arb_signals_strategy_enum'
ORDER BY e.enumsortorder;
