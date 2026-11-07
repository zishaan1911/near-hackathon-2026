"""Stateless EGSI snapshot + history for the Vercel function (api/ai.py).

A serverless function has no background loop and no memory between cold
starts, so instead of accumulating history over time (main.py's
EgsiHistory) every request derives it from the last N Ethereum blocks:
fetch them in parallel, compute one EGSI per block, and hand back the
latest snapshot plus the score series oldest -> newest.

Results are cached in module memory for one Ethereum block time (12 s) so
concurrent requests share one RPC fan-out instead of hammering the node.
"""
from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from typing import Protocol

from features.egsi import EgsiNormalizationConfig, EgsiWeights, compute_egsi
from ingestion.ethereum import DEFAULT_HISTORY_WINDOW_BLOCKS, BlockSample
from schemas import EgsiSnapshot, RawEthereumMetrics

CACHE_TTL_SECONDS = 12.0
DEFAULT_BLOCKS = 60


class BlockSource(Protocol):
    async def latest_block_number(self) -> int: ...

    async def get_block(self, number: int) -> BlockSample: ...


# (n_blocks, stored_at, result)
_cache: tuple[int, float, tuple[EgsiSnapshot, list[float]]] | None = None


def clear_cache() -> None:
    global _cache
    _cache = None


def _metrics_for(blocks: list[BlockSample], index: int) -> RawEthereumMetrics:
    block = blocks[index]
    window = blocks[max(0, index - DEFAULT_HISTORY_WINDOW_BLOCKS + 1): index + 1]
    return RawEthereumMetrics(
        block_number=block.number,
        timestamp=block.timestamp,
        base_fee_wei=block.base_fee_wei,
        gas_used=block.gas_used,
        gas_limit=block.gas_limit,
        # No txpool_status on public RPCs; reads as "no pressure", the
        # same fallback the stateful ingestion client uses.
        pending_tx_count=0,
        base_fee_history_wei=[b.base_fee_wei for b in window],
        dex_tx_count=block.dex_tx_count,
        block_tx_count=block.block_tx_count,
    )


async def build_snapshot_and_history(
    client: BlockSource,
    n_blocks: int = DEFAULT_BLOCKS,
    *,
    clock: Callable[[], float] = time.monotonic,
) -> tuple[EgsiSnapshot, list[float]]:
    """Latest EGSI snapshot plus per-block scores (oldest -> newest) for
    the last `n_blocks` blocks. `clock` is injectable for tests."""
    global _cache
    now = clock()
    if _cache is not None and _cache[0] == n_blocks and now - _cache[1] < CACHE_TTL_SECONDS:
        return _cache[2]

    latest = await client.latest_block_number()
    numbers = [n for n in range(latest - n_blocks + 1, latest + 1) if n >= 0]
    blocks = list(await asyncio.gather(*(client.get_block(n) for n in numbers)))
    blocks.sort(key=lambda b: b.number)

    weights, config = EgsiWeights(), EgsiNormalizationConfig()
    snapshots = [compute_egsi(_metrics_for(blocks, i), weights, config) for i in range(len(blocks))]
    result = (snapshots[-1], [float(s.score) for s in snapshots])
    _cache = (n_blocks, now, result)
    return result
