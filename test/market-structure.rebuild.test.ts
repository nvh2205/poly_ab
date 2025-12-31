import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Event } from '../src/database/entities/event.entity';
import { Market } from '../src/database/entities/market.entity';
import { MarketStructureService } from '../src/modules/strategy/market-structure.service';

function buildDataSource(): DataSource {
  const sslEnabled = process.env.DB_SSL === 'true';

  return new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5442),
    username: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || '123456',
    database: process.env.DB_DATABASE || 'polymarket_orderbook_ab',
    ssl: sslEnabled
      ? {
          rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
        }
      : undefined,
    entities: [Market, Event],
    synchronize: false,
    logging: false,
  });
}

async function main(): Promise<void> {
  const dataSource = buildDataSource();
  const capturedLogs: string[] = [];
  const originalLog = Logger.prototype.log;

  Logger.prototype.log = function (message: any, ...optionalParams: any[]) {
    capturedLogs.push(String(message));
    return originalLog.call(this, message, ...optionalParams);
  };

  try {
    await dataSource.initialize();
    const marketRepository = dataSource.getRepository(Market);
    const service = new MarketStructureService(marketRepository);

    const groups = await service.rebuild();

    console.log('--- Captured Logger output ---');
    console.log(capturedLogs.join('\n') || '(no logs)');
    console.log('\n--- Rebuild result (group count + sample) ---');
    console.log(`Groups built: ${groups.length}`);
    console.log(JSON.stringify(groups, null, 2));
  } catch (error) {
    console.error('Test script failed:', error);
  } finally {
    Logger.prototype.log = originalLog;
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

void main();

