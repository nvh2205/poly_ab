/**
 * Test script for native-core EIP-712 signing module
 */

const { signClobOrder, signClobOrdersBatch } = require('./index.js');

// Test with sample order data
const testOrder = {
    privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // Test key (don't use in production!)
    salt: '1234567890',
    maker: '0x33568DB0DfB9890f5107Fb50F566a159F6f612ED',
    signer: '0x4769B103570877eCD516BC7737DcFD834413E6b4',
    taker: '0x0000000000000000000000000000000000000000',
    tokenId: '17510381696424521626872545793830070082360183532089020912133870456423861609957',
    makerAmount: '1500000',
    takerAmount: '3000000',
    expiration: '0',
    nonce: '0',
    feeRateBps: '0',
    side: 0,
    signatureType: 2,
};

console.log('Testing signClobOrder...');
console.time('signClobOrder');

try {
    const signedOrder = signClobOrder(testOrder);
    console.timeEnd('signClobOrder');
    console.log('✅ Signed order:', JSON.stringify(signedOrder, null, 2));
} catch (error) {
    console.timeEnd('signClobOrder');
    console.error('❌ Error:', error.message);
    process.exit(1);
}

// Test batch signing
console.log('\nTesting signClobOrdersBatch (10 orders)...');
const batchOrders = Array(10).fill(null).map((_, i) => {
    const { privateKey, ...rest } = testOrder;
    return {
        ...rest,
        salt: String(Date.now() + i),
    };
});

console.time('signClobOrdersBatch');
try {
    const signedOrders = signClobOrdersBatch(testOrder.privateKey, batchOrders);
    console.timeEnd('signClobOrdersBatch');
    console.log(`✅ Signed ${signedOrders.length} orders successfully`);
} catch (error) {
    console.timeEnd('signClobOrdersBatch');
    console.error('❌ Batch error:', error.message);
    process.exit(1);
}

console.log('\n✅ All tests passed!');
