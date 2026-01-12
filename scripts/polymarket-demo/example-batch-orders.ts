/**
 * Example: Place Multiple Orders in a Single Batch Request
 * Reference: https://docs.polymarket.com/developers/CLOB/orders/create-order-batch
 * Maximum 15 orders per batch
 */

import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

// Configuration
const API_BASE_URL = 'http://localhost:3000/polymarket-onchain';

const CONFIG = {
  polygonRpc:
    'https://silent-virulent-ensemble.matic.quiknode.pro/69d6739125c575fbfc5ba71b43023323742a9092/',
  chainId: 137,
  clobUrl: 'https://clob.polymarket.com',
  privateKey: process.env.PRIVATE_KEY || '',
  proxyAddress: '0xb9b5cde0d64a06f5315be41a3ef2bbb530990fa5',
};

// Example market tokens (Replace with actual token IDs)
const MARKET_TOKENS = {
  market1: {
    tokenID:
      '8144906723415861399816003518186859303548988684295842315064719029456551973633',
    name: 'BTC Above 86K on Jan 10',
  },
  market2: {
    tokenID:
      '93025177978745967226369398316375153283719303181694312089956059680730874301533',
    name: 'Another Market',
  },
};

/**
 * Example 1: Place multiple BUY orders on the same market at different price levels
 */
const example1_MultiLevelOrders = async () => {
  console.log('\n╔═══════════════════════════════════════════╗');
  console.log('║  Example 1: Multi-Level Orders           ║');
  console.log('╚═══════════════════════════════════════════╝\n');

  const orders = [
    {
      tokenID: MARKET_TOKENS.market1.tokenID,
      price: 0.15,
      size: 10,
      side: 'BUY' as const,
      feeRateBps: 0,
      orderType: 'GTC' as const,
    },
    {
      tokenID: MARKET_TOKENS.market1.tokenID,
      price: 0.20,
      size: 15,
      side: 'BUY' as const,
      feeRateBps: 0,
      orderType: 'GTC' as const,
    },
    {
      tokenID: MARKET_TOKENS.market1.tokenID,
      price: 0.25,
      size: 20,
      side: 'BUY' as const,
      feeRateBps: 0,
      orderType: 'GTC' as const,
    },
  ];

  try {
    console.log(`📋 Placing ${orders.length} orders at different price levels...`);
    orders.forEach((order, i) => {
      console.log(`   ${i + 1}. ${order.side} ${order.size} @ ${order.price}`);
    });

    const response = await axios.post(`${API_BASE_URL}/place-batch-orders`, {
      config: CONFIG,
      orders,
    });

    console.log('\n✅ Batch order response:');
    console.log(`   Total: ${response.data.totalOrders}`);
    console.log(`   Success: ${response.data.successCount}`);
    console.log(`   Failed: ${response.data.failureCount}`);

    if (response.data.results) {
      console.log('\n📊 Detailed results:');
      response.data.results.forEach((result: any, i: number) => {
        if (result.success) {
          console.log(
            `   ✅ Order ${i + 1}: ${result.orderID} (Status: ${result.status})`,
          );
        } else {
          console.log(`   ❌ Order ${i + 1}: ${result.errorMsg}`);
        }
      });
    }

    return response.data;
  } catch (error: any) {
    console.error('❌ Error:', error.response?.data || error.message);
    return null;
  }
};

/**
 * Example 2: Place orders on multiple markets simultaneously
 */
const example2_MultiMarketOrders = async () => {
  console.log('\n╔═══════════════════════════════════════════╗');
  console.log('║  Example 2: Multi-Market Orders          ║');
  console.log('╚═══════════════════════════════════════════╝\n');

  const orders = [
    {
      tokenID: MARKET_TOKENS.market1.tokenID,
      price: 0.30,
      size: 10,
      side: 'BUY' as const,
      feeRateBps: 0,
      orderType: 'GTC' as const,
    },
    {
      tokenID: MARKET_TOKENS.market2.tokenID,
      price: 0.45,
      size: 15,
      side: 'BUY' as const,
      feeRateBps: 0,
      orderType: 'GTC' as const,
    },
  ];

  try {
    console.log(`📋 Placing ${orders.length} orders across different markets...`);
    orders.forEach((order, i) => {
      console.log(
        `   ${i + 1}. ${order.side} ${order.size} @ ${order.price} (Token: ${order.tokenID.substring(0, 15)}...)`,
      );
    });

    const response = await axios.post(`${API_BASE_URL}/place-batch-orders`, {
      config: CONFIG,
      orders,
    });

    console.log('\n✅ Batch order response:');
    console.log(`   Success: ${response.data.successCount}/${response.data.totalOrders}`);

    return response.data;
  } catch (error: any) {
    console.error('❌ Error:', error.response?.data || error.message);
    return null;
  }
};

/**
 * Example 3: Mix of BUY and SELL orders with different order types
 */
const example3_MixedOrderTypes = async () => {
  console.log('\n╔═══════════════════════════════════════════╗');
  console.log('║  Example 3: Mixed Order Types            ║');
  console.log('╚═══════════════════════════════════════════╝\n');

  const orders = [
    {
      tokenID: MARKET_TOKENS.market1.tokenID,
      price: 0.35,
      size: 10,
      side: 'BUY' as const,
      feeRateBps: 0,
      orderType: 'GTC' as const, // Good-Til-Cancelled
    },
    {
      tokenID: MARKET_TOKENS.market1.tokenID,
      price: 0.65,
      size: 10,
      side: 'SELL' as const,
      feeRateBps: 0,
      orderType: 'GTC' as const,
    },
    {
      tokenID: MARKET_TOKENS.market1.tokenID,
      price: 0.40,
      size: 5,
      side: 'BUY' as const,
      feeRateBps: 0,
      orderType: 'FOK' as const, // Fill-Or-Kill
    },
    {
      tokenID: MARKET_TOKENS.market1.tokenID,
      price: 0.50,
      size: 20,
      side: 'BUY' as const,
      feeRateBps: 0,
      orderType: 'GTC' as const,
      postOnly: true, // Post-only order (won't match immediately)
    },
  ];

  try {
    console.log(`📋 Placing ${orders.length} orders with mixed types...`);
    orders.forEach((order, i) => {
      const postOnlyStr = order.postOnly ? ' (POST-ONLY)' : '';
      console.log(
        `   ${i + 1}. ${order.orderType} ${order.side} ${order.size} @ ${order.price}${postOnlyStr}`,
      );
    });

    const response = await axios.post(`${API_BASE_URL}/place-batch-orders`, {
      config: CONFIG,
      orders,
    });

    console.log('\n✅ Batch order response:');
    console.log(`   Success: ${response.data.successCount}/${response.data.totalOrders}`);

    if (response.data.results) {
      console.log('\n📊 Detailed results:');
      response.data.results.forEach((result: any, i: number) => {
        if (result.success) {
          console.log(
            `   ✅ Order ${i + 1}: ${result.status.toUpperCase()} - ${result.orderID}`,
          );
        } else {
          console.log(`   ❌ Order ${i + 1}: ${result.errorMsg}`);
        }
      });
    }

    return response.data;
  } catch (error: any) {
    console.error('❌ Error:', error.response?.data || error.message);
    return null;
  }
};

/**
 * Example 4: Maximum batch size (15 orders)
 */
const example4_MaxBatchSize = async () => {
  console.log('\n╔═══════════════════════════════════════════╗');
  console.log('║  Example 4: Maximum Batch Size (15)      ║');
  console.log('╚═══════════════════════════════════════════╝\n');

  // Create 15 orders at different price levels
  const orders = Array.from({ length: 15 }, (_, i) => ({
    tokenID: MARKET_TOKENS.market1.tokenID,
    price: 0.10 + i * 0.05, // Prices from 0.10 to 0.80
    size: 5,
    side: 'BUY' as const,
    feeRateBps: 0,
    orderType: 'GTC' as const,
  }));

  try {
    console.log(`📋 Placing maximum batch size: ${orders.length} orders`);
    console.log(`   Price range: ${orders[0].price} to ${orders[orders.length - 1].price}`);

    const response = await axios.post(`${API_BASE_URL}/place-batch-orders`, {
      config: CONFIG,
      orders,
    });

    console.log('\n✅ Batch order response:');
    console.log(`   Total: ${response.data.totalOrders}`);
    console.log(`   Success: ${response.data.successCount}`);
    console.log(`   Failed: ${response.data.failureCount}`);

    return response.data;
  } catch (error: any) {
    console.error('❌ Error:', error.response?.data || error.message);
    return null;
  }
};

/**
 * Example 5: Test batch size limit (should fail with > 15 orders)
 */
const example5_ExceedBatchLimit = async () => {
  console.log('\n╔═══════════════════════════════════════════╗');
  console.log('║  Example 5: Exceed Batch Limit (Fail)    ║');
  console.log('╚═══════════════════════════════════════════╝\n');

  // Try to create 20 orders (exceeds the 15 limit)
  const orders = Array.from({ length: 20 }, (_, i) => ({
    tokenID: MARKET_TOKENS.market1.tokenID,
    price: 0.10 + i * 0.03,
    size: 5,
    side: 'BUY' as const,
    feeRateBps: 0,
    orderType: 'GTC' as const,
  }));

  try {
    console.log(`📋 Attempting to place ${orders.length} orders (exceeds limit)...`);

    const response = await axios.post(`${API_BASE_URL}/place-batch-orders`, {
      config: CONFIG,
      orders,
    });

    console.log('⚠️ Unexpected success:', response.data);
    return response.data;
  } catch (error: any) {
    console.log('✅ Expected error received:');
    console.log(`   ${error.response?.data?.message || error.message}`);
    return null;
  }
};

// Main execution
const main = async () => {
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║  Polymarket Batch Orders - Examples       ║');
  console.log('╚═══════════════════════════════════════════╝');

  const example = process.argv[2] || '1';

  switch (example) {
    case '1':
      await example1_MultiLevelOrders();
      break;
    case '2':
      await example2_MultiMarketOrders();
      break;
    case '3':
      await example3_MixedOrderTypes();
      break;
    case '4':
      await example4_MaxBatchSize();
      break;
    case '5':
      await example5_ExceedBatchLimit();
      break;
    case 'all':
      await example1_MultiLevelOrders();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await example2_MultiMarketOrders();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await example3_MixedOrderTypes();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await example4_MaxBatchSize();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await example5_ExceedBatchLimit();
      break;
    default:
      console.log('\nUsage: ts-node example-batch-orders.ts [example]');
      console.log('  1: Multi-level orders (same market, different prices)');
      console.log('  2: Multi-market orders');
      console.log('  3: Mixed order types (GTC, FOK, post-only)');
      console.log('  4: Maximum batch size (15 orders)');
      console.log('  5: Exceed batch limit (test error handling)');
      console.log('  all: Run all examples');
      break;
  }

  console.log('\n✅ Done!');
};

main().catch((error) => {
  console.error('\n❌ Fatal error:', error.message);
  process.exit(1);
});
