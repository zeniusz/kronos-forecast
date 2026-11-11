"""Kronos Forecast: a small web server. Serves the site in ./web and runs Kronos forecasts.

Run:  python server.py     then open http://127.0.0.1:8000
"""
import json
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd
import requests
import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from model import Kronos, KronosPredictor, KronosTokenizer

BASE = Path(__file__).parent
COINS = {"BTC": "Bitcoin", "ETH": "Ethereum", "SOL": "Solana", "BNB": "BNB", "XRP": "XRP",
         "DOGE": "Dogecoin", "ADA": "Cardano", "AVAX": "Avalanche", "LINK": "Chainlink", "LTC": "Litecoin"}
MODELS = {"small": "NeoQuasar/Kronos-small", "base": "NeoQuasar/Kronos-base"}
TOKENIZER = "NeoQuasar/Kronos-Tokenizer-base"
HOSTS = ["https://data-api.binance.vision", "https://api.binance.com", "https://api.binance.us"]
COLS = ["open", "high", "low", "close", "volume", "amount"]
HOUR = pd.Timedelta(hours=1)

app = FastAPI(title="Kronos Forecast")
_cache, _cache_lock = {}, threading.Lock()
_predictors, _model_lock = {}, threading.Lock()
_jobs, _pool = {}, ThreadPoolExecutor(max_workers=1)


def cached(key, ttl, fn):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    value = fn()
    with _cache_lock:
        _cache[key] = (now, value)
    return value


def binance(path, params):
    err = None
    for host in HOSTS:
        try:
            r = requests.get(f"{host}{path}", params=params, timeout=15)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            err = e
    raise HTTPException(502, f"Could not reach Binance ({type(err).__name__}). Check your internet connection.")


def check_coin(coin):
    if coin not in COINS:
        raise HTTPException(404, f"Unknown coin {coin}")


def candles(coin):
    """Closed hourly candles as a DataFrame with naive UTC timestamps."""
    def load():
        rows = binance("/api/v3/klines", {"symbol": f"{coin}USDT", "interval": "1h", "limit": 560})
        df = pd.DataFrame(rows, columns=["t", "open", "high", "low", "close", "volume", "ct", "amount", "n", "tb", "tq", "ig"])
        df["timestamps"] = pd.to_datetime(df["t"], unit="ms")
        for c in COLS:
            df[c] = df[c].astype(float)
        df = df[df["ct"] < time.time() * 1000]
        return df[["timestamps"] + COLS].reset_index(drop=True)
    return cached(("candles", coin), 60, load)


def ms(ts):
    return int(pd.Timestamp(ts).timestamp() * 1000)


def rows_of(df):
    return [[ms(r.timestamps), r.open, r.high, r.low, r.close] for r in df.itertuples()]


def predictor(name):
    with _model_lock:
        if name not in _predictors:
            dev = "cuda:0" if torch.cuda.is_available() else "cpu"
            _predictors[name] = KronosPredictor(Kronos.from_pretrained(MODELS[name]), KronosTokenizer.from_pretrained(TOKENIZER),
                                                device=dev, max_context=512)
        return _predictors[name]


def run_kronos(coin, hours, n_paths, lookback, temperature, top_p, model, offset=0):
    """Samples n_paths futures. offset hides the newest candles, to replay the past."""
    df = candles(coin)
    full = df.iloc[:-offset] if offset else df
    hist = full.iloc[-lookback:].reset_index(drop=True)
    key = ("forecast", coin, str(hist["timestamps"].iloc[-1]), hours, n_paths, lookback, temperature, top_p, model)

    def compute():
        y_ts = pd.Series(pd.date_range(hist["timestamps"].iloc[-1] + HOUR, periods=hours, freq="h"))
        pred = predictor(model)
        with _model_lock:
            paths = pred.predict_batch(
                df_list=[hist[COLS]] * n_paths, x_timestamp_list=[hist["timestamps"]] * n_paths,
                y_timestamp_list=[y_ts] * n_paths, pred_len=hours, T=temperature, top_p=top_p, sample_count=1, verbose=False)
        closes = np.stack([p["close"].values for p in paths])
        mean = sum(p[COLS] for p in paths) / len(paths)
        mean["high"] = mean[["open", "high", "close"]].max(axis=1)
        mean["low"] = mean[["open", "low", "close"]].min(axis=1)
        steps = []
        for i, t in enumerate(y_ts):
            steps.append({"t": ms(t), "o": float(mean["open"].iloc[i]), "h": float(mean["high"].iloc[i]),
                          "l": float(mean["low"].iloc[i]), "c": float(mean["close"].iloc[i]),
                          "q25": float(np.percentile(closes[:, i], 25)), "q75": float(np.percentile(closes[:, i], 75)),
                          "min": float(closes[:, i].min()), "max": float(closes[:, i].max())})
        last = float(hist["close"].iloc[-1])
        return {"steps": steps, "last": last, "n_paths": n_paths,
                "p_up": float((closes[:, -1] > last).mean()), "last_t": ms(hist["timestamps"].iloc[-1])}

    return full, cached(key, 3600, compute)


@app.get("/api/coins")
def api_coins():
    return COINS


@app.get("/api/prices")
def api_prices():
    def load():
        syms = json.dumps([f"{c}USDT" for c in COINS], separators=(",", ":"))
        data = binance("/api/v3/ticker/24hr", {"symbols": syms})
        return {d["symbol"][:-4]: {"price": float(d["lastPrice"]), "change": float(d["priceChangePercent"])} for d in data}
    return cached(("prices",), 30, load)


@app.get("/api/candles")
def api_candles(coin: str):
    check_coin(coin)
    return rows_of(candles(coin))


@app.get("/api/forecast")
def api_forecast(coin: str, hours: int = 24, paths: int = 8, model: str = "small", variety: float = 1.0):
    check_coin(coin)
    hours, paths = max(1, min(hours, 48)), max(2, min(paths, 16))
    if model not in MODELS:
        raise HTTPException(400, "Unknown model")
    full, res = run_kronos(coin, hours, paths, 400, variety, 0.9, model)
    return {**res, "hist": rows_of(full.iloc[-36:])}


@app.get("/api/accuracy")
def api_accuracy(coin: str, hours: int = 24, paths: int = 8, model: str = "small", variety: float = 1.0):
    check_coin(coin)
    hours, paths = max(1, min(hours, 48)), max(2, min(paths, 16))
    full, res = run_kronos(coin, hours, paths, 400, variety, 0.9, model, offset=hours)
    actual = candles(coin).iloc[-hours:]
    return {**res, "hist": rows_of(full.iloc[-36:]), "actual": rows_of(actual)}


def scan_job(job_id, offset):
    job = _jobs[job_id]
    try:
        for coin in COINS:
            df = candles(coin)
            start = float(df["close"].iloc[-1 - offset])
            _, res = run_kronos(coin, 24, 4, 256, 1.0, 0.9, "small", offset=offset)
            end = res["steps"][-1]["c"]
            job["rows"].append({"coin": coin, "start": start, "now": float(df["close"].iloc[-1]),
                                "exp": (end / start - 1) * 100, "pup": res["p_up"], "ts": res["last_t"]})
            job["done"] += 1
    except Exception as e:
        job["error"] = f"{type(e).__name__}: {e}"
    job["finished"] = True


@app.post("/api/scan")
def api_scan(offset: int = 0):
    job_id = uuid.uuid4().hex[:8]
    _jobs[job_id] = {"done": 0, "total": len(COINS), "rows": [], "error": None, "finished": False}
    _pool.submit(scan_job, job_id, 24 if offset else 0)
    return {"job": job_id}


@app.get("/api/job/{job_id}")
def api_job(job_id: str):
    if job_id not in _jobs:
        raise HTTPException(404, "Unknown job")
    return _jobs[job_id]


@app.exception_handler(Exception)
def on_error(_, exc):
    return JSONResponse({"detail": f"{type(exc).__name__}: {exc}"}, status_code=500)


app.mount("/", StaticFiles(directory=BASE / "web", html=True), name="web")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    print(f"\n  Kronos Forecast is running: http://127.0.0.1:{port}\n")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
