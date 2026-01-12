import { Contract, Wallet, providers, utils, constants } from 'ethers';
import axios from 'axios';

// --- CẤU HÌNH ---
const CONFIG = {
  rpc: 'https://silent-virulent-ensemble.matic.quiknode.pro/69d6739125c575fbfc5ba71b43023323742a9092/',
  privateKey:
    '',
};
const AMOUNT_USDC = 1;

const ADDR = {
  USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  CTF: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
};

const ABIS = {
  ERC20: [
    'function approve(address, uint256) returns (bool)',
    'function allowance(address, address) view returns (uint256)',
  ],
  CTF: [
    'function splitPosition(address, bytes32, bytes32, uint256[], uint256)',
  ],
};

// Hàm Gas an toàn
const getGas = async (provider: providers.Provider) => {
  const fee = await provider.getFeeData();
  const MIN = utils.parseUnits('50', 'gwei');
  let maxFee = fee.maxFeePerGas || MIN;
  let maxPrio = fee.maxPriorityFeePerGas || MIN;
  if (maxFee.lt(MIN)) maxFee = MIN;
  if (maxPrio.lt(MIN)) maxPrio = MIN;
  return {
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: maxPrio,
    gasLimit: 500000,
  };
};

const main = async () => {
  const provider = new providers.JsonRpcProvider(CONFIG.rpc);
  const wallet = new Wallet(CONFIG.privateKey, provider);
  console.log(`   Ví: ${wallet.address}`);

  // BƯỚC 1: LẤY THÔNG TIN TỪ API CLOB (CHUẨN HƠN GAMMA)
  console.log('\n1. Đang tải Condition ID...');
  const conditionId = '0xe2281743ca4852f55d231b561f5f509583c859241b65d390f58001477d8263e7';
  const parentId = constants.HashZero; // Thường Gamma không trả parentId, tạm để 0

  // BƯỚC 2 & 3: APPROVE & MINT (Giữ nguyên)
  const usdc = new Contract(ADDR.USDC, ABIS.ERC20, wallet);
  const ctf = new Contract(ADDR.CTF, ABIS.CTF, wallet);
  const amountWei = utils.parseUnits(AMOUNT_USDC.toString(), 6);
  const gas = await getGas(provider);

  const allowance = await usdc.allowance(wallet.address, ADDR.CTF);
  if (allowance.lt(amountWei)) {
    console.log('\n2. Đang Approve USDC...');
    const tx = await usdc.approve(ADDR.CTF, constants.MaxUint256, gas);
    await tx.wait();
    console.log('   ✅ Approve xong.');
  }

  console.log('\n3. Đang thực thi Mint...');
  try {
    const tx = await ctf.splitPosition(
      ADDR.USDC,
      parentId,
      conditionId,
      [1, 2],
      amountWei,
      gas,
    );
    console.log(`   🚀 Tx Hash: ${tx.hash}`);
    await tx.wait();
    console.log(`   🎉 THÀNH CÔNG!`);
  } catch (e: any) {
    console.error('   ❌ LỖI:', e.reason || e.message);
  }
};

main();
