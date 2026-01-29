import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Logger,
  ParseIntPipe,
  DefaultValuePipe,
  BadRequestException,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiQuery, ApiBody } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ArbSignal } from '../../database/entities/arb-signal.entity';
import { ArbPaperTrade } from '../../database/entities/arb-paper-trade.entity';
import { PaperExecutionService } from './paper-execution.service';
import { RealExecutionService } from './real-execution.service';
import { MarketStructureService } from './market-structure.service';
import { RetentionCleanupService } from './retention-cleanup.service';
import { TradeAnalysisService } from './trade-analysis.service';
import { MintQueueService } from './services/mint-queue.service';
import { ManagePositionQueueService } from './services/manage-position-queue.service';

@Controller('strategy')
export class StrategyController {
  private readonly logger = new Logger(StrategyController.name);

  constructor(
    @InjectRepository(ArbSignal)
    private readonly arbSignalRepository: Repository<ArbSignal>,
    @InjectRepository(ArbPaperTrade)
    private readonly arbPaperTradeRepository: Repository<ArbPaperTrade>,
    private readonly paperExecutionService: PaperExecutionService,
    private readonly realExecutionService: RealExecutionService,
    private readonly marketStructureService: MarketStructureService,
    private readonly retentionCleanupService: RetentionCleanupService,
    private readonly tradeAnalysisService: TradeAnalysisService,
    private readonly mintQueueService: MintQueueService,
    private readonly managePositionQueueService: ManagePositionQueueService,
  ) { }

  /**
   * GET /strategy/stats
   * Returns overall statistics for paper trading
   */
  @Get('stats')
  async getStats() {
    try {
      const paperStats = await this.paperExecutionService.getStats();

      // Get signal stats
      const totalSignals = await this.arbSignalRepository.count();
      const executableSignals = await this.arbSignalRepository.count({
        where: { isExecutable: true },
      });

      // Get recent activity
      const recentSignals = await this.arbSignalRepository.find({
        order: { createdAt: 'DESC' },
        take: 10,
        select: ['id', 'groupKey', 'strategy', 'profitBps', 'createdAt'],
      });

      return {
        signals: {
          total: totalSignals,
          executable: executableSignals,
          recent: recentSignals,
        },
        paperTrades: paperStats,
      };
    } catch (error) {
      this.logger.error(`Failed to get stats: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * GET /strategy/groups
   * Returns list of active range groups
   */
  @Get('groups')
  async getGroups() {
    try {
      const groups = await this.marketStructureService.getAllGroups();

      // Enrich with signal counts
      const enrichedGroups = await Promise.all(
        groups.map(async (group) => {
          const signalCount = await this.arbSignalRepository.count({
            where: { groupKey: group.groupKey },
          });

          return {
            groupKey: group.groupKey,
            eventSlug: group.eventSlug,
            crypto: group.crypto,
            childrenCount: group.children.length,
            parentsCount: group.parents.length,
            signalCount,
          };
        }),
      );

      return {
        total: enrichedGroups.length,
        groups: enrichedGroups,
      };
    } catch (error) {
      this.logger.error(`Failed to get groups: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * GET /strategy/signals?limit=100&groupKey=xxx
   * Returns arbitrage signals with optional filtering
   */
  @Get('signals')
  async getSignals(
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
    @Query('groupKey') groupKey?: string,
  ) {
    try {
      const queryBuilder = this.arbSignalRepository
        .createQueryBuilder('signal')
        .orderBy('signal.created_at', 'DESC')
        .take(Math.min(limit, 1000)); // Cap at 1000

      if (groupKey) {
        queryBuilder.where('signal.group_key = :groupKey', { groupKey });
      }

      const signals = await queryBuilder.getMany();

      // Get summary stats
      const totalCount = await (groupKey
        ? this.arbSignalRepository.count({ where: { groupKey } })
        : this.arbSignalRepository.count());

      return {
        total: totalCount,
        limit,
        groupKey: groupKey || 'all',
        signals,
      };
    } catch (error) {
      this.logger.error(`Failed to get signals: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * GET /strategy/paper-trades?limit=100&groupKey=xxx
   * Returns paper trade results with optional filtering
   */
  @Get('paper-trades')
  async getPaperTrades(
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
    @Query('groupKey') groupKey?: string,
  ) {
    try {
      if (groupKey) {
        const trades = await this.paperExecutionService.getTradesByGroup(
          groupKey,
          Math.min(limit, 1000),
        );

        return {
          total: trades.length,
          limit,
          groupKey,
          trades,
        };
      } else {
        const trades = await this.paperExecutionService.getRecentTrades(
          Math.min(limit, 1000),
        );

        return {
          total: trades.length,
          limit,
          groupKey: 'all',
          trades,
        };
      }
    } catch (error) {
      this.logger.error(
        `Failed to get paper trades: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * GET /strategy/paper-trades/stats?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
   * Returns cost/profit stats within a date range (defaults to today)
   */
  @Get('paper-trades/stats')
  @ApiQuery({
    name: 'start_date',
    required: false,
    description: 'YYYY-MM-DD start date (defaults to today)',
  })
  @ApiQuery({
    name: 'end_date',
    required: false,
    description: 'YYYY-MM-DD end date (defaults to start_date/today)',
  })
  async getPaperTradeStats(
    @Query('start_date') startDate?: string,
    @Query('end_date') endDate?: string,
  ) {
    try {
      const { startDate: rangeStart, endDate: rangeEnd } =
        this.resolveDateRange(startDate, endDate);

      const stats = await this.paperExecutionService.getTradeStatsByDateRange(
        rangeStart,
        rangeEnd,
      );

      return {
        range: {
          startDate: rangeStart.toISOString(),
          endDate: rangeEnd.toISOString(),
        },
        ...stats,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get paper trade stats: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * GET /strategy/signals/:groupKey/summary
   * Returns summary statistics for a specific group
   */
  @Get('signals/:groupKey/summary')
  async getGroupSummary(@Query('groupKey') groupKey: string) {
    try {
      const signals = await this.arbSignalRepository.find({
        where: { groupKey },
        order: { createdAt: 'DESC' },
      });

      if (signals.length === 0) {
        return {
          groupKey,
          signalCount: 0,
          avgProfitBps: 0,
          maxProfitBps: 0,
          strategies: {},
        };
      }

      const avgProfitBps =
        signals.reduce((sum, s) => sum + Number(s.profitBps || 0), 0) /
        signals.length;
      const maxProfitBps = Math.max(
        ...signals.map((s) => Number(s.profitBps || 0)),
      );

      // Group by strategy
      const strategies = signals.reduce(
        (acc, signal) => {
          const strategy = signal.strategy;
          if (!acc[strategy]) {
            acc[strategy] = { count: 0, totalProfitBps: 0 };
          }
          acc[strategy].count++;
          acc[strategy].totalProfitBps += Number(signal.profitBps || 0);
          return acc;
        },
        {} as Record<string, { count: number; totalProfitBps: number }>,
      );

      return {
        groupKey,
        signalCount: signals.length,
        avgProfitBps,
        maxProfitBps,
        strategies: Object.entries(strategies).map(([name, stats]) => ({
          name,
          count: stats.count,
          avgProfitBps: stats.totalProfitBps / stats.count,
        })),
      };
    } catch (error) {
      this.logger.error(
        `Failed to get group summary: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * GET /strategy/retention/stats
   * Returns current retention policy and database statistics
   */
  @Get('retention/stats')
  async getRetentionStats() {
    try {
      return await this.retentionCleanupService.getRetentionStats();
    } catch (error) {
      this.logger.error(
        `Failed to get retention stats: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * POST /strategy/retention/cleanup
   * Manually trigger retention cleanup
   */
  @Post('retention/cleanup')
  async triggerCleanup() {
    try {
      this.logger.log('Manual cleanup triggered via API');
      return await this.retentionCleanupService.triggerManualCleanup();
    } catch (error) {
      this.logger.error(
        `Failed to trigger cleanup: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * GET /strategy/real-trading/status
   * Get current real trading status and configuration
   */
  @Get('real-trading/status')
  async getRealTradingStatus() {
    try {
      return this.realExecutionService.getTradingStatus();
    } catch (error) {
      this.logger.error(
        `Failed to get real trading status: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * POST /strategy/real-trading/enable
   * Enable real trading at runtime
   */
  @Post('real-trading/enable')
  async enableRealTrading() {
    try {
      this.logger.log('Real trading enable requested via API');
      return this.realExecutionService.enableTrading();
    } catch (error) {
      this.logger.error(
        `Failed to enable real trading: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * POST /strategy/real-trading/disable
   * Disable real trading at runtime
   */
  @Post('real-trading/disable')
  async disableRealTrading() {
    try {
      this.logger.log('Real trading disable requested via API');
      return this.realExecutionService.disableTrading();
    } catch (error) {
      this.logger.error(
        `Failed to disable real trading: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * POST /strategy/real-trading/slippage/enable
   * Enable slippage independently at runtime
   */
  @Post('real-trading/slippage/enable')
  async enableSlippage() {
    try {
      this.logger.log('Slippage enable requested via API');
      return this.realExecutionService.enableSlippage();
    } catch (error) {
      this.logger.error(
        `Failed to enable slippage: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * POST /strategy/real-trading/slippage/disable
   * Disable slippage independently at runtime
   */
  @Post('real-trading/slippage/disable')
  async disableSlippage() {
    try {
      this.logger.log('Slippage disable requested via API');
      return this.realExecutionService.disableSlippage();
    } catch (error) {
      this.logger.error(
        `Failed to disable slippage: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  // ============================================
  // Mint Queue Endpoints
  // ============================================

  /**
   * GET /strategy/mint-queue/status
   * Get current mint queue status and statistics
   */
  @Get('mint-queue/status')
  async getMintQueueStatus() {
    try {
      return await this.mintQueueService.getStats();
    } catch (error) {
      this.logger.error(
        `Failed to get mint queue status: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * GET /strategy/mint-queue/waiting
   * Get all waiting jobs in the mint queue
   */
  @Get('mint-queue/waiting')
  async getMintQueueWaiting() {
    try {
      const jobs = await this.mintQueueService.getWaitingJobs();
      return {
        count: jobs.length,
        jobs,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get waiting jobs: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * GET /strategy/mint-queue/failed
   * Get all failed jobs in the mint queue
   */
  @Get('mint-queue/failed')
  async getMintQueueFailed() {
    try {
      const jobs = await this.mintQueueService.getFailedJobs();
      return {
        count: jobs.length,
        jobs,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get failed jobs: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * POST /strategy/mint-queue/clear
   * Clear all waiting jobs from the mint queue
   */
  @Post('mint-queue/clear')
  async clearMintQueue() {
    try {
      this.logger.log('Mint queue clear requested via API');
      await this.mintQueueService.clearQueue();
      return {
        success: true,
        message: 'Mint queue cleared',
      };
    } catch (error) {
      this.logger.error(
        `Failed to clear mint queue: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * POST /strategy/mint-queue/pause
   * Pause the mint queue processing
   */
  @Post('mint-queue/pause')
  async pauseMintQueue() {
    try {
      this.logger.log('Mint queue pause requested via API');
      await this.mintQueueService.pauseQueue();
      return {
        success: true,
        message: 'Mint queue paused',
      };
    } catch (error) {
      this.logger.error(
        `Failed to pause mint queue: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * POST /strategy/mint-queue/resume
   * Resume the mint queue processing
   */
  @Post('mint-queue/resume')
  async resumeMintQueue() {
    try {
      this.logger.log('Mint queue resume requested via API');
      await this.mintQueueService.resumeQueue();
      return {
        success: true,
        message: 'Mint queue resumed',
      };
    } catch (error) {
      this.logger.error(
        `Failed to resume mint queue: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * POST /strategy/mint-queue/retry-failed
   * Retry all failed jobs in the mint queue
   */
  @Post('mint-queue/retry-failed')
  async retryFailedMintJobs() {
    try {
      this.logger.log('Mint queue retry-failed requested via API');
      const retried = await this.mintQueueService.retryAllFailed();
      return {
        success: true,
        message: `Retried ${retried} failed jobs`,
        retriedCount: retried,
      };
    } catch (error) {
      this.logger.error(
        `Failed to retry failed jobs: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }


  /**
   * GET /strategy/analyze-transactions
   * Analyze transactions and compare with signals, export to Excel
   * @param start_date - Start date in YYYY-MM-DD format
   * @param end_date - End date (defaults to start_date + 1 day)
   * @param csv_path - Optional custom CSV file path
   * @param format - 'excel' for file download, 'json' for summary only
   */
  @Get('analyze-transactions')
  @ApiQuery({
    name: 'start_date',
    required: false,
    description: 'YYYY-MM-DD start date (defaults to today)',
  })
  @ApiQuery({
    name: 'end_date',
    required: false,
    description: 'YYYY-MM-DD end date (defaults to start_date + 1 day)',
  })
  @ApiQuery({
    name: 'csv_path',
    required: false,
    description: 'Custom CSV file path (optional)',
  })
  @ApiQuery({
    name: 'format',
    required: false,
    description: 'Response format: excel (default) or json',
  })
  async analyzeTransactions(
    @Query('start_date') startDate?: string,
    @Query('end_date') endDate?: string,
    @Query('csv_path') csvPath?: string,
    @Query('format') format?: string,
    @Res() res?: Response,
  ) {
    try {
      const { startDate: rangeStart, endDate: rangeEnd } =
        this.resolveDateRange(startDate, endDate);

      this.logger.log(
        `Analyzing transactions from ${rangeStart.toISOString()} to ${rangeEnd.toISOString()}`,
      );

      const result = await this.tradeAnalysisService.analyzeTransactions(
        rangeStart,
        rangeEnd,
        csvPath,
      );

      if (format === 'json') {
        return res.json({
          success: true,
          excelPath: result.excelPath,
          summary: result.summary,
        });
      }

      // Default: download Excel file
      res.download(result.excelPath, (err) => {
        if (err) {
          this.logger.error(`Failed to download Excel file: ${err.message}`);
        }
      });
    } catch (error) {
      this.logger.error(
        `Failed to analyze transactions: ${error.message}`,
        error.stack,
      );
      return res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }

  // ============================================
  // Manage Position Queue Endpoints
  // ============================================

  /**
   * GET /strategy/manage-position/status
   * Get current manage-position queue status
   */
  @Get('manage-position/status')
  async getManagePositionStatus() {
    try {
      return await this.managePositionQueueService.getStats();
    } catch (error) {
      this.logger.error(
        `Failed to get manage-position queue status: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * GET /strategy/manage-position/waiting
   * Get all waiting jobs in the manage-position queue
   */
  @Get('manage-position/waiting')
  async getManagePositionWaiting() {
    try {
      const jobs = await this.managePositionQueueService.getWaitingJobs();
      return {
        count: jobs.length,
        jobs,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get waiting jobs: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * GET /strategy/manage-position/failed
   * Get all failed jobs in the manage-position queue
   */
  @Get('manage-position/failed')
  async getManagePositionFailed() {
    try {
      const jobs = await this.managePositionQueueService.getFailedJobs();
      return {
        count: jobs.length,
        jobs,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get failed jobs: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * POST /strategy/manage-position/test
   * Manually trigger manage-position check with custom params
   * 
   * Example body:
   * {
   *   "tradeId": "test-trade-123",
   *   "orderIds": ["0xabc...", "0xdef..."],
   *   "originalOrders": [
   *     {
   *       "orderId": "0xabc...",
   *       "tokenID": "12345...",
   *       "side": "BUY",
   *       "price": 0.55,
   *       "size": 10,
   *       "negRisk": false
   *     }
   *   ]
   * }
   */
  @ApiBody({
    description: 'Trigger manage-position check with custom params',
    schema: {
      type: 'object',
      properties: {
        tradeId: { type: 'string', description: 'Optional trade ID (auto-generated if not provided)', example: 'test-trade-123' },
        orderIds: { type: 'array', items: { type: 'string' }, description: 'Order hashes to check status', example: ['0xabc123...', '0xdef456...'] },
        originalOrders: {
          type: 'array',
          description: 'Original order details for potential retry',
          items: {
            type: 'object',
            properties: {
              orderId: { type: 'string', description: 'Order hash', example: '0xabc123...' },
              tokenID: { type: 'string', description: 'Token ID (condition ID)', example: '12345678901234567890...' },
              side: { type: 'string', enum: ['BUY', 'SELL'], description: 'Order side', example: 'BUY' },
              price: { type: 'number', description: 'Order price (0-1)', example: 0.55 },
              size: { type: 'number', description: 'Order size', example: 10 },
              negRisk: { type: 'boolean', description: 'Whether this is a negRisk market', example: false },
            },
            required: ['orderId', 'tokenID', 'side', 'price', 'size'],
          },
        },
      },
      required: ['orderIds', 'originalOrders'],
    },
  })
  @Post('manage-position/test')
  async testManagePosition(
    @Body() body: {
      tradeId?: string;
      orderIds: string[];
      originalOrders: Array<{
        orderId: string;
        tokenID: string;
        side: 'BUY' | 'SELL';
        price: number;
        size: number;
        negRisk?: boolean;
      }>;
    },
  ) {
    try {
      const tradeId = body.tradeId || `test-${Date.now()}`;

      this.logger.log(`Manual manage-position test triggered via API: tradeId=${tradeId}`);

      const result = await this.managePositionQueueService.addToQueue(
        tradeId,
        body.orderIds,
        body.originalOrders,
      );

      return {
        success: true,
        message: result.queued ? 'Job queued successfully' : `Job not queued: ${result.reason}`,
        ...result,
        tradeId,
      };
    } catch (error) {
      this.logger.error(
        `Failed to queue manage-position test: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * POST /strategy/manage-position/clear
   * Clear all waiting jobs from the manage-position queue
   */
  @Post('manage-position/clear')
  async clearManagePositionQueue() {
    try {
      this.logger.log('Manage-position queue clear requested via API');
      await this.managePositionQueueService.clearQueue();
      return {
        success: true,
        message: 'Manage-position queue cleared',
      };
    } catch (error) {
      this.logger.error(
        `Failed to clear manage-position queue: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Normalize query params to a date range.
   * Defaults to the current day when params are omitted.
   */
  private resolveDateRange(
    startDate?: string,
    endDate?: string,
  ): { startDate: Date; endDate: Date } {
    const today = new Date();

    const startBase = startDate
      ? new Date(startDate)
      : endDate
        ? new Date(endDate)
        : today;
    const endBase = endDate ? new Date(endDate) : startBase;

    if (Number.isNaN(startBase.getTime())) {
      throw new BadRequestException('Invalid start_date');
    }

    if (Number.isNaN(endBase.getTime())) {
      throw new BadRequestException('Invalid end_date');
    }

    const normalizedStart = new Date(startBase);
    normalizedStart.setHours(0, 0, 0, 0);

    const normalizedEnd = new Date(endBase);
    normalizedEnd.setHours(23, 59, 59, 999);

    if (normalizedStart > normalizedEnd) {
      throw new BadRequestException('start_date must be before end_date');
    }

    return {
      startDate: normalizedStart,
      endDate: normalizedEnd,
    };
  }
}
