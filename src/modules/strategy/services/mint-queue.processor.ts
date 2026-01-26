import { Process, Processor, OnQueueActive, OnQueueCompleted, OnQueueFailed } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Market } from '../../../database/entities/market.entity';
import {
    PolymarketOnchainService,
    PolymarketConfig,
    MarketCondition,
} from '../../../common/services/polymarket-onchain.service';
import { loadPolymarketConfig } from '../../../common/services/polymarket-onchain.config';
import { MINT_QUEUE_NAME, MINT_JOB_NAME, MintJobData } from './mint-queue.service';

/**
 * Mint Queue Processor
 * 
 * Processes mint jobs from the Bull Queue.
 * Uses assetId to query database for market details.
 * 
 * Key Features:
 * - Query market by assetId (tokenYes or tokenNo field)
 * - Liquidity Protection (6x Rule): Only mint if usdc_balance > 6 * size
 * - Error Handling: Failed jobs are retried with exponential backoff
 */
@Processor(MINT_QUEUE_NAME)
export class MintQueueProcessor {
    private readonly logger = new Logger(MintQueueProcessor.name);

    /** Polymarket config (cached at startup) */
    private config!: PolymarketConfig;

    /** Liquidity protection multiplier (6x rule) */
    private readonly LIQUIDITY_PROTECTION_MULTIPLIER = 6;

    constructor(
        @InjectRepository(Market)
        private readonly marketRepository: Repository<Market>,
        private readonly polymarketOnchainService: PolymarketOnchainService,
    ) {
        // Load config
        try {
            this.config = loadPolymarketConfig();
            this.logger.log('MintQueueProcessor initialized with Polymarket config');
        } catch (error: any) {
            this.logger.error(`Failed to load Polymarket config: ${error.message}`);
        }
    }

    /**
     * Find market by assetId (tokenYes or tokenNo)
     */
    private async findMarketByAssetId(assetId: string): Promise<Market | null> {
        // Try tokenYes first
        let market = await this.marketRepository.findOne({
            where: { tokenYes: assetId },
        });

        if (market) {
            return market;
        }

        // Try tokenNo
        market = await this.marketRepository.findOne({
            where: { tokenNo: assetId },
        });

        return market;
    }

    /**
     * Process mint job
     */
    @Process(MINT_JOB_NAME)
    async processMintJob(job: Job<MintJobData>): Promise<{ success: boolean; txHash?: string; error?: string }> {
        const { assetId, size, createdAt } = job.data;

        this.logger.log(
            `Processing mint job #${job.id}: assetId=${assetId.substring(0, 10)}... | Size: ${size} USDC`
        );

        try {
            // 1. Check job age (expire after 5 minutes)
            const age = Date.now() - createdAt;
            if (age > 5 * 60 * 1000) {
                this.logger.warn(`Job #${job.id} expired (age: ${Math.round(age / 1000)}s)`);
                return { success: false, error: 'job_expired' };
            }

            // 2. Check liquidity protection (6x rule)
            const proxyAddress = this.config.proxyAddress || undefined;
            const balances = await this.polymarketOnchainService.getBalances(
                this.config,
                undefined,
                proxyAddress,
            );
            const currentUsdc = parseFloat(balances.usdc) || 0;
            const requiredBalance = size * this.LIQUIDITY_PROTECTION_MULTIPLIER;

            if (currentUsdc < requiredBalance) {
                const error = `Insufficient balance: need ${requiredBalance.toFixed(2)} USDC (6x of ${size}), have ${currentUsdc.toFixed(2)} USDC`;
                this.logger.warn(`Job #${job.id}: ${error}`);
                throw new Error(error); // Throw to trigger retry
            }

            // 3. Query market from database by assetId
            const market = await this.findMarketByAssetId(assetId);

            if (!market) {
                return { success: false, error: `Market not found for assetId: ${assetId.substring(0, 20)}...` };
            }

            if (!market.conditionId) {
                return { success: false, error: `Market ${market.slug} has no conditionId` };
            }

            if (!market.endDate || !market.type) {
                return { success: false, error: `Market ${market.slug} missing endDate or type` };
            }

            // 4. Build groupKey from type and endDate
            const endDateUtc = new Date(market.endDate).toISOString();
            const groupKey = `${market.type}-${endDateUtc}`;

            // 5. Build marketCondition
            const marketCondition: MarketCondition = {
                conditionId: market.conditionId,
                negRisk: market.negRisk ?? false,
                negRiskMarketID: market.negRiskMarketID ?? undefined,
            };

            this.logger.log(
                `Minting for ${market.slug}: conditionId=${market.conditionId}, negRisk=${market.negRisk}, groupKey=${groupKey}`
            );

            // 6. Execute mint via proxy
            const result = await this.polymarketOnchainService.mintTokensViaProxy(
                this.config,
                marketCondition,
                size,
                groupKey,
            );

            if (result.success) {
                this.logger.log(
                    `✅ Mint successful for ${market.slug} | TxHash: ${result.txHash}`
                );
                return { success: true, txHash: result.txHash };
            } else {
                this.logger.error(`❌ Mint failed for ${market.slug}: ${result.error}`);
                throw new Error(result.error || 'Mint failed'); // Throw to trigger retry
            }
        } catch (error: any) {
            this.logger.error(`Job #${job.id} error: ${error.message}`);
            throw error; // Re-throw to trigger Bull retry mechanism
        }
    }

    @OnQueueActive()
    onActive(job: Job<MintJobData>) {
        this.logger.debug(
            `Job #${job.id} started: assetId=${job.data.assetId.substring(0, 10)}... | Attempt: ${job.attemptsMade + 1}`
        );
    }

    @OnQueueCompleted()
    onCompleted(job: Job<MintJobData>, result: any) {
        if (result?.success) {
            this.logger.log(
                `Job #${job.id} completed: assetId=${job.data.assetId.substring(0, 10)}... | TxHash: ${result.txHash}`
            );
        } else {
            this.logger.warn(
                `Job #${job.id} completed with failure: assetId=${job.data.assetId.substring(0, 10)}... | Error: ${result?.error}`
            );
        }
    }

    @OnQueueFailed()
    onFailed(job: Job<MintJobData>, err: Error) {
        this.logger.error(
            `Job #${job.id} failed: assetId=${job.data.assetId.substring(0, 10)}... | Attempt: ${job.attemptsMade} | Error: ${err.message}`
        );
    }
}
