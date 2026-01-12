import axios from 'axios';
import type {
  ApiKeyCreds,
  ClobClient as ClobClientType,
} from '@polymarket/clob-client';
import { Contract, Wallet, constants, providers, utils } from 'ethers';

/**
 * Use runtime dynamic import via Function() to avoid CommonJS require on ESM deps
 * when running with ts-node (CJS mode by default).
 */
// const loadClob = (() => {
//   let cached: Promise<typeof import('@polymarket/clob-client')> | null = null;
//   const dynamicImport = new Function(
//     'modulePath',
//     'return import(modulePath);',
//   ) as (
//     modulePath: string,
//   ) => Promise<typeof import('@polymarket/clob-client')>;
//   return () => {
//     if (!cached) {
//       cached = dynamicImport('@polymarket/clob-client');
//     }
//     return cached;
//   };
// })();

/**
 * Hardcoded sample configuration. Replace with real values before running.
 */
const CONFIG = {
  polygonRpc:
    'https://silent-virulent-ensemble.matic.quiknode.pro/69d6739125c575fbfc5ba71b43023323742a9092/',
  chainId: 137,
  clobUrl: 'https://clob.polymarket.com',
  privateKey:
    '',
 
};

const MARKET_CONFIG = {
  slug: 'bitcoin-above-86k-on-january-10',
  tokenID:
    '8144906723415861399816003518186859303548988684295842315064719029456551973633',
  price: 0.2,
  size: 5,
  side: 'BUY' as const,
  feeRateBps: 0,
};

const PROXY_ADDRESS = '0xb9b5cde0d64a06f5315be41a3ef2bbb530990fa5';

const ONCHAIN_CONFIG = {
  ctfExchangeAddr: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E', // Contract CTF (Cố định)
  usdcAddr: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // Contract USDC (Cố định)

  // Condition ID của Market (Dùng cho Mint/Redeem)
  conditionId:
    '0xe2281743ca4852f55d231b561f5f509583c859241b65d390f58001477d8263e7',

  parentCollectionId: constants.HashZero, // Luôn là 0x0...0
  partition: [1, 2], // Đại diện cho YES và NO
  amount: utils.parseUnits('10', 6), // Số lượng USDC muốn Mint/Redeem (Ví dụ 10 USDC),
  ctfExchange: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E', // Contract Mint/Redeem
  usdc: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // USDC Token
};

// ABI tối giản để tương tác
const ABIS = {
  ERC20: [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
  ],
  CTF: [
    'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
    'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
  ],
};

// --- 2. UTILS ---
const loadClob = (() => {
  let cached: Promise<typeof import('@polymarket/clob-client')> | null = null;
  const dynamicImport = new Function(
    'modulePath',
    'return import(modulePath);',
  ) as (
    modulePath: string,
  ) => Promise<typeof import('@polymarket/clob-client')>;
  return () => {
    if (!cached) cached = dynamicImport('@polymarket/clob-client');
    return cached;
  };
})();

const buildWallet = () => {
  const provider = new providers.JsonRpcProvider(CONFIG.polygonRpc);
  return new Wallet(CONFIG.privateKey, provider);
};

// --- 3. BUILD CLIENT (FIX LỖI SIGNATURE TYPE) ---
const createClient = async (
  wallet: Wallet,
  creds?: ApiKeyCreds,
): Promise<ClobClientType> => {
  // Chỉ import ClobClient, không cần import SignatureType nữa để tránh lỗi
  const { ClobClient } = await loadClob();

  return new ClobClient(
    CONFIG.clobUrl,
    CONFIG.chainId,
    wallet,
    creds,
    2, // <--- SỬA CỨNG SỐ 2 (Tương đương SignatureType.POLY_GNOSIS_SAFE)
    PROXY_ADDRESS,
  );
};

const placeLimitOrder = async (
  client: ClobClientType,
  walletAddress: string,
) => {
  const { OrderType, Side } = await loadClob();
  console.log(`🚀 Đang gửi lệnh BUY...`);
  console.log(`   - Maker (Proxy): ${PROXY_ADDRESS}`);
  // FIX LỖI 2: Dùng walletAddress truyền vào thay vì client.signer.address
  console.log(`   - Signer (EOA):  ${walletAddress}`);

  try {
    const order = await client.createOrder({
      tokenID: MARKET_CONFIG.tokenID,
      price: MARKET_CONFIG.price,
      side: Side[MARKET_CONFIG.side],
      size: MARKET_CONFIG.size,
      feeRateBps: MARKET_CONFIG.feeRateBps,
    });

    const response = await client.postOrder(order, OrderType.GTC);

    if (response && response.orderID) {
      console.log('✅ ĐẶT LỆNH THÀNH CÔNG! Order ID:', response.orderID);
    } else {
      console.error('❌ API TRẢ VỀ LỖI:', JSON.stringify(response));
    }
  } catch (error: any) {
    console.error('❌ LỖI EXCEPTION:');
    console.error('   Msg:', error.message);
    if (error.response?.data) {
      console.error(
        '   Server Data:',
        JSON.stringify(error.response.data, null, 2),
      );
    }
  }
};

// Sửa hàm mintTokens trong file trade.ts

const mintTokens = async (wallet: Wallet, amountUSDC: number) => {
  console.log(`\n⚙️  BẮT ĐẦU MINT (SPLIT POSITION)...`);
  console.log(`   Số lượng: ${amountUSDC} USDC`);
  console.log(`   Ví thực hiện: ${wallet.address}`);

  const usdcContract = new Contract(ONCHAIN_CONFIG.usdc, ABIS.ERC20, wallet);
  const ctfContract = new Contract(
    ONCHAIN_CONFIG.ctfExchange,
    ABIS.CTF,
    wallet,
  );
  const amountWei = utils.parseUnits(amountUSDC.toString(), 6);

  // --- CẤU HÌNH GAS (QUAN TRỌNG) ---
  // Ép giá Gas lên 50 Gwei để vượt qua mức tối thiểu 25 Gwei của mạng
  const gasOverrides = {
    maxFeePerGas: utils.parseUnits('500', 'gwei'),

    // Tiền TIP cho thợ đào (Quan trọng nhất để được ưu tiên)
    // Đặt cao bằng Max Fee để đảm bảo thợ đào chọn bạn đầu tiên
    maxPriorityFeePerGas: utils.parseUnits('500', 'gwei'),

    // Gas Limit giữ nguyên mức an toàn
    gasLimit: 500000,
  };

  try {
    // 1. Kiểm tra số dư
    const balance = await usdcContract.balanceOf(wallet.address);
    if (balance.lt(amountWei)) {
      throw new Error(
        `❌ Số dư không đủ! Bạn có: ${utils.formatUnits(balance, 6)} USDC (Polygon)`,
      );
    }

    // 2. Approve (Có kèm Gas Overrides)
    const allowance = await usdcContract.allowance(
      wallet.address,
      ONCHAIN_CONFIG.ctfExchange,
    );
    if (allowance.lt(amountWei)) {
      console.log('🔸 Đang Approve USDC (Gas: 60 Gwei)...');

      // TRUYỀN gasOverrides VÀO THAM SỐ CUỐI CÙNG
      const txApprove = await usdcContract.approve(
        ONCHAIN_CONFIG.ctfExchange,
        constants.MaxUint256,
        gasOverrides,
      );

      console.log('   -> Tx Approve Sent:', txApprove.hash);
      await txApprove.wait();
      console.log('   ✅ Approve thành công!');
    }

    // 3. Mint / Split (Có kèm Gas Overrides)
    console.log('🔸 Đang gọi hàm splitPosition (Gas: 60 Gwei)...');

    // TRUYỀN gasOverrides VÀO THAM SỐ CUỐI CÙNG
    const txSplit = await ctfContract.splitPosition(
      ONCHAIN_CONFIG.usdc,
      constants.HashZero,
      ONCHAIN_CONFIG.conditionId,
      [1, 2],
      amountWei,
      gasOverrides,
    );

    console.log(`   -> Tx Hash: ${txSplit.hash}`);
    console.log('⏳ Đang chờ xác nhận...');
    await txSplit.wait();

    console.log(`✅ MINT THÀNH CÔNG! Token đã về ví ${wallet.address}`);
  } catch (error: any) {
    console.error('❌ LỖI MINT:', error.message || error);
    // Nếu vẫn lỗi Gas, hãy thử tăng số 60 lên 100 trong gasOverrides
  }
};

const main = async () => {
  console.log('--- POLYMARKET BOT FIX ---');
  const wallet = buildWallet();

  // B1: Client tạm
  console.log('1. Khởi tạo Client tạm...');
  const tempClient = await createClient(wallet);

  // B2: Lấy Key
  console.log('2. Đang lấy API Key...');
  const creds = await tempClient.createOrDeriveApiKey();
  console.log('   -> Key ID:', creds.key);

  // B3: Client chính thức (Type 2)
  console.log('3. Khởi tạo Client chính thức...');
  const authenticatedClient = await createClient(wallet, creds);


  const provider = new providers.JsonRpcProvider(CONFIG.polygonRpc);
  const nonce = await provider.getTransactionCount(wallet.address, 'latest');

  console.log(`✅ NONCE ĐANG BỊ KẸT LÀ: ${nonce}`);
//   console.log(`👉 Hãy điền số ${nonce} vào file cancel-stuck.ts để hủy lệnh.`);

    // await mintTokens(wallet, 1);

  //   // B4: Bắn lệnh (Truyền thêm địa chỉ ví để log cho dễ)
  //   await placeLimitOrder(authenticatedClient, wallet.address);
};

main().catch(console.error);
