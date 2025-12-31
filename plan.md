Dựa trên yêu cầu của bạn và code hiện có (stack NestJS, Redis, ClickHouse), tôi đã phân tích và thiết kế một plan chi tiết để triển khai hệ thống arbitrage này. Đây là bài toán **Range-based Combinatorial Arbitrage**.

Hệ thống của bạn không đơn thuần là arbitrage tam giác (triangular) mà là arbitrage trên tập hợp (subset sum problem).

Dưới đây là thiết kế chi tiết.

---

### 1. Mô hình hoá dữ liệu & Quan hệ Parent-Children

Để tính toán nhanh (sub-millisecond), bạn không thể query DB (Postgres/ClickHouse). Bạn cần xây dựng một **In-Memory Orderbook Snapshot** trong RAM của service Arbitrage.

#### A. Data Structure (In-Memory)

Tổ chức dữ liệu theo cấu trúc **Segment Map**.

Giả sử Parent event là giá Bitcoin ngày 30/12. Các child events chia nhỏ khoảng giá.

* **Step**: 2000 (ví dụ: 88k, 90k, 92k...).
* **Indexing**: Map các khoảng giá thực tế về index số nguyên .
* Event : [88k, 90k]
* Event : [90k, 92k]
* Parent : Covers [88k, 94k]  Tương ứng với range index  (bao gồm ).



**Object Model (Typescript Interface):**

```typescript
interface MarketNode {
  marketId: string; // Polymarket condition ID
  type: 'BINARY' | 'SCALAR';
  // Best prices snapshot (updated via Websocket)
  bestBid: number; // Giá cao nhất người mua chấp nhận
  bestAsk: number; // Giá thấp nhất người bán chấp nhận
  bidLiquidity: number; // Volume tại bestBid
  askLiquidity: number; // Volume tại bestAsk
}

interface RangeEvent {
  eventId: string;
  minVal: number; // 88000
  maxVal: number; // 94000
  step: number;   // 2000
  
  // Array chứa các market con đã sort theo range tăng dần
  // children[0] = market 88-90k, children[1] = market 90-92k
  children: MarketNode[]; 
  
  // Market tổng (nếu có), ví dụ "Above 88k" hoặc một range to hơn
  // Map key là hash của range [startIndex, endIndex] -> MarketNode
  parents: Map<string, MarketNode>; 
}

```

### 2. Thuật toán phát hiện Arbitrage

Sử dụng kỹ thuật **Prefix Sum (Mảng cộng dồn)** để giảm độ phức tạp tính toán tổng giá của một range con từ  xuống .

#### A. Logic toán học

Gọi  là giá mua vào (giá Ask) của child market .
Gọi  là giá bán ra (giá Bid) của parent market bao phủ range từ  đến .

**Công thức Profit:**

1. **Chiến lược 1: Parent Overvalued (Synthetic Short)**
* **Hành động:** Bán (Short) Parent tại  + Mua (Long) tất cả Children  tại .
* **Logic:** Bạn tạo ra một vị thế tổng hợp (synthetic) giá rẻ hơn và bán lại cho người đang mua Parent giá cao.
* **Công thức:**




2. **Chiến lược 2: Parent Undervalued (Synthetic Long)**
* **Hành động:** Mua (Long) Parent tại  + Bán (Short) tất cả Children tại .
* **Logic:** Bạn mua Parent giá rẻ, xé lẻ ra (unbundle) và bán lại cho từng market con đang có người mua giá cao.
* **Công thức:**





#### B. Tối ưu hiệu năng (Scan Strategy)

Thay vì loop qua mọi cặp  mỗi lần có update (Complexity ), ta dùng mảng Prefix Sum cho giá.

* Duy trì 2 mảng prefix sum cho mỗi Event Group:
* `SumAsk[k]` = 
* `SumBid[k]` = 


* Khi cần tính tổng giá Ask cho range :
* `Cost = SumAsk[j] - SumAsk[i-1]` (Tính trong )



**Quy trình xử lý sự kiện Websocket (Incremental Update):**

1. **Input:** Nhận message `OrderbookUpdate(marketId, price, side)`.
2. **Lookup:** Tìm `RangeEvent` chứa market đó và index  của nó.
3. **Update Prefix Sum:**
* Cập nhật lại mảng `SumAsk` hoặc `SumBid` từ index  đến . (Vì  nhỏ < 20-50 ranges, loop này tốn < 1 microsecond).


4. **Scan Opportunities (O(M)):**
* Duyệt qua danh sách `parents` (các market tổng).
* Với mỗi Parent bao phủ range :
* Tính `ChildCost = SumAsk[j] - SumAsk[i-1]`.
* So sánh với `ParentBid`.
* Nếu `ParentBid > ChildCost + MinProfit`: **TRIGGER EXECUTION**.





### 3. Execution Strategy (Chiến lược khớp lệnh)

Đây là phần rủi ro nhất (Execution Risk) vì bạn phải khớp lệnh trên nhiều market cùng lúc.

#### A. Thứ tự đặt lệnh (Legging Risk Management)

Nguyên tắc: **"Take Liquidity where it implies the most risk"** (Khớp lệnh ở nơi thanh khoản kém hoặc biến động nhanh trước).

* **Với chiến lược Mua Children - Bán Parent:**
1. **Scan Liquidity:** Kiểm tra `min(Volume)` có thể khớp được trên toàn bộ chuỗi (Parent + Children). Lấy volume nhỏ nhất làm `TargetSize`.
2. **Concurrency:** Gửi lệnh **Market Order (IOC - Immediate Or Cancel)** song song cho tất cả các Children và Parent cùng lúc.
3. **Tại sao IOC?** Để tránh bị treo vốn (partial fill). Nếu không khớp được hết, lệnh tự huỷ, bạn không bị kẹt vị thế.


* **Heuristic thực tế (Tránh Race Condition):**
* Nếu thanh khoản của Parent **rất lớn** so với Children: Mua Children trước (vì Children dễ bị trượt giá/hết hàng), sau đó mới dump vào Parent.
* Nếu thanh khoản ngang nhau: Bắn lệnh song song (Parallel Request).



#### B. Xử lý Partial Fill (Khớp một phần)

Nếu bạn bắn 5 lệnh mua Children, nhưng chỉ khớp 4 lệnh, 1 lệnh fail:

* Bạn đang bị "Naked Exposure" (Rủi ro mở).
* **Hành động:** Hệ thống phải có cơ chế **Auto-Hedge**. Ngay lập tức bán ngược lại 4 lệnh đã khớp (chấp nhận lỗ phí) hoặc mua market order giá cao hơn ở lệnh fail để đóng kín range (chấp nhận trượt giá để khoá rủi ro).

### 4. Pseudocode & Flowchart

```typescript
// Giả lập xử lý luồng real-time
onWebsocketMessage(update: OrderbookUpdate) {
    // 1. Update Local Cache
    const node = marketMap.get(update.marketId);
    node.updatePrice(update);

    // 2. Identify Scope
    const group = eventGroups.get(node.groupId);
    
    // 3. Rebuild Prefix Sums (Rất nhanh)
    group.recalculatePrefixSums(); 

    // 4. Check Arbitrage
    for (const parent of group.parents) {
        // Lấy range [i, j] mà parent này cover
        const [i, j] = parent.rangeIndices;

        // -- Check Strategy 1: Sell Parent, Buy Children --
        const costToBuyChildren = group.getSumAsk(i, j);
        const revenueSellParent = parent.bestBid;
        
        const potentialProfit = revenueSellParent - costToBuyChildren;
        
        if (potentialProfit > CONFIG.MIN_PROFIT_THRESHOLD) {
             // 5. Check Liquidity Depth
             const maxVol = Math.min(parent.bidVol, group.getMinAskVol(i, j));
             if (maxVol < CONFIG.MIN_TRADE_SIZE) continue;

             // 6. Execute
             executeArbitrage(parent, group.children.slice(i, j+1), 'SELL_PARENT_BUY_CHILDREN', maxVol);
        }

        // -- Check Strategy 2: Buy Parent, Sell Children --
        // Tương tự logic trên nhưng ngược chiều
    }
}

```

### 5. Implementation Plan (Dựa trên Code hiện có)

Tôi thấy bạn đã có `poly_ab` với NestJS. Dưới đây là các bước code cụ thể:

**Bước 1: Extend Entity & Ingestion**

* Sửa file `market.entity.ts`: Thêm cột `group_id` (để nhóm các range cùng loại), `range_min`, `range_max`, `parent_id`.
* Viết script (hoặc dùng LLM) để parse cái `slug` hoặc `description` của event để tự động xây dựng cây phả hệ (Parent-Child graph) và lưu vào Redis khi khởi động app.

**Bước 2: Redis Structure (`redis.service.ts`)**

* Hiện tại bạn dùng Redis cho Cache. Hãy dùng Redis Pub/Sub hoặc Stream để đẩy data từ `Ingestion Service` sang `Strategy Service`.
* Key schema cho Orderbook nóng: `OB:{market_id}` -> Hash `{bid: 0.45, ask: 0.46, bidVol: 1000...}`.

**Bước 3: Strategy Worker (NodeJS Service riêng biệt)**

* Tạo file `src/modules/strategy/arb-engine.ts`.
* Load toàn bộ Market cấu trúc cây vào biến `global` hoặc `class property` khi start.
* Subscribe vào luồng giá (từ socket hoặc Redis).
* Implement thuật toán Prefix Sum như trên.

**Bước 4: Execution Module**

* Cần wrapper cho API `createOrder` của Polymarket (thường qua Gnosis Safe hoặc EOA wallet).
* **Lưu ý:** Polymarket dùng CTF Exchange (Central Limit Order Book on-chain/hybrid). Việc đặt lệnh cần chữ ký EIP-712. Hãy chắc chắn code ký transaction (bằng `ethers.js` hoặc Go) được tối ưu tốc độ, tránh dùng JS thread đang xử lý tính toán để ký.

### 6. Các Heuristic Thực Tế (Kinh nghiệm Production)

1. **Fee Threshold:** Polymarket không thu phí giao dịch (hiện tại) nhưng CTF Exchange có thể có hoặc phí ẩn trong spread. Hãy đặt `MIN_PROFIT` khoảng 0.5% - 1% ban đầu. Đừng tham trade profit 0.01% vì rủi ro trượt giá (slippage) cao hơn mức đó.
2. **Blacklist:** Bỏ qua các market có spread quá rộng (>5%) hoặc volume < $100. Data nhiễu sẽ làm bot bắn lệnh sai.
3. **Time-to-Maturity:** Càng gần ngày đáo hạn (30 Dec), biến động càng mạnh nhưng giá càng hội tụ. Arbitrage an toàn nhất là khi còn xa ngày đáo hạn một chút (vài ngày/tuần).
4. **Gas/Relayer:** Nếu dùng CTF Exchange API, việc khớp lệnh là off-chain matching, on-chain settlement. Tốc độ API là quan trọng nhất. Hãy host bot server (AWS/GCP) ở region gần server của Polymarket (thường là US-East N.Virginia).

### Tổng kết Output mong muốn

Tôi đã cung cấp **Mô hình Segment Map + Prefix Sum** cho thuật toán (giải quyết bài toán Complexity), và **Parallel IOC Execution** cho bài toán khớp lệnh.

**Next Step:** Bạn có muốn tôi viết cụ thể đoạn code TypeScript (Class `ArbitrageEngine`) implement logic Prefix Sum và check điều kiện profit dựa trên các interface của project hiện tại không?