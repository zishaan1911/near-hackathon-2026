import os
import sys

import pytest
from fastapi.testclient import TestClient

# api/ lives at the repo root, one level above ai/.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import stateless  # noqa: E402
from api.ai import app, get_block_source  # noqa: E402
from ingestion.ethereum import BlockSample  # noqa: E402

LATEST = 20_000_000


class FakeSource:
    async def latest_block_number(self) -> int:
        return LATEST

    async def get_block(self, number: int) -> BlockSample:
        return BlockSample(
            number=number,
            timestamp=1_700_000_000 + 12 * (number - LATEST),
            base_fee_wei=(10 + number % 7) * 1_000_000_000,
            gas_used=10_000_000 + (number % 5) * 2_000_000,
            gas_limit=30_000_000,
            block_tx_count=150,
            dex_tx_count=number % 20,
        )


async def _fake_source():
    yield FakeSource()


@pytest.fixture
def client():
    stateless.clear_cache()
    app.dependency_overrides[get_block_source] = _fake_source
    yield TestClient(app)
    app.dependency_overrides.clear()
    stateless.clear_cache()


def test_health(client):
    resp = client.get("/api/ai/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_egsi_current(client):
    resp = client.get("/api/ai/egsi/current")
    assert resp.status_code == 200
    body = resp.json()
    assert {"market", "score", "components", "block_number", "timestamp"} <= body.keys()
    assert body["block_number"] == LATEST


def test_forecast(client):
    resp = client.get("/api/ai/forecast")
    assert resp.status_code == 200
    assert {"market", "expected_egsi", "confidence", "p_tail_500", "model_version"} <= resp.json().keys()


def test_cycle_and_history_restore(client):
    assert client.post("/api/ai/cycle").status_code == 200
    resp = client.post("/api/ai/cycle", json={"thetanuts_atm_iv": 0.6})
    assert resp.status_code == 200
    resp = client.post("/api/ai/history/restore", json={"scores": [1, 2, 3]})
    assert resp.json() == {"restored": 3}
