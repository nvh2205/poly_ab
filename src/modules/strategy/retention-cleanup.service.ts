import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { ArbSignal } from '../../database/entities/arb-signal.entity';
import { ArbPaperTrade } from '../../database/entities/arb-paper-trade.entity';

/**
 * RetentionCleanupService
 * Handles automatic cleanup of old arbitrage signals and paper trades
 * to prevent database bloat
 */
@Injectable()
export class RetentionCleanupService {
  private readonly logger = new Logger(RetentionCleanupService.name);

  // Configuration from environment variables
  private readonly retentionDays = this.numFromEnv('ARB_RETENTION_DAYS', 7);
  private readonly maxRecordsPerGroup = this.numFromEnv(
    'ARB_MAX_RECORDS_PER_GROUP',
    10000,
  );
  private readonly cleanupEnabled = this.boolFromEnv(
    'ARB_CLEANUP_ENABLED',
    true,
  );

  constructor(
    @InjectRepository(ArbSignal)
    private readonly arbSignalRepository: Repository<ArbSignal>,
    @InjectRepository(ArbPaperTrade)
    private readonly arbPaperTradeRepository: Repository<ArbPaperTrade>,
  ) {}

  /**
   * Run cleanup daily at 3 AM
   * Removes old signals and paper trades based on retention policy
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleDailyCleanup(): Promise<void> {
    if (!this.cleanupEnabled) {
      this.logger.debug('Cleanup is disabled via ARB_CLEANUP_ENABLED=false');
      return;
    }

    this.logger.log('Starting daily retention cleanup...');

    try {
      await this.cleanupByAge();
      await this.cleanupByCount();
      this.logger.log('Daily retention cleanup completed successfully');
    } catch (error) {
      this.logger.error(
        `Failed to complete daily cleanup: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Delete records older than retention period
   */
  private async cleanupByAge(): Promise<void> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);

    this.logger.log(
      `Cleaning up records older than ${this.retentionDays} days (before ${cutoffDate.toISOString()})`,
    );

    // Delete old paper trades first (due to foreign key constraint)
    const deletedTrades = await this.arbPaperTradeRepository.delete({
      createdAt: LessThan(cutoffDate),
    });

    this.logger.log(`Deleted ${deletedTrades.affected || 0} old paper trades`);

    // Delete old signals
    const deletedSignals = await this.arbSignalRepository.delete({
      createdAt: LessThan(cutoffDate),
    });

    this.logger.log(`Deleted ${deletedSignals.affected || 0} old signals`);
  }

  /**
   * Keep only top N records per group (by creation time)
   * This prevents any single group from dominating storage
   */
  private async cleanupByCount(): Promise<void> {
    this.logger.log(
      `Cleaning up groups exceeding ${this.maxRecordsPerGroup} records`,
    );

    // Get all unique group keys
    const groupKeys = await this.arbSignalRepository
      .createQueryBuilder('signal')
      .select('DISTINCT signal.group_key', 'groupKey')
      .getRawMany();

    let totalDeleted = 0;

    for (const { groupKey } of groupKeys) {
      const count = await this.arbSignalRepository.count({
        where: { groupKey },
      });

      if (count > this.maxRecordsPerGroup) {
        const toDelete = count - this.maxRecordsPerGroup;

        // Get IDs of oldest signals to delete
        const oldestSignals = await this.arbSignalRepository.find({
          where: { groupKey },
          order: { createdAt: 'ASC' },
          take: toDelete,
          select: ['id'],
        });

        const idsToDelete = oldestSignals.map((s) => s.id);

        if (idsToDelete.length > 0) {
          // Delete associated paper trades first
          await this.arbPaperTradeRepository.delete({
            signalId: idsToDelete as any,
          });

          // Delete signals
          await this.arbSignalRepository.delete(idsToDelete);

          totalDeleted += idsToDelete.length;
          this.logger.log(
            `Deleted ${idsToDelete.length} excess records from group ${groupKey}`,
          );
        }
      }
    }

    if (totalDeleted > 0) {
      this.logger.log(
        `Total deleted ${totalDeleted} records across all groups`,
      );
    } else {
      this.logger.log('No groups exceeded the maximum record count');
    }
  }

  /**
   * Manual cleanup trigger (can be called via admin endpoint if needed)
   */
  async triggerManualCleanup(): Promise<{
    success: boolean;
    message: string;
  }> {
    try {
      this.logger.log('Manual cleanup triggered');
      await this.cleanupByAge();
      await this.cleanupByCount();
      return {
        success: true,
        message: 'Manual cleanup completed successfully',
      };
    } catch (error) {
      this.logger.error(`Manual cleanup failed: ${error.message}`, error.stack);
      return {
        success: false,
        message: `Cleanup failed: ${error.message}`,
      };
    }
  }

  /**
   * Get current retention statistics
   */
  async getRetentionStats(): Promise<{
    retentionDays: number;
    maxRecordsPerGroup: number;
    cleanupEnabled: boolean;
    totalSignals: number;
    totalPaperTrades: number;
    oldestSignalDate: Date | null;
    newestSignalDate: Date | null;
  }> {
    const totalSignals = await this.arbSignalRepository.count();
    const totalPaperTrades = await this.arbPaperTradeRepository.count();

    const oldestSignal = await this.arbSignalRepository.findOne({
      order: { createdAt: 'ASC' },
      select: ['createdAt'],
    });

    const newestSignal = await this.arbSignalRepository.findOne({
      order: { createdAt: 'DESC' },
      select: ['createdAt'],
    });

    return {
      retentionDays: this.retentionDays,
      maxRecordsPerGroup: this.maxRecordsPerGroup,
      cleanupEnabled: this.cleanupEnabled,
      totalSignals,
      totalPaperTrades,
      oldestSignalDate: oldestSignal?.createdAt || null,
      newestSignalDate: newestSignal?.createdAt || null,
    };
  }

  private numFromEnv(key: string, defaultValue: number): number {
    const raw = process.env[key];
    if (!raw) return defaultValue;
    const num = Number(raw);
    return Number.isFinite(num) && num > 0 ? num : defaultValue;
  }

  private boolFromEnv(key: string, defaultValue: boolean): boolean {
    const raw = process.env[key];
    if (!raw) return defaultValue;
    return raw.toLowerCase() === 'true' || raw === '1';
  }
}
