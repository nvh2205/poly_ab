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
  // Condition ID của market BTC > 90k
  conditionId:
    '0xbd934f489afd85df62a1ee09c27fa7ab711b8bdde464c4d15c0af776f6400724',
};

const ADDR = {
  USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  CTF: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045', // Địa chỉ chuẩn CTF trên Polygon
};

const ABIS = {
  ERC20: [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
  ],
  CTF: [
    'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
    'function balanceOf(address account, uint256 id) view returns (uint256)',
    'function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])',
    'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)',
    'function getPositionId(address collateralToken, bytes32 collectionId) view returns (uint256)',
  ],
};

const ProxyAddress = '0x33568DB0DfB9890f5107Fb50F566a159F6f612ED';

// --- HÀM HELPER TÍNH TOÁN ID ---
// Token ID trong CTF được hash từ: Collateral + Condition + IndexSet
const getPositionIds = async (ctfContract: Contract, conditionId: string) => {
  const parentId = constants.HashZero;

  // IndexSet: 1 (binary 01) = Outcome A (Yes)
  // IndexSet: 2 (binary 10) = Outcome B (No)
  const indexSets = [1, 2];

  const positionIds = [];
  for (const indexSet of indexSets) {
    const collectionId = await ctfContract.getCollectionId(
      parentId,
      conditionId,
      indexSet,
    );
    const positionId = await ctfContract.getPositionId(ADDR.USDC, collectionId);
    positionIds.push(positionId);
  }
  return positionIds; // [IdOfYes, IdOfNo]
};

const main = async () => {
  if (!CONFIG.privateKey) throw new Error('Thiếu PRIVATE_KEY trong .env');

  const provider = new providers.JsonRpcProvider(CONFIG.rpc);
  const wallet = new Wallet(CONFIG.privateKey, provider);
  const ctf = new Contract(ADDR.CTF, ABIS.CTF, wallet);
  const usdc = new Contract(ADDR.USDC, ABIS.ERC20, wallet);

  console.log(`\n🤖 Bot Merge đang chạy với ví: ${wallet.address}`);

  // 1. Lấy Token ID của Yes và No
  console.log('🔍 Đang tính toán Token IDs...');
  const [yesTokenId, noTokenId] = await getPositionIds(
    ctf,
    MARKET_INFO.conditionId,
  );

  // 2. Kiểm tra số dư hiện tại của Token Yes và No
  const balances = await ctf.balanceOfBatch(
    [ProxyAddress, ProxyAddress],
    [yesTokenId, noTokenId],
  );

  const balanceYes = balances[0];
  const balanceNo = balances[1];

  console.log(`   💰 Balance YES: ${utils.formatUnits(balanceYes, 6)}`);
  console.log(`   💰 Balance NO : ${utils.formatUnits(balanceNo, 6)}`);

  return
  // 3. Tính lượng tối đa có thể Merge (Min của 2 loại)
  let mergeAmount = balanceYes.lt(balanceNo) ? balanceYes : balanceNo;

  if (mergeAmount.isZero()) {
    console.log('⚠️ Không có đủ cặp token để Merge (Cần cả Yes và No).');
    return;
  }

  console.log(
    `\n🔄 Chuẩn bị Merge: ${utils.formatUnits(mergeAmount, 6)} Sets -> USDC`,
  );

  // 4. Cấu hình Gas
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas
    ? feeData.maxFeePerGas.mul(120).div(100) // Tăng 20% giá gas để được ưu tiên
    : utils.parseUnits('50', 'gwei');

  const gasOptions = {
    maxFeePerGas: utils.parseUnits('3000', 'gwei'),
    maxPriorityFeePerGas: utils.parseUnits('3000', 'gwei'),
    gasLimit: 1000000, // <--- QUAN TRỌNG: Set cứng 1 triệu gas (thừa còn hơn thiếu)
  };

  // 5. Thực thi Merge
  // Lưu ý: Không cần Approve vì bạn đang burn token trong chính contract CTF mà bạn sở hữu
  try {
    const tx = await ctf.mergePositions(
      ADDR.USDC,
      constants.HashZero, // parentId
      MARKET_INFO.conditionId,
      [1, 2], // partition (Merge cả 2 outcomes)
      mergeAmount,
      gasOptions,
    );

    console.log(`   🚀 Tx Hash: ${tx.hash}`);
    await tx.wait();

    console.log(`   🎉 MERGE THÀNH CÔNG!`);
    const usdcBal = await usdc.balanceOf(wallet.address);
    console.log(
      `   💵 Số dư USDC hiện tại: ${utils.formatUnits(usdcBal, 6)} USDC`,
    );
  } catch (e: any) {
    console.error('   ❌ LỖI MERGE:', e.reason || e.message);
  }
};

main().catch(console.error);
