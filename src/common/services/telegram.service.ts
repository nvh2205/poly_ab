import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as TelegramBot from 'node-telegram-bot-api';

export interface OrderDetail {
  tokenID: string;
  marketSlug?: string;
  side: 'BUY' | 'SELL';
  price: number;
  errorMsg?: string;
}

export interface OrderNotification {
  success: boolean;
  strategy: string;
  ordersPlaced?: number;
  ordersFailed?: number;
  successfulOrders?: OrderDetail[];
  failedOrders?: OrderDetail[];
  size?: number;
  pnlPercent?: number;
  totalCost?: number;
  expectedPnl?: number;
  latencyMs?: number;
  error?: string;
  balance?: number;
  reserved?: number;
}

@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);
  private bot?: TelegramBot;
  private chatId?: string;
  private enabled = true;

  onModuleInit() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !this.chatId) {
      this.logger.warn(
        'Telegram notifications DISABLED. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable.',
      );
      return;
    }

    try {
      this.bot = new TelegramBot(token, { polling: false });
      this.enabled = true;
      this.logger.log('Telegram notification service initialized');
    } catch (error) {
      this.logger.error(
        `Failed to initialize Telegram bot: ${error.message}`,
      );
    }
  }

  /**
   * Send order fill notification to Telegram
   */
  async notifyOrderFilled(notification: OrderNotification): Promise<void> {
    if (!this.enabled || !this.bot || !this.chatId) {
      return;
    }

    try {
      const message = this.formatOrderMessage(notification);
      await this.bot.sendMessage(this.chatId, message, { parse_mode: 'HTML' });
    } catch (error) {
      this.logger.warn(
        `Failed to send Telegram notification: ${error.message}`,
      );
    }
  }

  /**
   * Format order notification message (concise but complete)
   */
  private formatOrderMessage(notification: OrderNotification): string {
    const { success, strategy, latencyMs } = notification;

    if (success) {
      const {
        ordersPlaced = 0,
        ordersFailed = 0,
        successfulOrders = [],
        failedOrders = [],
        size = 0,
        pnlPercent = 0,
        totalCost = 0,
        expectedPnl = 0,
        balance = 0,
        reserved = 0,
      } = notification;

      let message =
        `✅ <b>ORDER FILLED</b>\n\n` +
        `📊 Strategy: <code>${strategy}</code>\n` +
        `⏱ Latency: <b>${latencyMs}ms</b>\n\n` +
        `🎯 Orders: <b>${ordersPlaced}</b> placed${ordersFailed > 0 ? ` | <b>${ordersFailed}</b> failed` : ''}\n` +
        `💰 Size: <b>${size.toFixed(2)}</b> tokens\n` +
        `📈 PnL: <b>${pnlPercent.toFixed(2)}%</b> (${expectedPnl.toFixed(4)} USDC)\n` +
        `💵 Cost: <b>${totalCost.toFixed(2)}</b> USDC\n`;

      // Add successful orders details
      if (successfulOrders.length > 0) {
        message += `\n✅ <b>Successful Orders:</b>\n`;
        for (const order of successfulOrders) {
          const marketName = order.marketSlug 
            ? this.formatMarketName(order.marketSlug)
            : order.tokenID.substring(0, 8) + '...';
          message += `  • ${order.side} @ ${order.price.toFixed(3)} - <code>${marketName}</code>\n`;
        }
      }

      // Add failed orders details
      if (failedOrders.length > 0) {
        message += `\n⚠️ <b>Failed Orders:</b>\n`;
        for (const order of failedOrders) {
          const marketName = order.marketSlug 
            ? this.formatMarketName(order.marketSlug)
            : order.tokenID.substring(0, 8) + '...';
          const errorMsg = order.errorMsg || 'Unknown error';
          message += `  • ${order.side} @ ${order.price.toFixed(3)} - <code>${marketName}</code>\n`;
          message += `    ↳ <i>${this.truncateError(errorMsg, 60)}</i>\n`;
        }
      }

      message +=
        `\n🏦 Reserved: <b>${reserved.toFixed(2)}</b> USDC\n` +
        `💳 Balance: <b>${balance.toFixed(2)}</b> USDC`;

      return message;
    } else {
      const { error = 'Unknown error', reserved = 0, balance = 0 } = notification;

      return (
        `❌ <b>ORDER FAILED</b>\n\n` +
        `📊 Strategy: <code>${strategy}</code>\n` +
        `⏱ Latency: <b>${latencyMs}ms</b>\n\n` +
        `⚠️ Error: <code>${this.truncateError(error)}</code>\n\n` +
        `🔄 Rolled back: <b>${reserved.toFixed(2)}</b> USDC\n` +
        `💳 Balance: <b>${balance.toFixed(2)}</b> USDC`
      );
    }
  }

  /**
   * Format market slug to be more readable
   * Example: "btc-101000-101500" -> "BTC 101K-101.5K"
   */
  private formatMarketName(marketSlug: string): string {
    // If too long, truncate
    if (marketSlug.length > 40) {
      return marketSlug.substring(0, 40) + '...';
    }
    return marketSlug;
  }

  /**
   * Truncate long error messages to keep notification concise
   */
  private truncateError(error: string, maxLength = 100): string {
    if (error.length <= maxLength) {
      return error;
    }
    return error.substring(0, maxLength) + '...';
  }

  /**
   * Send generic message to Telegram (for testing or custom notifications)
   */
  async sendMessage(message: string): Promise<void> {
    if (!this.enabled || !this.bot || !this.chatId) {
      return;
    }

    try {
      await this.bot.sendMessage(this.chatId, message);
    } catch (error) {
      this.logger.warn(
        `Failed to send Telegram message: ${error.message}`,
      );
    }
  }
}
