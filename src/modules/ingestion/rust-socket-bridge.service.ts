import {
    Injectable,
    Logger,
    OnApplicationBootstrap,
    OnModuleDestroy,
} from '@nestjs/common';
import * as path from 'path';
import { isRustMode, getRunMode } from '../../common/config/run-mode';
import { RedisService } from '../../common/services/redis.service';
import { APP_CONSTANTS } from '../../common/constants/app.constants';

/**
 * Bridge service for Rust-based WebSocket data ingestion.
 *
 * When `RUN_MODE=rust`, this service initializes the Rust native module
 * (`rust-core`) to handle WebSocket connections, message parsing, and
 * top-of-book extraction. All data flows stay in Rust — no callbacks
 * to Node.js for price data.
 *
 * When `RUN_MODE=js` (default), this service does nothing and the existing
 * SocketManagerService handles all WebSocket connections.
 */
@Injectable()
export class RustSocketBridgeService
    implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(RustSocketBridgeService.name);
    private rustCore: any = null;
    private isActive = false;
    private subscribedTokens = new Set<string>();

    constructor(
        private readonly redisService: RedisService,
    ) { }

    /**
     * On application bootstrap, initialize Rust socket if RUN_MODE=rust.
     */
    async onApplicationBootstrap(): Promise<void> {
        if (!isRustMode()) {
            this.logger.log(
                `RUN_MODE=${getRunMode()}, Rust socket bridge is INACTIVE`,
            );
            return;
        }

        try {
            // Load the Rust native module
            this.rustCore = require(path.join(process.cwd(), 'rust-core'));

            // Initialize the socket engine
            this.rustCore.initSocket({
                wsUrl: APP_CONSTANTS.POLYMARKET_WS_URL,
                maxTokensPerConnection: APP_CONSTANTS.MAX_TOKENS_PER_SOCKET || 50,
                pingIntervalMs: 15000,
                reconnectBaseDelayMs: 1000,
                reconnectMaxDelayMs: 30000,
                maxReconnectAttempts: -1, // unlimited
                verbose: process.env.RUST_SOCKET_VERBOSE === 'true',
            });

            // No callback registration needed — entire data flow stays in Rust:
            // socket → engine → executor → on_trade_result (only callback)

            this.isActive = true;
            this.logger.log(
                '✅ Rust socket bridge initialized — RUN_MODE=rust',
            );

            // Restore subscriptions from Redis (same as SocketManagerService)
            await this.restoreSubscriptionsFromRedis();
        } catch (error) {
            this.logger.error(
                `Failed to initialize Rust socket bridge: ${error.message}`,
            );
            this.logger.warn(
                'Falling back to JS socket mode. Set RUN_MODE=js to suppress this warning.',
            );
            this.isActive = false;
        }
    }

    /**
     * Subscribe to tokens via the Rust socket engine.
     */
    subscribeToTokens(tokenIds: string[]): void {
        if (!this.isActive || !this.rustCore) {
            return;
        }
        this.rustCore.subscribeTokens(tokenIds);
        for (const id of tokenIds) {
            this.subscribedTokens.add(id);
        }
        this.logger.debug(`Subscribed ${tokenIds.length} tokens via Rust socket (total: ${this.subscribedTokens.size})`);
    }

    /**
     * Unsubscribe from tokens via the Rust socket engine.
     */
    unsubscribeFromTokens(tokenIds: string[]): void {
        if (!this.isActive || !this.rustCore) {
            return;
        }
        this.rustCore.unsubscribeTokens(tokenIds);
        for (const id of tokenIds) {
            this.subscribedTokens.delete(id);
        }
        this.logger.debug(
            `Unsubscribed ${tokenIds.length} tokens via Rust socket (total: ${this.subscribedTokens.size})`,
        );
    }

    /**
     * Get the Rust socket status for monitoring.
     */
    getStatus(): any {
        if (!this.isActive || !this.rustCore) {
            return { active: false, mode: 'js' };
        }
        const status = this.rustCore.getSocketStatus();
        return { active: true, mode: 'rust', ...status };
    }

    /**
     * Is the Rust socket bridge currently active?
     */
    get active(): boolean {
        return this.isActive;
    }

    /**
     * Check which tokens are already subscribed (TypeScript-side tracking).
     */
    areTokensSubscribed(tokenIds: string[]): boolean[] {
        return tokenIds.map((id) => this.subscribedTokens.has(id));
    }

    /**
     * Restore token subscriptions from Redis on startup.
     * Mirrors SocketManagerService.onApplicationBootstrap() behavior.
     */
    private async restoreSubscriptionsFromRedis(): Promise<void> {
        try {
            const savedTokens = await this.redisService.get(
                'subscribed_socket_tokens',
            );
            if (savedTokens) {
                const tokenIds: string[] = JSON.parse(savedTokens);
                if (tokenIds.length > 0) {
                    this.logger.log(
                        `Restoring ${tokenIds.length} token subscriptions from Redis`,
                    );
                    this.subscribeToTokens(tokenIds);
                }
            }
        } catch (error) {
            this.logger.warn(
                `Failed to restore subscriptions from Redis: ${error.message}`,
            );
        }
    }

    /**
     * Graceful shutdown — close all Rust WebSocket connections.
     */
    async onModuleDestroy(): Promise<void> {
        if (this.isActive && this.rustCore) {
            this.logger.log('Shutting down Rust socket bridge');
            this.rustCore.shutdownSocket();
            this.isActive = false;
        }
    }
}
