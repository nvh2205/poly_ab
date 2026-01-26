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
export const MINT_QUEUE_NAME = 'mint-queue';

/**
 * Job name constant
 */
export const MINT_JOB_NAME = 'mint-tokens';

/**
 * Data structure for mint job
 * Simplified: only assetId and size required
 * Processor will query database to get market details
 */
export interface MintJobData {
    /** Asset ID (tokenID) from Polymarket CLOB */
    assetId: string;
    /** Size to mint in USDC */
    size: number;
    /** Timestamp when job was created */
    createdAt: number;
}

/**
 * Mint Queue Service
 * 
 * Manages a Bull Queue for minting tokens after SELL signals are executed.
 * Uses assetId to query database for market details.
 * 
 * Key Features:
 * - **Simplified Input**: Only needs assetId and size
 * - **Bull Queue**: Uses NestJS Bull for robust job processing
 * - **Auto Retry**: Failed jobs are automatically retried with exponential backoff
 * - **Deduplication**: Prevents duplicate mints for the same asset within a time window
 */
@Injectable()
export class MintQueueService implements OnModuleInit {
    private readonly logger = new Logger(MintQueueService.name);

    /** Track recently queued assets to prevent duplicates */
    private recentlyQueued = new Map<string, number>();

    /** Deduplication window in ms (30 seconds) */
    private readonly DEDUP_WINDOW_MS = 30000;

    constructor(
        @InjectQueue(MINT_QUEUE_NAME)
        private readonly mintQueue: Queue<MintJobData>,
    ) { }

    async onModuleInit(): Promise<void> {
        this.logger.log('MintQueueService initialized with Bull Queue');

        // Log queue stats on startup
        const jobCounts = await this.mintQueue.getJobCounts();
        this.logger.log(`Queue stats: waiting=${jobCounts.waiting}, active=${jobCounts.active}, completed=${jobCounts.completed}, failed=${jobCounts.failed}`);
    }

    /**
     * Add a SELL signal to the mint queue for replenishment
     * Only needs assetId - processor will query database for market details
     * 
     * @param assetId - Asset ID (tokenID) from Polymarket CLOB
     * @param size - Size to mint in USDC
     */
    async addToQueue(
        assetId: string,
        size: number,
    ): Promise<{ queued: boolean; reason?: string; jobId?: string }> {
        // Deduplication: Check if recently queued
        const now = Date.now();
        const lastQueuedAt = this.recentlyQueued.get(assetId);
        if (lastQueuedAt && now - lastQueuedAt < this.DEDUP_WINDOW_MS) {
            this.logger.debug(
                `Skipping duplicate mint queue for assetId ${assetId.substring(0, 10)}... (queued ${Math.round((now - lastQueuedAt) / 1000)}s ago)`
            );
            return { queued: false, reason: 'duplicate_within_window' };
        }

        // Add job to queue
        const jobData: MintJobData = {
            assetId,
            size,
            createdAt: now,
        };

        const job = await this.mintQueue.add(MINT_JOB_NAME, jobData, {
            attempts: 3, // Retry up to 3 times
            backoff: {
                type: 'exponential',
                delay: 5000, // Start with 5s, then 10s, then 20s
            },
            removeOnComplete: 100, // Keep last 100 completed jobs
            removeOnFail: 50, // Keep last 50 failed jobs for debugging
            timeout: 120000, // 2 min timeout per job
        });

        // Mark as recently queued for deduplication
        this.recentlyQueued.set(assetId, now);

        // Clean old entries from dedup map
        this.cleanDeduplicationMap();

        this.logger.log(
            `Added to mint queue: assetId=${assetId.substring(0, 10)}... | Size: ${size} USDC | JobID: ${job.id}`
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
        const counts = await this.mintQueue.getJobCounts();
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
        const counts = await this.mintQueue.getJobCounts();
        const isPaused = await this.mintQueue.isPaused();

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
    async getWaitingJobs(): Promise<Array<{ id: string; data: MintJobData; timestamp: number }>> {
        const jobs = await this.mintQueue.getWaiting(0, 50);
        return jobs.map((job) => ({
            id: job.id?.toString() || '',
            data: job.data,
            timestamp: job.timestamp,
        }));
    }

    /**
     * Get failed jobs
     */
    async getFailedJobs(): Promise<Array<{ id: string; data: MintJobData; failedReason?: string }>> {
        const jobs = await this.mintQueue.getFailed(0, 20);
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
        await this.mintQueue.empty();
        this.logger.log('Mint queue cleared');
    }

    /**
     * Pause the queue
     */
    async pauseQueue(): Promise<void> {
        await this.mintQueue.pause();
        this.logger.log('Mint queue paused');
    }

    /**
     * Resume the queue
     */
    async resumeQueue(): Promise<void> {
        await this.mintQueue.resume();
        this.logger.log('Mint queue resumed');
    }

    /**
     * Retry all failed jobs
     */
    async retryAllFailed(): Promise<number> {
        const failedJobs = await this.mintQueue.getFailed();
        let retried = 0;

        for (const job of failedJobs) {
            await job.retry();
            retried++;
        }

        this.logger.log(`Retried ${retried} failed jobs`);
        return retried;
    }
}
