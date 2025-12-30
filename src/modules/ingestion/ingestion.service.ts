import { Injectable, Logger } from '@nestjs/common';
import { SocketManagerService } from './socket-manager.service';
import { BufferService } from './buffer.service';

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly socketManager: SocketManagerService,
    private readonly bufferService: BufferService,
  ) {}

  /**
   * Check if tokens are already subscribed
   */
  areTokensSubscribed(tokenIds: string[]): boolean[] {
    return this.socketManager.areTokensSubscribed(tokenIds);
  }

  /**
   * Get all subscribed tokens
   */
  getSubscribedTokens(): string[] {
    return this.socketManager.getSubscribedTokens();
  }

  /**
   * Subscribe to new token IDs
   */
  async subscribeToTokens(tokenIds: string[]): Promise<void> {
    this.logger.log(
      `Ingestion service subscribing to ${tokenIds.length} tokens`,
    );
    await this.socketManager.subscribeToTokens(tokenIds);
  }

  /**
   * Get ingestion statistics
   */
  getStats(): any {
    return {
      bufferSize: this.bufferService.getBufferSize(),
      connections: this.socketManager.getConnectionStatus(),
    };
  }

  /**
   * Force flush buffer (for testing or maintenance)
   */
  async forceFlush(): Promise<void> {
    await this.bufferService.forceFlush();
  }

  /**
   * Unsubscribe from token IDs
   */
  async unsubscribeFromTokens(tokenIds: string[]): Promise<void> {
    this.logger.log(
      `Ingestion service unsubscribing from ${tokenIds.length} tokens`,
    );
    await this.socketManager.unsubscribeFromTokens(tokenIds);
  }
}
