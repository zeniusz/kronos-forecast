"""Paper backtest: follow Kronos's top picks for 24h at a time, after fees.

Usage: python backtest.py [budget] [days]
Prices are in USDT; percentage results apply to any currency.
"""
import json
import sys
import time

import pandas as pd
import requests
import torch

from model import Kronos, KronosPredictor, KronosTokenizer

COINS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX", "LINK", "LTC"]
COLS = ["open", "high", "low", "close", "volume", "amount"]
HOSTS = ["https://data-api.binance.vision", "https://api.binance.com", "https://api.binance.us"]
LOOKBACK, PATHS, TOP_N = 256, 4, 3
COST = 0.003  # round trip: 0.1% fee per side + 0.05% slippage per side

budget = float(sys.argv[1]) if len(sys.argv) > 1 else 100.0
days = int(sys.argv[2]) if len(sys.argv) > 2 else 7


def fetch(symbol, limit=700):
    for host in HOSTS:
        try:
            r = requests.get(f"{host}/api/v3/klines", params={"symbol": symbol, "interval": "1h", "limit": limit}, timeout=15)
            r.raise_for_status()
            df = pd.DataFrame(r.json(), columns=["t", "open", "high", "low", "close", "volume", "ct", "amount", "n", "tb", "tq", "ig"])
            df["timestamps"] = pd.to_datetime(df["t"], unit="ms")
            for c in COLS:
                df[c] = df[c].astype(float)
            df = df[df["ct"] < time.time() * 1000]
            return df[["timestamps"] + COLS].reset_index(drop=True)
        except Exception as e:
            err = e
    raise RuntimeError(err)


def forecast(pred, hist):
    hist = hist.iloc[-LOOKBACK:].reset_index(drop=True)
    y_ts = pd.Series(pd.date_range(hist["timestamps"].iloc[-1] + pd.Timedelta(hours=1), periods=24, freq="h"))
    paths = pred.predict_batch([hist[COLS]] * PATHS, [hist["timestamps"]] * PATHS, [y_ts] * PATHS,
                               pred_len=24, T=1.0, top_p=0.9, sample_count=1, verbose=False)
    start = hist["close"].iloc[-1]
    ends = [p["close"].iloc[-1] for p in paths]
    return (sum(ends) / len(ends) / start - 1) * 100, sum(e > start for e in ends) / len(ends)


def pick(views, shorts):
    cand = []
    for c, (exp, pup) in views.items():
        if exp > 0.3 and pup >= 0.6:
            cand.append((abs(exp), c, 1))
        elif shorts and exp < -0.3 and pup <= 0.4:
            cand.append((abs(exp), c, -1))
    cand = sorted(cand, reverse=True)[:TOP_N]
    tot = sum(x[0] for x in cand)
    return {c: (s / tot, side) for s, c, side in cand}


def day_return(picks, actual):
    """Fraction gained on the whole budget for one 24h round, after costs."""
    return sum(w * (side * actual[c] / 100 - COST) for c, (w, side) in picks.items())


torch.manual_seed(7)
pred = KronosPredictor(Kronos.from_pretrained("NeoQuasar/Kronos-small"),
                       KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base"),
                       device="cuda:0" if torch.cuda.is_available() else "cpu", max_context=512)
data = {c: fetch(f"{c}USDT") for c in COINS}
out = {"budget": budget, "days": []}

for offset in [24 * d for d in range(1, days + 1)] + [0]:
    t0 = time.time()
    views, actual = {}, {}
    for c in COINS:
        df = data[c]
        hist = df.iloc[:len(df) - offset] if offset else df
        views[c] = forecast(pred, hist)
        if offset:
            actual[c] = (df["close"].iloc[len(df) - 1 - offset + 24] / hist["close"].iloc[-1] - 1) * 100
    day = {"offset_h": offset, "from": str(data["BTC"]["timestamps"].iloc[len(data["BTC"]) - 1 - offset]),
           "views": views, "actual": actual,
           "picks_ls": pick(views, True), "picks_long": pick(views, False)}
    if offset:
        day["ret_ls"] = day_return(day["picks_ls"], actual)
        day["ret_long"] = day_return(day["picks_long"], actual)
        day["ret_hold"] = sum(actual.values()) / len(actual) / 100
        hits = [(views[c][0] > 0) == (actual[c] > 0) for c in COINS]
        day["hit_rate"] = sum(hits) / len(hits)
        print(f"{day['from']}  long/short {day['ret_ls']*100:+.2f}%  long-only {day['ret_long']*100:+.2f}%  "
              f"hold-all {day['ret_hold']*100:+.2f}%  direction hits {sum(hits)}/10  picks {day['picks_ls']}  ({time.time()-t0:.0f}s)", flush=True)
    else:
        print("TODAY picks:", {c: (round(w * budget, 2), "rise" if s > 0 else "fall", round(views[c][0], 2)) for c, (w, s) in day["picks_ls"].items()}, flush=True)
        print("TODAY views:", {c: (round(e, 2), p) for c, (e, p) in views.items()}, flush=True)
    out["days"].append(day)

past = [d for d in out["days"] if d["offset_h"]]
for key, name in (("ret_ls", "Long/short"), ("ret_long", "Long-only"), ("ret_hold", "Hold all coins")):
    v = budget
    for d in sorted(past, key=lambda d: -d["offset_h"]):
        v *= 1 + d[key]
    print(f"{name}: {budget:.2f} -> {v:.2f} over {len(past)} days", flush=True)
print(f"Direction hit rate: {sum(d['hit_rate'] for d in past) / len(past) * 100:.0f}%")
json.dump(out, open("backtest_result.json", "w"), indent=1, default=str)
