import { Contract, Wallet, providers, utils, constants, BigNumber } from 'ethers';
import * as dotenv from 'dotenv';

dotenv.config();

// --- CẤU HÌNH ---
const CONFIG = {
  rpc: 'https://silent-virulent-ensemble.matic.quiknode.pro/69d6739125c575fbfc5ba71b43023323742a9092/',
  privateKey:
    '',
  // Địa chỉ Proxy của bạn
  proxyAddress: '',

  // Condition ID của market "Bitcoin 92k-94k" (Lấy từ JSON bạn gửi)
  conditionId:
    '0xad756823ed9304a1073e5bf4e008fed4da19856d7f196dcd1f861a7f0212f734',
};

const ADDR = {
  USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  CTF: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
};

const ABIS = {
  CTF: [
    'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
    'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)',
    'function getPositionId(address collateralToken, bytes32 collectionId) view returns (uint256)',
    'function balanceOf(address account, uint256 id) view returns (uint256)',
  ],
  GNOSIS_SAFE: [
    'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)',
    'function nonce() view returns (uint256)',
  ],
  ERC20: ['function balanceOf(address) view returns (uint256)'],
};

const main = async () => {
  if (!CONFIG.privateKey) throw new Error('Thiếu Private Key');

  const provider = new providers.JsonRpcProvider(CONFIG.rpc);
  const ownerWallet = new Wallet(CONFIG.privateKey, provider);
  const ctf = new Contract(ADDR.CTF, ABIS.CTF, provider); // Read-only
  const ctfInterface = new utils.Interface(ABIS.CTF);
  const proxy = new Contract(
    CONFIG.proxyAddress,
    ABIS.GNOSIS_SAFE,
    ownerWallet,
  );
  const usdc = new Contract(ADDR.USDC, ABIS.ERC20, provider);
  const feeData = await provider.getFeeData();

  const data = {
    lastBaseFeePerGas: BigNumber.from('0xbe030d70c7'),
    maxFeePerGas: BigNumber.from('0x017c5f83108e'),
    maxPriorityFeePerGas: BigNumber.from('0x59682f00'),
    gasPrice: BigNumber.from('0xc3d52b2ac7'),
  };

  // Convert sang string (an toàn)
  const lastBaseFeeWei = data.lastBaseFeePerGas.toString();
  const maxFeeWei = data.maxFeePerGas.toString();
  const maxPriorityFeeWei = data.maxPriorityFeePerGas.toString();
  const gasPriceWei = data.gasPrice.toString();

  console.log({
    lastBaseFeeWei,
    maxFeeWei,
    maxPriorityFeeWei,
    gasPriceWei,
  });

  console.log('feeData:----', feeData);
  // return;
  console.log(`\n🤖 BOT PROXY MERGE KHỞI ĐỘNG...`);
  console.log(`   Proxy: ${CONFIG.proxyAddress}`);
  console.log(`   Condition ID: ${CONFIG.conditionId}`);

  // 1. TÍNH TOÁN RAW TOKEN ID (Token do Mint mà có)
  const getRawTokenId = async (indexSet: number) => {
    const colId = await ctf.getCollectionId(
      constants.HashZero,
      CONFIG.conditionId,
      indexSet,
    );
    return await ctf.getPositionId(ADDR.USDC, colId);
  };

  const rawYesId = await getRawTokenId(1);
  const rawNoId = await getRawTokenId(2);

  // 2. CHECK BALANCE TRONG PROXY
  const balYes = await ctf.balanceOf(CONFIG.proxyAddress, rawYesId);
  const balNo = await ctf.balanceOf(CONFIG.proxyAddress, rawNoId);

  console.log(`\n📊 SỐ DƯ RAW TOKEN (Minted):`);
  console.log(`   YES: ${utils.formatUnits(balYes, 6)}`);
  console.log(`   NO : ${utils.formatUnits(balNo, 6)}`);

  // return

  // Lấy số lượng nhỏ nhất để Merge (Vì cần 1 Yes + 1 No = 1 USDC)
  let mergeAmount = balYes.lt(balNo) ? balYes : balNo;

  if (mergeAmount.eq(0)) {
    console.error(`\n❌ Không đủ cặp Token để Merge.`);
    console.log(`   Yêu cầu: Phải có cả YES và NO (Raw Token) trong ví.`);
    return;
  }

  console.log(
    `\n🔄 CHUẨN BỊ MERGE: ${utils.formatUnits(mergeAmount, 6)} Sets -> USDC`,
  );

  // 3. TẠO DATA LỆNH MERGE
  const mergeData = ctfInterface.encodeFunctionData('mergePositions', [
    ADDR.USDC,
    constants.HashZero, // Parent ID
    CONFIG.conditionId, // Condition ID
    [1, 2], // Partition (Gộp cả Yes và No)
    mergeAmount, // Số lượng
  ]);

  // 4. KÝ VÀ GỬI LỆNH QUA PROXY
  const nonce = await proxy.nonce();

  const safeTx = {
    to: ADDR.CTF,
    value: 0,
    data: mergeData,
    operation: 0,
    safeTxGas: 0,
    baseGas: 0,
    gasPrice: 0,
    gasToken: constants.AddressZero,
    refundReceiver: constants.AddressZero,
    nonce: nonce.toNumber(),
  };

  // Ký EIP-712
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

  console.log(`🚀 Đang gửi Transaction Merge...`);

  //   const feeData = await provider.getFeeData();
  //   const gasPrice = feeData.maxFeePerGas
  //       ? feeData.maxFeePerGas.mul(130).div(100)
  //       : utils.parseUnits('60', 'gwei');

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
        maxFeePerGas: utils.parseUnits('1000', 'gwei'),
        maxPriorityFeePerGas: utils.parseUnits('1000', 'gwei'),
        gasLimit: 2_000_000, // Set Gas thoải mái
      },
    );

    console.log(`   🔗 Tx Hash: ${tx.hash}`);
    await tx.wait();

    console.log(`\n🎉 MERGE THÀNH CÔNG!`);

    // Check lại số dư USDC của Proxy
    const usdcBal = await usdc.balanceOf(CONFIG.proxyAddress);
    console.log(
      `   💵 Số dư USDC hiện tại của Proxy: ${utils.formatUnits(usdcBal, 6)} USDC`,
    );
  } catch (e: any) {
    console.error(`   ❌ LỖI MERGE:`,  e.message);
  }
};

main();
