import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { mkdir, writeFile } from 'fs/promises';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { Event } from '../src/database/entities/event.entity';
import { Market } from '../src/database/entities/market.entity';
import { MarketStructureService } from '../src/modules/strategy/market-structure.service';
import { MarketDataStreamService } from '../src/modules/ingestion/market-data-stream.service';
import { ArbitrageEngineService } from '../src/modules/strategy/arbitrage-engine.service';

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
  const startedAt = new Date().toISOString();
  const previewLimit = Number(process.env.BOOTSTRAP_JSON_PREVIEW_LIMIT ?? 200);
  const includeAllKeys = process.env.BOOTSTRAP_JSON_INCLUDE_ALL_KEYS === 'true';

  const artifactsDir = path.resolve(process.cwd(), 'test', 'artifacts');
  const outputPath = path.join(artifactsDir, 'arbitrage-engine.bootstrap.json');

  const output: Record<string, unknown> = {
    startedAt,
    outputPath,
    success: false,
    env: {
      DB_HOST: process.env.DB_HOST || 'localhost',
      DB_PORT: Number(process.env.DB_PORT || 5442),
      DB_USERNAME: process.env.DB_USERNAME || 'root',
      DB_DATABASE: process.env.DB_DATABASE || 'polymarket_orderbook_ab',
      DB_SSL: process.env.DB_SSL === 'true',
      DB_SSL_REJECT_UNAUTHORIZED: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
    },
    capturedLogs: [],
  };

  Logger.prototype.log = function (message: any, ...optionalParams: any[]) {
    capturedLogs.push(String(message));
    return originalLog.call(this, message, ...optionalParams);
  };

  const marketDataStreamService = new MarketDataStreamService();

  try {
    await dataSource.initialize();
    const marketRepository = dataSource.getRepository(Market);
    const marketStructureService = new MarketStructureService(marketRepository);
    const arbitrageEngine = new ArbitrageEngineService(
      marketStructureService,
      marketDataStreamService,
    );

    await arbitrageEngine.onModuleInit();

    const internals = arbitrageEngine as unknown as {
      groups: Map<string, unknown>;
      marketIdIndex: Map<string, unknown>;
      slugIndex: Map<string, unknown>;
      tokenIndex: Map<string, unknown>;
    };

    const groupCount = internals.groups?.size ?? 0;
    const marketIdKeys = Array.from(internals.marketIdIndex?.keys?.() ?? []);
    const slugKeys = Array.from(internals.slugIndex?.keys?.() ?? []);
    const tokenKeys = Array.from(internals.tokenIndex?.keys?.() ?? []);
    const groupKeys = Array.from(internals.groups?.keys?.() ?? []);

    const takeMaybe = <T,>(arr: T[]): T[] =>
      includeAllKeys ? arr : arr.slice(0, Number.isFinite(previewLimit) ? previewLimit : 200);

    const sampleGroupKey = groupKeys[0];
    const sampleGroup = sampleGroupKey ? internals.groups.get(sampleGroupKey) : undefined;

    console.log('--- Captured Logger output ---');
    console.log(capturedLogs.join('\n') || '(no logs)');
    console.log('\n--- ArbitrageEngine bootstrap summary ---');
    console.log(`Groups registered: ${groupCount}`);
    console.log(`Group keys: ${groupKeys.slice(0, 20).join(', ') || '(none)'}`);
    console.log(`marketIdIndex size: ${marketIdKeys.length}`);
    console.log(`slugIndex size: ${slugKeys.length}`);
    console.log(`tokenIndex size: ${tokenKeys.length}`);
    console.log('\nSample keys:');
    console.log(`marketIdIndex keys: ${marketIdKeys.slice(0, 10).join(', ') || '(none)'}`);
    console.log(`slugIndex keys: ${slugKeys.slice(0, 10).join(', ') || '(none)'}`);
    console.log(`tokenIndex keys: ${tokenKeys.slice(0, 10).join(', ') || '(none)'}`);
    if (sampleGroupKey) {
      console.log('\n--- Sample group (first) ---');
      console.log(JSON.stringify(sampleGroup, null, 2));
    }

    output.success = true;
    output.capturedLogs = capturedLogs;
    output.summary = {
      groupCount,
      groupKeysTotal: groupKeys.length,
      marketIdIndexTotal: marketIdKeys.length,
      slugIndexTotal: slugKeys.length,
      tokenIndexTotal: tokenKeys.length,
      previewLimit: includeAllKeys ? null : previewLimit,
      includeAllKeys,
    };
    output.keys = {
      groupKeys: takeMaybe(groupKeys),
      marketIdIndexKeys: takeMaybe(marketIdKeys),
      slugIndexKeys: takeMaybe(slugKeys),
      tokenIndexKeys: takeMaybe(tokenKeys),
    };
    output.sampleGroup = sampleGroupKey
      ? {
          key: sampleGroupKey,
          value: sampleGroup,
        }
      : null;
  } catch (error) {
    console.error('Bootstrap test failed:', error);
    output.success = false;
    output.capturedLogs = capturedLogs;
    output.error = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    };
  } finally {
    try {
      await mkdir(artifactsDir, { recursive: true });
      await writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');
      console.log(`\nWrote bootstrap output JSON to: ${outputPath}`);
    } catch (writeErr) {
      console.error('Failed to write bootstrap output JSON:', writeErr);
    }

    await marketDataStreamService.onModuleDestroy?.();
    await (async () => {
      if (dataSource.isInitialized) {
        await dataSource.destroy();
      }
    })();
    Logger.prototype.log = originalLog;
  }
}

void main();

