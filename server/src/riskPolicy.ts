/**
 * Hard risk policy for order preparation, enforced here in the server, not
 * in the chat assistant or the client. Pure functions, no I/O, fully
 * unit-tested.
 *
 * Not every policy constant is enforced by every check below yet; each
 * function's doc comment says exactly which constants it applies and why
 * the others don't apply to that particular action.
 */

export interface RiskPolicyConfig {
  /** MAX_ORDER_CONTRACTS — cap on a single order's quantity. */
  maxOrderContracts: number;
  /** MAX_POSITION_CONTRACTS — cap on a trader's net position size.
   * NOT enforced by checkOrderRisk below: doing so needs a live position
   * read this server doesn't
   * have yet (no indexer/position-query path built). Revisit once one
   * exists. */
  maxPositionContracts: number;
  /** MAX_SLIPPAGE, in basis points — how far an order's price may sit
   * from a supplied reference price. Only enforced by checkOrderRisk
   * when a reference price is actually supplied (e.g. from the latest
   * oracle index value) — omitting one skips this check entirely rather
   * than failing closed on missing data. */
  maxSlippageBps: number;
}

export type RiskCheckResult = { accepted: true } | { accepted: false; reason: string };

function accept(): RiskCheckResult {
  return { accepted: true };
}

function reject(reason: string): RiskCheckResult {
  return { accepted: false, reason };
}

export interface OrderRiskCheckInput {
  price: number;
  quantity: number;
  /** From the live Market object (MarketState.tickSize).
   * 0 disables the tick-alignment check. */
  tickSize: number;
  marketPaused: boolean;
  marketSettled: boolean;
  /** Optional reference price (e.g. the latest oracle index value) —
   * enables the MAX_SLIPPAGE check when supplied. */
  referencePrice?: number;
}

/**
 * Pre-trade risk check for manual order placement. Applies MAX_ORDER_CONTRACTS
 * and, when a reference price is supplied, MAX_SLIPPAGE — see
 * RiskPolicyConfig's field docs for which constants don't apply here and
 * why.
 */
export function checkOrderRisk(input: OrderRiskCheckInput, policy: RiskPolicyConfig): RiskCheckResult {
  if (input.marketPaused) return reject('market is paused');
  if (input.marketSettled) return reject('market is already settled');
  if (!Number.isInteger(input.price) || input.price <= 0) return reject('price must be a positive integer');
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    return reject('quantity must be a positive integer');
  }
  if (input.tickSize > 0 && input.price % input.tickSize !== 0) {
    return reject(`price must be a multiple of the market tick size (${input.tickSize})`);
  }
  if (input.quantity > policy.maxOrderContracts) {
    return reject(`quantity exceeds MAX_ORDER_CONTRACTS (${policy.maxOrderContracts})`);
  }
  if (input.referencePrice !== undefined && policy.maxSlippageBps > 0) {
    if (input.referencePrice <= 0) return reject('referencePrice must be positive when supplied');
    const diffBps = (Math.abs(input.price - input.referencePrice) / input.referencePrice) * 10_000;
    if (diffBps > policy.maxSlippageBps) {
      return reject(
        `price is more than MAX_SLIPPAGE (${policy.maxSlippageBps} bps) from the reference price (${input.referencePrice})`,
      );
    }
  }
  return accept();
}


