import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Market } from './market.entity';

@Entity('events')
@Index(['eventId'], { unique: true })
@Index(['slug'], { unique: true })
@Index(['active'])
@Index(['startDate'])
export class Event extends BaseEntity {
  @Column({ name: 'event_id', type: 'varchar', length: 255, unique: true })
  eventId: string;

  @Column({ type: 'varchar', length: 500, unique: true })
  slug: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  ticker: string;

  @Column({ type: 'text', nullable: true })
  title: string;

  @Column({ type: 'text', nullable: true })
  subtitle: string;

  @Column({ type: 'boolean', nullable: true })
  active: boolean;

  @Column({ type: 'boolean', nullable: true })
  closed: boolean;

  @Column({ type: 'boolean', nullable: true })
  archived: boolean;

  @Column({ name: 'start_date', type: 'timestamp', nullable: true })
  startDate: Date;

  @Column({ name: 'creation_date', type: 'timestamp', nullable: true })
  creationDate: Date;

  @Column({ name: 'end_date', type: 'timestamp', nullable: true })
  endDate: Date;

  // Store full raw API payload for forward-compatibility
  @Column({ type: 'jsonb', nullable: true })
  data: any;

  @Column({ name: 'last_crawled_at', type: 'timestamp', nullable: true })
  lastCrawledAt: Date;

  @OneToMany(() => Market, (market) => market.event)
  markets: Market[];
}
