import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { mkdir, writeFile } from 'fs/promises';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { Event } from '../src/database/entities/event.entity';
import { Market } from '../src/database/entities/market.entity';
import { MarketStructureService } from '../src/modules/strategy/market-structure.service';
import { MarketDataStreamService } from '../src/modules/ingestion/market-data-stream.service';
import { ArbitrageEngineTrioService } from '../src/modules/strategy/arbitrage-engine-trio.service';

/**
 * Test bootstrap for ArbitrageEngineTrioService
 * This test inspects all cached memory variables in the Trio Model engine
 * 
 * Run: npx ts-node test/arbitrage-engine-trio.bootstrap.test.ts
 * 
 * Environment variables:
 * - BOOTSTRAP_JSON_PREVIEW_LIMIT: Number of items to include in key arrays (default: 200)
 * - BOOTSTRAP_JSON_INCLUDE_ALL_KEYS: Set to 'true' to include ALL keys (warning: large output)
 */

interface TrioState {
    parentLowerIndex: number;
    parentUpperIndex: number;
    rangeIndex: number;
    lowerYes: unknown;
    upperNo: unknown;
    rangeNo: unknown;
}

interface GroupState {
    group: unknown;
    childStates: unknown[];
    parentStates: unknown[];
    trioStates: TrioState[];
    cooldowns: Map<string, number>;
    trioLookupByAsset: Map<string, number[]>;
}

interface TrioLocator {
    groupKey: string;
    trioIndex: number;
    role: string;
}

// Helper to convert Map to Object for JSON serialization
function mapToObject<K extends string | number, V>(map: Map<K, V> | undefined): Record<string, V> {
    if (!map) return {};
    const obj: Record<string, V> = {};
    for (const [key, value] of map.entries()) {
        obj[String(key)] = value;
    }
    return obj;
}

// Deep serialize GroupState, converting all Maps to Objects
function serializeGroupState(state: GroupState): Record<string, unknown> {
    return {
        group: state.group,
        childStates: state.childStates,
        parentStates: state.parentStates,
        trioStates: state.trioStates,
        cooldowns: mapToObject(state.cooldowns),
        trioLookupByAsset: mapToObject(state.trioLookupByAsset),
    };
}

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
                rejectUnauthorized:
                    process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
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
    const outputPath = path.join(artifactsDir, 'arbitrage-engine-trio.bootstrap.json');

    const output: Record<string, unknown> = {
        startedAt,
        outputPath,
        success: false,
        modelType: 'TRIO',
        description: 'ArbitrageEngineTrioService - Optimized 3-market only, adjacent parent pairs',
        env: {
            DB_HOST: process.env.DB_HOST || 'localhost',
            DB_PORT: Number(process.env.DB_PORT || 5442),
            DB_USERNAME: process.env.DB_USERNAME || 'root',
            DB_DATABASE: process.env.DB_DATABASE || 'polymarket_orderbook_ab',
            DB_SSL: process.env.DB_SSL === 'true',
            DB_SSL_REJECT_UNAUTHORIZED:
                process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
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
        const trioEngine = new ArbitrageEngineTrioService(
            marketStructureService,
            marketDataStreamService,
        );

        await trioEngine.onModuleInit();

        // Cast to access private internals
        const internals = trioEngine as unknown as {
            groups: Map<string, GroupState>;
            marketIdIndex: Map<string, unknown>;
            slugIndex: Map<string, unknown>;
            tokenIndex: Map<string, unknown>;
            trioTokenIndex: Map<string, TrioLocator[]>;
            allTokenIndex: Map<string, unknown>;
            lastPriceCache: Map<string, unknown>;
        };

        // === CACHE MEMORY SUMMARY ===
        const groupCount = internals.groups?.size ?? 0;
        const marketIdKeys = Array.from(internals.marketIdIndex?.keys?.() ?? []);
        const slugKeys = Array.from(internals.slugIndex?.keys?.() ?? []);
        const tokenKeys = Array.from(internals.tokenIndex?.keys?.() ?? []);
        const groupKeys = Array.from(internals.groups?.keys?.() ?? []);
        const trioTokenKeys = Array.from(internals.trioTokenIndex?.keys?.() ?? []);
        const allTokenKeys = Array.from(internals.allTokenIndex?.keys?.() ?? []);
        const lastPriceCacheKeys = Array.from(internals.lastPriceCache?.keys?.() ?? []);

        // === TRIO-SPECIFIC STATS ===
        let totalTrioStates = 0;
        let totalTrioLookupEntries = 0;
        let totalCooldownEntries = 0;
        const trioStatsPerGroup: Record<string, { trioCount: number; lookupSize: number; cooldownSize: number }> = {};

        for (const [groupKey, state] of internals.groups?.entries?.() ?? []) {
            const trioCount = state.trioStates?.length ?? 0;
            const lookupSize = state.trioLookupByAsset?.size ?? 0;
            const cooldownSize = state.cooldowns?.size ?? 0;

            totalTrioStates += trioCount;
            totalTrioLookupEntries += lookupSize;
            totalCooldownEntries += cooldownSize;

            trioStatsPerGroup[groupKey] = { trioCount, lookupSize, cooldownSize };
        }

        // === MEMORY ESTIMATION ===
        const estimateMapMemory = (map: Map<unknown, unknown> | undefined): number => {
            if (!map) return 0;
            // Rough estimate: 50 bytes per entry (key + value + overhead)
            return map.size * 50;
        };

        const memoryEstimates = {
            groups: estimateMapMemory(internals.groups) + (totalTrioStates * 200), // + TrioState objects
            tokenIndex: estimateMapMemory(internals.tokenIndex),
            slugIndex: estimateMapMemory(internals.slugIndex),
            marketIdIndex: estimateMapMemory(internals.marketIdIndex),
            trioTokenIndex: estimateMapMemory(internals.trioTokenIndex) + (trioTokenKeys.length * 100), // + locator arrays
            allTokenIndex: estimateMapMemory(internals.allTokenIndex),
            lastPriceCache: estimateMapMemory(internals.lastPriceCache),
            trioLookups: totalTrioLookupEntries * 50,
            cooldowns: totalCooldownEntries * 50,
        };

        const totalMemoryBytes = Object.values(memoryEstimates).reduce((a, b) => a + b, 0);

        const takeMaybe = <T>(arr: T[]): T[] =>
            includeAllKeys
                ? arr
                : arr.slice(0, Number.isFinite(previewLimit) ? previewLimit : 200);

        // === SAMPLE DATA ===
        const sampleGroupKey = groupKeys[0];
        const sampleGroup = sampleGroupKey
            ? internals.groups.get(sampleGroupKey)
            : undefined;

        // Get sample trios with details
        const sampleTrios: Array<{ groupKey: string; trio: TrioState; lookupDepth: Record<string, number> }> = [];
        for (const [groupKey, state] of internals.groups?.entries?.() ?? []) {
            if (state.trioStates?.length > 0) {
                const trio = state.trioStates[0];

                // Check lookup depth for each token in this trio
                const lookupDepth: Record<string, number> = {};
                for (const assetId of [trio.lowerYes, trio.upperNo, trio.rangeNo]) {
                    const id = (assetId as any)?.assetId;
                    if (id) {
                        lookupDepth[id] = state.trioLookupByAsset?.get(id)?.length ?? 0;
                    }
                }

                sampleTrios.push({ groupKey, trio, lookupDepth });
                if (sampleTrios.length >= 3) break;
            }
        }

        // Sample trioTokenIndex entries
        const sampleTrioTokenIndex: Record<string, TrioLocator[]> = {};
        let count = 0;
        for (const [tokenId, locators] of internals.trioTokenIndex?.entries?.() ?? []) {
            sampleTrioTokenIndex[tokenId] = locators;
            count++;
            if (count >= 10) break;
        }

        // === CONSOLE OUTPUT ===
        console.log('='.repeat(60));
        console.log('ArbitrageEngineTrioService - Cache Memory Report');
        console.log('='.repeat(60));
        console.log(`\n--- Captured Logger output ---`);
        console.log(capturedLogs.join('\n') || '(no logs)');

        console.log(`\n--- MEMORY CACHE SUMMARY ---`);
        console.log(`Groups registered:       ${groupCount}`);
        console.log(`Total TrioStates:        ${totalTrioStates}`);
        console.log(`Total TrioLookup entries:${totalTrioLookupEntries}`);
        console.log(`Total Cooldown entries:  ${totalCooldownEntries}`);

        console.log(`\n--- INDEX SIZES ---`);
        console.log(`tokenIndex:              ${tokenKeys.length} entries`);
        console.log(`slugIndex:               ${slugKeys.length} entries`);
        console.log(`marketIdIndex:           ${marketIdKeys.length} entries`);
        console.log(`trioTokenIndex:          ${trioTokenKeys.length} entries`);
        console.log(`allTokenIndex:           ${allTokenKeys.length} entries`);
        console.log(`lastPriceCache:          ${lastPriceCacheKeys.length} entries`);

        console.log(`\n--- MEMORY ESTIMATES (bytes) ---`);
        for (const [key, value] of Object.entries(memoryEstimates)) {
            console.log(`${key.padEnd(20)}: ${value.toLocaleString()} bytes (${(value / 1024).toFixed(2)} KB)`);
        }
        console.log(`${'TOTAL'.padEnd(20)}: ${totalMemoryBytes.toLocaleString()} bytes (${(totalMemoryBytes / 1024).toFixed(2)} KB)`);

        console.log(`\n--- TRIO STATS PER GROUP (first 10) ---`);
        const groupEntries = Object.entries(trioStatsPerGroup).slice(0, 10);
        for (const [key, stats] of groupEntries) {
            console.log(`${key.substring(0, 40).padEnd(42)}: ${stats.trioCount} trios, ${stats.lookupSize} lookups`);
        }

        console.log(`\n--- SAMPLE TRIOS ---`);
        for (const sample of sampleTrios) {
            console.log(`Group: ${sample.groupKey}`);
            console.log(`  ParentLower: ${sample.trio.parentLowerIndex}, ParentUpper: ${sample.trio.parentUpperIndex}, Range: ${sample.trio.rangeIndex}`);
            console.log(`  LowerYes AssetId: ${(sample.trio.lowerYes as any)?.assetId}`);
            console.log(`  UpperNo AssetId:  ${(sample.trio.upperNo as any)?.assetId}`);
            console.log(`  RangeNo AssetId:  ${(sample.trio.rangeNo as any)?.assetId}`);
            console.log(`  Lookup depths:    ${JSON.stringify(sample.lookupDepth)}`);
        }

        console.log(`\n--- SAMPLE trioTokenIndex (first 10) ---`);
        for (const [tokenId, locators] of Object.entries(sampleTrioTokenIndex)) {
            const arr = Array.isArray(locators) ? locators : [locators];
            console.log(`${tokenId.substring(0, 20)}...: ${arr.length} locators`);
            for (const loc of arr.slice(0, 2)) {
                if (loc && typeof loc === 'object') {
                    console.log(`    -> group: ${(loc as any).groupKey?.substring?.(0, 30) ?? '?'}..., trio: ${(loc as any).trioIndex}, role: ${(loc as any).role}`);
                }
            }
        }

        // === BUILD OUTPUT JSON ===
        output.success = true;
        output.capturedLogs = capturedLogs;
        output.summary = {
            groupCount,
            totalTrioStates,
            totalTrioLookupEntries,
            totalCooldownEntries,
            indexSizes: {
                tokenIndex: tokenKeys.length,
                slugIndex: slugKeys.length,
                marketIdIndex: marketIdKeys.length,
                trioTokenIndex: trioTokenKeys.length,
                allTokenIndex: allTokenKeys.length,
                lastPriceCache: lastPriceCacheKeys.length,
            },
            memoryEstimates,
            totalMemoryBytes,
            totalMemoryKB: (totalMemoryBytes / 1024).toFixed(2),
            previewLimit: includeAllKeys ? null : previewLimit,
            includeAllKeys,
        };
        output.keys = {
            groupKeys: takeMaybe(groupKeys),
            tokenIndexKeys: takeMaybe(tokenKeys),
            tokenIndexFull: Object.fromEntries(
                takeMaybe(tokenKeys).map(k => [k, internals.tokenIndex.get(k)])
            ),
            slugIndexKeys: takeMaybe(slugKeys),
            marketIdIndexKeys: takeMaybe(marketIdKeys),
            trioTokenIndexKeys: takeMaybe(trioTokenKeys),
            allTokenIndexKeys: takeMaybe(allTokenKeys),
        };
        output.trioStatsPerGroup = trioStatsPerGroup;
        output.sampleGroup = sampleGroupKey && sampleGroup
            ? {
                key: sampleGroupKey,
                value: serializeGroupState(sampleGroup),
            }
            : null;
        output.sampleTrios = sampleTrios;
        output.sampleTrioTokenIndex = sampleTrioTokenIndex;

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
            console.log(`\n${'='.repeat(60)}`);
            console.log(`Wrote bootstrap output JSON to: ${outputPath}`);
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
