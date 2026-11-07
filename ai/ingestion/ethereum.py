"""Ethereum chain data ingestion (ARCHITECTURE.md §2, §3): pulls the raw
signals features/egsi.py's compute_egsi() needs from an Ethereum JSON-RPC
endpoint over plain JSON-RPC via httpx (no web3.py: it drags in a
dependency tree far too heavy for a Vercel Python function).

NOT exercised against a live RPC endpoint in the build sandbox — there is
no network egress to any Ethereum RPC provider there. Only the parsing/
shaping logic (_count_dex_transactions, _fetch_base_fee_history's
trimming, the RawEthereumMetrics assembly) is unit-tested here, against a
mocked _rpc() (tests/test_ingestion.py). Point EthereumIngestionClient
at a real RPC URL and verify against live data on your machine before
trusting it — see ai/README.md.
"""
from __future__ import annotations

from dataclasses import dataclass

import httpx

from schemas import RawEthereumMetrics

# A short, illustrative list of well-known DEX/DeFi router addresses on
# Ethereum mainnet, used as the dex_tx_count proxy for the dex_activity
# EGSI component (features/egsi.py). Intentionally small and easy to
# extend — a production version would maintain this separately (config
# file or DB table), not hard-code it in source.
KNOWN_DEX_ROUTER_ADDRESSES: frozenset[str] = frozenset(
    addr.lower()
    for addr in [
        "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",  # Uniswap V2 Router
        "0xE592427A0AEce92De3Edee1F18E0157C05861564",  # Uniswap V3 Router
        "0x1111111254EEB25477B68fb85Ed929f73A960582",  # 1inch V5 Router
        "0xDef1C0ded9bec7F1a1670819833240f027b25EfF",  # 0x Exchange Proxy
    ]
)

# How many recent blocks' base fees to sample for fee_momentum /
# gas_volatility (ARCHITECTURE.md §3).
DEFAULT_HISTORY_WINDOW_BLOCKS = 20


# Per-request timeout and retry budget for the JSON-RPC calls.
RPC_TIMEOUT_SECONDS = 8.0
RPC_RETRIES = 1


class RpcError(RuntimeError):
    """The RPC endpoint was unreachable or returned a JSON-RPC error."""


def _hex_to_int(value) -> int:
    if isinstance(value, int):
        return value
    return int(value, 16)


def _rpc_payload(method: str, params: list) -> dict:
    return {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}


def _unwrap(body: dict):
    if "error" in body and body["error"]:
        raise RpcError(str(body["error"]))
    return body.get("result")


def count_dex_transactions(transactions) -> int:
    count = 0
    for tx in transactions:
        to_addr = tx.get("to") if isinstance(tx, dict) else None
        if to_addr and to_addr.lower() in KNOWN_DEX_ROUTER_ADDRESSES:
            count += 1
    return count


@dataclass(frozen=True)
class BlockSample:
    """The handful of per-block numbers EGSI needs, already decoded from
    the hex JSON-RPC block. Used by the stateless path (stateless.py)."""

    number: int
    timestamp: int
    base_fee_wei: int
    gas_used: int
    gas_limit: int
    block_tx_count: int
    dex_tx_count: int


def parse_block(raw: dict) -> BlockSample:
    txs = raw.get("transactions", [])
    return BlockSample(
        number=_hex_to_int(raw["number"]),
        timestamp=_hex_to_int(raw["timestamp"]),
        base_fee_wei=_hex_to_int(raw.get("baseFeePerGas", "0x0")),
        gas_used=_hex_to_int(raw["gasUsed"]),
        gas_limit=_hex_to_int(raw["gasLimit"]),
        block_tx_count=len(txs),
        dex_tx_count=count_dex_transactions(txs),
    )


class AsyncEthereumRpcClient:
    """Async JSON-RPC client used by the stateless Vercel path, so many
    blocks can be fetched concurrently with asyncio.gather."""

    def __init__(self, rpc_url: str, timeout: float = RPC_TIMEOUT_SECONDS, retries: int = RPC_RETRIES):
        self.rpc_url = rpc_url
        self.timeout = timeout
        self.retries = retries
        self._http: httpx.AsyncClient | None = None

    async def _rpc(self, method: str, params: list):
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=self.timeout)
        last_exc: Exception | None = None
        for _ in range(self.retries + 1):
            try:
                resp = await self._http.post(self.rpc_url, json=_rpc_payload(method, params))
                resp.raise_for_status()
                return _unwrap(resp.json())
            except (httpx.HTTPError, RpcError, ValueError) as exc:
                last_exc = exc
        raise RpcError(f"{method} failed: {last_exc}")

    async def latest_block_number(self) -> int:
        return _hex_to_int(await self._rpc("eth_blockNumber", []))

    async def get_block(self, number: int) -> BlockSample:
        raw = await self._rpc("eth_getBlockByNumber", [hex(number), True])
        if not raw:
            raise RpcError(f"block {number} not found")
        return parse_block(raw)

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None


class EthereumIngestionClient:
    def __init__(self, rpc_url: str, history_window_blocks: int = DEFAULT_HISTORY_WINDOW_BLOCKS):
        self.rpc_url = rpc_url
        self.history_window_blocks = history_window_blocks

    def _rpc(self, method: str, params: list):
        """One JSON-RPC call: 8 s timeout, one retry."""
        last_exc: Exception | None = None
        for _ in range(RPC_RETRIES + 1):
            try:
                resp = httpx.post(self.rpc_url, json=_rpc_payload(method, params), timeout=RPC_TIMEOUT_SECONDS)
                resp.raise_for_status()
                return _unwrap(resp.json())
            except (httpx.HTTPError, RpcError, ValueError) as exc:
                last_exc = exc
        raise RpcError(f"{method} failed: {last_exc}")

    def fetch_latest_metrics(self) -> RawEthereumMetrics:
        latest = self._rpc("eth_getBlockByNumber", ["latest", True])
        if not latest:
            raise RpcError("latest block not found")
        base_fee_history = self._fetch_base_fee_history()
        transactions = latest["transactions"]
        dex_tx_count = self._count_dex_transactions(transactions)
        pending_tx_count = self._fetch_pending_tx_count()

        return RawEthereumMetrics(
            block_number=_hex_to_int(latest["number"]),
            timestamp=_hex_to_int(latest["timestamp"]),
            base_fee_wei=_hex_to_int(latest["baseFeePerGas"]),
            gas_used=_hex_to_int(latest["gasUsed"]),
            gas_limit=_hex_to_int(latest["gasLimit"]),
            pending_tx_count=pending_tx_count,
            base_fee_history_wei=base_fee_history,
            dex_tx_count=dex_tx_count,
            block_tx_count=len(transactions),
        )

    def _fetch_base_fee_history(self) -> list[int]:
        fee_history = self._rpc("eth_feeHistory", [hex(self.history_window_blocks), "latest", []])
        # baseFeePerGas carries one extra trailing entry — the *next*
        # block's already-computable projected base fee — so this is
        # trimmed to exactly one entry per historical block, oldest
        # first, matching what features/egsi.py expects.
        return [_hex_to_int(v) for v in fee_history["baseFeePerGas"][:-1]]

    def _count_dex_transactions(self, transactions) -> int:
        return count_dex_transactions(transactions)

    def _fetch_pending_tx_count(self) -> int:
        """Mempool pressure proxy. txpool_status isn't exposed by every
        RPC provider (notably: Infura, Alchemy and public RPCs don't
        support it) — falls back to 0 (reads as "no pressure") rather
        than raising, since a missing mempool signal shouldn't take down
        the whole EGSI computation."""
        try:
            status = self._rpc("txpool_status", [])
            return _hex_to_int(status.get("pending", "0x0"))
        except Exception:
            return 0
