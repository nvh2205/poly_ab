import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnApplicationBootstrap,
} from '@nestjs/common';
import * as WebSocket from 'ws';
import { UtilService } from '../../common/services/util.service';
import { BufferService } from './buffer.service';
import {
  MarketData,
  SocketMessage,
} from '../../common/interfaces/market.interface';
import { APP_CONSTANTS } from '../../common/constants/app.constants';
import { RedisService } from '../../common/services/redis.service';

interface SocketConnection {
  ws: WebSocket;
  tokens: string[];
  pingInterval?: NodeJS.Timeout;
  reconnectAttempts: number;
}

@Injectable()
export class SocketManagerService
  implements OnModuleDestroy, OnApplicationBootstrap
{
  private readonly logger = new Logger(SocketManagerService.name);
  private readonly connections: Map<string, SocketConnection> = new Map();
  private readonly wsUrl: string = APP_CONSTANTS.POLYMARKET_WS_URL;
  private readonly maxTokensPerSocket: number =
    APP_CONSTANTS.MAX_TOKENS_PER_SOCKET;
  private readonly pingInterval: number = APP_CONSTANTS.PING_INTERVAL_MS;
  private readonly maxReconnectAttempts = 5;
  private readonly subscribedTokens: Set<string> = new Set();

  constructor(
    private readonly utilService: UtilService,
    private readonly bufferService: BufferService,
    private readonly redisService: RedisService,
  ) {
    this.logger.log(
      `SocketManager initialized with max tokens per socket: ${this.maxTokensPerSocket}`,
    );
  }

  /**
   * On application bootstrap, restore subscriptions from Redis
   */
  async onApplicationBootstrap() {
    // await this.subscribeToTokens([
    //   '94164450030368190400729331975351099941603993532048876081305050829912705949378',
    //   '19694973394230695654914264856659289660682856244721407447188824491392283705947',
    // ]);
  }

  /**
   * Check if tokens are already subscribed
   */
  areTokensSubscribed(tokenIds: string[]): boolean[] {
    return tokenIds.map((tokenId) => this.subscribedTokens.has(tokenId));
  }

  /**
   * Get all subscribed tokens
   */
  getSubscribedTokens(): string[] {
    return Array.from(this.subscribedTokens);
  }

  /**
   * Subscribe to new tokens (with deduplication)
   */
  async subscribeToTokens(tokenIds: string[]): Promise<void> {
    // Filter out already subscribed tokens
    const newTokens = tokenIds.filter(
      (tokenId) => !this.subscribedTokens.has(tokenId),
    );

    if (newTokens.length === 0) {
      this.logger.log('No new tokens to subscribe (all already subscribed)');
      return;
    }

    this.logger.log(
      `Subscribing to ${newTokens.length} new tokens (filtered from ${tokenIds.length} total)`,
    );

    // Add to subscribed set
    newTokens.forEach((token) => this.subscribedTokens.add(token));

    // Chunk tokens into groups of max size
    const chunks = this.utilService.chunkArray(
      newTokens,
      this.maxTokensPerSocket,
    );

    this.logger.log(`Created ${chunks.length} socket connections`);

    // Create a socket connection for each chunk
    for (const [index, chunk] of chunks.entries()) {
      const connectionId = `socket-${Date.now()}-${index}`;
      await this.createSocketConnection(connectionId, chunk);
      // Small delay to avoid overwhelming the server
      await this.utilService.sleep(100);
    }
  }

  /**
   * Create a new WebSocket connection
   */
  private async createSocketConnection(
    connectionId: string,
    tokens: string[],
  ): Promise<void> {
    try {
      this.logger.log(
        `Creating socket connection ${connectionId} for ${tokens.length} tokens`,
      );

      const ws = new WebSocket.WebSocket(this.wsUrl);
      const connection: SocketConnection = {
        ws,
        tokens,
        reconnectAttempts: 0,
      };

      ws.on('open', () => {
        this.logger.log(`Socket ${connectionId} opened`);
        this.handleOpen(connectionId, connection);
      });

      ws.on('message', (data: any) => {
        this.handleMessage(connectionId, data);
      });

      ws.on('error', (error: Error) => {
        this.logger.error(`Socket ${connectionId} error:`, error.message);
      });

      ws.on('close', (code: number, reason: Buffer) => {
        this.logger.warn(
          `Socket ${connectionId} closed: ${code} - ${reason?.toString() || 'unknown'}`,
        );
        this.handleClose(connectionId, connection);
      });

      ws.on('pong', () => {
        // this.logger.debug(`Received pong from ${connectionId}`);
      });

      this.connections.set(connectionId, connection);
    } catch (error) {
      this.logger.error(
        `Error creating socket connection ${connectionId}:`,
        error.message,
      );
    }
  }

  /**
   * Handle WebSocket open event
   */
  private handleOpen(connectionId: string, connection: SocketConnection): void {
    const { ws, tokens } = connection;

    // Send subscription message
    const subscriptionMessage = {
      assets_ids: tokens,
      type: 'market',
    };

    const messageStr = JSON.stringify(subscriptionMessage);
    this.logger.debug(
      `Sending subscription message on ${connectionId}: ${messageStr.substring(0, 200)}...`,
    );

    ws.send(messageStr);
    this.logger.log(`Subscribed to ${tokens.length} tokens on ${connectionId}`);

    // Setup ping interval
    connection.pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.WebSocket.OPEN) {
        ws.ping();
      }
    }, this.pingInterval);

    // Reset reconnect attempts on successful connection
    connection.reconnectAttempts = 0;
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(connectionId: string, data: any): void {
    try {
      const message = data.toString();
      // Skip ping/pong messages
      if (message === 'PONG' || message === 'PING') {
        return;
      }

      // Parse JSON message
      const parsed = JSON.parse(message);
      
      // Handle both array and single object formats
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      
      for (const msg of messages) {
        // Handle different event types
        if (msg.event_type === 'book') {
          // Transform to our data format
          let bookTimestamp: number;
          if (typeof msg.timestamp === 'string') {
            bookTimestamp = parseInt(msg.timestamp, 10);
          } else {
            bookTimestamp = msg.timestamp || Date.now();
          }

          const marketData: MarketData = {
            market: msg.market || '',
            asset_id: msg.asset_id || '',
            timestamp: bookTimestamp,
            bids: msg.bids || null,
            asks: msg.asks || null,
            last_trade_price: msg.last_trade_price ? parseFloat(msg.last_trade_price) : null,
          };

          // Push to buffer for batch processing
          this.bufferService.push(marketData);
        } else if (msg.event_type === 'price_change') {
          // Handle price_change event - only update best_bid and best_ask
          // Do NOT include size/side as they represent user orders on the orderbook
          // if (msg.price_changes && Array.isArray(msg.price_changes)) {
          //   let timestamp: number;

          //   if (typeof msg.timestamp === 'string') {
          //     timestamp = parseInt(msg.timestamp, 10);
          //   } else {
          //     timestamp = msg.timestamp || Date.now();
          //   }
          //   for (const change of msg.price_changes) {
          //     const priceChangeData = {
          //       market: msg.market || '',
          //       asset_id: change.asset_id,
          //       timestamp: timestamp,
          //       best_bid: parseFloat(change.best_bid),
          //       best_ask: parseFloat(change.best_ask),
          //     };
          //     // Push to price change buffer
          //     this.bufferService.pushPriceChange(priceChangeData);
          //   }
          // }
        }
      }
    } catch (error) {
      // this.logger.error(
      //   `Error handling message from ${connectionId}:`,
      //   error.message,
      // );
    }
  }

  /**
   * Handle WebSocket close event
   */
  private handleClose(
    connectionId: string,
    connection: SocketConnection,
  ): void {
    // Clear ping interval
    if (connection.pingInterval) {
      clearInterval(connection.pingInterval);
    }

    // Attempt to reconnect
    if (connection.reconnectAttempts < this.maxReconnectAttempts) {
      connection.reconnectAttempts++;
      const delay = Math.min(
        1000 * Math.pow(2, connection.reconnectAttempts),
        30000,
      );

      this.logger.log(
        `Reconnecting ${connectionId} in ${delay}ms (attempt ${connection.reconnectAttempts}/${this.maxReconnectAttempts})`,
      );

      setTimeout(() => {
        this.reconnect(connectionId, connection.tokens);
      }, delay);
    } else {
      this.logger.error(
        `Max reconnect attempts reached for ${connectionId}. Giving up.`,
      );
      this.connections.delete(connectionId);
    }
  }

  /**
   * Reconnect a socket
   */
  private async reconnect(
    connectionId: string,
    tokens: string[],
  ): Promise<void> {
    this.connections.delete(connectionId);
    await this.createSocketConnection(connectionId, tokens);
  }

  /**
   * Close all connections (graceful shutdown)
   */
  async closeAllConnections(): Promise<void> {
    this.logger.log('Closing all socket connections...');

    for (const [connectionId, connection] of this.connections.entries()) {
      if (connection.pingInterval) {
        clearInterval(connection.pingInterval);
      }

      if (connection.ws.readyState === WebSocket.WebSocket.OPEN) {
        connection.ws.close();
      }

      this.connections.delete(connectionId);
    }

    this.logger.log('All socket connections closed');
  }

  /**
   * Get connection status
   */
  getConnectionStatus(): any {
    const status = [];

    for (const [connectionId, connection] of this.connections.entries()) {
      status.push({
        id: connectionId,
        state: this.getReadyStateString(connection.ws.readyState),
        tokens: connection.tokens.length,
        reconnectAttempts: connection.reconnectAttempts,
      });
    }

    return status;
  }

  /**
   * Get readable state string
   */
  private getReadyStateString(state: number): string {
    switch (state) {
      case WebSocket.WebSocket.CONNECTING:
        return 'CONNECTING';
      case WebSocket.WebSocket.OPEN:
        return 'OPEN';
      case WebSocket.WebSocket.CLOSING:
        return 'CLOSING';
      case WebSocket.WebSocket.CLOSED:
        return 'CLOSED';
      default:
        return 'UNKNOWN';
    }
  }

  /**
   * Unsubscribe from tokens (remove from subscriptions and close related connections)
   */
  async unsubscribeFromTokens(tokenIds: string[]): Promise<void> {
    if (!tokenIds || tokenIds.length === 0) {
      return;
    }

    this.logger.log(`Unsubscribing from ${tokenIds.length} tokens`);

    // Remove from subscribed set
    tokenIds.forEach((token) => this.subscribedTokens.delete(token));

    // Remove from Redis
    if (tokenIds.length > 0) {
      await this.redisService.srem('active_clob_tokens', ...tokenIds);
    }

    // Remove token metadata from Redis
    for (const tokenId of tokenIds) {
      await this.redisService.del(`token_metadata:${tokenId}`);
    }

    // Find connections that contain expired tokens and collect active tokens that need to be reconnected
    const connectionsToClose: string[] = [];
    const tokensToReconnect: string[] = [];

    for (const [connectionId, connection] of this.connections.entries()) {
      const hasExpiredTokens = tokenIds.some((token) =>
        connection.tokens.includes(token),
      );

      if (hasExpiredTokens) {
        connectionsToClose.push(connectionId);

        // Collect non-expired tokens from this connection that need to be reconnected
        const activeTokensInConnection = connection.tokens.filter(
          (token) => !tokenIds.includes(token),
        );
        tokensToReconnect.push(...activeTokensInConnection);
      }
    }

    // Close connections containing expired tokens
    for (const connectionId of connectionsToClose) {
      const connection = this.connections.get(connectionId);
      if (connection) {
        this.logger.log(
          `Closing connection ${connectionId} (had ${connection.tokens.length} tokens, ${connection.tokens.filter((t) => tokenIds.includes(t)).length} expired)`,
        );
        if (connection.pingInterval) {
          clearInterval(connection.pingInterval);
        }
        if (connection.ws.readyState === WebSocket.WebSocket.OPEN) {
          connection.ws.close();
        }
        this.connections.delete(connectionId);
      }
    }

    // Reconnect active tokens that were in closed connections
    if (tokensToReconnect.length > 0) {
      this.logger.log(
        `Reconnecting ${tokensToReconnect.length} active tokens from closed connections`,
      );
      // Remove from subscribedTokens first so subscribeToTokens will process them
      tokensToReconnect.forEach((token) => this.subscribedTokens.delete(token));
      await this.subscribeToTokens(tokensToReconnect);
    }

    this.logger.log(`Successfully unsubscribed from ${tokenIds.length} tokens`);
  }

  /**
   * Module cleanup
   */
  async onModuleDestroy() {
    await this.closeAllConnections();
    // Force flush any remaining data
    await this.bufferService.forceFlush();
  }
}
