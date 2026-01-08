# ArbitrageEngine Test Suite

Bộ test chi tiết cho `ArbitrageEngineService`, tập trung vào phương thức `handleTopOfBook` và các tính năng arbitrage.

## 📁 Cấu trúc Test Files

### 1. `arbitrage-engine.handle-top-of-book.test.ts`
File test chính cho phương thức `handleTopOfBook`:

- **Range Market Arbitrage - Unbundling**: Test chiến lược SELL_PARENT_BUY_CHILDREN
- **Range Market Arbitrage - Bundling**: Test chiến lược BUY_PARENT_SELL_CHILDREN  
- **Market Indexing and Lookup**: Test việc index và lookup markets theo token ID, slug, market ID
- **Prefix Sum Recalculation**: Test việc tính toán prefix sums sau khi update
- **Cooldown and Throttling**: Test cơ chế cooldown giữa các opportunity emissions
- **Profit Thresholds**: Test ngưỡng profit tối thiểu (BPS và absolute)
- **Multiple Groups**: Test xử lý nhiều groups độc lập
- **Edge Cases**: Test các trường hợp đặc biệt (missing values, NaN, Infinity)

### 2. `arbitrage-engine.simulation.test.ts`
File test nâng cao với các simulation thực tế:

- **Scenario 1: BTC Rally**: Simulate giá BTC tăng mạnh
- **Scenario 2: Market Inefficiency**: Simulate mispriced ranges 
- **Scenario 3: Two-way Arbitrage**: Test cả bundling và unbundling cùng lúc
- **Scenario 4: Rapid Price Updates**: Stress test với 100 updates liên tục
- **Scenario 5: Partial Range Coverage**: Test arbitrage với subset của ranges
- **Scenario 6: Market Depth Changes**: Test thay đổi bid/ask sizes
- **Scenario 7: Real-world Pricing**: Test với phân phối xác suất thực tế từ Polymarket
- **Performance Metrics**: Đo performance với 1000 updates

### 3. `arbitrage-engine.bootstrap.test.ts`
Test bootstrap và initialization (đã có sẵn)

## 🚀 Cách chạy Tests

### Bước 1: Cài đặt Dependencies

Nếu chưa có Jest và Jest types:

```bash
npm install --save-dev jest @types/jest ts-jest
```

### Bước 2: Cấu hình Jest

Tạo file `jest.config.js` ở root directory:

```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.interface.ts',
    '!src/**/*.entity.ts',
  ],
  coverageDirectory: 'coverage',
  testTimeout: 30000,
  globals: {
    'ts-jest': {
      tsconfig: {
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
      },
    },
  },
};
```

### Bước 3: Thêm scripts vào package.json

```json
{
  "scripts": {
    "test": "jest",
    "test:watch": "jest --watch",
    "test:cov": "jest --coverage",
    "test:handle-top-of-book": "jest arbitrage-engine.handle-top-of-book.test.ts",
    "test:simulation": "jest arbitrage-engine.simulation.test.ts"
  }
}
```

### Bước 4: Chạy Tests

```bash
# Chạy tất cả tests
npm test

# Chạy test handleTopOfBook
npm run test:handle-top-of-book

# Chạy simulation tests
npm run test:simulation

# Chạy với watch mode (tự động chạy lại khi file thay đổi)
npm run test:watch

# Chạy với coverage report
npm run test:cov

# Chạy test cụ thể
npx jest -t "should detect unbundling arbitrage"
```

## 🔧 Cấu hình Environment Variables

Các test có thể được cấu hình bằng environment variables:

```bash
# Ngưỡng profit tối thiểu (basis points)
export ARB_MIN_PROFIT_BPS=5

# Ngưỡng profit tối thiểu (absolute value)
export ARB_MIN_PROFIT_ABS=0

# Throttle time giữa các scans (ms)
export ARB_SCAN_THROTTLE_MS=200

# Cooldown time giữa các opportunity emissions (ms)
export ARB_COOLDOWN_MS=1000
```

Hoặc tạo file `.env.test`:

```env
ARB_MIN_PROFIT_BPS=5
ARB_MIN_PROFIT_ABS=0
ARB_SCAN_THROTTLE_MS=50
ARB_COOLDOWN_MS=200
```

## 📊 Test Coverage

Để xem test coverage:

```bash
npm run test:cov
```

Report sẽ được tạo trong thư mục `coverage/`:
- `coverage/index.html`: HTML report (mở bằng browser)
- `coverage/lcov-report/`: Detailed line-by-line coverage

## 🐛 Debugging Tests

### Debug trong VS Code

Tạo file `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Jest Debug",
      "program": "${workspaceFolder}/node_modules/.bin/jest",
      "args": [
        "--runInBand",
        "--no-cache",
        "${file}"
      ],
      "console": "integratedTerminal",
      "internalConsoleOptions": "neverOpen",
      "disableOptimisticBPs": true,
      "windows": {
        "program": "${workspaceFolder}/node_modules/jest/bin/jest"
      }
    }
  ]
}
```

Sau đó:
1. Mở file test
2. Đặt breakpoint
3. Press F5 hoặc click "Run and Debug"

### Debug bằng Node Inspector

```bash
node --inspect-brk node_modules/.bin/jest --runInBand test/arbitrage-engine.handle-top-of-book.test.ts
```

Sau đó mở Chrome tại `chrome://inspect`

### Verbose Output

```bash
# Hiển thị console.log trong tests
npx jest --verbose --silent=false

# Chạy từng test một
npx jest --runInBand

# Không dùng cache
npx jest --no-cache
```

## 📝 Viết Tests mới

### Template cơ bản

```typescript
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { ArbitrageEngineService } from '../src/modules/strategy/arbitrage-engine.service';
// ... other imports

describe('My Test Suite', () => {
  let service: ArbitrageEngineService;
  let topOfBookSubject: Subject<TopOfBookUpdate>;
  
  beforeEach(async () => {
    // Setup
    topOfBookSubject = new Subject<TopOfBookUpdate>();
    // ... mock services
    
    service = new ArbitrageEngineService(
      marketStructureService,
      marketDataStreamService,
    );
    
    await service.onModuleInit();
  });
  
  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
  });
  
  it('should do something', async () => {
    // Arrange
    const update: TopOfBookUpdate = { /* ... */ };
    
    // Act
    topOfBookSubject.next(update);
    await new Promise((resolve) => setTimeout(resolve, 100));
    
    // Assert
    expect(/* ... */).toBe(/* ... */);
  });
});
```

### Best Practices

1. **Sử dụng meaningful test names**: Mô tả rõ ràng test case đang test cái gì
2. **Arrange-Act-Assert pattern**: Tách biệt setup, execution, và verification
3. **Mock external dependencies**: Mock DB, Redis, external APIs
4. **Test edge cases**: Null, undefined, NaN, Infinity, empty arrays, etc.
5. **Use async/await**: Đợi async operations hoàn thành trước khi assert
6. **Clean up**: Luôn cleanup trong afterEach
7. **Isolate tests**: Mỗi test độc lập, không phụ thuộc vào thứ tự

## 🔍 Hiểu Output của Tests

### Success Output

```
PASS  test/arbitrage-engine.handle-top-of-book.test.ts
  ArbitrageEngineService - handleTopOfBook
    Range Market Arbitrage - Unbundling (SELL_PARENT_BUY_CHILDREN)
      ✓ should detect unbundling arbitrage opportunity (305 ms)
    Range Market Arbitrage - Bundling (BUY_PARENT_SELL_CHILDREN)
      ✓ should detect bundling arbitrage opportunity (308 ms)
```

### Failure Output

```
FAIL  test/arbitrage-engine.handle-top-of-book.test.ts
  ● Range Market Arbitrage - Unbundling › should detect unbundling arbitrage

    expect(received).toBeGreaterThan(expected)

    Expected: > 0
    Received:   0

      268 |       await new Promise((resolve) => setTimeout(resolve, 300));
      269 |
    > 270 |       expect(opportunities.length).toBeGreaterThan(0);
          |                                    ^
```

## 📖 Tài liệu tham khảo

- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [NestJS Testing](https://docs.nestjs.com/fundamentals/testing)
- [RxJS Testing](https://rxjs.dev/guide/testing/marble-testing)

## 💡 Tips

1. **Chạy test cụ thể**: Dùng `.only` hoặc `.skip`
   ```typescript
   it.only('should run only this test', () => {});
   it.skip('should skip this test', () => {});
   ```

2. **Test async code**: Luôn dùng async/await hoặc return Promise
   ```typescript
   it('should handle async', async () => {
     await service.onModuleInit();
     // ...
   });
   ```

3. **Mock console để clean output**:
   ```typescript
   jest.spyOn(console, 'log').mockImplementation();
   ```

4. **Test timing-dependent code**: Tăng timeout nếu cần
   ```typescript
   it('slow test', async () => {
     // ...
   }, 10000); // 10 second timeout
   ```

5. **Sử dụng test.each cho parameterized tests**:
   ```typescript
   test.each([
     [0.75, 0.65, 0.10],
     [0.80, 0.70, 0.10],
   ])('profit calculation: %f - %f = %f', (bid, ask, expected) => {
     expect(bid - ask).toBe(expected);
   });
   ```

## 🤝 Contributing

Khi thêm test mới:
1. Đảm bảo test pass: `npm test`
2. Check coverage: `npm run test:cov`
3. Format code: `npm run format`
4. Lint code: `npm run lint`

## 📄 License

MIT

