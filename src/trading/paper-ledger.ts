/**
 * Paper trading ledger
 *
 * Simulated fill bookkeeping shared by the `paper_trade` agent tool and by the
 * /poly order path when paper trading is enabled for the current user.
 * Nothing in this module talks to an exchange.
 */

import type { Database } from '../db';

export type PaperTradeSide = 'buy' | 'sell';

export interface PaperTradeRequest {
  marketId: string;
  marketName?: string;
  outcome?: string;
  side: string;
  size: number;
  price: number;
}

export interface PaperFill {
  side: PaperTradeSide;
  outcome: string;
  market: string;
  size: number;
  price: number;
  notional: number;
  balance: number;
  realizedPnl: number;
  remainingShares: number;
  positionSize: number;
  avgEntry: number | null;
}

export type PaperTradeResult =
  | { ok: true; fill: PaperFill }
  | { ok: false; error: string };

interface SettingsRow {
  enabled: number;
  balance: number;
}

interface PositionRow {
  market_id: string;
  market_name: string;
  side: string;
  size: number;
  entry_price: number;
}

/**
 * Whether paper trading is switched on for a user.
 */
export function isPaperTradingEnabled(db: Database, userId: string): boolean {
  const row = db.query<{ enabled: number }>(
    'SELECT enabled FROM paper_trading_settings WHERE user_id = ?',
    [userId]
  )[0];
  return !!row?.enabled;
}

/**
 * Record a simulated buy or sell against the user's paper account.
 *
 * Buys deduct cash and fold into the position at a share-weighted average
 * entry. Sells credit proceeds, realise P&L against the average entry and
 * reduce or close the position.
 */
export function recordPaperTrade(
  db: Database,
  userId: string,
  request: PaperTradeRequest
): PaperTradeResult {
  const settings = db.query<SettingsRow>(
    'SELECT enabled, balance FROM paper_trading_settings WHERE user_id = ?',
    [userId]
  )[0];

  if (!settings) {
    return {
      ok: false,
      error: 'Paper trading not set up. Enable paper trading mode first, e.g. "enable paper trading with $10,000".',
    };
  }
  if (!settings.enabled) {
    return {
      ok: false,
      error: 'Paper trading is disabled. Enable paper trading mode before recording simulated trades.',
    };
  }

  const marketId = String(request.marketId ?? '').trim();
  const requestedName = String(request.marketName ?? '').trim();
  const outcome = String(request.outcome ?? 'YES').trim().toUpperCase() || 'YES';
  const side = String(request.side ?? '').trim().toLowerCase();
  const size = Number(request.size);
  const price = Number(request.price);

  if (!marketId) return { ok: false, error: 'market_id is required' };
  if (side !== 'buy' && side !== 'sell') {
    return { ok: false, error: "side must be 'buy' or 'sell'" };
  }
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, error: 'size must be a positive number of shares' };
  }
  if (!Number.isFinite(price) || price <= 0 || price > 1) {
    return { ok: false, error: 'price must be between 0 and 1 (USDC per share)' };
  }

  const notional = size * price;
  const now = new Date().toISOString();
  const existing = db.query<PositionRow>(
    'SELECT market_id, market_name, side, size, entry_price FROM paper_positions WHERE user_id = ? AND market_id = ? AND side = ?',
    [userId, marketId, outcome]
  )[0];

  // Keep the readable market name already on file when the caller omits it
  const marketName = requestedName || existing?.market_name || marketId;

  if (side === 'buy') {
    if (settings.balance < notional) {
      return {
        ok: false,
        error: `Insufficient paper balance: need $${notional.toFixed(2)}, have $${settings.balance.toFixed(2)}`,
      };
    }

    const newBalance = settings.balance - notional;

    if (existing) {
      const newSize = existing.size + size;
      const newEntry = (existing.entry_price * existing.size + price * size) / newSize;
      db.run(
        'UPDATE paper_positions SET size = ?, entry_price = ?, market_name = ? WHERE user_id = ? AND market_id = ? AND side = ?',
        [newSize, newEntry, marketName, userId, marketId, outcome]
      );
    } else {
      db.run(
        'INSERT INTO paper_positions (user_id, market_id, market_name, side, size, entry_price, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [userId, marketId, marketName, outcome, size, price, now]
      );
    }

    db.run('UPDATE paper_trading_settings SET balance = ? WHERE user_id = ?', [newBalance, userId]);
    db.run(
      "INSERT INTO paper_trades (user_id, market_id, market_name, side, size, price, pnl, created_at) VALUES (?, ?, ?, 'BUY', ?, ?, 0, ?)",
      [userId, marketId, marketName, size, price, now]
    );

    const updated = db.query<PositionRow>(
      'SELECT market_id, market_name, side, size, entry_price FROM paper_positions WHERE user_id = ? AND market_id = ? AND side = ?',
      [userId, marketId, outcome]
    )[0];

    return {
      ok: true,
      fill: {
        side: 'buy',
        outcome,
        market: marketName,
        size,
        price,
        notional,
        balance: newBalance,
        realizedPnl: 0,
        remainingShares: updated ? updated.size : size,
        positionSize: updated ? updated.size : size,
        avgEntry: updated ? updated.entry_price : price,
      },
    };
  }

  // Sell: reduce or close an existing simulated position
  if (!existing || existing.size < size) {
    const held = existing?.size ?? 0;
    return {
      ok: false,
      error: `Cannot sell ${size} shares of ${outcome}: only ${held} held in ${marketName}`,
    };
  }

  const realizedPnl = (price - existing.entry_price) * size;
  const newBalance = settings.balance + notional;
  const remaining = existing.size - size;

  if (remaining > 0) {
    db.run(
      'UPDATE paper_positions SET size = ? WHERE user_id = ? AND market_id = ? AND side = ?',
      [remaining, userId, marketId, outcome]
    );
  } else {
    db.run(
      'DELETE FROM paper_positions WHERE user_id = ? AND market_id = ? AND side = ?',
      [userId, marketId, outcome]
    );
  }

  db.run('UPDATE paper_trading_settings SET balance = ? WHERE user_id = ?', [newBalance, userId]);
  db.run(
    "INSERT INTO paper_trades (user_id, market_id, market_name, side, size, price, pnl, created_at) VALUES (?, ?, ?, 'SELL', ?, ?, ?, ?)",
    [userId, marketId, marketName, size, price, realizedPnl, now]
  );

  return {
    ok: true,
    fill: {
      side: 'sell',
      outcome,
      market: marketName,
      size,
      price,
      notional,
      balance: newBalance,
      realizedPnl,
      remainingShares: remaining,
      positionSize: remaining,
      avgEntry: remaining > 0 ? existing.entry_price : null,
    },
  };
}
