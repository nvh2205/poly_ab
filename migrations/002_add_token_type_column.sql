-- Migration: Add token_type column to arb_signals table
-- Date: 2026-01-04
-- Description: Add token_type enum column to track whether arbitrage is on YES or NO token

-- Step 1: Create enum type for token_type
DO $$ 
BEGIN
    -- Create token_type enum if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'arb_signals_token_type_enum') THEN
        CREATE TYPE arb_signals_token_type_enum AS ENUM ('yes', 'no');
    END IF;
END $$;

-- Step 2: Add token_type column with default 'yes'
DO $$ 
BEGIN
    -- Add column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'arb_signals' 
        AND column_name = 'token_type'
    ) THEN
        ALTER TABLE arb_signals 
        ADD COLUMN token_type arb_signals_token_type_enum NOT NULL DEFAULT 'yes';
        
        -- Add comment
        COMMENT ON COLUMN arb_signals.token_type IS 
        'Token type being arbitraged in binary markets:
        - yes: Trading YES token
        - no: Trading NO token
        Default is yes for backward compatibility and range arbitrage.';
        
        -- Create index for faster queries
        CREATE INDEX idx_arb_signals_token_type ON arb_signals(token_type);
    END IF;
END $$;

-- Step 3: Verify the migration
SELECT 
    column_name,
    data_type,
    column_default,
    is_nullable
FROM information_schema.columns
WHERE table_name = 'arb_signals' 
AND column_name = 'token_type';

-- Show sample data
SELECT 
    strategy,
    token_type,
    COUNT(*) as count
FROM arb_signals
GROUP BY strategy, token_type
ORDER BY strategy, token_type;

