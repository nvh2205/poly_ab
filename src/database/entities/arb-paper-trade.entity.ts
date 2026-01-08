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
 * ArbPaperTrade Entity
 * Stores paper-trade simulation results for arbitrage signals
 */
@Entity('arb_paper_trades')
@Index(['signalId'])
@Index(['createdAt'])
export class ArbPaperTrade {
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

  @Column({ name: 'filled_size', type: 'decimal', precision: 18, scale: 8 })
  filledSize: number;

  @Column({ type: 'jsonb', nullable: true })
  entry?: any;

  @Column({ type: 'jsonb', nullable: true })
  fills?: any;

  @Column({ name: 'pnl_abs', type: 'decimal', precision: 18, scale: 8, nullable: true })
  pnlAbs?: number;

  @Column({ name: 'pnl_bps', type: 'decimal', precision: 18, scale: 4, nullable: true })
  pnlBps?: number;

  @Column({ name: 'latency_ms', type: 'int', nullable: true })
  latencyMs?: number;

  @Column({
    name: 'total_cost',
    type: 'decimal',
    precision: 18,
    scale: 8,
    nullable: true,
  })
  totalCost?: number;

  @Column({ name: 'timestamp_ms', type: 'bigint' })
  timestampMs: number;
}

