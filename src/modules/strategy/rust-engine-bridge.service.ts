import {
    Injectable,
    Logger,
    OnApplicationBootstrap,
    OnModuleDestroy,
} from '@nestjs/common';
import * as path from 'path';
import { isRustMode, getRunMode } from '../../common/config/run-mode';
import { ethers } from 'ethers';
import { Observable, Subject } from 'rxjs';
import { MarketStructureService } from './market-structure.service';
import { loadPolymarketConfig } from '../../common/services/polymarket-onchain.config';
import { PolymarketOnchainService } from '../../common/services/polymarket-onchain.service';
import { RedisService } from '../../common/services/redis.service';
import { WORKER_USDC_BALANCE_KEY } from '../worker/worker-cron.service';
import { RangeGroup, MarketRangeDescriptor } from './interfaces/range-group.interface';

/**
 * Rust TradeResult — received from Rust executor via onTradeResult callback.
 * Matches `TradeResult` struct in `rust-core/src/types/order.rs`.
 */
export interface RustTradeResult {
    success: boolean;
    orderIds: string[];
    successfulOrders: Array<{
        tokenId: string;
        marketSlug: string;
        side: string;
        price: number;
        size: number;
        negRisk: boolean;
    }>;
    failedOrders: Array<{
        tokenId: string;
        marketSlug: string;
        side: string;
        price: number;
        errorMsg: string;
    }>;
    totalCost: number;
    expectedPnl: number;
    latencyUs: number;
    signalGroupKey: string;
    signalEventSlug: string;
    signalCrypto: string;
    signalStrategy: string;
    signalProfitAbs: number;
    signalProfitBps: number;
    signalTimestampMs: number;

    // Signal snapshot: Parent
    signalParentAssetId: string;
    signalParentMarketSlug: string;
    signalParentBestBid: number | null;
    signalParentBestAsk: number | null;
    signalParentBestBidSize: number | null;
    signalParentBestAskSize: number | null;
    signalParentNegRisk: boolean;

    // Signal snapshot: Parent Upper
    signalParentUpperAssetId: string;
    signalParentUpperMarketSlug: string;
    signalParentUpperBestBid: number | null;
    signalParentUpperBestAsk: number | null;
    signalParentUpperBestBidSize: number | null;
    signalParentUpperBestAskSize: number | null;
    signalParentUpperNegRisk: boolean;

    // Signal snapshot: Child
    signalChildAssetId: string;
    signalChildMarketSlug: string;
    signalChildBestBid: number | null;
    signalChildBestAsk: number | null;
    signalChildBestBidSize: number | null;
    signalChildBestAskSize: number | null;
    signalChildNegRisk: boolean;
    signalChildIndex: number;

    // Aggregates
    signalChildrenSumAsk: number;
    signalChildrenSumBid: number;

    // Triangle context
    signalTriangleTotalCost: number | null;
    signalTriangleTotalBid: number | null;
    signalTrianglePayout: number | null;
    signalTriangleMode: string | null;

    signalReason: string;
}

/**
 * Bridge service for Rust-based arbitrage engine + executor.
 *
 * When `RUN_MODE=rust`, this service:
 * 1. Loads the rust-core native module
 * 2. Pushes market structure to Rust via updateMarketStructure()
 * 3. Initializes the Rust executor (signer + HTTP client + validation)
 * 4. Registers onTradeResult() callback to receive trade results
 * 5. Pushes USDC balance updates to Rust via updateBalance()
 * 6. Exposes onTradeResult$() Observable for downstream result handling
 *
 * When `RUN_MODE=js` (default), this service is inactive.
 * RealExecutionService subscribes to whichever mode is active.
 */
@Injectable()
export class RustEngineBridgeService
    implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(RustEngineBridgeService.name);
    private rustCore: any = null;
    private isActive = false;
    private executorActive = false;
    private tradingEnabled = false;

    private readonly tradeResult$ = new Subject<RustTradeResult>();
    private balanceRefreshInterval?: ReturnType<typeof setInterval>;

    // Cache: market descriptors for signal conversion
    private descriptorCache = new Map<string, {
        descriptor: MarketRangeDescriptor;
        role: 'parent' | 'child';
        groupKey: string;
    }>();

    constructor(
        private readonly marketStructureService: MarketStructureService,
        private readonly redisService: RedisService,
        private readonly polymarketOnchainService: PolymarketOnchainService,
    ) { }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    async onApplicationBootstrap(): Promise<void> {
        if (!isRustMode()) {
            this.logger.log(
                `RUN_MODE=${getRunMode()}, Rust engine bridge is INACTIVE`,
            );
            return;
        }

        try {
            this.rustCore = require(path.join(process.cwd(), 'rust-core'));

            // Configure engine with env vars
            this.rustCore.updateEngineConfig({
                minProfitBps: parseFloat(process.env.ARB_MIN_PROFIT_BPS || '5'),
                minProfitAbs: parseFloat(process.env.ARB_MIN_PROFIT_ABS || '0'),
                cooldownMs: parseInt(process.env.ARB_COOLDOWN_MS || '1000', 10),
            });

            this.isActive = true;
            this.logger.log(
                '✅ Rust engine bridge initialized — RUN_MODE=rust',
            );

            // === EXECUTOR INITIALIZATION (always active when RUN_MODE=rust) ===
            await this.initRustExecutor();
        } catch (error) {
            this.logger.error(
                `Failed to initialize Rust engine bridge: ${error.message}`,
            );
            this.logger.warn(
                'Falling back to JS mode. Set RUN_MODE=js to suppress this warning.',
            );
            this.isActive = false;
        }
    }

    onModuleDestroy(): void {
        this.tradeResult$.complete();
        if (this.balanceRefreshInterval) {
            clearInterval(this.balanceRefreshInterval);
        }
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    get active(): boolean {
        return this.isActive;
    }

    get executorIsActive(): boolean {
        return this.executorActive;
    }

    /**
     * Observable for trade results from Rust executor.
     * RealExecutionService subscribes to this for DB save, Telegram, etc.
     */
    onTradeResult(): Observable<RustTradeResult> {
        return this.tradeResult$.asObservable();
    }

    /**
     * Enable/disable real trading at runtime.
     * Propagates to Rust executor validation state.
     */
    setTradingEnabled(enabled: boolean): void {
        this.tradingEnabled = enabled;
        if (this.executorActive && this.rustCore) {
            this.rustCore.setTradingEnabled(enabled);
            this.logger.log(`Rust executor trading ${enabled ? 'ENABLED' : 'DISABLED'}`);
        }
    }

    /**
     * Push balance update to Rust executor (called externally or from refresh cycle).
     */
    updateBalance(usdcBalance: number): void {
        if (this.executorActive && this.rustCore) {
            this.rustCore.updateBalance(usdcBalance);
        }
    }

    /**
     * Push minted asset balances for a group to Rust executor.
     * Used for SELL leg validation — Rust skips if minted < default_size.
     */
    updateMintedAssets(groupKey: string, assets: Map<string, number>): void {
        if (this.executorActive && this.rustCore) {
            const entries = Array.from(assets.entries()).map(([tokenId, amount]) => ({
                tokenId,
                amount,
            }));
            this.rustCore.updateMintedAssets(groupKey, entries);
        }
    }

    /**
     * Push all minted asset caches to Rust executor (bulk).
     * Called from RealExecutionService after minted refresh.
     */
    pushAllMintedAssets(mintedCache: Map<string, Map<string, number>>): void {
        if (!this.executorActive || !this.rustCore) return;
        for (const [groupKey, assets] of mintedCache) {
            this.updateMintedAssets(groupKey, assets);
        }
    }

    hasGroups(): boolean {
        if (!this.isActive || !this.rustCore) return false;
        const status = this.rustCore.getEngineStatus();
        return status.totalGroups > 0;
    }

    getGroupKeys(): string[] {
        return Array.from(
            new Set(
                Array.from(this.descriptorCache.values()).map((e) => e.groupKey),
            ),
        );
    }

    // =========================================================================
    // MARKET STRUCTURE SYNC
    // =========================================================================

    /**
     * Push market structure to Rust engine.
     * Called by MarketService after market structure is rebuilt.
     */
    syncMarketStructure(): number {
        if (!this.isActive || !this.rustCore) {
            return 0;
        }

        const groups = this.marketStructureService.getAllGroups();
        if (groups.length === 0) {
            this.logger.warn('No groups available for Rust engine sync');
            return 0;
        }

        // Convert RangeGroup[] to Rust N-API input format
        const napiGroups = groups.map((g) => this.convertGroupToNapi(g));

        const trioCount = this.rustCore.updateMarketStructure(napiGroups);

        // Rebuild descriptor cache for signal conversion
        this.rebuildDescriptorCache(groups);

        this.logger.log(
            `Rust engine synced: ${groups.length} groups, ${trioCount} trios`,
        );

        return trioCount;
    }

    /**
     * Called by MarketService when groups are cleaned up.
     */
    cleanupExpiredGroups(groupKeys: string[]): number {
        // Remove from descriptor cache
        let removed = 0;
        for (const [slug, entry] of this.descriptorCache) {
            if (groupKeys.includes(entry.groupKey)) {
                this.descriptorCache.delete(slug);
                removed++;
            }
        }

        // Re-sync structure (Rust engine rebuilds entirely)
        if (this.isActive) {
            this.syncMarketStructure();
        }

        return removed;
    }

    /**
     * Ensure engine has groups, trigger sync if not.
     */
    async ensureBootstrapped(): Promise<void> {
        if (this.hasGroups()) {
            return;
        }
        this.logger.log('Rust engine has no groups, triggering sync...');
        await this.marketStructureService.rebuild();
        this.syncMarketStructure();
    }

    // =========================================================================
    // CONVERSION: RangeGroup → Rust N-API input
    // =========================================================================

    private convertGroupToNapi(group: RangeGroup): any {
        return {
            groupKey: group.groupKey,
            eventSlug: group.eventSlug || '',
            crypto: group.crypto || '',
            children: group.children
                .filter((c) => c.clobTokenIds?.length >= 2)
                .map((c) => ({
                    marketId: c.marketId,
                    slug: c.slug,
                    clobTokenIds: c.clobTokenIds,
                    boundsLower: c.bounds?.lower ?? undefined,
                    boundsUpper: c.bounds?.upper ?? undefined,
                    kind: c.kind || 'unknown',
                    negRisk: c.negRisk ?? false,
                })),
            parents: group.parents
                .filter((p) => p.clobTokenIds?.length >= 2)
                .map((p) => ({
                    marketId: p.marketId,
                    slug: p.slug,
                    clobTokenIds: p.clobTokenIds,
                    boundsLower: p.bounds?.lower ?? undefined,
                    boundsUpper: p.bounds?.upper ?? undefined,
                    kind: p.kind || 'unknown',
                    negRisk: p.negRisk ?? false,
                })),
        };
    }

    // =========================================================================
    // HELPERS
    // =========================================================================

    private rebuildDescriptorCache(groups: RangeGroup[]): void {
        this.descriptorCache.clear();
        for (const group of groups) {
            for (const child of group.children) {
                this.descriptorCache.set(child.slug, {
                    descriptor: child,
                    role: 'child',
                    groupKey: group.groupKey,
                });
            }
            for (const parent of group.parents) {
                this.descriptorCache.set(parent.slug, {
                    descriptor: parent,
                    role: 'parent',
                    groupKey: group.groupKey,
                });
            }
        }
    }

    // =========================================================================
    // EXECUTOR INITIALIZATION
    // =========================================================================

    /**
     * Initialize the Rust executor:
     * - Load Polymarket config (private key, API credentials)
     * - Derive signer address from private key
     * - Call rustCore.initExecutor(config)
     * - Register onTradeResult callback
     * - Start background balance push cycle
     */
    private async initRustExecutor(): Promise<void> {
        try {
            const config = loadPolymarketConfig();

            // Derive signer address from private key
            const wallet = new ethers.Wallet(config.privateKey);
            const signerAddress = wallet.address;

            // Get CLOB API credentials (auto-derived from wallet if env vars not set)
            const creds = await this.polymarketOnchainService.getApiCredentials();
            this.logger.log(`API credentials resolved for signer=${signerAddress.substring(0, 10)}...`);

            // Initialize executor in Rust
            this.rustCore.initExecutor({
                privateKey: config.privateKey,
                proxyAddress: config.proxyAddress,
                signerAddress: creds.signerAddress,
                apiKey: creds.apiKey,
                apiSecret: creds.apiSecret,
                apiPassphrase: creds.apiPassphrase,
                clobUrl: config.clobUrl || undefined,
                minPnlThresholdPercent: parseFloat(
                    process.env.REAL_TRADING_MIN_PNL_PERCENT || '0.7',
                ),
                defaultSize: parseFloat(
                    process.env.REAL_TRADE_SIZE || '10',
                ),
                slippageEnabled:
                    process.env.SLIPPAGE_ENABLED === 'false',
                opportunityTimeoutMs: parseInt(
                    process.env.ARB_COOLDOWN_MS || '20000',
                    10,
                ),
            });

            // Register trade result callback
            this.rustCore.onTradeResult((result: RustTradeResult) => {
                try {
                    this.tradeResult$.next(result);
                } catch (err) {
                    this.logger.error(
                        `Trade result callback error: ${err.message}`,
                    );
                }
            });

            // Trading starts DISABLED — only enabled via API (enableTrading())
            this.rustCore.setTradingEnabled(this.tradingEnabled);

            // Push initial balance
            await this.pushBalanceToRust();

            // Background balance refresh (every 5s, push to Rust)
            this.balanceRefreshInterval = setInterval(() => {
                this.pushBalanceToRust().catch(() => {
                    // Silent fail — Rust will just keep old balance
                });
            }, 5000);

            this.executorActive = true;
            this.logger.log(
                `🦀 Rust executor initialized — signer=${signerAddress.substring(0, 10)}...`,
            );
            this.logger.log(
                `   trading=${this.tradingEnabled}, size=${process.env.REAL_TRADE_SIZE || '10'}, ` +
                `pnl_threshold=${process.env.REAL_TRADING_MIN_PNL_PERCENT || '1'}%`,
            );
        } catch (error) {
            this.logger.error(
                `Failed to initialize Rust executor: ${error.message}`,
            );
            this.logger.warn(
                'Falling back to JS execution. Set RUN_MODE=js to suppress this warning.',
            );
            this.executorActive = false;
        }
    }

    /**
     * Read USDC balance from Redis (or fallback) and push to Rust executor.
     */
    private async pushBalanceToRust(): Promise<void> {
        try {
            const balanceStr = await this.redisService.get(
                WORKER_USDC_BALANCE_KEY,
            );
            if (balanceStr !== null) {
                const balance = parseFloat(balanceStr) || 0;
                this.rustCore.updateBalance(balance);
            }
        } catch {
            // Silent fail — balance will be stale but not crash
        }
    }
}
