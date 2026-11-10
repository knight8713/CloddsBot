import type { HandlerContext, HandlerResult } from './types';
import { errorResult } from './types';
import { validatePreTrade } from '../../trading/pre-trade';
import { isPaperTradingEnabled } from '../../trading/paper-ledger';

export function guardTrade(
  context: HandlerContext,
  label: string,
  notionalUsd?: number,
  options: { requireNotional?: boolean; skipSizeLimit?: boolean } = {}
): HandlerResult | null {
  const error = validatePreTrade({
    label,
    notionalUsd,
    maxOrderSize: context.tradingContext?.maxOrderSize,
    requireNotional: options.requireNotional,
    skipSizeLimit: options.skipSizeLimit,
  });
  return error ? errorResult(error) : null;
}


/**
 * Refuse real orders for venues that do not go through the paper ledger.
 *
 * Fails closed when the paper state cannot be read, and is a no-op without a
 * user identity (e.g. standalone CLI use).
 */
export function blockInPaperMode(context: HandlerContext, label: string): HandlerResult | null {
  if (!context.userId) return null;

  let enabled: boolean;
  try {
    enabled = isPaperTradingEnabled(context.db, context.userId);
  } catch {
    return errorResult(`Could not verify paper trading state, so ${label} was not placed.`);
  }

  if (!enabled) return null;

  return errorResult(
    `Paper trading is on. ${label} places real orders on its exchange, so it is blocked in paper mode. ` +
    'Use paper_trade to record a simulated position, or disable paper trading to trade for real.'
  );
}
