import { Wallet, providers, utils } from "ethers";

// --- CẤU HÌNH ---
const CONFIG = {
  rpc: "https://silent-virulent-ensemble.matic.quiknode.pro/69d6739125c575fbfc5ba71b43023323742a9092/",
  privateKey: '',
};

// 🔴 QUAN TRỌNG: ĐIỀN SỐ NONCE NHỎ NHẤT BẠN TÌM ĐƯỢC Ở BƯỚC 1
const STUCK_NONCE = 16; // <--- VÍ DỤ: SỬA SỐ NÀY THÀNH SỐ NONCE BẠN TÌM THẤY

const main = async () => {
  const provider = new providers.JsonRpcProvider(CONFIG.rpc);
  const wallet = new Wallet(CONFIG.privateKey, provider);

  console.log(`🔥 ĐANG HỦY GIAO DỊCH NONCE: ${STUCK_NONCE}`);

  // Dùng Gas cực mạnh (3000 Gwei) để chắc chắn 100% không bị lỗi "Replacement underpriced"
  const gasOverrides = {
    maxFeePerGas: utils.parseUnits("3000", "gwei"),
    maxPriorityFeePerGas: utils.parseUnits("3000", "gwei"),
    gasLimit: 100000, 
    nonce: STUCK_NONCE, // Ghi đè vào vị trí đang tắc
  };

  try {
    const tx = await wallet.sendTransaction({
      to: wallet.address, // Gửi về chính mình
      value: 0,
      ...gasOverrides
    });

    console.log("🚀 Đã bắn lệnh Hủy siêu tốc!");
    console.log(`   Tx Hash: ${tx.hash}`);
    
    await tx.wait();
    console.log("✅ ĐÃ THÔNG TẮC THÀNH CÔNG!");

  } catch (error: any) {
    console.error("❌ LỖI:", error.message);
  }
};

main();