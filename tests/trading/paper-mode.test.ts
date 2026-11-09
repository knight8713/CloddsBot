import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { paperTradeGuard } from '../../src/skills/bundled/trading-polymarket/index';
import { createPaperExecutionService } from '../../src/trading/paper-execution';
import { blockInPaperMode } from '../../src/agents/handlers/trading-guard';
import * as binanceHandlers from '../../src/agents/handlers/binance';
import * as bybitHandlers from '../../src/agents/handlers/bybit';
import * as hyperliquidHandlers from '../../src/agents/handlers/hyperliquid';
import * as solanaHandlers from '../../src/agents/handlers/solana';
import * as manifoldHandlers from '../../src/agents/handlers/manifold';
import * as kalshiHandlers from '../../src/agents/handlers/kalshi';
import * as predictfunHandlers from '../../src/agents/handlers/predictfun';
import * as opinionHandlers from '../../src/agents/handlers/opinion';

const USER = 'paper-user';
const OTHER_USER = 'other-user';

interface TestDb {
  raw: DatabaseSync;
  db: {
    run: (sql: string, params?: unknown[]) => unknown;
    query: <T>(sql: string, params?: unknown[]) => T[];
  };
}

function createTestDb(options: { enabled: boolean; balance?: number }): TestDb {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`
    CREATE TABLE paper_trading_settings (
      user_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      balance REAL NOT NULL DEFAULT 10000,
      starting_balance REAL NOT NULL DEFAULT 10000,
      created_at TEXT NOT NULL
    );
    CREATE TABLE paper_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      market_name TEXT,
      side TEXT NOT NULL,
      size REAL NOT NULL,
      entry_price REAL NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      market_name TEXT,
      side TEXT NOT NULL,
      size REAL NOT NULL,
      price REAL NOT NULL,
      pnl REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
  raw
    .prepare(
      'INSERT INTO paper_trading_settings (user_id, enabled, balance, starting_balance, created_at) VALUES (?, ?, ?, 10000, datetime(\'now\'))'
    )
    .run(USER, options.enabled ? 1 : 0, options.balance ?? 1000);

  return {
    raw,
    db: {
      run: (sql, params = []) => raw.prepare(sql).run(...(params as never[])),
      query: <T>(sql: string, params: unknown[] = []) =>
        raw.prepare(sql).all(...(params as never[])) as T[],
    },
  };
}

function contextFor(testDb: TestDb, userId: string = USER): any {
  return { db: testDb.db, userId };
}

function handlersFrom(mod: Record<string, unknown>, tool: string): any {
  for (const value of Object.values(mod)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && tool in (value as object)) {
      return value as any;
    }
  }
  throw new Error(`No handler map exports ${tool}`);
}

function allRows(testDb: TestDb, table: 'paper_positions' | 'paper_trades'): any[] {
  return testDb.raw.prepare(`SELECT * FROM ${table}`).all() as any[];
}

// =============================================================================
// /poly orders
// =============================================================================

describe('paper mode routing: /poly orders', () => {
  it('leaves real trading untouched when paper trading is off', async () => {
    const { db } = createTestDb({ enabled: false });
    assert.equal(await paperTradeGuard('buy', 'token-1', '10', '0.40', { db, userId: USER }), null);
  });

  it('leaves real trading untouched for a user with no paper account', async () => {
    const { db } = createTestDb({ enabled: true });
    assert.equal(await paperTradeGuard('buy', 'token-1', '10', '0.40', { db, userId: OTHER_USER }), null);
  });

  it('leaves real trading untouched when there is no user identity', async () => {
    const { db } = createTestDb({ enabled: true });
    assert.equal(await paperTradeGuard('buy', 'token-1', '10', '0.40', { db }), null);
  });

  it('books a simulated buy and says no order was sent', async () => {
    const testDb = createTestDb({ enabled: true });
    const reply = await paperTradeGuard('buy', 'token-1', '10', '0.40', {
      db: testDb.db,
      userId: USER,
    });

    assert.match(reply ?? '', /PAPER TRADE/);
    assert.match(reply ?? '', /no order was sent/);
    assert.match(reply ?? '', /BUY 10 shares YES @ 40¢/);
    assert.match(reply ?? '', /Balance: \$996\.00/);

    const [position] = allRows(testDb, 'paper_positions');
    assert.equal(position.size, 10);
    assert.equal(position.entry_price, 0.4);
    assert.equal(allRows(testDb, 'paper_trades')[0].side, 'BUY');
  });

  it('books a simulated sell with realized P&L and remaining size', async () => {
    const testDb = createTestDb({ enabled: true });
    await paperTradeGuard('buy', 'token-1', '10', '0.40', { db: testDb.db, userId: USER });

    const reply = await paperTradeGuard('sell', 'token-1', '4', '0.60', {
      db: testDb.db,
      userId: USER,
    });

    assert.match(reply ?? '', /SELL 4 shares YES @ 60¢/);
    assert.match(reply ?? '', /Realized P&L: \+\$0\.80/);
    assert.match(reply ?? '', /Remaining: 6 shares/);
    assert.equal(allRows(testDb, 'paper_positions')[0].size, 6);
  });

  it('refuses a price-less order instead of sending a market order', async () => {
    const testDb = createTestDb({ enabled: true });
    const reply = await paperTradeGuard('buy', 'token-1', '10', undefined, {
      db: testDb.db,
      userId: USER,
    });

    assert.match(reply ?? '', /would be simulated/);
    assert.match(reply ?? '', /Include a limit price/);
    assert.equal(allRows(testDb, 'paper_trades').length, 0);
  });

  it('rejects an oversell without touching the exchange', async () => {
    const testDb = createTestDb({ enabled: true });
    await paperTradeGuard('buy', 'token-1', '10', '0.40', { db: testDb.db, userId: USER });

    const reply = await paperTradeGuard('sell', 'token-1', '999', '0.60', {
      db: testDb.db,
      userId: USER,
    });

    assert.match(reply ?? '', /Paper trade rejected/);
    assert.match(reply ?? '', /only 10 held/);
  });
});

// =============================================================================
// Agent execution service
// =============================================================================

describe('paper mode routing: agent execution service', () => {
  const realServiceThatMustNotBeUsed = {
    buyLimit: () => {
      throw new Error('real buyLimit was called');
    },
    sellLimit: () => {
      throw new Error('real sellLimit was called');
    },
    marketBuy: () => {
      throw new Error('real marketBuy was called');
    },
    marketSell: () => {
      throw new Error('real marketSell was called');
    },
  };

  it('fills limit orders in the ledger without calling the real service', async () => {
    const testDb = createTestDb({ enabled: true });
    const service = createPaperExecutionService({
      db: testDb.db,
      userId: USER,
      base: realServiceThatMustNotBeUsed as any,
    });

    const result = await service.buyLimit({
      platform: 'kalshi',
      marketId: 'KX-TEST',
      outcome: 'yes',
      price: 0.4,
      size: 10,
    });

    assert.equal(result.success, true);
    assert.equal(result.status, 'filled');
    assert.match(result.orderId ?? '', /^paper-/);
    assert.equal(result.avgFillPrice, 0.4);
    assert.equal(result.filledSize, 10);
    assert.equal(allRows(testDb, 'paper_positions')[0].size, 10);
  });

  it('prices market orders from the read-only price lookup', async () => {
    const testDb = createTestDb({ enabled: true });
    const service = createPaperExecutionService({
      db: testDb.db,
      userId: USER,
      base: { getExecutablePrice: async () => 0.55 } as any,
    });

    const result = await service.marketBuy({
      platform: 'polymarket',
      marketId: 'market-1',
      tokenId: 'token-9',
      size: 2,
    });

    assert.equal(result.success, true);
    assert.equal(result.avgFillPrice, 0.55);
    assert.equal(allRows(testDb, 'paper_trades')[0].price, 0.55);
  });

  it('refuses market orders that have no price reference', async () => {
    const testDb = createTestDb({ enabled: true });
    const service = createPaperExecutionService({ db: testDb.db, userId: USER });

    const result = await service.marketSell({
      platform: 'polymarket',
      marketId: 'market-1',
      tokenId: 'token-9',
      size: 2,
    });

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /market orders are simulated/);
    assert.equal(allRows(testDb, 'paper_trades').length, 0);
  });

  it('books batch orders', async () => {
    const testDb = createTestDb({ enabled: true });
    const service = createPaperExecutionService({ db: testDb.db, userId: USER });

    const results = await service.placeOrdersBatch([
      { platform: 'opinion', marketId: 'op-1', side: 'buy', price: 0.3, size: 5 },
      { platform: 'opinion', marketId: 'op-1', side: 'sell', price: 0.45, size: 2 },
    ]);

    assert.deepEqual(results.map(r => r.success), [true, true]);
    assert.equal(allRows(testDb, 'paper_trades').length, 2);
    assert.equal(allRows(testDb, 'paper_positions')[0].size, 3);
  });

  it('returns safe no-ops for order management', async () => {
    const { db } = createTestDb({ enabled: true });
    const service = createPaperExecutionService({ db, userId: USER });

    assert.equal(await service.cancelOrder('polymarket', 'order-1'), false);
    assert.equal(await service.cancelAllOrders(), 0);
    assert.deepEqual(await service.getOpenOrders(), []);
    assert.deepEqual(await service.cancelOrdersBatch('opinion', ['a', 'b']), [
      { orderId: 'a', success: false },
      { orderId: 'b', success: false },
    ]);
  });

  it('never throws when the ledger write fails, so fallbacks cannot place a real order', async () => {
    const service = createPaperExecutionService({
      db: {
        // Settings read succeeds so the failure happens on the ledger write
        query: () => [{ enabled: 1, balance: 1000 }],
        run: () => {
          throw new Error('database unavailable');
        },
      } as any,
      userId: USER,
    });

    const result = await service.buyLimit({
      platform: 'kalshi',
      marketId: 'KX-TEST',
      price: 0.4,
      size: 1,
    });

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /Paper ledger write failed/);
  });
});

// =============================================================================
// Crypto and perp tools
// =============================================================================

describe('paper mode routing: crypto and perp tools', () => {
  it('is inert without a user identity', () => {
    const { db } = createTestDb({ enabled: true });
    assert.equal(blockInPaperMode({ db } as any, 'x'), null);
  });

  it('is inert when paper trading is off', () => {
    const { db } = createTestDb({ enabled: false });
    assert.equal(blockInPaperMode({ db, userId: USER } as any, 'x'), null);
  });

  it('fails closed when the paper state cannot be read', () => {
    const reply = blockInPaperMode(
      {
        userId: USER,
        db: {
          query: () => {
            throw new Error('database unavailable');
          },
          run: () => {},
        },
      } as any,
      'binance futures'
    );

    assert.match(reply ?? '', /Could not verify paper trading state/);
  });

  const cryptoAndPerpTools: Array<[Record<string, unknown>, string, Record<string, unknown>]> = [
    [binanceHandlers, 'binance_futures_long', { symbol: 'BTCUSDT', size: 1 }],
    [binanceHandlers, 'binance_futures_short', { symbol: 'BTCUSDT', size: 1 }],
    [binanceHandlers, 'binance_futures_close', { symbol: 'BTCUSDT' }],
    [bybitHandlers, 'bybit_long', { symbol: 'BTCUSDT', size: 1 }],
    [bybitHandlers, 'bybit_short', { symbol: 'BTCUSDT', size: 1 }],
    [bybitHandlers, 'bybit_close', { symbol: 'BTCUSDT' }],
    [hyperliquidHandlers, 'hyperliquid_long', { coin: 'BTC', size: 1 }],
    [hyperliquidHandlers, 'hyperliquid_short', { coin: 'BTC', size: 1 }],
    [hyperliquidHandlers, 'hyperliquid_close', { coin: 'BTC' }],
    [hyperliquidHandlers, 'hyperliquid_leverage', { coin: 'BTC', leverage: 10 }],
    [solanaHandlers, 'solana_jupiter_swap', { input_mint: 'a', output_mint: 'b', amount: 1 }],
    [solanaHandlers, 'raydium_swap', { input_mint: 'a', output_mint: 'b', amount: 1 }],
    [solanaHandlers, 'orca_whirlpool_swap', { input_mint: 'a', output_mint: 'b', amount: 1 }],
    [solanaHandlers, 'meteora_dlmm_swap', { input_mint: 'a', output_mint: 'b', amount: 1 }],
    [solanaHandlers, 'solana_auto_swap', { input_mint: 'a', output_mint: 'b', amount: 1 }],
    [solanaHandlers, 'bags_swap', { input_mint: 'a', output_mint: 'b', amount: 1 }],
    [solanaHandlers, 'pumpfun_trade', { token: 'x', side: 'buy', amount: 0.1 }],
    [solanaHandlers, 'swarm_buy', { token: 'x', amount: 0.1 }],
    [solanaHandlers, 'swarm_sell', { token: 'x', amount: 0.1 }],
    [solanaHandlers, 'drift_direct_place_order', { market_index: 0, side: 'long', size: 1 }],
    [solanaHandlers, 'drift_direct_modify_order', { order_id: 1, size: 1 }],
    [solanaHandlers, 'drift_direct_set_leverage', { market_index: 0, leverage: 5 }],
  ];

  it('blocks every crypto and perp order tool', async () => {
    const testDb = createTestDb({ enabled: true });
    const context = contextFor(testDb);

    for (const [mod, tool, input] of cryptoAndPerpTools) {
      const reply = await handlersFrom(mod, tool)[tool](input, context);
      assert.match(reply, /Paper trading is on/, `${tool} should be blocked`);
      assert.match(reply, new RegExp(tool), `${tool} message should name the tool`);
    }

    assert.equal(allRows(testDb, 'paper_trades').length, 0);
  });

  it('lets the same tools through when paper trading is off', async () => {
    const testDb = createTestDb({ enabled: false });
    const reply = await handlersFrom(binanceHandlers, 'binance_futures_long').binance_futures_long(
      { symbol: 'BTCUSDT', size: 1 },
      contextFor(testDb)
    );

    assert.doesNotMatch(reply, /Paper trading is on/);
    assert.match(reply, /BINANCE_API_KEY/);
  });
});

// =============================================================================
// Prediction venues that bypass the execution service
// =============================================================================

describe('paper mode routing: venues outside the ledger', () => {
  const cases: Array<[Record<string, unknown>, string, Record<string, unknown>]> = [
    [manifoldHandlers, 'manifold_bet', { market_id: 'm', amount: 10, outcome: 'YES' }],
    [manifoldHandlers, 'manifold_sell', { market_id: 'm', outcome: 'YES', shares: 5 }],
    [manifoldHandlers, 'manifold_multiple_choice', { market_id: 'm', answer_id: 'a', amount: 5 }],
    [manifoldHandlers, 'manifold_multi_bet', { market_id: 'm', answer_ids: ['a'], amount: 5 }],
    [kalshiHandlers, 'kalshi_create_order_group', { orders: [{}] }],
    [
      predictfunHandlers,
      'predictfun_create_order',
      { market_id: 'm', token_id: 't', side: 'BUY', price: 0.4, quantity: 5 },
    ],
    [
      opinionHandlers,
      'opinion_place_order',
      { market_id: 1, token_id: 't', side: 'BUY', price: 0.4, amount: 5 },
    ],
  ];

  it('refuses real orders in paper mode', async () => {
    const testDb = createTestDb({ enabled: true });
    const context = contextFor(testDb);

    for (const [mod, tool, input] of cases) {
      const reply = await handlersFrom(mod, tool)[tool](input, context);
      // Opinion books a simulated fill while the others refuse outright;
      // neither outcome reaches the venue API.
      assert.match(
        reply,
        /Paper trading is on|Paper trade filled \(simulated, no order sent\)/,
        `${tool} should not place a real order`
      );
    }
  });

  it('does not block them when paper trading is off', async () => {
    const testDb = createTestDb({ enabled: false });
    const reply = await handlersFrom(manifoldHandlers, 'manifold_bet').manifold_bet(
      { market_id: 'm', amount: 10, outcome: 'YES' },
      contextFor(testDb)
    );

    assert.doesNotMatch(reply, /Paper trading is on/);
    assert.match(reply, /Manifold credentials/);
  });
});
