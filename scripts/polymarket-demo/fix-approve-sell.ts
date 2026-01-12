import { Contract, Wallet, providers, utils, constants } from 'ethers';
import * as dotenv from 'dotenv';

dotenv.config();

// --- CẤU HÌNH ---
const CONFIG = {
  rpc: 'https://silent-virulent-ensemble.matic.quiknode.pro/69d6739125c575fbfc5ba71b43023323742a9092/',
  privateKey: process.env.PRIVATE_KEY || '', // Key của Owner
  // Địa chỉ Proxy của bạn (Ví đang giữ token YES/NO)
  proxyAddress: '0x33568db0dfb9890f5107fb50f566a159f6f612ed',
};

const ADDR = {
  // Conditional Tokens Framework (Nơi quản lý Token YES/NO)
  CTF: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
  // CTF Exchange (Sàn giao dịch khớp lệnh CLOB) - Cần cấp quyền cho ông này
  EXCHANGE: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
};

const ABIS = {
  CTF: [
    'function setApprovalForAll(address operator, bool approved)',
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
  ],
  GNOSIS_SAFE: [
    'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)',
    'function nonce() view returns (uint256)',
  ],
};

const main = async () => {
  if (!CONFIG.privateKey) throw new Error('Thiếu Private Key');

  const provider = new providers.JsonRpcProvider(CONFIG.rpc);
  const ownerWallet = new Wallet(CONFIG.privateKey, provider);
  const ctf = new Contract(ADDR.CTF, ABIS.CTF, provider);
  const proxy = new Contract(
    CONFIG.proxyAddress,
    ABIS.GNOSIS_SAFE,
    ownerWallet,
  );
  const ctfInterface = new utils.Interface(ABIS.CTF);

  console.log(`\n🤖 Đang cấu hình quyền BÁN (Sell) cho Proxy...`);
  console.log(`   Proxy: ${CONFIG.proxyAddress}`);

  // 1. KIỂM TRA TRẠNG THÁI HIỆN TẠI
  const isApproved = await ctf.isApprovedForAll(
    CONFIG.proxyAddress,
    ADDR.EXCHANGE,
  );
  console.log(`   Trạng thái Approve hiện tại: ${isApproved}`);

  if (isApproved) {
    console.log(
      `   ✅ Proxy ĐÃ có quyền bán. Nếu vẫn lỗi, hãy kiểm tra lại Token ID.`,
    );
    return;
  }

  console.log(`   ❌ Proxy CHƯA có quyền bán. Đang tiến hành Approve...`);

  // 2. TẠO DATA LỆNH APPROVE
  // Hàm này cho phép Exchange kiểm soát toàn bộ token ERC1155 (YES/NO) của Proxy
  const approveData = ctfInterface.encodeFunctionData('setApprovalForAll', [
    ADDR.EXCHANGE,
    true,
  ]);

  // 3. GỬI TRANSACTION QUA PROXY
  const nonce = await proxy.nonce();

  const safeTx = {
    to: ADDR.CTF, // Gọi vào Contract CTF
    value: 0,
    data: approveData, // Lệnh setApprovalForAll
    operation: 0, // Call
    safeTxGas: 0,
    baseGas: 0,
    gasPrice: 0,
    gasToken: constants.AddressZero,
    refundReceiver: constants.AddressZero,
    nonce: nonce.toNumber(),
  };

  // Ký lệnh
  const chainId = (await provider.getNetwork()).chainId;
  const domain = { verifyingContract: CONFIG.proxyAddress, chainId };
  const types = {
    SafeTx: [
      { type: 'address', name: 'to' },
      { type: 'uint256', name: 'value' },
      { type: 'bytes', name: 'data' },
      { type: 'uint8', name: 'operation' },
      { type: 'uint256', name: 'safeTxGas' },
      { type: 'uint256', name: 'baseGas' },
      { type: 'uint256', name: 'gasPrice' },
      { type: 'address', name: 'gasToken' },
      { type: 'address', name: 'refundReceiver' },
      { type: 'uint256', name: 'nonce' },
    ],
  };

  const signature = await ownerWallet._signTypedData(domain, types, safeTx);

  console.log(`   🚀 Đang gửi Transaction setApprovalForAll...`);

  // Tăng Gas để đảm bảo thành công
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas
    ? feeData.maxFeePerGas.mul(150).div(100)
    : utils.parseUnits('60', 'gwei');

  try {
    const tx = await proxy.execTransaction(
      safeTx.to,
      safeTx.value,
      safeTx.data,
      safeTx.operation,
      safeTx.safeTxGas,
      safeTx.baseGas,
      safeTx.gasPrice,
      safeTx.gasToken,
      safeTx.refundReceiver,
      signature,
      {
        maxFeePerGas: gasPrice,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
        gasLimit: 300000,
      },
    );

    console.log(`   🔗 Tx Hash: ${tx.hash}`);
    await tx.wait();
    console.log(`   ✅ CẤP QUYỀN THÀNH CÔNG!`);
    console.log(`   👉 Bây giờ bạn hãy thử đặt lệnh Bán (Sell) lại.`);
  } catch (e: any) {
    console.error(`   ❌ LỖI:`, e.reason || e.message);
  }
};

main();
