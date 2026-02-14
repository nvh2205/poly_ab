/**
 * Centralized RUN_MODE configuration.
 *
 * Single env var `RUN_MODE` controls the entire runtime:
 *   - `RUN_MODE=rust`  → All Rust components active, all JS counterparts inactive
 *   - `RUN_MODE=js`    → All JS components active (default, legacy behavior)
 *
 * This replaces the previous 3 separate flags:
 *   ENGINE_MODE, EXECUTOR_MODE, SOCKET_MODE
 */

export type RunMode = 'rust' | 'js';

/**
 * Returns the raw RUN_MODE string for logging.
 * Reads directly from process.env to ensure value is available after ConfigModule loads .env
 */
export function getRunMode(): RunMode {
    const mode = process.env.RUN_MODE || 'js';
    return mode.trim() as RunMode;
}

/**
 * Returns true when the entire pipeline should use Rust:
 *   Socket (ingestion) → Engine (arbitrage) → Executor (order placement)
 */
export function isRustMode(): boolean {
    return getRunMode() === 'rust';
}
