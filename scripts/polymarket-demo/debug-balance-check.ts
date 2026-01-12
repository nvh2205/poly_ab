import { Contract, Wallet, providers, utils } from 'ethers';
import * as dotenv from 'dotenv';

dotenv.config();

const CONFIG = {
    rpc: "https://silent-virulent-ensemble.matic.quiknode.pro/69d6739125c575fbfc5ba71b43023323742a9092/",
    // Điền địa chỉ Proxy của bạn
  proxyAddress: '0x33568db0dfb9890f5107fb50f566a159f6f612ed',
};

// DỮ LIỆU TỪ JSON BẠN GỬI (TOKEN ID CHUẨN CỦA SÀN)
const CLOB_IDS = {
  YES: '74645459583107258436965305739293526016362329617355262163322858365903243305286',
  NO: '101830734778432899440324460330545872849605907455813396886197020262585314227966',
};

const ABIS = {
  CTF: [
    'function balanceOf(address account, uint256 id) view returns (uint256)',
  ],
};

const main = async () => {
  const provider = new providers.JsonRpcProvider(CONFIG.rpc);
  const ctf = new Contract(
    '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
    ABIS.CTF,
    provider,
  );

  console.log(`\n🕵️‍♂️ KIỂM TRA SỐ DƯ TOKEN NEG-RISK (TOKEN MUA)`);
  console.log(`   Proxy: ${CONFIG.proxyAddress}`);

  // Check ID YES
  const balYes = await ctf.balanceOf(CONFIG.proxyAddress, CLOB_IDS.YES);
  console.log(`\n1️⃣  Token YES (ID: ...${CLOB_IDS.YES.slice(-6)})`);
  console.log(`   💰 Số dư: ${utils.formatUnits(balYes, 6)}`);

  // Check ID NO
  const balNo = await ctf.balanceOf(CONFIG.proxyAddress, CLOB_IDS.NO);
  console.log(`\n2️⃣  Token NO (ID: ...${CLOB_IDS.NO.slice(-6)})`);
  console.log(`   💰 Số dư: ${utils.formatUnits(balNo, 6)}`);
};

main();
