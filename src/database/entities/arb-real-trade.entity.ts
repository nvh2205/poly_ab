import {
  Entity,
  Column,
  Index,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ArbSignal } from './arb-signal.entity';

/**
 * ArbRealTrade Entity
 * Stores real trade execution results for arbitrage signals
 */
@Entity('arb_real_trades')
@Index(['signalId'])
@Index(['createdAt'])
@Index(['success'])
export class ArbRealTrade {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date;

  @Column({ name: 'signal_id', type: 'uuid' })
  signalId: string;

  @ManyToOne(() => ArbSignal, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'signal_id' })
  signal: ArbSignal;

  @Column({ type: 'boolean', default: false })
  success: boolean;

  @Column({ name: 'order_ids', type: 'jsonb', nullable: true })
  orderIds?: string[];

  @Column({ type: 'text', nullable: true })
  error?: string;

  @Column({ name: 'error_messages', type: 'jsonb', nullable: true })
  errorMessages?: Array<{
    tokenID: string;
    marketSlug?: string;
    side: 'BUY' | 'SELL';
    price: number;
    errorMsg: string;
  }>;

  @Column({
    name: 'total_cost',
    type: 'decimal',
    precision: 18,
    scale: 8,
    nullable: true,
  })
  totalCost?: number;

  @Column({
    name: 'expected_pnl',
    type: 'decimal',
    precision: 18,
    scale: 8,
    nullable: true,
  })
  expectedPnl?: number;

  @Column({ name: 'timestamp_ms', type: 'bigint' })
  timestampMs: number;

  // === Failure Tracking (for manage-position service) ===

  @Column({ name: 'failure_type', type: 'varchar', length: 50, nullable: true })
  failureType?: 'PARTIAL_FILL_CANCELLED' | 'TRANSACTION_FAILED' | null;

  @Column({ name: 'retry_order_ids', type: 'jsonb', nullable: true })
  retryOrderIds?: string[];

  @Column({ name: 'retry_count', type: 'int', default: 0 })
  retryCount: number;

  @Column({ name: 'original_order_details', type: 'jsonb', nullable: true })
  originalOrderDetails?: Array<{
    orderId: string;
    tokenID: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    status?: string;
    sizeMatched?: number;
    associateTrades?: string[];
  }>;
}
