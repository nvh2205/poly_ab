import {
  Entity,
  Column,
  Index,
  JoinColumn,
  ManyToOne,
  RelationId,
} from 'typeorm';
import { BaseEntity } from './base.entity';
import { Event } from './event.entity';

@Entity('markets')
@Index(['slug'], { unique: true })
@Index(['marketId'], { unique: true })
@Index(['conditionId'])
@Index(['active'])
@Index(['startTime'])
export class Market extends BaseEntity {
  @Column({ name: 'market_id', type: 'varchar', length: 255, unique: true })
  marketId: string;

  @ManyToOne(() => Event, (event) => event.markets, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'event_id', referencedColumnName: 'eventId' })
  event?: Event | null;

  @RelationId((market: Market) => market.event)
  eventId?: string | null;

  @Column({ type: 'text', nullable: true })
  question: string;

  @Column({
    name: 'condition_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  conditionId: string;

  @Column({ type: 'varchar', length: 500, unique: true })
  slug: string;

  @Column({ type: 'decimal', precision: 20, scale: 10, nullable: true })
  volume: string;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @Column({ type: 'boolean', default: false })
  closed: boolean;

  @Column({ name: 'question_id', type: 'varchar', length: 255, nullable: true })
  questionID: string;

  @Column({ name: 'clob_token_ids', type: 'jsonb', nullable: true })
  clobTokenIds: string[];

  @Column({ name: 'token_yes', type: 'varchar', length: 255, nullable: true })
  tokenYes: string;

  @Column({ name: 'token_no', type: 'varchar', length: 255, nullable: true })
  tokenNo: string;

  @Column({ name: 'creation_date', type: 'timestamp', nullable: true })
  creationDate: Date;

  @Column({ name: 'start_time', type: 'timestamp', nullable: true })
  startTime: Date;

  @Column({ name: 'end_date', type: 'timestamp', nullable: true })
  endDate: Date;

  @Column({ name: 'type', type: 'varchar', length: 255, nullable: true })
  type: string; // crypto from config (e.g., 'btc', 'eth', 'solana')

  @Column({ name: 'neg_risk', type: 'boolean', nullable: true })
  negRisk: boolean | null;

  @Column({
    name: 'neg_risk_market_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  negRiskMarketID: string | null;
}
