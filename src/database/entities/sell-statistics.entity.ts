import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base.entity';

/**
 * SellStatistics Entity
 * Aggregates sell counts per market/token to identify mint-friendly ranges.
 */
@Entity('sell_statistics')
@Index(['marketId', 'tokenType', 'tokenId'])
@Index(['marketSlug'])
export class SellStatistics extends BaseEntity {
  @Column({ name: 'market_slug', type: 'varchar', length: 500 })
  marketSlug: string;

  @Column({ name: 'market_id', type: 'varchar', length: 255 })
  marketId: string;

  @Column({
    name: 'token_type',
    type: 'enum',
    enum: ['yes', 'no'],
  })
  tokenType: 'yes' | 'no';

  @Column({ name: 'token_id', type: 'varchar', length: 255 })
  tokenId: string;

  @Column({
    name: 'sell_parent_buy_children_count',
    type: 'int',
    default: 0,
  })
  sellParentBuyChildrenCount: number;

  @Column({
    name: 'buy_parent_sell_children_count',
    type: 'int',
    default: 0,
  })
  buyParentSellChildrenCount: number;

  @Column({
    name: 'polymarket_triangle_sell_count',
    type: 'int',
    default: 0,
  })
  polymarketTriangleSellCount: number;

  @Column({ type: 'varchar', length: 255 })
  identifi: string;

  @Column({ type: 'varchar', length: 100 })
  symbol: string;
}
