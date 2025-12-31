import {
  Entity,
  Column,
  Index,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';

/**
 * ArbSignal Entity
 * Stores arbitrage opportunities detected by the engine
 */
@Entity('arb_signals')
@Index(['groupKey'])
@Index(['crypto'])
@Index(['parentMarketId'])
@Index(['parentAssetId'])
@Index(['createdAt'])
export class ArbSignal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date;

  @Column({ name: 'group_key', type: 'varchar', length: 255 })
  groupKey: string;

  @Column({ name: 'event_slug', type: 'varchar', length: 255, nullable: true })
  eventSlug?: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  crypto?: string;

  @Column({
    type: 'enum',
    enum: ['SELL_PARENT_BUY_CHILDREN', 'BUY_PARENT_SELL_CHILDREN'],
  })
  strategy: 'SELL_PARENT_BUY_CHILDREN' | 'BUY_PARENT_SELL_CHILDREN';

  @Column({ name: 'parent_market_id', type: 'varchar', length: 255 })
  parentMarketId: string;

  @Column({ name: 'parent_asset_id', type: 'varchar', length: 255 })
  parentAssetId: string;

  @Column({ name: 'range_i', type: 'int' })
  rangeI: number;

  @Column({ name: 'range_j', type: 'int' })
  rangeJ: number;

  @Column({ name: 'parent_best_bid', type: 'decimal', precision: 18, scale: 8, nullable: true })
  parentBestBid?: number;

  @Column({ name: 'parent_best_ask', type: 'decimal', precision: 18, scale: 8, nullable: true })
  parentBestAsk?: number;

  @Column({ name: 'children_sum_ask', type: 'decimal', precision: 18, scale: 8 })
  childrenSumAsk: number;

  @Column({ name: 'children_sum_bid', type: 'decimal', precision: 18, scale: 8 })
  childrenSumBid: number;

  @Column({ name: 'profit_abs', type: 'decimal', precision: 18, scale: 8 })
  profitAbs: number;

  @Column({ name: 'profit_bps', type: 'decimal', precision: 18, scale: 4 })
  profitBps: number;

  @Column({ name: 'is_executable', type: 'boolean', default: false })
  isExecutable: boolean;

  @Column({ type: 'text', nullable: true })
  reason?: string;

  @Column({ type: 'jsonb', nullable: true })
  snapshot?: any;

  @Column({ name: 'timestamp_ms', type: 'bigint' })
  timestampMs: number;
}

