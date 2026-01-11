/**
 * Demo: Sử dụng PolymarketOnchainService với API credentials caching
 * 
 * Ưu điểm:
 * - API credentials được TỰ ĐỘNG tạo trong onApplicationBootstrap
 * - Cache lại và sử dụng cho tất cả operations
 * - Lệnh đầu tiên cũng nhanh (không cần đợi tạo credentials)
 * 
 * Cách chạy:
 * 1. Cấu hình env vars: PRIVATE_KEY, POLYGON_RPC
 * 2. npx ts-node scripts/polymarket-demo/trade-with-cache.ts
 */

import { PolymarketOnchainService } from '../../src/common/services/polymarket-onchain.service';
import type { PolymarketConfig } from '../../src/common/services/polymarket-onchain.service';
import { ConfigService } from '@nestjs/config';

/**
 * Mock ConfigService cho demo
 * Trong production, NestJS sẽ tự động inject ConfigService
 */
class MockConfigService {
  private env = {
    POLYGON_RPC: 'https://silent-virulent-ensemble.matic.quiknode.pro/69d6739125c575fbfc5ba71b43023323742a9092/',
    CHAIN_ID: '137',
    CLOB_URL: 'https://clob.polymarket.com',
    PRIVATE_KEY: '0xd9041b8755ef104078a24c9823b5d55efb48e63b7380ed677f17fa1cc5c83eff',
    PROXY_ADDRESS: '0xb9b5cde0d64a06f5315be41a3ef2bbb530990fa5',
  };

  get(key: string, defaultValue?: string): string {
    return this.env[key] || defaultValue || '';
  }
}

/**
 * Cấu hình Polymarket - Có thể override default config từ env
 */
const CUSTOM_CONFIG: PolymarketConfig = {
  polygonRpc:
    'https://silent-virulent-ensemble.matic.quiknode.pro/69d6739125c575fbfc5ba71b43023323742a9092/',
  chainId: 137,
  clobUrl: 'https://clob.polymarket.com',
  privateKey:
    '0xd9041b8755ef104078a24c9823b5d55efb48e63b7380ed677f17fa1cc5c83eff',
  proxyAddress: '0xb9b5cde0d64a06f5315be41a3ef2bbb530990fa5',
};

/**
 * Thông tin market để trade
 */
const MARKET = {
  slug: 'bitcoin-above-86k-on-january-10',
  tokenID:
    '8144906723415861399816003518186859303548988684295842315064719029456551973633',
};

/**
 * Demo 1: Đặt nhiều lệnh liên tiếp - credentials được tạo SẴN trong bootstrap
 */
async function demoMultipleOrders() {
  console.log('\n🎯 Demo 1: Đặt nhiều lệnh với pre-cached credentials\n');
  
  const configService = new MockConfigService() as any;
  const service = new PolymarketOnchainService(configService);
  
  // Khởi tạo service (load CLOB module + TẠO CREDENTIALS)
  console.log('⚡ Bootstrapping service (tạo credentials tự động)...');
  await service.onApplicationBootstrap();
  
  // Get default config (đã có credentials cached)
  const config = service.getDefaultConfig() || CUSTOM_CONFIG;
  
  console.log('\n📝 Đặt lệnh #1 (credentials đã sẵn sàng!)...');
  const order1 = await service.placeLimitOrder(config, {
    tokenID: MARKET.tokenID,
    price: 0.2,
    size: 5,
    side: 'BUY',
  });
  console.log('   Kết quả:', order1);
  
  console.log('\n📝 Đặt lệnh #2 (dùng cached credentials)...');
  const order2 = await service.placeLimitOrder(config, {
    tokenID: MARKET.tokenID,
    price: 0.21,
    size: 5,
    side: 'BUY',
  });
  console.log('   Kết quả:', order2);
  
  console.log('\n📝 Đặt lệnh #3 (dùng cached credentials)...');
  const order3 = await service.placeLimitOrder(config, {
    tokenID: MARKET.tokenID,
    price: 0.22,
    size: 5,
    side: 'BUY',
  });
  console.log('   Kết quả:', order3);
  
  console.log('\n✅ Hoàn thành! Tất cả 3 lệnh đều NHANH (credentials đã cache từ bootstrap).');
}

/**
 * Demo 2: Batch orders - credentials sẵn sàng ngay
 */
async function demoBatchOrders() {
  console.log('\n🎯 Demo 2: Đặt batch orders với pre-cached credentials\n');
  
  const configService = new MockConfigService() as any;
  const service = new PolymarketOnchainService(configService);
  await service.onApplicationBootstrap();
  
  const config = service.getDefaultConfig() || CUSTOM_CONFIG;
  
  console.log('📦 Đặt 5 lệnh cùng lúc (credentials đã sẵn sàng)...');
  
  const result = await service.placeBatchOrders(config, [
    { tokenID: MARKET.tokenID, price: 0.2, size: 5, side: 'BUY' },
    { tokenID: MARKET.tokenID, price: 0.21, size: 5, side: 'BUY' },
    { tokenID: MARKET.tokenID, price: 0.22, size: 5, side: 'BUY' },
    { tokenID: MARKET.tokenID, price: 0.23, size: 5, side: 'BUY' },
    { tokenID: MARKET.tokenID, price: 0.24, size: 5, side: 'BUY' },
  ]);
  
  console.log('\n📊 Kết quả batch:');
  console.log(`   Success: ${result.success}`);
  if (result.results) {
    result.results.forEach((r, i) => {
      console.log(`   Order ${i + 1}: ${r.success ? '✅' : '❌'} ${r.orderID || r.errorMsg}`);
    });
  }
}

/**
 * Demo 3: Trading workflow hoàn chỉnh
 */
async function demoCompleteWorkflow() {
  console.log('\n🎯 Demo 3: Workflow hoàn chỉnh với auto-cached credentials\n');
  
  const configService = new MockConfigService() as any;
  const service = new PolymarketOnchainService(configService);
  
  console.log('⚡ Bootstrapping (auto-create credentials)...');
  await service.onApplicationBootstrap();
  
  const config = service.getDefaultConfig() || CUSTOM_CONFIG;
  
  // 1. Kiểm tra balance
  console.log('\n1️⃣ Kiểm tra balance...');
  const balance = await service.getBalances(config);
  console.log(`   USDC: ${balance.usdc}`);
  console.log(`   Address: ${balance.address}`);
  
  // 2. Đặt một lệnh (NHANH vì credentials đã cache)
  console.log('\n2️⃣ Đặt lệnh BUY (credentials đã sẵn sàng)...');
  const order = await service.placeLimitOrder(config, {
    tokenID: MARKET.tokenID,
    price: 0.2,
    size: 5,
    side: 'BUY',
  });
  console.log(`   ${order.success ? '✅' : '❌'} OrderID: ${order.orderID || order.error}`);
  
  // 3. Đợi một chút
  console.log('\n3️⃣ Đợi 5 giây...');
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  // 4. Hủy lệnh (sử dụng cached client)
  console.log('\n4️⃣ Hủy tất cả lệnh...');
  const cancel = await service.cancelOrders(config, MARKET.tokenID);
  console.log(`   ${cancel.success ? '✅' : '❌'} ${cancel.error || 'Đã hủy'}`);
  
  console.log('\n✅ Workflow hoàn thành! Tất cả operations đều NHANH nhờ pre-cached credentials.');
}

/**
 * Demo 4: Clear cache và tạo credentials mới
 */
async function demoCacheClear() {
  console.log('\n🎯 Demo 4: Clear cache và re-create credentials\n');
  
  const configService = new MockConfigService() as any;
  const service = new PolymarketOnchainService(configService);
  
  console.log('⚡ Bootstrap lần 1 (tạo credentials)...');
  await service.onApplicationBootstrap();
  
  const config = service.getDefaultConfig() || CUSTOM_CONFIG;
  
  console.log('📝 Đặt lệnh (dùng pre-cached credentials)...');
  await service.placeLimitOrder(config, {
    tokenID: MARKET.tokenID,
    price: 0.2,
    size: 5,
    side: 'BUY',
  });
  
  console.log('\n🗑️  Clear cache...');
  service.clearCache();
  
  console.log('📝 Đặt lệnh sau clear (tạo credentials mới)...');
  await service.placeLimitOrder(config, {
    tokenID: MARKET.tokenID,
    price: 0.22,
    size: 5,
    side: 'BUY',
  });
  
  console.log('\n✅ Demo hoàn thành!');
}

/**
 * Main function - chọn demo để chạy
 */
async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  Polymarket Trading với Auto-Cached Credentials           ║');
  console.log('║  Credentials được TẠO TỰ ĐỘNG trong onApplicationBootstrap║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  
  // Uncomment demo bạn muốn chạy:
  
  // await demoMultipleOrders();
  // await demoBatchOrders();
  await demoCompleteWorkflow();
  // await demoCacheClear();
}

// Chạy
main().catch(console.error);
