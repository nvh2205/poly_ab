

```markdown
# Polymarket Market Maker Docs (Node.js Edition)

Tài liệu này hướng dẫn tích hợp Market Making trên Polymarket sử dụng **Node.js**.
Hệ thống bao gồm hai phần chính:
1.  **Off-chain (CLOB):** Đặt lệnh, hủy lệnh qua API (Trading).
2.  **On-chain (Polygon):** Tương tác Smart Contract để Mint (Split) và Redeem (Merge) token nhằm thực hiện arbitrage.

## 1. Cài đặt môi trường

### Yêu cầu
* Node.js v18+
* Ví Polygon có MATIC (để làm gas) và USDC (để giao dịch).

### Cài đặt dependencies
Bạn cần cài đặt SDK của Polymarket và Ethers.js để tương tác blockchain.

```bash
npm install @polymarket/clob-client ethers dotenv

```

### Cấu hình biến môi trường (.env)

Tạo file `.env` tại thư mục gốc:

```env
# Private Key ví Polygon của bạn (Không bao gồm 0x ở đầu nếu export từ Metamask)
PRIVATE_KEY=your_private_key_here

# RPC Polygon (Nên dùng Alchemy hoặc Infura để ổn định, đây là public RPC)
POLYGON_RPC=[https://polygon-rpc.com](https://polygon-rpc.com)

# Polymarket Chain ID (137 cho Mainnet)
CHAIN_ID=137

```

---

## 2. Trading (CLOB Client)

Phần này sử dụng `@polymarket/clob-client` để tương tác với sổ lệnh (Orderbook).

### Khởi tạo Client

Tạo file `trade.js`:

```javascript
require('dotenv').config();
const { ClobClient, OrderType, Side } = require('@polymarket/clob-client');
const { ethers } = require('ethers');

async function main() {
    // 1. Tạo Signer từ Private Key
    const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    // 2. Khởi tạo ClobClient
    const client = new ClobClient(
        '[https://clob.polymarket.com](https://clob.polymarket.com)',
        process.env.CHAIN_ID,
        wallet
    );

    // 3. Tạo API Credentials (chỉ cần chạy 1 lần để lấy key, sau đó hệ thống tự nhớ)
    try {
        const creds = await client.createApiCreds();
        console.log("API Creds Created:", creds);
    } catch (e) {
        console.log("Creds might already exist or error:", e.message);
    }

    // --- BẮT ĐẦU ĐẶT LỆNH ---
    
    // Token ID của Outcome (Lấy từ Gamma API hoặc UI)
    // Ví dụ: Token ID cho "Will Bitcoin hit $100k in 2024? - YES"
    const tokenId = "TOKEN_ID_OF_OUTCOME"; 

    console.log("Placing order...");
    
    try {
        // Tạo và gửi lệnh (Create & Post)
        const order = await client.createOrder({
            tokenID: tokenId,
            price: 0.65,      // Giá mua 0.65$
            side: Side.BUY,   // Mua (hoặc Side.SELL)
            size: 100,        // Số lượng
            feeRateBps: 0,    // Market maker thường được rebate hoặc 0 fee
        });

        const response = await client.postOrder(order, OrderType.GTC); // GTC: Good Till Cancelled
        console.log("Order Success:", response);
    } catch (error) {
        console.error("Order Failed:", error);
    }

    // --- HỦY LỆNH ---
    // client.cancel("ORDER_ID");
    // client.cancelAll();
}

main();

```

---

## 3. Mint & Redeem (On-chain Interaction)

Phần này tương tác trực tiếp với **Conditional Tokens Framework (CTF)** contract trên mạng Polygon.

* **Mint (Split):** Đổi 1 USDC thành (1 YES + 1 NO). Dùng khi tổng giá YES + NO > 1$ trên thị trường (Arbitrage bán).
* **Redeem (Merge):** Đổi (1 YES + 1 NO) thành 1 USDC. Dùng khi tổng giá YES + NO < 1$ (Arbitrage mua gộp).

Tạo file `market-maker.js`:

```javascript
require('dotenv').config();
const { ethers } = require('ethers');

// --- CẤU HÌNH ĐỊA CHỈ CONTRACT (POLYGON) ---
const CTF_EXCHANGE_ADDR = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"; // Contract chính
const USDC_ADDR = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";         // USDC Proxy

// --- ABI CẦN THIẾT ---
const CTF_ABI = [
    "function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)",
    "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)"
];

const ERC20_ABI = [
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)"
];

async function marketMakerOps() {
    const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    const ctfContract = new ethers.Contract(CTF_EXCHANGE_ADDR, CTF_ABI, wallet);
    const usdcContract = new ethers.Contract(USDC_ADDR, ERC20_ABI, wallet);

    // --- THÔNG SỐ CHUNG ---
    // Condition ID: ID của market (khác với Token ID, lấy từ API Polymarket)
    const conditionId = "CONDITION_ID_OF_MARKET"; 
    const parentCollectionId = ethers.ZeroHash; // Luôn là 0x0...0 cho thị trường gốc
    const partition = [1, 2]; // [1, 2] đại diện cho Outcome YES và NO

    // Số tiền muốn Mint/Redeem (Ví dụ 10 USDC / 10 Sets)
    // USDC có 6 số thập phân
    const amount = ethers.parseUnits("10", 6); 

    // ==========================================
    // 1. MINT (SPLIT POSITION)
    // ==========================================
    console.log("--- Bắt đầu Mint (Split) ---");
    
    // Bước 1: Approve cho CTF contract tiêu USDC của bạn
    const allowance = await usdcContract.allowance(wallet.address, CTF_EXCHANGE_ADDR);
    if (allowance < amount) {
        console.log("Approving USDC...");
        const txApprove = await usdcContract.approve(CTF_EXCHANGE_ADDR, ethers.MaxUint256);
        await txApprove.wait();
        console.log("Approved!");
    }

    // Bước 2: Gọi hàm splitPosition
    try {
        console.log("Splitting position...");
        const txSplit = await ctfContract.splitPosition(
            USDC_ADDR,
            parentCollectionId,
            conditionId,
            partition,
            amount
        );
        console.log(`Mint TX Hash: ${txSplit.hash}`);
        await txSplit.wait();
        console.log("Mint Success! Bạn đã nhận được YES và NO token.");
    } catch (e) {
        console.error("Mint Error:", e);
    }

    // ==========================================
    // 2. REDEEM (MERGE POSITION)
    // ==========================================
    // Yêu cầu: Bạn phải có đủ cả YES và NO token trong ví
    console.log("\n--- Bắt đầu Redeem (Merge) ---");

    try {
        console.log("Merging positions...");
        const txMerge = await ctfContract.mergePositions(
            USDC_ADDR,
            parentCollectionId,
            conditionId,
            partition,
            amount
        );
        console.log(`Redeem TX Hash: ${txMerge.hash}`);
        await txMerge.wait();
        console.log("Redeem Success! Bạn đã đổi YES+NO lấy lại USDC.");
    } catch (e) {
        console.error("Redeem Error:", e);
    }
}

marketMakerOps();

```

## 4. Các tiện ích hỗ trợ (Utils)

Để code chạy trơn tru, bạn cần biết cách lấy `conditionId` và `tokenId`. Dưới đây là helper function sử dụng Gamma API (API GraphQL của Polymarket).

```javascript
const axios = require('axios');

async function getMarketDetails(slug) {
    // Slug ví dụ: "will-bitcoin-hit-100k-in-2024" lấy từ URL
    const query = `
        query {
            market(slug: "${slug}") {
                conditionId
                question
                outcomes
                clobTokenIds
            }
        }
    `;

    const res = await axios.post('[https://gamma-api.polymarket.com/query](https://gamma-api.polymarket.com/query)', { query });
    const data = res.data.data.market;
    
    console.log("Condition ID:", data.conditionId);
    console.log("YES Token ID:", JSON.parse(data.clobTokenIds)[0]); 
    console.log("NO Token ID:", JSON.parse(data.clobTokenIds)[1]);
}

```

## 5. Quy trình Market Making cơ bản

1. **Lắng nghe giá:** Dùng `ClobClient` để subscribe websocket hoặc poll giá Orderbook.
2. **Tính toán chênh lệch:**
* Nếu `Giá_YES + Giá_NO > 1.01` (trừ phí): Thực hiện **Mint** (Split) 1 USDC ra 2 token, sau đó bán cả 2 token trên CLOB để ăn chênh lệch.
* Nếu `Giá_YES + Giá_NO < 0.99`: Mua cả YES và NO trên CLOB, sau đó **Redeem** (Merge) để lấy về 1 USDC.


3. **Quản lý Inventory:** Cân bằng số lượng USDC và Token để tránh rủi ro biến động giá khi giữ vị thế quá lâu.

```

### Điểm cần lưu ý cho Node.js Developer:
* **Async/Await:** Mọi tương tác blockchain và API đều là bất đồng bộ.
* **BigNumber:** USDC có 6 decimals. Khi làm việc với `ethers`, luôn chú ý dùng `ethers.parseUnits("amount", 6)` thay vì tính toán số học thông thường để tránh lỗi mất mát độ chính xác.
* **Gas Fee:** Mạng Polygon phí rẻ nhưng hay tắc nghẽn. Nếu bot chạy tần suất cao, bạn cần điều chỉnh `gasPrice` trong `overrides` của `ethers` (ví dụ: dùng Gas Station API của Polygon để lấy phí realtime).


```