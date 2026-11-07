import asyncio

import pytest

import stateless
from ingestion.ethereum import BlockSample

LATEST = 20_000_000


class FakeClient:
    def __init__(self):
        self.latest_calls = 0
        self.block_calls = 0

    async def latest_block_number(self) -> int:
        self.latest_calls += 1
        return LATEST

    async def get_block(self, number: int) -> BlockSample:
        self.block_calls += 1
        return BlockSample(
            number=number,
            timestamp=1_700_000_000 + 12 * (number - LATEST),
            base_fee_wei=(10 + number % 7) * 1_000_000_000,
            gas_used=10_000_000 + (number % 5) * 2_000_000,
            gas_limit=30_000_000,
            block_tx_count=150,
            dex_tx_count=number % 20,
        )


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture(autouse=True)
def fresh_cache():
    stateless.clear_cache()
    yield
    stateless.clear_cache()


def test_builds_snapshot_and_history_of_requested_length():
    client = FakeClient()
    snapshot, scores = asyncio.run(stateless.build_snapshot_and_history(client, n_blocks=30, clock=FakeClock()))

    assert len(scores) == 30
    assert all(0 <= s <= 1000 for s in scores)
    assert snapshot.block_number == LATEST
    assert snapshot.score == scores[-1]
    assert client.block_calls == 30


def test_second_call_within_ttl_is_served_from_cache():
    client = FakeClient()
    clock = FakeClock()
    first = asyncio.run(stateless.build_snapshot_and_history(client, n_blocks=10, clock=clock))
    calls = (client.latest_calls, client.block_calls)

    clock.now += 11.9
    second = asyncio.run(stateless.build_snapshot_and_history(client, n_blocks=10, clock=clock))

    assert (client.latest_calls, client.block_calls) == calls
    assert second == first


def test_cache_expires_after_ttl():
    client = FakeClient()
    clock = FakeClock()
    asyncio.run(stateless.build_snapshot_and_history(client, n_blocks=10, clock=clock))

    clock.now += 12.0
    asyncio.run(stateless.build_snapshot_and_history(client, n_blocks=10, clock=clock))

    assert client.latest_calls == 2
    assert client.block_calls == 20
