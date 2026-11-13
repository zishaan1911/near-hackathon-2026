/**
 * Pure builders for the wallet transactions the adapter prepares (never signs).
 * Each returns a PreparedTransaction (types.ts) matching docs/near-abi.md:
 * receiver, method, args, gas and attached deposit. No network access.
 */
import type { NearAdapterConfig } from './config.js';
import type {
  CancelOrderParams,
  ClaimParams,
  DepositParams,
  PlaceOrderParams,
  PreparedTransaction,
  WithdrawParams,
} from './types.js';

/** 30 Tgas — place_order, cancel_order, claim. */
export const GAS_DEFAULT = '30000000000000';
/** 60 Tgas — withdraw (cross-contract ft_transfer). */
export const GAS_WITHDRAW = '60000000000000';
/** 100 Tgas — ft_transfer_call on the token. */
export const GAS_DEPOSIT = '100000000000000';
/** 1 yoctoNEAR, required by NEP-141 transfers and withdraw. */
export const ONE_YOCTO = '1';
export const NO_DEPOSIT = '0';

type ContractIds = Pick<NearAdapterConfig, 'contractId' | 'collateralToken'>;

function requireAmount(amount: string): string {
  if (typeof amount !== 'string' || !/^[1-9]\d*$/.test(amount)) {
    throw new Error(`amount must be a positive integer string in token base units, got ${JSON.stringify(amount)}`);
  }
  return amount;
}

function requirePositiveInt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireId(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function functionCall(
  receiverId: string,
  methodName: string,
  args: Record<string, unknown>,
  gas: string,
  deposit: string,
  summary: PreparedTransaction['summary'],
): PreparedTransaction {
  return {
    receiverId,
    actions: [{ type: 'FunctionCall', params: { methodName, args, gas, deposit } }],
    summary,
  };
}

/** `ft_transfer_call` on the collateral token; the contract's
 * ft_on_transfer credits the trader's `available`. */
export function buildDeposit(ids: ContractIds, params: DepositParams): PreparedTransaction {
  const amount = requireAmount(params.amount);
  return functionCall(
    ids.collateralToken,
    'ft_transfer_call',
    { receiver_id: ids.contractId, amount, msg: '' },
    GAS_DEPOSIT,
    ONE_YOCTO,
    { action: 'deposit', trader: params.trader, amount, token: ids.collateralToken },
  );
}

export function buildWithdraw(ids: ContractIds, params: WithdrawParams): PreparedTransaction {
  const amount = requireAmount(params.amount);
  return functionCall(ids.contractId, 'withdraw', { amount }, GAS_WITHDRAW, ONE_YOCTO, {
    action: 'withdraw',
    trader: params.trader,
    amount,
  });
}

export function buildPlaceOrder(ids: ContractIds, params: PlaceOrderParams): PreparedTransaction {
  const price = requirePositiveInt(params.price, 'price');
  const quantity = requirePositiveInt(params.quantity, 'quantity');
  return functionCall(
    ids.contractId,
    'place_order',
    { is_bid: params.isBid, price, quantity },
    GAS_DEFAULT,
    NO_DEPOSIT,
    { action: 'place_order', trader: params.trader, side: params.isBid ? 'bid' : 'ask', price, quantity },
  );
}

export function buildCancelOrder(ids: ContractIds, params: CancelOrderParams): PreparedTransaction {
  const orderId = requireId(params.orderId, 'orderId');
  return functionCall(ids.contractId, 'cancel_order', { order_id: orderId }, GAS_DEFAULT, NO_DEPOSIT, {
    action: 'cancel_order',
    trader: params.trader,
    orderId,
  });
}

export function buildClaim(ids: ContractIds, params: ClaimParams): PreparedTransaction {
  const tradeId = requireId(params.tradeId, 'tradeId');
  return functionCall(ids.contractId, 'claim', { trade_id: tradeId }, GAS_DEFAULT, NO_DEPOSIT, {
    action: 'claim',
    trader: params.trader,
    tradeId,
  });
}
