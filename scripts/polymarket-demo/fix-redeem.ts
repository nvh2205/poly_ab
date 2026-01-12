import { Contract, Wallet, providers, utils, constants } from 'ethers';
import * as dotenv from 'dotenv';

dotenv.config();

// --- CẤU HÌNH ---
const CONFIG = {
  rpc: 'https://silent-virulent-ensemble.matic.quiknode.pro/69d6739125c575fbfc5ba71b43023323742a9092/',
  privateKey:
    '',
};

const MARKET_INFO = {
  // Thay bằng Condition ID của market ĐÃ KẾT THÚC (Resolved)
  conditionId:
    '0x756618c654130b6b6438ca715187c10f90cc0d89a3ceedd7aea52fadd9c7404c',
};

const ADDR = {
  USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  CTF: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
};

const ABIS = {
  ERC20: ['function balanceOf(address) view returns (uint256)'],
  CTF: [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
    'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
    'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)',
    'function getPositionId(address collateralToken, bytes32 collectionId) view returns (uint256)',
    'function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])',
  ],
};

const main = async () => {
  if (!CONFIG.privateKey) throw new Error('Thiếu PRIVATE_KEY trong .env');

  const provider = new providers.JsonRpcProvider(CONFIG.rpc);
  const wallet = new Wallet(CONFIG.privateKey, provider);
  const ctf = new Contract(ADDR.CTF, ABIS.CTF, wallet);
  const usdc = new Contract(ADDR.USDC, ABIS.ERC20, wallet);

  console.log(`\n🤖 Bot Redeem đang chạy với ví: ${wallet.address}`);

  // 1. KIỂM TRA MARKET ĐÃ RESOLVED CHƯA?
  // Nếu market chưa có kết quả, hàm payoutNumerators sẽ trả về 0 cho tất cả
  //   console.log('🔍 Kiểm tra trạng thái Market...');
  const payoutYes = await ctf.payoutNumerators(MARKET_INFO.conditionId, 0);
  const payoutNo = await ctf.payoutNumerators(MARKET_INFO.conditionId, 1);

  // Logic check resolution của CTF: Tổng payout phải > 0 (thường là 1)
  if (payoutYes.eq(0) && payoutNo.eq(0)) {
    console.error(
      '⚠️ Market chưa được giải quyết (Not Resolved). Không thể Redeem.',
    );
    console.log(
      '   👉 Hãy quay lại dùng script Merge nếu bạn muốn thoát vị thế.',
    );
    return;
  }

  console.log(`   ✅ Market đã kết thúc!`);
  console.log(
    `   🏆 Kết quả Payout: YES=${payoutYes.toString()}, NO=${payoutNo.toString()}`,
  );

  // 2. Lấy số dư hiện tại của Token YES và NO
  // Chúng ta sẽ thử redeem cả 2 loại (Token thua sẽ redeem được 0 đồng, Token thắng được 1 đồng)
  const indexSets = [1, 2]; // 1=Yes, 2=No
  const parentId = constants.HashZero;

  // Tính ID để check balance (như bài trước)
  const positionIds = [];
  for (const indexSet of indexSets) {
    const collectionId = await ctf.getCollectionId(
      parentId,
      MARKET_INFO.conditionId,
      indexSet,
    );
    const positionId = await ctf.getPositionId(ADDR.USDC, collectionId);
    positionIds.push(positionId);
  }

  const balances = await ctf.balanceOfBatch(
    [wallet.address, wallet.address],
    positionIds,
  );
  const totalTokens = balances[0].add(balances[1]);

  if (totalTokens.isZero()) {
    console.log('⚠️ Bạn không còn token nào của market này để Redeem.');
    return;
  }

  console.log(
    `   💰 Tìm thấy: ${utils.formatUnits(balances[0], 6)} YES và ${utils.formatUnits(balances[1], 6)} NO`,
  );
  console.log(`\n🔄 Đang thực hiện Redeem...`);

  // 3. Cấu hình Gas (Hardcode cho chắc chắn)
  const feeData = await provider.getFeeData();
  const gasOptions = {
    maxFeePerGas: utils.parseUnits('3000', 'gwei'),
    maxPriorityFeePerGas: utils.parseUnits('3000', 'gwei'),
    gasLimit: 1000000, // <--- QUAN TRỌNG: Set cứng 1 triệu gas (thừa còn hơn thiếu)
  };

  // 4. Gọi hàm redeemPositions
  // indexSets: [1, 2] nghĩa là "Hãy kiểm tra và trả tiền cho cả token YES và NO của tôi"
  try {
    const tx = await ctf.redeemPositions(
      ADDR.USDC,
      parentId,
      MARKET_INFO.conditionId,
      indexSets,
      gasOptions,
    );

    console.log(`   🚀 Tx Hash: ${tx.hash}`);
    await tx.wait();

    console.log(`   🎉 REDEEM THÀNH CÔNG!`);
    const usdcBal = await usdc.balanceOf(wallet.address);
    console.log(
      `   💵 Số dư USDC hiện tại: ${utils.formatUnits(usdcBal, 6)} USDC`,
    );
  } catch (e: any) {
    console.error('   ❌ LỖI REDEEM:', e.reason || e.message);
  }
};

main().catch(console.error);
