"""Vercel entry for the stateless AI function. Same routes as ai/main.py,
mounted under /api/ai. No background tasks: every request derives EGSI and
history from recent blocks (ai/stateless.py) and forecasts with the
statistical baseline (the trained LightGBM models are not deployed).
"""
from __future__ import annotations

import sys
from pathlib import Path

# The ai/ modules use flat imports (`from schemas import ...`).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "ai"))

from fastapi import Depends, FastAPI, HTTPException  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

import stateless  # noqa: E402
from config import settings  # noqa: E402
from inference.baseline_forecaster import BaselineForecaster  # noqa: E402
from ingestion.ethereum import AsyncEthereumRpcClient  # noqa: E402
from schemas import CycleRequest, EgsiSnapshot, ForecastOutput  # noqa: E402

app = FastAPI(title="GASX AI Service (stateless)", version="0.1.0")
_baseline_forecaster = BaselineForecaster()


async def get_block_source():
    """Dependency so tests can swap the RPC client out."""
    client = AsyncEthereumRpcClient(settings.ethereum_rpc_url)
    try:
        yield client
    finally:
        await client.aclose()


async def _snapshot_and_history(source) -> tuple[EgsiSnapshot, list[float]]:
    try:
        return await stateless.build_snapshot_and_history(source)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"ethereum RPC unavailable: {exc}") from exc


@app.get("/api/ai/health")
def health() -> dict:
    return {"status": "ok", "model_loaded": False, "history_len": 0, "stateless": True}


@app.get("/api/ai/egsi/current", response_model=EgsiSnapshot)
async def get_current_egsi(source=Depends(get_block_source)) -> EgsiSnapshot:
    snapshot, _ = await _snapshot_and_history(source)
    return snapshot


@app.get("/api/ai/forecast", response_model=ForecastOutput)
async def get_forecast(source=Depends(get_block_source)) -> ForecastOutput:
    _, scores = await _snapshot_and_history(source)
    forecast = _baseline_forecaster.predict([int(round(s)) for s in scores])
    if forecast is None:
        raise HTTPException(status_code=503, detail="not enough block history for a forecast")
    return forecast


@app.post("/api/ai/cycle", response_model=EgsiSnapshot)
async def run_cycle(thetanuts: CycleRequest | None = None, source=Depends(get_block_source)) -> EgsiSnapshot:
    # Same as GET current: the optional Thetanuts body is accepted for
    # wire compatibility with ai/main.py but nothing is stored.
    snapshot, _ = await _snapshot_and_history(source)
    return snapshot


class HistoryRestoreRequest(BaseModel):
    scores: list[int] = Field(default_factory=list)


@app.post("/api/ai/history/restore")
def restore_history(request: HistoryRestoreRequest) -> dict:
    # No-op: history is rebuilt from chain data on every request.
    return {"restored": len(request.scores)}
