import {
    Injectable,
    Logger,
    OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';

/**
 * Queue name constant
 */
export const MANAGE_POSITION_QUEUE_NAME = 'manage-position-queue';

/**
 * Job name constant
 */
export const MANAGE_POSITION_JOB_NAME = 'check-order-status';

/**
 * Data structure for manage position job
 */
export interface ManagePositionJobData {
    /** ArbRealTrade ID for updating failure tracking */
    tradeId: string;
    /** Order IDs to check status */
    orderIds: string[];
    /** Original order details for retry */
    originalOrders: Array<{
        orderId: string;
        tokenID: string;
        side: 'BUY' | 'SELL';
        price: number;
        size: number;
        negRisk?: boolean;
    }>;
    /** Timestamp when job was created */
    createdAt: number;
}

/**
 * Manage Position Queue Service
 * 
 * Manages a Bull Queue for checking order status after batch orders are submitted.
 * Handles partial fills (cancelled remainder) and failed on-chain transactions.
 * 
 * Key Features:
 * - **Delayed Processing**: Jobs are delayed 3s to allow Polymarket matching
 * - **Bull Queue**: Uses NestJS Bull for robust job processing
 * - **Auto Retry**: Failed jobs are automatically retried with exponential backoff
 * - **Deduplication**: Prevents duplicate checks for the same trade
 */
@Injectable()
export class ManagePositionQueueService implements OnModuleInit {
    private readonly logger = new Logger(ManagePositionQueueService.name);

    /** Track recently queued trades to prevent duplicates */
    private recentlyQueued = new Map<string, number>();

    /** Deduplication window in ms (60 seconds) */
    private readonly DEDUP_WINDOW_MS = 60000;

    /** Delay before processing (wait for Polymarket to match orders) */
    private readonly PROCESS_DELAY_MS = 3000;

    constructor(
        @InjectQueue(MANAGE_POSITION_QUEUE_NAME)
        private readonly managePositionQueue: Queue<ManagePositionJobData>,
    ) { }

    async onModuleInit(): Promise<void> {
        this.logger.log('ManagePositionQueueService initialized with Bull Queue');

        // Log queue stats on startup
        const jobCounts = await this.managePositionQueue.getJobCounts();
        this.logger.log(`Queue stats: waiting=${jobCounts.waiting}, active=${jobCounts.active}, completed=${jobCounts.completed}, failed=${jobCounts.failed}`);
    }

    /**
     * Add order IDs to the queue for status checking
     * 
     * @param tradeId - ArbRealTrade ID for updating failure tracking
     * @param orderIds - Order IDs to check
     * @param originalOrders - Original order details for potential retry
     */
    async addToQueue(
        tradeId: string,
        orderIds: string[],
        originalOrders: Array<{
            orderId: string;
            tokenID: string;
            side: 'BUY' | 'SELL';
            price: number;
            size: number;
            negRisk?: boolean;
        }>,
    ): Promise<{ queued: boolean; reason?: string; jobId?: string }> {
        // Deduplication: Check if recently queued
        const now = Date.now();
        // const lastQueuedAt = this.recentlyQueued.get(tradeId);
        // if (lastQueuedAt && now - lastQueuedAt < this.DEDUP_WINDOW_MS) {
        //     this.logger.debug(
        //         `Skipping duplicate manage-position queue for tradeId ${tradeId} (queued ${Math.round((now - lastQueuedAt) / 1000)}s ago)`
        //     );
        //     return { queued: false, reason: 'duplicate_within_window' };
        // }

        // Add job to queue with delay
        const jobData: ManagePositionJobData = {
            tradeId,
            orderIds,
            originalOrders,
            createdAt: now,
        };

        const job = await this.managePositionQueue.add(MANAGE_POSITION_JOB_NAME, jobData, {
            delay: this.PROCESS_DELAY_MS, // Wait for Polymarket to match orders
            attempts: 3, // Retry up to 3 times
            backoff: {
                type: 'exponential',
                delay: 500, // Start with 0.5s, then 1s, then 2s
            },
            removeOnComplete: 100, // Keep last 100 completed jobs
            removeOnFail: 50, // Keep last 50 failed jobs for debugging
            timeout: 120000, // 2 min timeout per job
        });

        // Mark as recently queued for deduplication
        this.recentlyQueued.set(tradeId, now);

        // Clean old entries from dedup map
        this.cleanDeduplicationMap();

        this.logger.log(
            `Added to manage-position queue: tradeId=${tradeId} | Orders: ${orderIds.length} | JobID: ${job.id} | Delay: ${this.PROCESS_DELAY_MS}ms`
        );

        return { queued: true, jobId: job.id?.toString() };
    }

    /**
     * Clean old entries from deduplication map
     */
    private cleanDeduplicationMap(): void {
        const now = Date.now();
        for (const [key, timestamp] of this.recentlyQueued.entries()) {
            if (now - timestamp > this.DEDUP_WINDOW_MS * 2) {
                this.recentlyQueued.delete(key);
            }
        }
    }

    /**
     * Get current queue length (waiting jobs)
     */
    async getQueueLength(): Promise<number> {
        const counts = await this.managePositionQueue.getJobCounts();
        return counts.waiting;
    }

    /**
     * Get queue statistics
     */
    async getStats(): Promise<{
        waiting: number;
        active: number;
        completed: number;
        failed: number;
        delayed: number;
        isPaused: boolean;
    }> {
        const counts = await this.managePositionQueue.getJobCounts();
        const isPaused = await this.managePositionQueue.isPaused();

        return {
            waiting: counts.waiting,
            active: counts.active,
            completed: counts.completed,
            failed: counts.failed,
            delayed: counts.delayed,
            isPaused,
        };
    }

    /**
     * Get waiting jobs
     */
    async getWaitingJobs(): Promise<Array<{ id: string; data: ManagePositionJobData; timestamp: number }>> {
        const jobs = await this.managePositionQueue.getWaiting(0, 50);
        return jobs.map((job) => ({
            id: job.id?.toString() || '',
            data: job.data,
            timestamp: job.timestamp,
        }));
    }

    /**
     * Get failed jobs
     */
    async getFailedJobs(): Promise<Array<{ id: string; data: ManagePositionJobData; failedReason?: string }>> {
        const jobs = await this.managePositionQueue.getFailed(0, 20);
        return jobs.map((job) => ({
            id: job.id?.toString() || '',
            data: job.data,
            failedReason: job.failedReason,
        }));
    }

    /**
     * Clear all waiting jobs
     */
    async clearQueue(): Promise<void> {
        await this.managePositionQueue.empty();
        this.logger.log('Manage position queue cleared');
    }

    /**
     * Pause the queue
     */
    async pauseQueue(): Promise<void> {
        await this.managePositionQueue.pause();
        this.logger.log('Manage position queue paused');
    }

    /**
     * Resume the queue
     */
    async resumeQueue(): Promise<void> {
        await this.managePositionQueue.resume();
        this.logger.log('Manage position queue resumed');
    }

    /**
     * Retry all failed jobs
     */
    async retryAllFailed(): Promise<number> {
        const failedJobs = await this.managePositionQueue.getFailed();
        let retried = 0;

        for (const job of failedJobs) {
            await job.retry();
            retried++;
        }

        this.logger.log(`Retried ${retried} failed jobs`);
        return retried;
    }
}
