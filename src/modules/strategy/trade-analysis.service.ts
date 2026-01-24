import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import { ArbSignal } from '../../database/entities/arb-signal.entity';
import { ArbRealTrade } from '../../database/entities/arb-real-trade.entity';
import { Market } from '../../database/entities/market.entity';

/**
 * CSV Transaction from Polymarket export
 */
interface CsvTransaction {
  marketName: string;
  action: 'Buy' | 'Sell' | 'Split' | 'Merge' | 'Redeem' | 'Lost';
  usdcAmount: number;
  tokenAmount: number;
  tokenName: string; // 'Yes', 'No', or ''
  timestamp: number; // Unix epoch seconds
  hash: string;
}

/**
 * Matched transaction with signal data
 */
interface MatchedTransaction {
  transaction: CsvTransaction;
  realTrade?: ArbRealTrade;
  signal?: ArbSignal;
  market?: Market;
  matchStatus: 'matched' | 'unmatched' | 'trade_only' | 'split_merge_redeem';
  expectedPrice?: number;
  actualPrice?: number;
  slippagePercent?: number;
  slippageUsdc?: number;
  pnlContribution?: number;
}

/**
 * Analysis summary
 */
interface AnalysisSummary {
  totalTransactions: number;
  matchedWithSignals: number;
  unmatched: number;
  splitMergeRedeem: number;
  totalSlippageUsdc: number;
  avgSlippagePercent: number;
  totalPnl: number;
  byStrategy: Record<string, { count: number; pnl: number }>;
  byAction: Record<string, { count: number; volume: number }>;
}

/**
 * Full analysis result
 */
interface AnalysisResult {
  summary: AnalysisSummary;
  matchedTransactions: MatchedTransaction[];
  slippageAnalysis: MatchedTransaction[];
  failedUnmatched: MatchedTransaction[];
}

/**
 * Trade Analysis Service
 * Compares Polymarket transaction history with arbitrage signals
 * to identify slippage, size mismatches, and calculate P&L
 */
@Injectable()
export class TradeAnalysisService {
  private readonly logger = new Logger(TradeAnalysisService.name);

  // Tolerance for timestamp matching (in seconds)
  private readonly TIMESTAMP_TOLERANCE_SEC = 10;

  constructor(
    @InjectRepository(ArbSignal)
    private readonly arbSignalRepository: Repository<ArbSignal>,
    @InjectRepository(ArbRealTrade)
    private readonly arbRealTradeRepository: Repository<ArbRealTrade>,
    @InjectRepository(Market)
    private readonly marketRepository: Repository<Market>,
  ) {}

  /**
   * Main entry point - analyze transactions between dates
   */
  async analyzeTransactions(
    startDate: Date,
    endDate: Date,
    csvPath?: string,
  ): Promise<{ excelPath: string; summary: AnalysisSummary }> {
    this.logger.log(
      `Starting analysis from ${startDate.toISOString()} to ${endDate.toISOString()}`,
    );

    // 1. Load CSV transactions
    const csvTransactions = await this.loadCsvTransactions(csvPath);
    this.logger.log(`Loaded ${csvTransactions.length} transactions from CSV`);

    // 2. Filter transactions by date range
    const startEpoch = Math.floor(startDate.getTime() / 1000);
    const endEpoch = Math.floor(endDate.getTime() / 1000);
    const filteredTransactions = csvTransactions.filter(
      (tx) => tx.timestamp >= startEpoch && tx.timestamp <= endEpoch,
    );
    this.logger.log(
      `${filteredTransactions.length} transactions in date range`,
    );

    // 3. Fetch real trades from DB
    const realTrades = await this.fetchRealTradesInRange(startDate, endDate);
    this.logger.log(`Fetched ${realTrades.length} real trades from DB`);

    // 4. Fetch all signals for these trades
    const signalIds = realTrades.map((t) => t.signalId).filter(Boolean);
    const signals = await this.fetchSignalsByIds(signalIds);
    this.logger.log(`Fetched ${signals.length} signals`);

    // 5. Load markets for matching
    const markets = await this.loadAllMarkets();
    this.logger.log(`Loaded ${markets.length} markets`);

    // 6. Match transactions with signals
    const matchedTransactions = this.matchTransactions(
      filteredTransactions,
      realTrades,
      signals,
      markets,
    );

    // 7. Analyze and calculate summary
    const analysis = this.analyzeDiscrepancies(matchedTransactions);

    // 8. Generate Excel report
    const excelPath = await this.generateExcelReport(
      analysis,
      startDate,
      endDate,
    );

    return {
      excelPath,
      summary: analysis.summary,
    };
  }

  /**
   * Load and parse CSV file
   */
  async loadCsvTransactions(csvPath?: string): Promise<CsvTransaction[]> {
    // Default to the latest CSV in data folder
    const defaultPath = path.join(
      process.cwd(),
      'data',
      'Polymarket-Transaction-History-Sat Jan 24 2026 00_30_26 GMT+0700 (Indochina Time).csv',
    );
    const filePath = csvPath || defaultPath;

    if (!fs.existsSync(filePath)) {
      throw new Error(`CSV file not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim());

    // Skip header
    const transactions: CsvTransaction[] = [];
    for (let i = 1; i < lines.length; i++) {
      const parsed = this.parseCsvLine(lines[i]);
      if (parsed) {
        transactions.push(parsed);
      }
    }

    return transactions;
  }

  /**
   * Parse a single CSV line (handling quoted fields)
   */
  private parseCsvLine(line: string): CsvTransaction | null {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        fields.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    fields.push(current.trim());

    if (fields.length < 7) return null;

    return {
      marketName: fields[0],
      action: fields[1] as CsvTransaction['action'],
      usdcAmount: parseFloat(fields[2]) || 0,
      tokenAmount: parseFloat(fields[3]) || 0,
      tokenName: fields[4],
      timestamp: parseInt(fields[5]) || 0,
      hash: fields[6],
    };
  }

  /**
   * Fetch real trades from database in date range
   */
  async fetchRealTradesInRange(
    startDate: Date,
    endDate: Date,
  ): Promise<ArbRealTrade[]> {
    return this.arbRealTradeRepository.find({
      where: {
        createdAt: Between(startDate, endDate),
      },
      relations: ['signal'],
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Fetch signals by IDs
   */
  async fetchSignalsByIds(signalIds: string[]): Promise<ArbSignal[]> {
    if (signalIds.length === 0) return [];

    return this.arbSignalRepository
      .createQueryBuilder('signal')
      .whereInIds(signalIds)
      .getMany();
  }

  /**
   * Load all markets for matching
   */
  async loadAllMarkets(): Promise<Market[]> {
    return this.marketRepository.find();
  }

  /**
   * Match transactions with signals
   */
  matchTransactions(
    transactions: CsvTransaction[],
    realTrades: ArbRealTrade[],
    signals: ArbSignal[],
    markets: Market[],
  ): MatchedTransaction[] {
    const signalMap = new Map(signals.map((s) => [s.id, s]));
    const marketMap = new Map(markets.map((m) => [m.question, m]));

    const matched: MatchedTransaction[] = [];

    for (const tx of transactions) {
      // Skip Split/Merge/Redeem/Lost - these are not trading actions
      if (['Split', 'Merge', 'Redeem', 'Lost'].includes(tx.action)) {
        matched.push({
          transaction: tx,
          matchStatus: 'split_merge_redeem',
        });
        continue;
      }

      // Find matching market by question
      const market = marketMap.get(tx.marketName);

      // Find matching real trade by timestamp
      const matchingTrade = this.findMatchingTrade(tx, realTrades, signalMap);

      if (matchingTrade) {
        const signal = signalMap.get(matchingTrade.signalId);

        // Calculate actual price from transaction
        const actualPrice =
          tx.tokenAmount > 0 ? tx.usdcAmount / tx.tokenAmount : 0;

        // Get expected price from signal snapshot
        const expectedPrice = this.getExpectedPrice(signal, tx.action, tx.marketName);

        // Calculate slippage
        const slippagePercent =
          expectedPrice > 0
            ? ((actualPrice - expectedPrice) / expectedPrice) * 100
            : 0;

        const slippageUsdc =
          tx.tokenAmount * (actualPrice - (expectedPrice || 0));

        matched.push({
          transaction: tx,
          realTrade: matchingTrade,
          signal,
          market,
          matchStatus: 'matched',
          expectedPrice,
          actualPrice,
          slippagePercent,
          slippageUsdc,
          pnlContribution: this.calculatePnlContribution(tx, expectedPrice),
        });
      } else {
        matched.push({
          transaction: tx,
          market,
          matchStatus: 'unmatched',
          actualPrice:
            tx.tokenAmount > 0 ? tx.usdcAmount / tx.tokenAmount : undefined,
        });
      }
    }

    return matched;
  }

  /**
   * Find matching trade by timestamp and other criteria
   */
  private findMatchingTrade(
    tx: CsvTransaction,
    realTrades: ArbRealTrade[],
    signalMap: Map<string, ArbSignal>,
  ): ArbRealTrade | undefined {
    const txTimestampMs = tx.timestamp * 1000;

    for (const trade of realTrades) {
      const tradeTimestampMs = Number(trade.timestampMs);
      const timeDiff = Math.abs(txTimestampMs - tradeTimestampMs);

      // Check timestamp within tolerance
      if (timeDiff <= this.TIMESTAMP_TOLERANCE_SEC * 1000) {
        const signal = signalMap.get(trade.signalId);
        if (!signal) continue;

        // Additional matching: check if action aligns with strategy
        const strategyMatchesBuy =
          tx.action === 'Buy' &&
          (signal.strategy.includes('BUY') ||
            signal.strategy === 'POLYMARKET_TRIANGLE');

        const strategyMatchesSell =
          tx.action === 'Sell' &&
          (signal.strategy.includes('SELL') ||
            signal.strategy === 'POLYMARKET_TRIANGLE');

        if (strategyMatchesBuy || strategyMatchesSell) {
          return trade;
        }
      }
    }

    return undefined;
  }

  /**
   * Snapshot structure from signal
   */
  private parseSnapshot(snapshot: any): {
    parent?: { marketSlug: string; bestAsk: number; bestBid: number };
    parentUpper?: { marketSlug: string; bestAsk: number; bestBid: number };
    children?: Array<{ marketSlug: string; bestAsk: number; bestBid: number }>;
  } | null {
    if (!snapshot) return null;
    
    try {
      const parsed = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
      return {
        parent: parsed.parent ? {
          marketSlug: parsed.parent.marketSlug,
          bestAsk: parsed.parent.bestAsk,
          bestBid: parsed.parent.bestBid,
        } : undefined,
        parentUpper: parsed.parentUpper ? {
          marketSlug: parsed.parentUpper.marketSlug,
          bestAsk: parsed.parentUpper.bestAsk,
          bestBid: parsed.parentUpper.bestBid,
        } : undefined,
        children: parsed.children?.map((child: any) => ({
          marketSlug: child.marketSlug,
          bestAsk: child.bestAsk,
          bestBid: child.bestBid,
        })),
      };
    } catch {
      return null;
    }
  }

  /**
   * Convert market name to slug format for matching
   * Example: "Will the price of Bitcoin be above $86,000 on January 23?" -> "bitcoin-above-86k-on-january-23"
   */
  private marketNameToSlugPattern(marketName: string): string {
    return marketName
      .toLowerCase()
      .replace(/will the price of /g, '')
      .replace(/be above \$/g, 'above-')
      .replace(/be between \$/g, 'between-')
      .replace(/,000/g, 'k')
      .replace(/ and \$/g, '-')
      .replace(/ on /g, '-on-')
      .replace(/\?/g, '')
      .replace(/\s+/g, '-')
      .replace(/--+/g, '-')
      .trim();
  }

  /**
   * Get expected price from signal snapshot based on transaction market and action
   * Maps CSV marketName to snapshot marketSlug
   */
  private getExpectedPrice(
    signal: ArbSignal | undefined,
    action: string,
    marketName: string,
  ): number | undefined {
    if (!signal) return undefined;

    const snapshot = this.parseSnapshot(signal.snapshot);
    if (!snapshot) {
      // Fallback to signal fields if no snapshot
      if (action === 'Buy') {
        return signal.parentBestAsk
          ? Number(signal.parentBestAsk)
          : signal.childrenSumAsk
            ? Number(signal.childrenSumAsk)
            : undefined;
      } else if (action === 'Sell') {
        return signal.parentBestBid
          ? Number(signal.parentBestBid)
          : signal.childrenSumBid
            ? Number(signal.childrenSumBid)
            : undefined;
      }
      return undefined;
    }

    // Try to find matching market in snapshot
    const marketSlugPattern = this.marketNameToSlugPattern(marketName);

    // Check parent
    if (snapshot.parent && snapshot.parent.marketSlug.includes(marketSlugPattern.slice(0, 20))) {
      return action === 'Buy' ? snapshot.parent.bestAsk : snapshot.parent.bestBid;
    }

    // Check parentUpper
    if (snapshot.parentUpper && snapshot.parentUpper.marketSlug.includes(marketSlugPattern.slice(0, 20))) {
      return action === 'Buy' ? snapshot.parentUpper.bestAsk : snapshot.parentUpper.bestBid;
    }

    // Check children
    if (snapshot.children) {
      for (const child of snapshot.children) {
        if (child.marketSlug.includes(marketSlugPattern.slice(0, 20))) {
          return action === 'Buy' ? child.bestAsk : child.bestBid;
        }
      }
    }

    // Try more aggressive matching - extract key numbers
    const numbersInMarket = marketName.match(/\$?([\d,]+)/g)?.map(n => n.replace(/[$,]/g, ''));
    
    if (numbersInMarket && numbersInMarket.length > 0) {
      const firstNum = numbersInMarket[0];
      const shortNum = firstNum.replace(/000$/, 'k');
      
      // Check against parent
      if (snapshot.parent?.marketSlug.includes(shortNum)) {
        return action === 'Buy' ? snapshot.parent.bestAsk : snapshot.parent.bestBid;
      }
      
      // Check against parentUpper
      if (snapshot.parentUpper?.marketSlug.includes(shortNum)) {
        return action === 'Buy' ? snapshot.parentUpper.bestAsk : snapshot.parentUpper.bestBid;
      }
      
      // Check against children
      if (snapshot.children) {
        for (const child of snapshot.children) {
          if (child.marketSlug.includes(shortNum)) {
            return action === 'Buy' ? child.bestAsk : child.bestBid;
          }
        }
      }
    }

    // Final fallback to signal fields
    if (action === 'Buy') {
      return signal.parentBestAsk
        ? Number(signal.parentBestAsk)
        : signal.childrenSumAsk
          ? Number(signal.childrenSumAsk)
          : undefined;
    } else if (action === 'Sell') {
      return signal.parentBestBid
        ? Number(signal.parentBestBid)
        : signal.childrenSumBid
          ? Number(signal.childrenSumBid)
          : undefined;
    }

    return undefined;
  }

  /**
   * Calculate P&L contribution from a transaction
   */
  private calculatePnlContribution(
    tx: CsvTransaction,
    expectedPrice?: number,
  ): number {
    if (!expectedPrice) return 0;

    const actualPrice =
      tx.tokenAmount > 0 ? tx.usdcAmount / tx.tokenAmount : 0;

    if (tx.action === 'Buy') {
      // For buy: negative if we paid more than expected
      return tx.tokenAmount * (expectedPrice - actualPrice);
    } else if (tx.action === 'Sell') {
      // For sell: positive if we received more than expected
      return tx.tokenAmount * (actualPrice - expectedPrice);
    }

    return 0;
  }

  /**
   * Analyze discrepancies and calculate summary
   */
  analyzeDiscrepancies(matchedTransactions: MatchedTransaction[]): AnalysisResult {
    const matched = matchedTransactions.filter(
      (m) => m.matchStatus === 'matched',
    );
    const unmatched = matchedTransactions.filter(
      (m) => m.matchStatus === 'unmatched',
    );
    const splitMergeRedeem = matchedTransactions.filter(
      (m) => m.matchStatus === 'split_merge_redeem',
    );

    // Calculate slippage stats
    const withSlippage = matched.filter((m) => m.slippagePercent !== undefined);
    const totalSlippageUsdc = withSlippage.reduce(
      (sum, m) => sum + (m.slippageUsdc || 0),
      0,
    );
    const avgSlippagePercent =
      withSlippage.length > 0
        ? withSlippage.reduce((sum, m) => sum + (m.slippagePercent || 0), 0) /
          withSlippage.length
        : 0;

    // Calculate total P&L
    const totalPnl = matched.reduce(
      (sum, m) => sum + (m.pnlContribution || 0),
      0,
    );

    // Group by strategy
    const byStrategy: Record<string, { count: number; pnl: number }> = {};
    for (const m of matched) {
      const strategy = m.signal?.strategy || 'unknown';
      if (!byStrategy[strategy]) {
        byStrategy[strategy] = { count: 0, pnl: 0 };
      }
      byStrategy[strategy].count++;
      byStrategy[strategy].pnl += m.pnlContribution || 0;
    }

    // Group by action
    const byAction: Record<string, { count: number; volume: number }> = {};
    for (const m of matchedTransactions) {
      const action = m.transaction.action;
      if (!byAction[action]) {
        byAction[action] = { count: 0, volume: 0 };
      }
      byAction[action].count++;
      byAction[action].volume += m.transaction.usdcAmount;
    }

    // Slippage analysis - transactions with significant slippage
    const slippageAnalysis = matched
      .filter((m) => Math.abs(m.slippagePercent || 0) > 1)
      .sort(
        (a, b) =>
          Math.abs(b.slippagePercent || 0) - Math.abs(a.slippagePercent || 0),
      );

    return {
      summary: {
        totalTransactions: matchedTransactions.length,
        matchedWithSignals: matched.length,
        unmatched: unmatched.length,
        splitMergeRedeem: splitMergeRedeem.length,
        totalSlippageUsdc,
        avgSlippagePercent,
        totalPnl,
        byStrategy,
        byAction,
      },
      matchedTransactions: matched,
      slippageAnalysis,
      failedUnmatched: unmatched,
    };
  }

  /**
   * Generate Excel report
   */
  async generateExcelReport(
    analysis: AnalysisResult,
    startDate: Date,
    endDate: Date,
  ): Promise<string> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Trade Analysis Service';
    workbook.created = new Date();

    // Sheet 1: Summary
    this.addSummarySheet(workbook, analysis.summary);

    // Sheet 2: Transaction Detail
    this.addDetailSheet(workbook, analysis.matchedTransactions);

    // Sheet 3: Slippage Analysis
    this.addSlippageSheet(workbook, analysis.slippageAnalysis);

    // Sheet 4: Failed/Unmatched
    this.addUnmatchedSheet(workbook, analysis.failedUnmatched);

    // Sheet 5: Strategy Performance
    this.addStrategySheet(workbook, analysis.summary);

    // Save to file
    const filename = `trade-analysis-${startDate.toISOString().split('T')[0]}-to-${endDate.toISOString().split('T')[0]}.xlsx`;
    const outputPath = path.join(process.cwd(), 'data', filename);

    await workbook.xlsx.writeFile(outputPath);
    this.logger.log(`Excel report saved to: ${outputPath}`);

    return outputPath;
  }

  /**
   * Add Summary sheet
   */
  private addSummarySheet(
    workbook: ExcelJS.Workbook,
    summary: AnalysisSummary,
  ): void {
    const sheet = workbook.addWorksheet('Summary');

    // Title
    sheet.mergeCells('A1:B1');
    sheet.getCell('A1').value = 'Transaction Analysis Summary';
    sheet.getCell('A1').font = { bold: true, size: 16 };

    // Metrics
    const metrics = [
      ['Total Transactions', summary.totalTransactions],
      ['Matched with Signals', summary.matchedWithSignals],
      ['Unmatched', summary.unmatched],
      ['Split/Merge/Redeem', summary.splitMergeRedeem],
      ['Total Slippage (USDC)', summary.totalSlippageUsdc.toFixed(4)],
      ['Avg Slippage %', summary.avgSlippagePercent.toFixed(2) + '%'],
      ['Total P&L', summary.totalPnl.toFixed(4)],
    ];

    let row = 3;
    for (const [label, value] of metrics) {
      sheet.getCell(`A${row}`).value = label;
      sheet.getCell(`B${row}`).value = value;
      sheet.getCell(`A${row}`).font = { bold: true };
      row++;
    }

    // Action breakdown
    row += 2;
    sheet.getCell(`A${row}`).value = 'By Action';
    sheet.getCell(`A${row}`).font = { bold: true, size: 14 };
    row++;

    for (const [action, data] of Object.entries(summary.byAction)) {
      sheet.getCell(`A${row}`).value = action;
      sheet.getCell(`B${row}`).value = `${data.count} trades`;
      sheet.getCell(`C${row}`).value = `$${data.volume.toFixed(2)}`;
      row++;
    }

    sheet.columns = [{ width: 25 }, { width: 20 }, { width: 15 }];
  }

  /**
   * Add Detail sheet
   */
  private addDetailSheet(
    workbook: ExcelJS.Workbook,
    transactions: MatchedTransaction[],
  ): void {
    const sheet = workbook.addWorksheet('Transaction Detail');

    // Header
    const headers = [
      'Timestamp',
      'Market',
      'Action',
      'Token',
      'Size',
      'USDC Amount',
      'Expected Price',
      'Actual Price',
      'Slippage %',
      'Slippage USDC',
      'Signal ID',
      'Strategy',
      'Hash',
    ];

    sheet.addRow(headers);
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' },
    };

    // Data rows
    for (const m of transactions) {
      const tx = m.transaction;
      sheet.addRow([
        new Date(tx.timestamp * 1000).toISOString(),
        tx.marketName,
        tx.action,
        tx.tokenName,
        tx.tokenAmount,
        tx.usdcAmount,
        m.expectedPrice?.toFixed(4) || '',
        m.actualPrice?.toFixed(4) || '',
        m.slippagePercent?.toFixed(2) || '',
        m.slippageUsdc?.toFixed(4) || '',
        m.signal?.id || '',
        m.signal?.strategy || '',
        tx.hash,
      ]);
    }

    // Auto-fit columns
    sheet.columns.forEach((col) => {
      col.width = 15;
    });
    sheet.getColumn(2).width = 50; // Market name
    sheet.getColumn(13).width = 70; // Hash
  }

  /**
   * Add Slippage Analysis sheet
   */
  private addSlippageSheet(
    workbook: ExcelJS.Workbook,
    transactions: MatchedTransaction[],
  ): void {
    const sheet = workbook.addWorksheet('Slippage Analysis');

    // Header
    const headers = [
      'Timestamp',
      'Market',
      'Action',
      'Size',
      'Expected Price',
      'Actual Price',
      'Slippage %',
      'Slippage USDC',
      'Strategy',
    ];

    sheet.addRow(headers);
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFCC00' },
    };

    // Data rows - sorted by slippage
    for (const m of transactions) {
      const tx = m.transaction;
      const row = sheet.addRow([
        new Date(tx.timestamp * 1000).toISOString(),
        tx.marketName,
        tx.action,
        tx.tokenAmount,
        m.expectedPrice?.toFixed(4) || '',
        m.actualPrice?.toFixed(4) || '',
        m.slippagePercent?.toFixed(2) || '',
        m.slippageUsdc?.toFixed(4) || '',
        m.signal?.strategy || '',
      ]);

      // Highlight high slippage
      if (Math.abs(m.slippagePercent || 0) > 5) {
        row.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFF9999' },
        };
      }
    }

    sheet.columns.forEach((col) => {
      col.width = 15;
    });
    sheet.getColumn(2).width = 50;
  }

  /**
   * Add Unmatched sheet
   */
  private addUnmatchedSheet(
    workbook: ExcelJS.Workbook,
    transactions: MatchedTransaction[],
  ): void {
    const sheet = workbook.addWorksheet('Failed-Unmatched');

    // Header
    const headers = [
      'Timestamp',
      'Market',
      'Action',
      'Token',
      'Size',
      'USDC Amount',
      'Actual Price',
      'Hash',
      'Possible Reason',
    ];

    sheet.addRow(headers);
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFF6666' },
    };

    for (const m of transactions) {
      const tx = m.transaction;
      sheet.addRow([
        new Date(tx.timestamp * 1000).toISOString(),
        tx.marketName,
        tx.action,
        tx.tokenName,
        tx.tokenAmount,
        tx.usdcAmount,
        m.actualPrice?.toFixed(4) || '',
        tx.hash,
        'No matching signal found within timestamp window',
      ]);
    }

    sheet.columns.forEach((col) => {
      col.width = 15;
    });
    sheet.getColumn(2).width = 50;
    sheet.getColumn(8).width = 70;
    sheet.getColumn(9).width = 40;
  }

  /**
   * Add Strategy Performance sheet
   */
  private addStrategySheet(
    workbook: ExcelJS.Workbook,
    summary: AnalysisSummary,
  ): void {
    const sheet = workbook.addWorksheet('Strategy Performance');

    // Header
    const headers = ['Strategy', 'Trade Count', 'P&L (USDC)', 'Avg P&L'];

    sheet.addRow(headers);
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF99CCFF' },
    };

    for (const [strategy, data] of Object.entries(summary.byStrategy)) {
      const avgPnl = data.count > 0 ? data.pnl / data.count : 0;
      const row = sheet.addRow([
        strategy,
        data.count,
        data.pnl.toFixed(4),
        avgPnl.toFixed(4),
      ]);

      // Color code P&L
      if (data.pnl > 0) {
        row.getCell(3).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FF99FF99' },
        };
      } else if (data.pnl < 0) {
        row.getCell(3).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFF9999' },
        };
      }
    }

    sheet.columns = [{ width: 35 }, { width: 15 }, { width: 15 }, { width: 15 }];
  }
}
