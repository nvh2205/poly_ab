import { Process, Processor, OnQueueActive, OnQueueCompleted, OnQueueFailed } from '@nestjs/bull';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ArbRealTrade } from '../../../database/entities/arb-real-trade.entity';
import {
    PolymarketOnchainService,
    PolymarketConfig,
    BatchOrderParams,
} from '../../../common/services/polymarket-onchain.service';
import { loadPolymarketConfig } from '../../../common/services/polymarket-onchain.config';
import { MANAGE_POSITION_QUEUE_NAME, MANAGE_POSITION_JOB_NAME, ManagePositionJobData } from './manage-position-queue.service';

interface FailureDetail {
    orderId: string;
    type: 'PARTIAL_FILL_CANCELLED' | 'TRANSACTION_FAILED';
    reason: string;
}

interface OrderDetailFromApi {
    orderId: string;
    tokenID: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    status?: string;
    sizeMatched?: number;
    associateTrades?: string[];
}

/**
 * Manage Position Processor
 * 
 * Processes manage-position jobs from the Bull Queue.
 * Handles two failure cases:
 * 1. PARTIAL_FILL_CANCELLED: Order matched partially, remainder was cancelled
 * 2. TRANSACTION_FAILED: Order matched fully but on-chain transaction failed
 * 
 * Key Features:
 * - Batch collection of retry orders before posting
 * - Single batch post for all retries (reduces API calls)
 * - Database updates for failure tracking
 */
@Processor(MANAGE_POSITION_QUEUE_NAME)
export class ManagePositionProcessor {
    private readonly logger = new Logger(ManagePositionProcessor.name);

    /** Polymarket config (cached at startup) */
    private config!: PolymarketConfig;

    /** Minimum order value for Polymarket (USDC) */
    private readonly MIN_ORDER_VALUE = 1.0;

    /** Maximum price for probability markets */
    private readonly MAX_PRICE = 0.999;

    constructor(
        @InjectRepository(ArbRealTrade)
        private readonly arbRealTradeRepository: Repository<ArbRealTrade>,
        private readonly polymarketOnchainService: PolymarketOnchainService,
    ) {
        // Load config
        try {
            this.config = loadPolymarketConfig();
            this.logger.log('ManagePositionProcessor initialized with Polymarket config');
        } catch (error: any) {
            this.logger.error(`Failed to load Polymarket config: ${error.message}`);
        }
    }

    /**
     * Build retry order for partial fill case
     * - SELL: Use very low price (0.001) for immediate matching
     * - BUY: Use max price (0.999) for immediate matching
     * Both ensure orders get filled instantly at best available price
     */
    private buildRetryOrderForPartialFill(
        order: { tokenID: string; price: number; size: number; side: 'BUY' | 'SELL'; negRisk?: boolean },
        remainingSize: number,
    ): BatchOrderParams | null {
        if (order.side === 'SELL') {
            // SELL: Use very low price for immediate matching
            // Polymarket matches SELL orders instantly at best bid
            return {
                tokenID: order.tokenID,
                price: 0.001, // Very low price to ensure immediate fill
                size: remainingSize,
                side: 'SELL',
                negRisk: order.negRisk,
            };
        } else {
            // BUY: Use max price for immediate matching
            // Polymarket matches BUY orders instantly at best ask
            return {
                tokenID: order.tokenID,
                price: this.MAX_PRICE, // 0.999 - max price for immediate fill
                size: remainingSize,
                side: 'BUY',
                negRisk: order.negRisk,
            };
        }
    }

    /**
     * Update trade with retry info in database
     */
    private async updateTradeWithRetryInfo(
        tradeId: string,
        failureDetails: FailureDetail[],
        orderDetails: OrderDetailFromApi[],
        retryOrderIds?: string[],
    ): Promise<void> {
        try {
            // Determine primary failure type (prefer TRANSACTION_FAILED if any)
            let primaryFailureType: 'PARTIAL_FILL_CANCELLED' | 'TRANSACTION_FAILED' | null = null;
            if (failureDetails.some(f => f.type === 'TRANSACTION_FAILED')) {
                primaryFailureType = 'TRANSACTION_FAILED';
            } else if (failureDetails.some(f => f.type === 'PARTIAL_FILL_CANCELLED')) {
                primaryFailureType = 'PARTIAL_FILL_CANCELLED';
            }

            await this.arbRealTradeRepository.update(tradeId, {
                failureType: primaryFailureType,
                retryOrderIds: retryOrderIds || [],
                retryCount: 1, // Increment would require a separate query
                originalOrderDetails: orderDetails,
            });

            this.logger.log(
                `Updated trade ${tradeId}: failureType=${primaryFailureType}, retryOrderIds=${retryOrderIds?.length || 0}`
            );
        } catch (error: any) {
            this.logger.error(`Failed to update trade ${tradeId}: ${error.message}`);
        }
    }

    /**
     * Process order status check job
     * 1. Check all orders and collect retry candidates
     * 2. Post all retry orders in a SINGLE batch call
     * 3. Update database with failure tracking
     */
    @Process(MANAGE_POSITION_JOB_NAME)
    async processOrderCheck(job: Job<ManagePositionJobData>): Promise<{
        success: boolean;
        retryCount: number;
        failureCount: number;
        error?: string;
    }> {
        const { tradeId, originalOrders, createdAt } = job.data;

        this.logger.log(
            `Processing manage-position job #${job.id}: tradeId=${tradeId} | Orders: ${originalOrders.length}`
        );

        const retryOrders: BatchOrderParams[] = [];
        const failureDetails: FailureDetail[] = [];
        const orderDetailsFromApi: OrderDetailFromApi[] = [];

        try {

            // Step 1: Check all orders and collect retry candidates
            for (const order of originalOrders) {
                const orderResult = await this.polymarketOnchainService.getOrder(order.orderId);

                if (!orderResult.success || !orderResult.order) {
                    this.logger.warn(`Failed to get order ${order.orderId}: ${orderResult.error}`);
                    continue;
                }

                const orderDetail = orderResult.order;
                const originalSize = parseFloat(orderDetail.original_size || orderDetail.size || '0');
                const sizeMatched = parseFloat(orderDetail.size_matched || '0');

                // Store order detail for database update
                orderDetailsFromApi.push({
                    orderId: order.orderId,
                    tokenID: order.tokenID,
                    side: order.side,
                    price: order.price,
                    size: order.size,
                    status: orderDetail.status,
                    sizeMatched,
                    associateTrades: orderDetail.associate_trades,
                });

                // CASE 1: Partial fill, remainder cancelled
                if (orderDetail.status === 'MATCHED' && originalSize > sizeMatched) {
                    const remainingSize = originalSize - sizeMatched;
                    const retryOrder = this.buildRetryOrderForPartialFill(order, remainingSize);

                    if (retryOrder) {
                        retryOrders.push(retryOrder);
                        failureDetails.push({
                            orderId: order.orderId,
                            type: 'PARTIAL_FILL_CANCELLED',
                            reason: `Matched ${sizeMatched.toFixed(2)}/${originalSize.toFixed(2)}`,
                        });
                        this.logger.log(
                            `PARTIAL_FILL: ${order.orderId.substring(0, 10)}... matched ${sizeMatched}/${originalSize}, will retry ${remainingSize}`
                        );
                    }
                }
                // CASE 2: Full match, check transaction status
                else if (
                    orderDetail.status === 'MATCHED' &&
                    originalSize > 0 &&
                    orderDetail.associate_trades?.length > 0
                ) {
                    // Get trade details to check transaction status
                    const tradesResult = await this.polymarketOnchainService.getTrades({
                        id: orderDetail.associate_trades[0],
                    });

                    if (tradesResult.success && tradesResult.trades?.[0]) {
                        const trade = tradesResult.trades[0];
                        if (trade.status === 'FAILED') {
                            retryOrders.push({
                                tokenID: order.tokenID,
                                price: order.price,
                                size: order.size,
                                side: order.side,
                                negRisk: order.negRisk,
                            });
                            failureDetails.push({
                                orderId: order.orderId,
                                type: 'TRANSACTION_FAILED',
                                reason: `On-chain tx failed for trade ${orderDetail.associate_trades[0]}`,
                            });
                            this.logger.log(
                                `TRANSACTION_FAILED: ${order.orderId.substring(0, 10)}... on-chain tx failed, will retry with original params`
                            );
                        }
                    }
                }
            }

            // Step 2: Post all retry orders in a SINGLE batch call
            let retryOrderIds: string[] = [];
            if (retryOrders.length > 0) {
                this.logger.log(
                    `Posting ${retryOrders.length} retry orders in batch for tradeId=${tradeId}`
                );

                const result = await this.polymarketOnchainService.placeBatchOrdersNative(
                    this.config,
                    retryOrders,
                );

                if (result.success && result.results) {
                    retryOrderIds = result.results
                        .filter((r) => r.success && r.orderID)
                        .map((r) => r.orderID!);

                    const successCount = retryOrderIds.length;
                    const failCount = result.results.filter((r) => !r.success).length;

                    this.logger.log(
                        `Retry batch result: ${successCount} success, ${failCount} failed`
                    );
                } else {
                    this.logger.error(`Retry batch failed: ${result.error}`);
                }
            }

            // Step 3: Update database with failure tracking
            if (failureDetails.length > 0 || orderDetailsFromApi.length > 0) {
                await this.updateTradeWithRetryInfo(
                    tradeId,
                    failureDetails,
                    orderDetailsFromApi,
                    retryOrderIds,
                );
            }

            return {
                success: true,
                retryCount: retryOrders.length,
                failureCount: failureDetails.length,
            };
        } catch (error: any) {
            this.logger.error(`Job #${job.id} error: ${error.message}`);
            throw error; // Re-throw to trigger Bull retry mechanism
        }
    }

    @OnQueueActive()
    onActive(job: Job<ManagePositionJobData>) {
        this.logger.debug(
            `Job #${job.id} started: tradeId=${job.data.tradeId} | Orders: ${job.data.originalOrders.length} | Attempt: ${job.attemptsMade + 1}`
        );
    }

    @OnQueueCompleted()
    onCompleted(job: Job<ManagePositionJobData>, result: any) {
        if (result?.success) {
            this.logger.log(
                `Job #${job.id} completed: tradeId=${job.data.tradeId} | Retries: ${result.retryCount} | Failures: ${result.failureCount}`
            );
        } else {
            this.logger.warn(
                `Job #${job.id} completed with failure: tradeId=${job.data.tradeId} | Error: ${result?.error}`
            );
        }
    }

    @OnQueueFailed()
    onFailed(job: Job<ManagePositionJobData>, err: Error) {
        this.logger.error(
            `Job #${job.id} failed: tradeId=${job.data.tradeId} | Attempt: ${job.attemptsMade} | Error: ${err.message}`
        );
    }
}
