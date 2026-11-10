/**
 * Paper-mode execution adapter
 *
 * Wraps the real ExecutionService (or stands alone when no credentials exist)
 * for a user with paper trading enabled. Every order-placement call is recorded
 * in the simulated ledger instead of being sent to an exchange, so agent tools
 * that go through `tradingContext.executionService` cannot place real orders.
 *
 * Read-only helpers fall back to the real service only to price market orders;
 * order management returns safe no-ops.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '../db';
import type { ExecutionServiceRef, OrderResultRef, PredictionPlatform } from '../types';
import { recordPaperTrade } from './paper-ledger';

export interface PaperExecutionOptions {
  db: Database;
  userId: string;
  /** Real execution service (optional). Only used to read a market price. */
  base?: ExecutionServiceRef;
}

type OrderRequestShape = {
  platform: PredictionPlatform;
  marketId: string;
  tokenId?: string;
  outcome?: string;
  price: number;
  size: number;
};

type MarketOrderShape = {
  platform: PredictionPlatform;
  marketId: string;
  tokenId?: string;
  outcome?: string;
  size: number;
};

function simulate(
  db: Database,
  userId: string,
  side: 'buy' | 'sell',
  request: OrderRequestShape
): OrderResultRef {
  try {
    const result = recordPaperTrade(db, userId, {
      marketId: request.tokenId ?? request.marketId,
      outcome: request.outcome ?? 'YES',
      side,
      size: Number(request.size),
      price: Number(request.price),
    });

    if (!result.ok) {
      return { success: false, error: result.error };
    }

    return {
      success: true,
      orderId: `paper-${randomUUID().slice(0, 8)}`,
      status: 'filled',
      filledSize: result.fill.size,
      avgFillPrice: result.fill.price,
    };
  } catch (error) {
    // Never throw: callers with a real-service fallback must not end up
    // placing a real order because the ledger write failed.
    return {
      success: false,
      error: `Paper ledger write failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function executablePrice(
  base: ExecutionServiceRef | undefined,
  request: MarketOrderShape,
  side: 'buy' | 'sell'
): Promise<number | null> {
  const candidate = (base as unknown as {
    getExecutablePrice?: (
      platform: PredictionPlatform,
      marketIdOrTokenId: string,
      side: 'buy' | 'sell',
      outcome?: string
    ) => Promise<number | null>;
  })?.getExecutablePrice;

  if (typeof candidate !== 'function') return null;

  try {
    const price = await candidate.call(
      base,
      request.platform,
      request.tokenId ?? request.marketId,
      side,
      request.outcome
    );
    return typeof price === 'number' && price > 0 && price < 1 ? price : null;
  } catch {
    return null;
  }
}

/**
 * Build an ExecutionServiceRef that records simulated fills for `userId`.
 */
export function createPaperExecutionService(options: PaperExecutionOptions): ExecutionServiceRef {
  const { db, userId, base } = options;

  const marketOrder = async (
    side: 'buy' | 'sell',
    request: MarketOrderShape
  ): Promise<OrderResultRef> => {
    const price = await executablePrice(base, request, side);
    if (price === null) {
      return {
        success: false,
        error:
          'Paper trading is on, so market orders are simulated and need a price reference. ' +
          'Use a limit order, or fetch a price first, so the simulated fill can be booked.',
      };
    }
    return simulate(db, userId, side, { ...request, price });
  };

  return {
    buyLimit: async (request) => simulate(db, userId, 'buy', request),
    sellLimit: async (request) => simulate(db, userId, 'sell', request),
    makerBuy: async (request) => simulate(db, userId, 'buy', request),
    makerSell: async (request) => simulate(db, userId, 'sell', request),
    marketBuy: async (request) => marketOrder('buy', request),
    marketSell: async (request) => marketOrder('sell', request),

    placeOrdersBatch: async (orders) =>
      orders.map((order) => simulate(db, userId, order.side, order)),

    cancelOrder: async () => false,
    cancelAllOrders: async () => 0,
    getOpenOrders: async () => [],
    cancelOrdersBatch: async (_platform, orderIds) =>
      orderIds.map((orderId) => ({ orderId, success: false })),
  };
}
