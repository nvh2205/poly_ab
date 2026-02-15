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
    enum: [
      'SELL_PARENT_BUY_CHILDREN',
      'BUY_PARENT_SELL_CHILDREN',
      'BUY_CHILD_YES_SELL_PARENT_NO',
      'BUY_PARENT_NO_SELL_CHILD_YES',
      'BUY_CHILD_YES_SELL_PARENT_YES',
      'BUY_PARENT_NO_SELL_CHILD_NO',
      'POLYMARKET_TRIANGLE',
      'POLYMARKET_TRIANGLE_BUY',
      'POLYMARKET_TRIANGLE_SELL',
    ],
  })
  strategy:
    | 'SELL_PARENT_BUY_CHILDREN'
    | 'BUY_PARENT_SELL_CHILDREN'
    | 'BUY_CHILD_YES_SELL_PARENT_NO'
    | 'BUY_PARENT_NO_SELL_CHILD_YES'
    | 'BUY_CHILD_YES_SELL_PARENT_YES'
    | 'BUY_PARENT_NO_SELL_CHILD_NO'
    | 'POLYMARKET_TRIANGLE'
    | 'POLYMARKET_TRIANGLE_BUY'
    | 'POLYMARKET_TRIANGLE_SELL';

  @Column({ name: 'parent_market_id', type: 'varchar', length: 255, nullable: true })
  parentMarketId?: string;

  @Column({ name: 'parent_asset_id', type: 'varchar', length: 255, nullable: true })
  parentAssetId?: string;

  @Column({
    name: 'token_type',
    type: 'enum',
    enum: ['yes', 'no'],
    default: 'yes',
  })
  tokenType: 'yes' | 'no';

  @Column({ name: 'range_i', type: 'int', nullable: true })
  rangeI?: number;

  @Column({ name: 'range_j', type: 'int', nullable: true })
  rangeJ?: number;

  @Column({
    name: 'parent_best_bid',
    type: 'decimal',
    precision: 18,
    scale: 8,
    nullable: true,
  })
  parentBestBid?: number;

  @Column({
    name: 'parent_best_ask',
    type: 'decimal',
    precision: 18,
    scale: 8,
    nullable: true,
  })
  parentBestAsk?: number;

  @Column({
    name: 'parent_best_bid_size',
    type: 'decimal',
    precision: 18,
    scale: 8,
    nullable: true,
  })
  parentBestBidSize?: number;

  @Column({
    name: 'parent_best_ask_size',
    type: 'decimal',
    precision: 18,
    scale: 8,
    nullable: true,
  })
  parentBestAskSize?: number;

  @Column({
    name: 'parent_upper_best_bid',
    type: 'decimal',
    precision: 18,
    scale: 8,
    nullable: true,
  })
  parentUpperBestBid?: number;

  @Column({
    name: 'parent_upper_best_ask',
    type: 'decimal',
    precision: 18,
    scale: 8,
    nullable: true,
  })
  parentUpperBestAsk?: number;

  @Column({
    name: 'parent_upper_best_bid_size',
    type: 'decimal',
    precision: 18,
    scale: 8,
    nullable: true,
  })
  parentUpperBestBidSize?: number;

  @Column({
    name: 'parent_upper_best_ask_size',
    type: 'decimal',
    precision: 18,
    scale: 8,
    nullable: true,
  })
  parentUpperBestAskSize?: number;

  @Column({
    name: 'children_sum_ask',
    type: 'decimal',
    precision: 18,
    scale: 8,
    nullable: true,
  })
  childrenSumAsk?: number;

  @Column({
    name: 'children_sum_bid',
    type: 'decimal',
    precision: 18,
    scale: 8,
    nullable: true,
  })
  childrenSumBid?: number;

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
