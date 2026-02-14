# Rust Engine State Variables — Tài liệu chi tiết

> Tệp `rust-core/src/engine/state.rs` định nghĩa toàn bộ cấu trúc dữ liệu nội bộ của Rust arbitrage engine.
> Tài liệu này giải thích **tác dụng**, **cách hoạt động** và **nơi sử dụng** của từng biến.

---

## Mục lục

1. [EngineState — Container chính](#1-enginestate--container-chính)
2. [EngineConfig — Cấu hình engine](#2-engineconfig--cấu-hình-engine)
3. [PriceTable — Bảng giá trung tâm](#3-pricetable--bảng-giá-trung-tâm)
4. [PriceSlot — Snapshot giá 1 token](#4-priceslot--snapshot-giá-1-token)
5. [MarketMeta — Metadata của 1 market](#5-marketmeta--metadata-của-1-market)
6. [GroupState — Trạng thái 1 nhóm thị trường](#6-groupstate--trạng-thái-1-nhóm-thị-trường)
7. [TrioState — Trạng thái 1 bộ ba arbitrage](#7-triostate--trạng-thái-1-bộ-ba-arbitrage)
8. [RangeCoverage — Phạm vi bao phủ children](#8-rangecoverage--phạm-vi-bao-phủ-children)
9. [TokenRole — Vai trò dispatch của token](#9-tokenrole--vai-trò-dispatch-của-token)
10. [LastPrice — Cache dirty checking](#10-lastprice--cache-dirty-checking)
11. [Data Flow — Luồng dữ liệu tổng thể](#11-data-flow--luồng-dữ-liệu-tổng-thể)

---

## 1. EngineState — Container chính

```rust
pub struct EngineState {
    pub price_table:      PriceTable,
    pub groups:           Vec<GroupState>,
    pub group_key_index:  HashMap<String, u16>,
    pub token_index:      HashMap<String, Vec<TokenRole>>,
    pub last_price_cache: HashMap<String, LastPrice>,
    pub config:           EngineConfig,
}
```

| Biến | Kiểu | Tác dụng |
|------|------|----------|
| `price_table` | `PriceTable` | **Nguồn dữ liệu giá duy nhất** cho toàn bộ engine. Tất cả evaluators đọc giá từ đây — không lưu trữ giá riêng. |
| `groups` | `Vec<GroupState>` | Danh sách tất cả nhóm thị trường (VD: group ETH ngày 26/01). Mỗi group chứa children, parents, trios. |
| `group_key_index` | `HashMap<String, u16>` | Mapping nhanh từ `group_key` (VD: `"eth-2026-01-26T17:00:00.000Z"`) sang vị trí trong `groups[]`. Tác dụng: tìm group O(1) khi nhận signal từ N-API. |
| `token_index` | `HashMap<String, Vec<TokenRole>>` | **Bảng dispatch chính**. Khi nhận TopOfBook cho 1 token, engine dùng bảng này để biết token đó cần trigger evaluator nào (xem [TokenRole](#9-tokenrole--vai-trò-dispatch-của-token)). Lưu ý: 1 token có thể có **nhiều roles** (VD: vừa là Parent vừa là TrioLeg). |
| `last_price_cache` | `HashMap<String, LastPrice>` | Cache giá cuối cùng cho **dirty checking**. Nếu bid/ask không đổi, engine bỏ qua update → giảm CPU. |
| `config` | `EngineConfig` | Cấu hình profit thresholds và cooldown. |

**Nơi sử dụng:**
- `engine.rs` → `handle_top_of_book()`: entry point nhận price update, dùng `token_index` để dispatch, `price_table` để đọc/ghi giá.
- `napi_exports.rs` → `update_market_structure()`: rebuild toàn bộ state.

---

## 2. EngineConfig — Cấu hình engine

```rust
pub struct EngineConfig {
    pub min_profit_bps: f64,
    pub min_profit_abs: f64,
    pub cooldown_ms:    i64,
}
```

| Biến | Mặc định | Tác dụng |
|------|----------|----------|
| `min_profit_bps` | `30.0` | **Ngưỡng lợi nhuận tối thiểu tính bằng basis points** (1 bps = 0.01%). Nếu profit < giá trị này, signal bị bỏ qua. VD: 30 bps = 0.30%. |
| `min_profit_abs` | `0.005` | **Ngưỡng lợi nhuận tuyệt đối tối thiểu** (tính bằng USD). Phải thỏa **đồng thời** cả `min_profit_bps` VÀ `min_profit_abs`. |
| `cooldown_ms` | `3000` | **Thời gian chờ tối thiểu** (ms) giữa 2 signal cùng loại trên cùng 1 trio. Tránh spam signal. |

**Nơi sử dụng:**
- `trio_evaluator.rs` → `calc_trio_profit_only()`: so sánh profit với `min_profit_bps` và `min_profit_abs`.
- `range_evaluator.rs` → `evaluate_unbundling()` / `evaluate_bundling()`: tương tự.
- Cả 2 evaluator: kiểm tra `cooldown_ms` trước khi emit signal.

**Ví dụ kiểm tra trong `trio_evaluator.rs`:**
```rust
let meets_buy = profit_buy >= cfg.min_profit_abs 
             && profit_bps_buy >= cfg.min_profit_bps;
```

---

## 3. PriceTable — Bảng giá trung tâm

```rust
pub struct PriceTable {
    pub slots:         Vec<PriceSlot>,
    pub token_to_slot: HashMap<String, u32>,
}
```

| Biến | Tác dụng |
|------|----------|
| `slots` | **Mảng phẳng** chứa tất cả PriceSlot. Mỗi token (YES hoặc NO) có đúng 1 slot. Thiết kế flat array cho cache-friendly access. Allocate 1 lần khi `update_market_structure()`, sau đó chỉ update in-place. |
| `token_to_slot` | Mapping `token_id → slot_index`. Khi nhận TopOfBook, engine dùng mapping này để tìm slot cần update. |

**Nguyên tắc thiết kế:**
- Mỗi token chỉ có **1 slot duy nhất** → Zero duplication.
- TrioState và Range evaluator **không lưu giá** — chỉ lưu `slot_index` và đọc trực tiếp từ PriceTable.
- `alloc_slot()` gọi khi build market structure, trả về slot index có sẵn hoặc tạo mới.

**Ví dụ allocation (từ `engine.rs`):**
```rust
let yes_slot = pt.alloc_slot(&clob_token_ids[0]); // YES token → slot 0
let no_slot  = pt.alloc_slot(&clob_token_ids[1]); // NO token  → slot 1
```

---

## 4. PriceSlot — Snapshot giá 1 token

```rust
#[repr(C)]
pub struct PriceSlot {
    pub best_bid:      f64,
    pub best_ask:      f64,
    pub best_bid_size: f64,
    pub best_ask_size: f64,
    pub timestamp_ms:  i64,
}
```

| Biến | Tác dụng |
|------|----------|
| `best_bid` | Giá mua tốt nhất (highest bid). Giá trị **`NaN`** nghĩa là chưa có dữ liệu — evaluator sẽ skip. |
| `best_ask` | Giá bán tốt nhất (lowest ask). Tương tự, `NaN` = chưa có data. |
| `best_bid_size` | **Khối lượng** có sẵn ở mức bid (dùng để tính fill size cho order). |
| `best_ask_size` | Khối lượng có sẵn ở mức ask. |
| `timestamp_ms` | Thời điểm update cuối cùng (Unix ms). Default = 0 = chưa update. |

**`#[repr(C)]`**: Layout bộ nhớ C-compatible, kích thước 40 bytes — vừa 1 CPU cache line → tối ưu cho random access.

**Default values:**
```rust
PriceSlot {
    best_bid: f64::NAN,  // NaN = "no data"
    best_ask: f64::NAN,
    best_bid_size: 0.0,
    best_ask_size: 0.0,
    timestamp_ms: 0,
}
```

**Nơi sử dụng:**
- `trio_evaluator.rs`: Đọc 3 slots → `ly.best_ask + un.best_ask + rn.best_ask` = totalAsk.
- `range_evaluator.rs`: Đọc 3 YES slots → tính profit unbundling/bundling.
- `engine.rs` → `handle_top_of_book()`: Ghi giá mới vào slot.

---

## 5. MarketMeta — Metadata của 1 market

```rust
pub struct MarketMeta {
    pub market_id:      String,
    pub slug:           String,
    pub clob_token_ids: [String; 2],    // [YES, NO]
    pub bounds_lower:   Option<f64>,
    pub bounds_upper:   Option<f64>,
    pub kind:           MarketKind,
    pub neg_risk:       bool,
    pub yes_slot:       u32,
    pub no_slot:        u32,
}
```

| Biến | Tác dụng |
|------|----------|
| `market_id` | ID duy nhất của market trên Polymarket (VD: `"0x1234..."`). |
| `slug` | Tên slug human-readable (VD: `"will-the-price-of-ethereum-be-between-2800-2900-on-january-26"`). Dùng trong signal output và logging. |
| `clob_token_ids` | **Cặp token ID** — `[0]` = YES token, `[1]` = NO token. Đây là ID thực trên CLOB (Central Limit Order Book) của Polymarket. |
| `bounds_lower` | Biên dưới của market. VD: Range(2800-2900) → `bounds_lower = 2800`. Parent ≥3000 → `bounds_lower = 3000`. Market "below" → `None`. |
| `bounds_upper` | Biên trên. Range(2800-2900) → `bounds_upper = 2900`. Parent "above" → `None` (vô cực). |
| `kind` | Loại market: `Range` (VD: 2800-2900), `Above` (VD: ≥2800), `Below` (VD: <2800). |
| `neg_risk` | **Negative risk flag**. `true` cho range children (negRisk market), `false` cho parents (standard market). Ảnh hưởng đến cách Polymarket tính CLOB order. |
| **`yes_slot`** | **Chỉ số PriceTable slot cho YES token** (`clob_token_ids[0]`). Đây là cầu nối giữa MarketMeta và PriceTable — thay vì lookup bằng string, engine đọc giá bằng `pt.get(yes_slot)` = O(1) array access. |
| **`no_slot`** | **Chỉ số PriceTable slot cho NO token** (`clob_token_ids[1]`). Tương tự `yes_slot`. |

### `yes_slot` / `no_slot` — Chi tiết hoạt động

Đây là **2 biến quan trọng nhất** cho hiệu suất:

**Allocation (1 lần khi build market structure):**
```rust
// engine.rs → update_market_structure()
let yes_slot = self.price_table.alloc_slot(&desc.clob_token_ids[0]);
let no_slot  = self.price_table.alloc_slot(&desc.clob_token_ids[1]);
let meta = MarketMeta { yes_slot, no_slot, ... };
```

**Usage trong TrioState (triangle arb — dùng NO token):**
```rust
// trio_evaluator.rs → calc_trio_profit_only()
let ly = pt.get(trio.lower_yes_slot);  // → parent_lower.yes_slot
let un = pt.get(trio.upper_no_slot);   // → parent_upper.no_slot
let rn = pt.get(trio.range_no_slot);   // → range_child.no_slot
let total_ask = ly.best_ask + un.best_ask + rn.best_ask;
```

**Usage trong Range evaluator (unbundling/bundling — dùng YES token):**
```rust
// range_evaluator.rs → evaluate_unbundling()
let parent_lower = pt.get(group.parent_metas[idx].yes_slot);
let parent_upper = pt.get(group.parent_metas[idx].yes_slot);
let range_child  = pt.get(group.child_metas[idx].yes_slot);
let profit = parent_lower.best_bid - (range_child.best_ask + parent_upper.best_ask);
```

> **Tại sao Trio dùng NO mà Range dùng YES?**
> - **Triangle BUY**: Mua 3 tokens YES+NO+NO, tổng chi phí < $2 payout → lợi nhuận.
> - **Unbundling**: Bán Parent YES, mua Range YES + ParentUpper YES → phân tách.
> - **Bundling**: Mua Parent YES, bán Range YES + ParentUpper YES → kết hợp.

---

## 6. GroupState — Trạng thái 1 nhóm thị trường

```rust
pub struct GroupState {
    pub group_key:          String,
    pub event_slug:         String,
    pub crypto:             String,
    pub child_metas:        Vec<MarketMeta>,
    pub parent_metas:       Vec<MarketMeta>,
    pub parent_coverages:   Vec<Option<RangeCoverage>>,
    pub trio_states:        Vec<TrioState>,
    pub trio_lookup_by_asset: HashMap<String, Vec<u16>>,
}
```

| Biến | Tác dụng |
|------|----------|
| `group_key` | Key duy nhất (VD: `"eth-2026-01-26T17:00:00.000Z"`). Gồm crypto + expiry time. |
| `event_slug` | Slug event trên Polymarket (VD: `"eth-price-jan-26"`). |
| `crypto` | Loại crypto (VD: `"eth"`, `"btc"`). |
| `child_metas` | **Danh sách range children** — sorted theo bounds ascending. VD: `[<2800, 2800-2900, 2900-3000, ..., ≥3700]`. Bao gồm cả `below` và `above` ở 2 đầu. Index trong mảng này được dùng bởi `TrioState.range_idx`. |
| `parent_metas` | **Danh sách parent markets** — sorted theo bounds ascending. VD: `[≥2800, ≥2900, ≥3000, ..., ≥3700]`. Index dùng bởi `TrioState.parent_lower_idx` / `parent_upper_idx`. |
| `parent_coverages` | Mapping `parent[i]` → range child nào parent đó bao phủ. Trong trio model, mỗi parent chỉ cover **1 child liền kề** (VD: Parent ≥2800 → Range 2800-2900). Xem [RangeCoverage](#8-rangecoverage--phạm-vi-bao-phủ-children). |
| `trio_states` | **Danh sách tất cả trio** trong group. Mỗi trio = 1 bộ ba arbitrage (parentLower + parentUpper + rangeChild). |
| `trio_lookup_by_asset` | **Reverse lookup** — từ `token_id` → danh sách `trio_index` bị ảnh hưởng. Dùng cho range arbitrage: khi 1 token thay đổi giá, lookup nhanh O(1) để biết cần evaluate trio nào. Mỗi trio đóng góp **5 tokens** vào lookup (YES+NO cho mỗi parent + YES cho range). |

**Ví dụ dữ liệu thực (ETH group):**
```
child_metas:  11 entries  [<2800, 2800-2900, ..., ≥3700]
parent_metas: 10 entries  [≥2800, ≥2900, ..., ≥3700]
trio_states:   9 entries  [trio0: ≥2800↔≥2900↔range(2800-2900), ...]
trio_lookup:  37 entries  (mỗi token → indices)
```

---

## 7. TrioState — Trạng thái 1 bộ ba arbitrage

```rust
pub struct TrioState {
    // Indices into GroupState.parent_metas / child_metas
    pub parent_lower_idx: u16,
    pub parent_upper_idx: u16,
    pub range_idx:        u16,

    // PriceTable slot IDs — direct lookup
    pub lower_yes_slot: u32,
    pub upper_no_slot:  u32,
    pub range_no_slot:  u32,

    // Token IDs for signal output
    pub lower_yes_token: String,
    pub upper_no_token:  String,
    pub range_no_token:  String,

    // Cooldown timestamps
    pub last_emitted_buy_ms:      i64,
    pub last_emitted_unbundle_ms: i64,
    pub last_emitted_bundle_ms:   i64,
}
```

### Index Group

| Biến | Tác dụng |
|------|----------|
| `parent_lower_idx` | Index vào `group.parent_metas[]` cho parent phía dưới. VD: `0` → `parent_metas[0]` = "≥2800". |
| `parent_upper_idx` | Index vào `group.parent_metas[]` cho parent phía trên. Luôn = `parent_lower_idx + 1`. VD: `1` → "≥2900". |
| `range_idx` | Index vào `group.child_metas[]` cho range child kết nối. VD: `1` → "2800-2900". |

### Slot Group — **Hot path variables**

| Biến | Tác dụng | Evaluator |
|------|----------|-----------|
| `lower_yes_slot` | PriceTable slot cho **parent lower YES** token. Pre-computed từ `parent_metas[lower].yes_slot` khi build trio. | **Trio**: đọc `pt.get(trio.lower_yes_slot).best_ask` cho triangle BUY cost. |
| `upper_no_slot` | PriceTable slot cho **parent upper NO** token. Pre-computed từ `parent_metas[upper].no_slot`. | **Trio**: đọc `pt.get(trio.upper_no_slot).best_ask`. |
| `range_no_slot` | PriceTable slot cho **range child NO** token. Pre-computed từ `child_metas[range].no_slot`. | **Trio**: đọc `pt.get(trio.range_no_slot).best_ask`. |

> **Tại sao pre-compute slots?**
> Vì trong hot path (mỗi TopOfBook update), engine chỉ cần 3 array lookups (`slots[idx]`) thay vì 3 HashMap lookups (`token_to_slot.get(token_id)`) — nhanh hơn ~10x.

### Token Group — Signal metadata

| Biến | Tác dụng |
|------|----------|
| `lower_yes_token` | Token ID của parent lower YES. Dùng để: 1) tạo `emit_key` cho cooldown, 2) gắn vào ArbSignal output. |
| `upper_no_token` | Token ID của parent upper NO. Tương tự. |
| `range_no_token` | Token ID của range child NO. Tương tự. |

### Cooldown Group

| Biến | Tác dụng |
|------|----------|
| `last_emitted_buy_ms` | Timestamp (Unix ms) lần cuối emit signal **TRIANGLE_BUY** cho trio này. Nếu `now - last_emitted_buy_ms < cooldown_ms` → skip. |
| `last_emitted_unbundle_ms` | Tương tự cho signal **SELL_PARENT_BUY_CHILDREN** (unbundling). |
| `last_emitted_bundle_ms` | Tương tự cho signal **BUY_PARENT_SELL_CHILDREN** (bundling). |

> **Tại sao inline cooldown thay vì HashMap?**
> Mỗi trio chỉ có 3 loại signal → lưu 3 timestamps inline trực tiếp (24 bytes) nhanh hơn nhiều so với `HashMap<String, i64>` (mỗi entry ~80+ bytes + hashing overhead).

### Ví dụ trio thực tế

```
Trio[0]:
  parentLower[0] = "≥2800" (yes_slot=22, no_slot=23)
  parentUpper[1] = "≥2900" (yes_slot=24, no_slot=25)
  rangeChild[1]  = "2800-2900" (yes_slot=2, no_slot=3)

  lower_yes_slot = 22  (→ pt.slots[22] = YES price of ≥2800)
  upper_no_slot  = 25  (→ pt.slots[25] = NO price of ≥2900)
  range_no_slot  = 3   (→ pt.slots[3]  = NO price of 2800-2900)

  Triangle BUY formula:
    totalAsk = slots[22].best_ask + slots[25].best_ask + slots[3].best_ask
    profit = $2.00 - totalAsk
```

---

## 8. RangeCoverage — Phạm vi bao phủ children

```rust
pub struct RangeCoverage {
    pub start_index: i32,
    pub end_index:   i32,
}
```

| Biến | Tác dụng |
|------|----------|
| `start_index` | Index bắt đầu trong `child_metas[]` mà parent này bao phủ. |
| `end_index` | Index kết thúc. **Trong trio model: `start_index == end_index`** (mỗi parent chỉ cover 1 child liền kề). |

**Trong trio model:**
```
Parent[0] ≥2800 → coverage = {start: 1, end: 1}  // → child[1] = Range 2800-2900
Parent[1] ≥2900 → coverage = {start: 2, end: 2}  // → child[2] = Range 2900-3000
Parent[9] ≥3700 → coverage = None                 // → parent cuối, không có trio
```

**Nơi sử dụng:**
- `trio_evaluator.rs` L94-99: Gắn `coverage.start_index` / `coverage.end_index` vào ArbSignal → downstream service (execution) dùng để lưu DB field `rangeI` / `rangeJ`.
- `range_evaluator.rs` L95-100, L177-182: Tương tự.
- `real-execution.service.ts` L1537-1538: `rangeI: coverage.startIndex`, `rangeJ: coverage.endIndex`.

---

## 9. TokenRole — Vai trò dispatch của token

```rust
pub enum TrioLegRole {
    ParentLowerYes,
    ParentUpperNo,
    RangeNo,
}

pub enum TokenRole {
    TrioLeg {
        group_idx: u16,
        trio_idx:  u16,
        role:      TrioLegRole,
    },
    RangeChild {
        group_idx: u16,
        child_idx: u16,
    },
    Parent {
        group_idx: u16,
        parent_idx: u16,
    },
}
```

### TrioLegRole

| Value | Token | Evaluator | Tác dụng |
|-------|-------|-----------|----------|
| `ParentLowerYes` | Parent lower YES | Trio | Trigger `evaluate_single_trio()` trực tiếp. |
| `ParentUpperNo` | Parent upper NO | Trio | Trigger `evaluate_single_trio()` trực tiếp. |
| `RangeNo` | Range child NO | Trio | Trigger `evaluate_single_trio()` trực tiếp. |

### TokenRole

| Variant | Khi nào trigger | Evaluator |
|---------|----------------|-----------|
| `TrioLeg { group_idx, trio_idx, role }` | Token là 1 trong 3 chân triangle (YES/NO/NO). | **Trio evaluator** — evaluate chính xác 1 trio. |
| `RangeChild { group_idx, child_idx }` | Token là YES token của 1 range child. | **Range evaluator** — lookup `trio_lookup_by_asset` để tìm trios bị ảnh hưởng, evaluate unbundling + bundling. |
| `Parent { group_idx, parent_idx }` | Token là YES token của 1 parent market. | **Range evaluator** — tương tự RangeChild. |

**Ví dụ dispatch trong `handle_top_of_book()`:**
```rust
// 1 token có thể có NHIỀU roles!
// VD: token "106170...929517" của parent ≥3100:
//   - Parent(g0, p3)           → triggers range evaluator
//   - TrioLeg(g0, t3, ParentLowerYes) → triggers trio evaluator on trio[3]

for role in &roles {
    match role {
        TokenRole::TrioLeg { group_idx, trio_idx, .. } => {
            // Evaluate 1 trio cụ thể
            trio_evaluator::evaluate_single_trio(group, trio_idx, price_table, config);
        }
        TokenRole::RangeChild { group_idx, .. } | TokenRole::Parent { group_idx, .. } => {
            // Tìm tất cả trios bị ảnh hưởng
            let trio_indices = group.trio_lookup_by_asset.get(asset_id);
            range_evaluator::evaluate_trios_for_range_arbitrage(group, trio_indices, ...);
        }
    }
}
```

---

## 10. LastPrice — Cache dirty checking

```rust
pub struct LastPrice {
    pub bid:          f64,
    pub ask:          f64,
    pub timestamp_ms: i64,
}
```

| Biến | Tác dụng |
|------|----------|
| `bid` | Giá bid cuối cùng đã xử lý. |
| `ask` | Giá ask cuối cùng đã xử lý. |
| `timestamp_ms` | Timestamp lần xử lý cuối. |

**Dirty checking logic** (`EngineState.is_price_changed()`):
```
1. Nếu timestamp mới ≤ timestamp cũ → skip (data cũ hơn)
2. Nếu bid === cached.bid && ask === cached.ask → skip (giá không đổi)
3. Ngược lại → update cache, return true (cần xử lý)
```

**Tác dụng**: Tránh evaluate toàn bộ trios khi nhận duplicate price updates — giảm CPU đáng kể trong production khi websocket gửi liên tục.

---

## 11. Data Flow — Luồng dữ liệu tổng thể

```
                 ┌──────────────────────────────────────────────────┐
                 │            update_market_structure()              │
                 │                                                  │
                 │  RangeGroupInput[] ──┬── PriceTable.alloc_slot() │
                 │                     ├── build MarketMeta[]       │
                 │                     ├── initialize_trio_states() │
                 │                     ├── compute_coverages()      │
                 │                     └── build token_index        │
                 └──────────────────────────────────────────────────┘
                                        ↓
                   ┌────────────────────────────────────────────────┐
                   │           handle_top_of_book()                 │
                   │                                                │
     TopOfBook ──→ │ 1. is_price_changed()  (last_price_cache)     │
       update      │ 2. price_table.update(slot, bid, ask, ...)    │
                   │ 3. token_index.get(asset_id)  → Vec<TokenRole>│
                   │                                                │
                   │    ┌─── TrioLeg ──────────────────────────┐   │
                   │    │  trio_evaluator::evaluate_single_trio │   │
                   │    │  reads: lower_yes_slot, upper_no_slot,│   │
                   │    │         range_no_slot from PriceTable │   │
                   │    │  emits: POLYMARKET_TRIANGLE_BUY       │   │
                   │    └──────────────────────────────────────┘   │
                   │                                                │
                   │    ┌─── RangeChild / Parent ──────────────┐   │
                   │    │  trio_lookup_by_asset.get(token_id)   │   │
                   │    │  range_evaluator::evaluate_trios...   │   │
                   │    │  reads: yes_slot from PriceTable      │   │
                   │    │  emits: SELL_PARENT_BUY_CHILDREN      │   │
                   │    │         BUY_PARENT_SELL_CHILDREN      │   │
                   │    └──────────────────────────────────────┘   │
                   └────────────────────────────────────────────────┘
                                        ↓
                              Vec<ArbSignal> → N-API callback → TypeScript
```

### Slot Usage Summary

| Evaluator | Parent Lower | Parent Upper | Range Child | Formula |
|-----------|-------------|-------------|-------------|---------|
| **Trio** (Triangle BUY) | `yes_slot` | `no_slot` | `no_slot` | `$2 - (askLY + askUN + askRN)` |
| **Range** (Unbundling) | `yes_slot` | `yes_slot` | `yes_slot` | `bidPL - (askRC + askPU)` |
| **Range** (Bundling) | `yes_slot` | `yes_slot` | `yes_slot` | `(bidRC + bidPU) - askPL` |

---

## Appendix: MarketKind

```rust
pub enum MarketKind {
    Range,  // VD: "will-the-price-of-ethereum-be-between-2800-2900"
    Above,  // VD: "ethereum-above-2800"
    Below,  // VD: "will-the-price-of-ethereum-be-less-than-2800"
}
```

| Kind | bounds_lower | bounds_upper | Vai trò |
|------|-------------|-------------|---------|
| `Range` | Có (VD: 2800) | Có (VD: 2900) | Range child — tham gia trio như `range_no_slot` |
| `Above` | Có (VD: 2800) | `None` | Parent market — tham gia trio như `lower_yes_slot` hoặc `upper_no_slot` |
| `Below` | `None` | Có (VD: 2800) | Range child đặc biệt — vị trí đầu tiên trong `child_metas[]`, thường không tạo trio |
