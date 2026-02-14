import { Injectable, Logger } from '@nestjs/common';
import { SocketManagerService } from './socket-manager.service';
import { BufferService } from './buffer.service';
import { RustSocketBridgeService } from './rust-socket-bridge.service';
import { isRustMode, getRunMode } from '../../common/config/run-mode';

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);
  private readonly rustMode: boolean;

  constructor(
    private readonly socketManager: SocketManagerService,
    private readonly bufferService: BufferService,
    private readonly rustSocketBridge: RustSocketBridgeService,
  ) {
    this.rustMode = isRustMode();
    this.logger.log(`IngestionService initialized with RUN_MODE=${getRunMode()}`);
  }

  /**
   * Check if tokens are already subscribed.
   * Only available in JS mode (Rust mode doesn't expose this yet).
   */
  areTokensSubscribed(tokenIds: string[]): boolean[] {
    if (this.rustMode) {
      return this.rustSocketBridge.areTokensSubscribed(tokenIds);
    }
    return this.socketManager.areTokensSubscribed(tokenIds);
  }

  /**
   * Get all subscribed tokens.
   * Only available in JS mode.
   */
  getSubscribedTokens(): string[] {
    if (this.rustMode) {
      return []; // TODO: expose from Rust via getSocketStatus
    }
    return this.socketManager.getSubscribedTokens();
  }

  /**
   * Subscribe to new token IDs.
   *
   * Routes to Rust or JS socket based on RUN_MODE env.
   */
  async subscribeToTokens(tokenIds: string[]): Promise<void> {
    this.logger.log(
      `Ingestion service subscribing to ${tokenIds.length} tokens (mode=${getRunMode()})`,
    );

    if (this.rustMode) {
      this.rustSocketBridge.subscribeToTokens(tokenIds);
    } else {
      await this.socketManager.subscribeToTokens(tokenIds);
    }
  }

  /**
   * Get ingestion statistics.
   */
  getStats(): any {
    if (this.rustMode) {
      return {
        bufferSize: this.bufferService.getBufferSize(),
        connections: this.rustSocketBridge.getStatus(),
      };
    }
    return {
      bufferSize: this.bufferService.getBufferSize(),
      connections: this.socketManager.getConnectionStatus(),
    };
  }

  /**
   * Force flush buffer (for testing or maintenance).
   */
  async forceFlush(): Promise<void> {
    await this.bufferService.forceFlush();
  }

  /**
   * Unsubscribe from token IDs.
   *
   * Routes to Rust or JS socket based on RUN_MODE env.
   */
  async unsubscribeFromTokens(tokenIds: string[]): Promise<void> {
    this.logger.log(
      `Ingestion service unsubscribing from ${tokenIds.length} tokens (mode=${getRunMode()})`,
    );

    if (this.rustMode) {
      this.rustSocketBridge.unsubscribeFromTokens(tokenIds);
    } else {
      await this.socketManager.unsubscribeFromTokens(tokenIds);
    }
  }
}
