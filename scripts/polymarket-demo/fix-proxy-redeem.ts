import { Contract, Wallet, providers, utils, constants } from 'ethers';
import * as dotenv from 'dotenv';

dotenv.config();

// --- CẤU HÌNH ---
const CONFIG = {
  rpc: 'https://silent-virulent-ensemble.matic.quiknode.pro/69d6739125c575fbfc5ba71b43023323742a9092/',
  privateKey:
    '',
};

const ADDR = {
  // Thay bằng địa chỉ Proxy Wallet (Gnosis Safe) của bạn trên Polymarket
  // Bạn có thể lấy ở Profile -> Copy Address
  PROXY_WALLET: '0xb9b5cde0d64a06f5315be41a3ef2bbb530990fa5',

  USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  CTF: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
};

const MARKET_INFO = {
  // Condition ID của market ĐÃ RESOLVED
  conditionId:
    '0x756618c654130b6b6438ca715187c10f90cc0d89a3ceedd7aea52fadd9c7404c',
};

// --- ABI ---
const ABIS = {
  CTF: [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  ],
  // ABI chuẩn của Gnosis Safe để thực thi lệnh
  GNOSIS_SAFE: [
    'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)',
    'function nonce() view returns (uint256)',
  ],
};

const main = async () => {
  if (!CONFIG.privateKey) throw new Error('Thiếu PRIVATE_KEY');
  if (!ADDR.PROXY_WALLET || !utils.isAddress(ADDR.PROXY_WALLET))
    throw new Error('Địa chỉ PROXY_WALLET không hợp lệ');

  const provider = new providers.JsonRpcProvider(CONFIG.rpc);
  const wallet = new Wallet(CONFIG.privateKey, provider);

  // Contract Instances
  const proxy = new Contract(ADDR.PROXY_WALLET, ABIS.GNOSIS_SAFE, wallet);
  const ctfInterface = new utils.Interface(ABIS.CTF); // Chỉ dùng Interface để encode data

  console.log(`\n🤖 Bot Proxy Redeem đang chạy...`);
  console.log(`   🔑 EOA Signer: ${wallet.address}`);
  console.log(`   🏦 Proxy Wallet: ${ADDR.PROXY_WALLET}`);

  // BƯỚC 1: TẠO PAYLOAD CHO HÀM REDEEM
  // Đây là lệnh mà Proxy sẽ chạy: "Proxy ơi, hãy gọi hàm redeemPositions trên contract CTF đi"
  const redeemData = ctfInterface.encodeFunctionData('redeemPositions', [
    ADDR.USDC,
    constants.HashZero,
    MARKET_INFO.conditionId,
    [1, 2], // Redeem cả Yes và No
  ]);

  // BƯỚC 2: CHUẨN BỊ THÔNG SỐ CHO GIAO DỊCH SAFE
  const nonce = await proxy.nonce(); // Lấy số thứ tự giao dịch tiếp theo của Safe

  const safeTx = {
    to: ADDR.CTF, // Proxy sẽ gọi đến contract CTF
    value: 0, // Không gửi kèm MATIC
    data: redeemData, // Dữ liệu hàm redeem đã encode ở bước 1
    operation: 0, // 0 = Call, 1 = DelegateCall. Ở đây dùng 0.
    safeTxGas: 0, // 0 để tự estimate hoặc set gas
    baseGas: 0,
    gasPrice: 0,
    gasToken: constants.AddressZero,
    refundReceiver: constants.AddressZero,
    nonce: nonce.toNumber(),
  };

  // BƯỚC 3: KÝ GIAO DỊCH (EIP-712 SIGNATURE)
  // Để Proxy chấp nhận lệnh, EOA Owner phải ký xác nhận
  const chainId = (await provider.getNetwork()).chainId;

  const domain = {
    verifyingContract: ADDR.PROXY_WALLET,
    chainId: chainId,
  };

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

  console.log('✍️  Đang ký giao dịch EIP-712...');
  // Ethers v5 signature
  const signature = await wallet._signTypedData(domain, types, safeTx);

  // BƯỚC 4: GỬI LỆNH THỰC THI (EXECUTE)
  console.log('🚀 Đang gửi lệnh execTransaction lên Proxy...');

  const feeData = await provider.getFeeData();
  const gasOptions = {
    maxFeePerGas: utils.parseUnits('3000', 'gwei'),
    maxPriorityFeePerGas: utils.parseUnits('3000', 'gwei'),
    gasLimit: 1000000, // <--- QUAN TRỌNG: Set cứng 1 triệu gas (thừa còn hơn thiếu)
  };

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
      gasOptions,
    );

    console.log(`   🔗 Tx Hash: ${tx.hash}`);
    await tx.wait();
    console.log(`   🎉 PROXY REDEEM THÀNH CÔNG!`);
    console.log(
      `   ℹ️  Lưu ý: USDC sau khi redeem đang nằm trong ví PROXY (${ADDR.PROXY_WALLET}), chưa về ví EOA.`,
    );
  } catch (e: any) {
    console.error('   ❌ LỖI:', e.reason || e.message);
  }
};

main().catch(console.error);
