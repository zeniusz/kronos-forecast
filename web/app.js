"use strict";

/* ---------- constants and state ---------- */
const COINS = { BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", BNB: "BNB", XRP: "XRP", DOGE: "Dogecoin", ADA: "Cardano", AVAX: "Avalanche", LINK: "Chainlink", LTC: "Litecoin" };
const VIEWS = [["forecast", "Forecast"], ["accuracy", "Accuracy check"], ["scan", "All coins"], ["paper", "Paper money"]];
const UP = "#35e0c2", DOWN = "#ff5c8a", FUT = "#a78bfa", HOUR = 3600e3;

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem("kf." + k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("kf." + k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem("kf." + k); } catch { /* private mode */ } },
};

const state = {
  coin: store.get("coin", "BTC"),
  view: store.get("view", "forecast"),
  settings: { hours: 24, paths: 8, model: "small", variety: 1, ...store.get("settings", {}) },
  paper: { budget: 100, sym: "$", fee: 0.15, mode: "kronos", topN: 3, shorts: true, ...store.get("paper", {}) },
  prices: {}, scan: null, replay: null, token: 0, timer: null, forecastEnds: 0,
};
if (!COINS[state.coin]) state.coin = "BTC";

/* ---------- formatting ---------- */
const num = (x, d = 2) => x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const price = (x) => "$" + (Math.abs(x) >= 1 ? num(x, 2) : num(x, 4));
const rangePrice = (x) => (x >= 1000 ? "$" + num(x, 0) : price(x));
const pct = (x) => (x >= 0 ? "+" : "") + num(x, 2) + "%";
const signed = (x) => (x >= 0 ? "+" : "") + num(x, 2);
const when = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayLbl = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric" });
const tone = (x) => (x >= 0 ? "up-t" : "down-t");

/* ---------- api ---------- */
async function api(path, opts) {
  let r;
  try { r = await fetch(path, opts); } catch { throw new Error("Cannot reach the Kronos server. Check that it is still running, then retry."); }
  if (!r.ok) {
    let m = r.statusText;
    try { m = (await r.json()).detail || m; } catch { /* not json */ }
    throw new Error(m);
  }
  return r.json();
}

/* ---------- shell: header, coins, tabs, settings ---------- */
function renderCoins() {
  $("#coins").innerHTML = Object.keys(COINS).map((c) => {
    const p = state.prices[c];
    return `<button class="coin" data-coin="${c}" aria-pressed="${c === state.coin}">
      <b>${c}</b><span>${p ? price(p.price) : "&nbsp;"}</span>${p ? `<em class="${tone(p.change)}">${pct(p.change)}</em>` : ""}</button>`;
  }).join("");
}
function renderTabs() {
  $("#tabs").innerHTML = VIEWS.map(([id, name]) => `<button class="tab" role="tab" data-view="${id}" aria-selected="${id === state.view}">${name}</button>`).join("");
}
function setStatus(ok, text) {
  const s = $("#status");
  s.className = "status" + (ok ? "" : " bad");
  s.innerHTML = `<i></i><span>${esc(text)}</span>`;
}
async function refreshPrices() {
  try {
    state.prices = await api("/api/prices");
    renderCoins();
    setStatus(true, `Live prices from Binance, updated ${clock.format(new Date())}. Forecasts refresh hourly.`);
  } catch (e) { setStatus(false, e.message); }
}

$("#coins").addEventListener("click", (e) => {
  const b = e.target.closest(".coin");
  if (!b || b.dataset.coin === state.coin) return;
  state.coin = b.dataset.coin; store.set("coin", state.coin);
  renderCoins(); render();
});
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (!b) return;
  state.view = b.dataset.view; store.set("view", state.view);
  renderTabs(); render();
});

const form = $("#settingsForm");
function syncSettingsForm() {
  for (const k of ["model", "hours", "paths", "variety"]) form.elements[k].value = state.settings[k];
  $("#pathsOut").textContent = state.settings.paths;
  $("#varietyOut").textContent = Number(state.settings.variety).toFixed(1);
}
form.addEventListener("input", () => {
  $("#pathsOut").textContent = form.elements.paths.value;
  $("#varietyOut").textContent = Number(form.elements.variety.value).toFixed(1);
});
form.addEventListener("submit", (e) => {
  e.preventDefault();
  state.settings = { model: form.elements.model.value, hours: +form.elements.hours.value, paths: +form.elements.paths.value, variety: +form.elements.variety.value };
  store.set("settings", state.settings);
  $("#settings").open = false;
  render();
});

/* ---------- view helpers ---------- */
function setView(html) { $("#view").innerHTML = html; }
function loadingHtml(title, detail) {
  const t0 = Date.now();
  clearInterval(state.timer);
  state.timer = setInterval(() => { const el = $("#elapsed"); if (el) el.textContent = Math.round((Date.now() - t0) / 1000) + "s"; }, 1000);
  return `<div class="state"><h3>${esc(title)}</h3><p>${esc(detail)} <span id="elapsed">0s</span></p><div class="progress loop"><i></i></div></div>`;
}
function errorHtml(msg) {
  return `<div class="state error"><h3>That did not work</h3><p>${esc(msg)}</p><button class="btn primary" id="retry">Try again</button></div>`;
}
function stat(label, value, foot = "", opts = {}) {
  return `<div class="stat ${opts.fut ? "fut" : ""}"><span>${label}</span><b class="${opts.small ? "sm" : ""}">${value}</b><span class="${opts.footTone || ""}">${foot}</span></div>`;
}
function table(head, rows, numeric = []) {
  return `<div class="table-wrap"><table><thead><tr>${head.map((h, i) => `<th class="${numeric.includes(i) ? "n" : ""}">${h}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${numeric.includes(i) ? "n" : ""}">${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
$("#view").addEventListener("click", (e) => { if (e.target.id === "retry") render(); });

/* ---------- chart (hand-drawn SVG) ---------- */
function niceTicks(lo, hi, count = 5) {
  const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw)), n = raw / mag;
  const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag, out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

/* o: { hist, fut, futCandles, fan, expected, lines:[{pts,color,w,dash,name}], height, legend } */
function drawChart(host, o) {
  host._ro?.disconnect();
  const draw = () => {
    const W = Math.max(host.clientWidth - 16, 320), H = o.height || 460, m = { l: 10, r: 68, t: 18, b: 34 };
    const slots = [];
    (o.hist || []).forEach((c) => slots.push({ t: c[0], o: c[1], h: c[2], l: c[3], c: c[4], k: "real" }));
    (o.fut || []).forEach((s) => slots.push({ t: s.t, o: s.o, h: s.h, l: s.l, c: s.c, min: s.min, max: s.max, k: "fc" }));
    if (!slots.length) return;
    const t0 = slots[0].t, t1 = slots[slots.length - 1].t + HOUR, pw = W - m.l - m.r, ph = H - m.t - m.b;
    const X = (t) => m.l + ((t - t0) / (t1 - t0)) * pw, cx = (t) => X(t + HOUR / 2), cw = Math.max(2, (pw / slots.length) * 0.6);
    const vals = [];
    slots.forEach((s) => { vals.push(s.h, s.l); if (o.fan && s.max !== undefined) vals.push(s.max, s.min); });
    (o.lines || []).forEach((ln) => ln.pts.forEach((p) => vals.push(p[1])));
    let lo = Math.min(...vals), hi = Math.max(...vals); const pad = (hi - lo) * 0.06 || hi * 0.01; lo -= pad; hi += pad;
    const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * ph;
    const dec = hi > 1000 ? 0 : hi > 10 ? 2 : 4;
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label || "Candlestick chart")}">
      `;
    niceTicks(lo, hi).forEach((v) => {
      s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="#fff" stroke-opacity=".07"/>
        <text x="${W - m.r + 8}" y="${Y(v) + 4}" fill="#8f98c0" font-size="12">$${num(v, dec)}</text>`;
    });
    const firstFut = (o.fut || [])[0];
    if (firstFut && (o.fan || o.futCandles)) {
      const xf = X(firstFut.t);
      s += `<rect x="${xf}" y="${m.t}" width="${W - m.r - xf}" height="${ph}" fill="${FUT}" fill-opacity=".05"/>
        <line x1="${xf}" x2="${xf}" y1="${m.t}" y2="${m.t + ph}" stroke="#fff" stroke-opacity=".35" stroke-dasharray="3 4"/>
        <text x="${xf - 7}" y="${m.t + 13}" text-anchor="end" fill="#8f98c0" font-size="12">Now</text>
        <text x="${xf + 7}" y="${m.t + 13}" fill="${"#c7beff"}" font-size="12">Forecast</text>`;
    }
    if (o.fan && o.fut) {
      const poly = (a, b) => o.fut.map((p) => `${cx(p.t)},${Y(p[a])}`).join(" ") + " " + [...o.fut].reverse().map((p) => `${cx(p.t)},${Y(p[b])}`).join(" ");
      s += `<polygon points="${poly("max", "min")}" fill="${FUT}" fill-opacity=".09"/><polygon points="${poly("q75", "q25")}" fill="${FUT}" fill-opacity=".24"/>`;
    }
    slots.forEach((c) => {
      if (c.k === "fc" && !o.futCandles) return;
      const up = c.c >= c.o, col = up ? UP : DOWN, x = cx(c.t), top = Y(Math.max(c.o, c.c)), h = Math.max(1.5, Math.abs(Y(c.o) - Y(c.c)));
      const fill = c.k === "real" ? col : col + "40";
      s += `<line x1="${x}" x2="${x}" y1="${Y(c.h)}" y2="${Y(c.l)}" stroke="${col}" stroke-width="${c.k === "real" ? 1.2 : 2}"/>
        <rect x="${x - cw / 2}" y="${top}" width="${cw}" height="${h}" fill="${fill}" stroke="${col}" stroke-width="${c.k === "real" ? 1 : 2}" rx="1"/>`;
    });
    if (o.expected && o.fut) s += `<polyline fill="none" stroke="#fff" stroke-width="2.5" stroke-linejoin="round" points="${o.fut.map((p) => `${cx(p.t)},${Y(p.c)}`).join(" ")}"/>`;
    (o.lines || []).forEach((ln) => {
      s += `<polyline fill="none" stroke="${ln.color}" stroke-width="${ln.w || 3}" ${ln.dash ? 'stroke-dasharray="2 6" stroke-linecap="round"' : ""} stroke-linejoin="round" points="${ln.pts.map((p) => `${cx(p[0])},${Y(p[1])}`).join(" ")}"/>`;
    });
    slots.forEach((c, i) => {
      const d = new Date(c.t);
      if (d.getHours() % 6 === 0 && (i === 0 || new Date(slots[i - 1].t).getHours() !== d.getHours())) {
        s += `<text x="${cx(c.t)}" y="${H - 12}" text-anchor="middle" fill="#8f98c0" font-size="12">${d.getHours() === 0 ? dayLbl.format(d) : clock.format(d)}</text>`;
      }
    });
    s += `<line class="xh" y1="${m.t}" y2="${m.t + ph}" stroke="#fff" stroke-opacity=".4" visibility="hidden"/></svg><div class="tip" hidden></div>`;
    const legend = host.querySelector(".legend")?.outerHTML || "";
    host.innerHTML = s + legend;

    const svg = host.querySelector("svg"), tip = host.querySelector(".tip"), xh = host.querySelector(".xh");
    svg.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W;
      let best = null, bd = Infinity;
      slots.forEach((c) => { const d = Math.abs(cx(c.t) - px); if (d < bd) { bd = d; best = c; } });
      if (!best || px < m.l || px > W - m.r) { tip.hidden = true; xh.setAttribute("visibility", "hidden"); return; }
      const x = cx(best.t); xh.setAttribute("x1", x); xh.setAttribute("x2", x); xh.setAttribute("visibility", "visible");
      let html = `<b>${when.format(new Date(best.t))}</b>`;
      if (best.k === "fc" && !o.futCandles) html += `<br>Expected close ${price(best.c)}<br>Range ${price(best.min)} to ${price(best.max)}`;
      else html += `<br>${best.k === "fc" ? "Forecast" : "Real"} candle<br>Open ${price(best.o)}<br>High ${price(best.h)}<br>Low ${price(best.l)}<br>Close ${price(best.c)}`;
      (o.lines || []).forEach((ln) => { const p = ln.pts.find((q) => q[0] === best.t); if (p) html += `<br>${esc(ln.name)} ${price(p[1])}`; });
      tip.innerHTML = html; tip.hidden = false;
      const hw = host.clientWidth, left = (x / W) * r.width + 8 + 14;
      tip.style.left = Math.min(left, hw - 190) + "px"; tip.style.top = "26px";
    });
    svg.addEventListener("pointerleave", () => { tip.hidden = true; xh.setAttribute("visibility", "hidden"); });
  };
  host.innerHTML = `<div class="legend">${o.legend || ""}</div>`;
  draw();
  let w = host.clientWidth;
  host._ro = new ResizeObserver(() => { if (Math.abs(host.clientWidth - w) > 4) { w = host.clientWidth; draw(); } });
  host._ro.observe(host);
}
const LEG = {
  real: '<span><i class="sw solid"></i>Real candles</span>',
  fc: '<span><i class="sw hollow"></i>Forecast candles</span>',
  exp: '<span><i class="sw line"></i>Expected path</span>',
  mid: '<span><i class="sw band"></i>Middle half of futures</span>',
  full: '<span><i class="sw band2"></i>Full range</span>',
  happened: '<span><i class="sw line"></i>What happened</span>',
  said: '<span><i class="sw dots"></i>What Kronos said</span>',
};

/* ---------- view: forecast ---------- */
async function viewForecast() {
  const tok = ++state.token, coin = state.coin, s = state.settings;
  setView(loadingHtml(`Forecasting ${COINS[coin]}`, "This takes up to a minute on a laptop."));
  let d;
  try { d = await api(`/api/forecast?coin=${coin}&hours=${s.hours}&paths=${s.paths}&model=${s.model}&variety=${s.variety}`); }
  catch (e) { if (tok === state.token) setView(errorHtml(e.message)); return; }
  if (tok !== state.token) return;
  clearInterval(state.timer);
  state.forecastEnds = d.last_t + 2 * HOUR;

  const steps = d.steps, last = d.last, end = steps[steps.length - 1].c, move = (end / last - 1) * 100, pUp = d.p_up, agree = Math.max(pUp, 1 - pUp);
  const dir = move > 0.3 ? "up" : move < -0.3 ? "down" : "flat";
  const strength = agree >= 0.8 ? "Strong agreement" : agree < 0.65 ? "Mixed signals" : "Moderate agreement";
  const hist = d.hist, tk = state.prices[coin];
  const nowPx = tk ? tk.price : last, chg24 = tk ? tk.change : hist.length > 24 ? (last / hist[hist.length - 25][4] - 1) * 100 : 0;
  const ups = Math.round(pUp * d.n_paths);
  const word = dir === "up" ? "higher" : "lower";
  const headline = dir === "flat" ? `${COINS[coin]} looks <span class="flat">flat</span> over the next ${s.hours} hours.`
    : `${COINS[coin]} is leaning <span class="${dir}">${word}</span> over the next ${s.hours} hours.`;
  const lastStep = steps[steps.length - 1];
  const picks = [1, 3, 6, 12, 18, 24, 36, 48].filter((h) => h <= steps.length);

  setView(`
    <h1 class="verdict">${headline}</h1>
    <p class="sub">Kronos expects a price near <b>${price(end)}</b> (${pct(move)}) in ${s.hours} hours. ${ups} of ${d.n_paths} simulated futures end above the current price. ${strength}.</p>
    <div class="stats">
      ${stat("Price now", price(nowPx), `${pct(chg24)} past 24 hours`, { footTone: tone(chg24) })}
      ${stat(`Expected in ${s.hours}h`, price(end), `${pct(move)} from the last close`, { fut: true })}
      ${stat("Simulated end-price range", `${rangePrice(lastStep.min)} to ${rangePrice(lastStep.max)}`, `lowest and highest of ${d.n_paths} futures`, { fut: true, small: true })}
      ${stat("Futures that end higher", `${ups} of ${d.n_paths}`, strength.toLowerCase(), { fut: true })}
    </div>
    <p class="basis">The forecast starts from the last closed hourly candle at ${price(last)}, so it can differ slightly from the live price.</p>
    <div class="chart" id="chartMain"></div>
    <h2>Hour by hour</h2>
    ${table(["When", "From now", "Expected price", "Change vs now", "Low end", "High end"],
      picks.map((h) => { const p = steps[h - 1], ch = (p.c / last - 1) * 100; return [when.format(new Date(p.t + HOUR)), `+${h}h`, price(p.c), `<span class="${tone(ch)}">${pct(ch)}</span>`, price(p.min), price(p.max)]; }),
      [2, 3, 4, 5])}
    <h2>Forecast candles up close</h2>
    <p class="cap">Each candle is one predicted hour: where the price opens, how far it swings, and where it closes. Hover for the numbers.</p>
    <div class="chart" id="chartZoom"></div>
    <details class="more"><summary>All forecast numbers</summary>
      ${table(["Hour starting", "Open", "High", "Low", "Close"], steps.map((p) => [when.format(new Date(p.t)), price(p.o), price(p.h), price(p.l), price(p.c)]), [1, 2, 3, 4])}
    </details>`);
  drawChart($("#chartMain"), { hist, fut: steps, futCandles: true, fan: true, expected: true, height: 500, label: `${COINS[coin]} price history and forecast`,
    legend: LEG.real + LEG.fc + LEG.exp + LEG.mid + LEG.full });
  drawChart($("#chartZoom"), { hist: [], fut: steps, futCandles: true, height: 360, label: `${COINS[coin]} forecast candles`, legend: LEG.fc });
}

/* ---------- view: accuracy ---------- */
async function viewAccuracy() {
  const tok = ++state.token, coin = state.coin, s = state.settings, h = Math.min(24, s.hours);
  setView(loadingHtml(`Replaying the forecast for ${COINS[coin]}`, "This takes up to a minute on a laptop."));
  let d;
  try { d = await api(`/api/accuracy?coin=${coin}&hours=${h}&paths=${s.paths}&model=${s.model}&variety=${s.variety}`); }
  catch (e) { if (tok === state.token) setView(errorHtml(e.message)); return; }
  if (tok !== state.token) return;
  clearInterval(state.timer);
  const steps = d.steps, act = d.actual, start = d.last;
  const predMove = (steps[steps.length - 1].c / start - 1) * 100, realMove = (act[act.length - 1][4] / start - 1) * 100, hit = (predMove > 0) === (realMove > 0);
  const miss = steps.reduce((a, p, i) => a + Math.abs(p.c - act[i][4]) / act[i][4], 0) / steps.length * 100;
  const inside = steps.filter((p, i) => act[i][4] >= p.min && act[i][4] <= p.max).length / steps.length * 100;
  setView(`
    <p class="lead">A fair test for ${COINS[coin]}: Kronos forecasts the last ${h} hours using only the data from before them. Then you can compare its guess with what really happened.</p>
    <div class="stats three">
      ${stat("Direction", `<span class="${hit ? "up-t" : "down-t"}">${hit ? "Right" : "Wrong"}</span>`, `Kronos said ${pct(predMove)}, the price moved ${pct(realMove)}`)}
      ${stat("Average miss", `${num(miss)}%`, "between forecast and real price, per hour")}
      ${stat("Hours inside the range", `${Math.round(inside)}%`, "real price within the simulated futures")}
    </div>
    <div class="chart" id="chartAcc"></div>
    <p class="small">This is one window for one coin, so it proves little by itself. Run <code>python backtest.py</code> for a week-long test across all coins.</p>`);
  drawChart($("#chartAcc"), {
    hist: d.hist, fut: steps, fan: true, height: 460, label: "Forecast compared with what happened",
    lines: [{ pts: act.map((c) => [c[0], c[4]]), color: "#fff", w: 3, name: "Real close" }, { pts: steps.map((p) => [p.t, p.c]), color: FUT, w: 3.5, dash: true, name: "Kronos close" }],
    legend: LEG.real + LEG.happened + LEG.said + LEG.mid + LEG.full });
}

/* ---------- scan helper, shared by "All coins" and "Paper money" ---------- */
async function runScan(offset, box, label, resumeId) {
  let job = resumeId;
  if (!job) { ({ job } = await api(`/api/scan?offset=${offset}`, { method: "POST" })); store.set("job" + offset, { id: job, at: Date.now() }); }
  for (;;) {
    const j = await api(`/api/job/${job}`);
    box.innerHTML = `<div class="progress"><i style="width:${(j.done / j.total) * 100}%"></i></div><div class="small">${esc(label)} ${j.done} of ${j.total} coins done.</div>`;
    if (j.error) throw new Error(j.error);
    if (j.finished) return j.rows;
    await sleep(1500);
  }
}
/* picks up a scan that was started before the page was reloaded */
async function resumeScan(offset, box, label) {
  const j = store.get("job" + offset, null);
  if (!j || Date.now() - j.at > 3600e3) return null;
  try { return { rows: await runScan(offset, box, label, j.id), at: j.at }; } catch { return null; }
}
const leans = (r) => (r.exp > 0.3 && r.pup >= 0.6 ? "up" : r.exp < -0.3 && r.pup <= 0.4 ? "down" : "unsure");

/* ---------- view: all coins ---------- */
function scanTable(rows) {
  return table(["Coin", "Price", "Expected in 24h", "Chance of ending higher", "Kronos leans"],
    [...rows].sort((a, b) => b.exp - a.exp).map((r) => {
      const l = leans(r);
      return [`${COINS[r.coin]} (${r.coin})`, price(r.now), `<span class="${tone(r.exp)}">${pct(r.exp)}</span>`,
        `<span class="bar"><i style="width:${r.pup * 100}%"></i></span>${Math.round(r.pup * 100)}%`,
        `<span class="pill ${l}">${l === "up" ? "Up" : l === "down" ? "Down" : "Unsure"}</span>`];
    }), [1, 2]);
}
function viewScan() {
  ++state.token; clearInterval(state.timer);
  const draw = () => {
    setView(`<p class="lead">Kronos forecasts the next 24 hours for all ten coins and ranks them. A full scan takes a few minutes on a laptop.</p>
      <button class="btn primary" id="scanBtn">${state.scan ? "Scan again" : "Scan all coins"}</button>
      <div id="scanBox" style="margin:14px 0"></div>
      ${state.scan ? `<p class="cap">Scanned at ${state.scan.at}. Sorted from the strongest expected rise to the strongest expected fall.</p>${scanTable(state.scan.rows)}
        <p class="small">"Unsure" means the expected move is under 0.3% or the simulated futures disagree.</p>` : ""}`);
    $("#scanBtn").onclick = async () => {
      $("#scanBtn").disabled = true;
      try { const rows = await runScan(0, $("#scanBox"), "Scanning."); state.scan = { rows, at: clock.format(new Date()) }; if (state.view === "scan") draw(); }
      catch (e) { if (state.view === "scan") { $("#scanBox").innerHTML = `<p class="down-t">${esc(e.message)}</p>`; $("#scanBtn").disabled = false; } }
    };
    if (!state.scan && store.get("job0", null)) {
      $("#scanBtn").disabled = true;
      resumeScan(0, $("#scanBox"), "Scanning.").then((r) => {
        if (state.view !== "scan") return;
        if (r) { state.scan = { rows: r.rows, at: clock.format(new Date(r.at)) }; draw(); } else { $("#scanBox").innerHTML = ""; $("#scanBtn").disabled = false; }
      });
    }
  };
  draw();
}

/* ---------- view: paper money ---------- */
function allocate(rows, p) {
  if (p.mode === "equal") return Object.fromEntries(rows.map((r) => [r.coin, { amount: p.budget / rows.length, side: 1 }]));
  const cand = [];
  rows.forEach((r) => {
    if (r.exp > 0.3 && r.pup >= 0.6) cand.push([Math.abs(r.exp), r.coin, 1]);
    else if (p.shorts && r.exp < -0.3 && r.pup <= 0.4) cand.push([Math.abs(r.exp), r.coin, -1]);
  });
  cand.sort((a, b) => b[0] - a[0]);
  const top = cand.slice(0, p.topN), tot = top.reduce((a, c) => a + c[0], 0);
  return Object.fromEntries(top.map(([sc, coin, side]) => [coin, { amount: (p.budget * sc) / tot, side }]));
}
const worth = (amount, side, move, fee) => amount * (1 + (side * move) / 100) - amount * 2 * (fee / 100);

function replayHtml(rows, p) {
  const sym = p.sym, alloc = allocate(rows, p);
  rows.forEach((r) => { r.actual = (r.now / r.start - 1) * 100; });
  const invested = Object.values(alloc).reduce((a, x) => a + x.amount, 0);
  const value = p.budget - invested + rows.reduce((a, r) => a + (alloc[r.coin] ? worth(alloc[r.coin].amount, alloc[r.coin].side, r.actual, p.fee) : 0), 0);
  const hold = rows.reduce((a, r) => a + worth(p.budget / rows.length, 1, r.actual, p.fee), 0);
  const order = [...rows].sort((a, b) => (alloc[b.coin]?.amount || 0) - (alloc[a.coin]?.amount || 0));
  return `<h2>If you had started 24 hours ago</h2>
    <div class="stats three">
      ${stat("Following Kronos", sym + num(value), `${signed(value - p.budget)} after costs`, { fut: true, footTone: tone(value - p.budget) })}
      ${stat("Holding all ten coins equally", sym + num(hold), `${signed(hold - p.budget)} after costs`, { footTone: tone(hold - p.budget) })}
      ${stat("Kept as cash", sym + num(p.budget - invested), "not invested")}
    </div>
    ${Object.keys(alloc).length ? "" : '<p class="cap">Kronos was not sure enough about any coin, so the money would have stayed in cash.</p>'}
    ${table(["Coin", "Bet", "Kronos expected", "What happened", "Put in", "Worth after"], order.map((r) => {
      const a = alloc[r.coin];
      return [r.coin, a ? (a.side > 0 ? "Rise" : "Fall") : "No bet", pct(r.exp), `<span class="${tone(r.actual)}">${pct(r.actual)}</span>`, a ? sym + num(a.amount) : "", a ? sym + num(worth(a.amount, a.side, r.actual, p.fee)) : ""];
    }), [2, 3, 4, 5])}
    <p class="small">One day proves little. Bigger bets swing further in both directions.</p>`;
}

async function liveHtml() {
  const lv = store.get("live", null);
  if (!lv) return "";
  const coins = Object.keys(lv.positions), data = {};
  try { await Promise.all(coins.map(async (c) => { data[c] = await api(`/api/candles?coin=${c}`); })); }
  catch (e) { return `<h2>Live portfolio</h2><p class="down-t">${esc(e.message)}</p>`; }
  const endT = lv.entryTs + 24 * HOUR;
  let total = lv.budget - coins.reduce((a, c) => a + lv.positions[c].amount, 0); const cash = total; let done = false, hours = 0;
  const rows = coins.map((c) => {
    const cs = data[c], p = lv.positions[c], fin = cs.find((x) => x[0] >= endT), px = (fin || cs[cs.length - 1])[4];
    done = !!fin; hours = Math.max(0, Math.min(24, Math.floor((cs[cs.length - 1][0] - lv.entryTs) / HOUR)));
    const v = worth(p.amount, p.side, (px / p.entry - 1) * 100, lv.fee); total += v;
    return [c, p.side > 0 ? "Rise" : "Fall", lv.sym + num(p.amount), price(p.entry), price(px), pct(p.expected), lv.sym + num(v), `<span class="${tone(v - p.amount)}">${signed(v - p.amount)}</span>`];
  });
  return `<h2>Live portfolio, started ${when.format(new Date(lv.entryTs + HOUR))}</h2>
    <div class="stats three">
      ${stat(done ? "Final value" : "Value now", lv.sym + num(total), `${signed(total - lv.budget)} after costs`, { fut: true, footTone: tone(total - lv.budget) })}
      ${stat("Progress", done ? "Finished" : `${hours} of 24 hours`, "the bets close after 24 hours")}
      ${stat("Kept as cash", lv.sym + num(cash), "not invested")}
    </div>
    ${rows.length ? table(["Coin", "Bet", "Put in", "Price at start", done ? "Price at end" : "Price now", "Kronos expected", "Worth", "Result"], rows, [2, 3, 4, 5, 6, 7])
      : '<p class="cap">Kronos was not sure enough about any coin, so all of the money stayed in cash.</p>'}
    <p style="margin-top:14px"><button class="btn" id="resetLive">Reset portfolio</button></p>`;
}

async function viewPaper() {
  const tok = ++state.token; clearInterval(state.timer);
  const p = state.paper;
  setView(`<p class="lead">Try Kronos with pretend money. Nothing here is connected to an exchange and no real trade is ever placed.</p>
    <div class="form">
      <label class="field">Pretend amount<input type="number" id="pBudget" min="10" max="1000000" step="10" value="${p.budget}"></label>
      <label class="field">Currency<select id="pSym">${["$", "€", "£"].map((s) => `<option ${s === p.sym ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      <label class="field">Cost per trade <output id="pFeeOut">${p.fee.toFixed(2)}%</output><input type="range" id="pFee" min="0" max="0.5" step="0.05" value="${p.fee}"></label>
      <div class="field">How to split it<div class="radio">
        <label><input type="radio" name="pMode" value="kronos" ${p.mode === "kronos" ? "checked" : ""}>Kronos picks</label>
        <label><input type="radio" name="pMode" value="equal" ${p.mode === "equal" ? "checked" : ""}>Split equally</label></div></div>
      <label class="field">Coins to bet on <output id="pTopOut">${p.topN}</output><input type="range" id="pTop" min="1" max="5" step="1" value="${p.topN}"></label>
      <label class="check"><input type="checkbox" id="pShorts" ${p.shorts ? "checked" : ""}>Bet on falls too</label>
    </div>
    <p class="small" style="margin:-6px 0 16px">Cost per trade covers the exchange fee and slippage, charged when buying and again when selling. About 0.15% is typical for large coins. Bets on falls need a futures account on a real exchange.</p>
    <div class="actions"><button class="btn" id="replayBtn">Replay the last 24 hours</button><button class="btn primary" id="startBtn">Start a live portfolio</button></div>
    <p class="small">Either button forecasts all ten coins first, which takes a few minutes on a laptop.</p>
    <div id="paperBox" style="margin:14px 0"></div><div id="replayOut"></div><div id="liveOut"></div>`);

  const read = () => {
    state.paper = { budget: Math.max(10, +$("#pBudget").value || 100), sym: $("#pSym").value, fee: +$("#pFee").value, mode: document.querySelector("input[name=pMode]:checked").value, topN: +$("#pTop").value, shorts: $("#pShorts").checked };
    store.set("paper", state.paper); return state.paper;
  };
  const redraw = () => { if (state.replay) $("#replayOut").innerHTML = replayHtml(state.replay, state.paper); };
  document.querySelector(".form").addEventListener("input", () => {
    read(); $("#pFeeOut").textContent = state.paper.fee.toFixed(2) + "%"; $("#pTopOut").textContent = state.paper.topN; redraw();
  });
  const busy = (b) => { $("#replayBtn").disabled = b; $("#startBtn").disabled = b; };
  $("#replayBtn").onclick = async () => {
    busy(true);
    try { state.replay = await runScan(24, $("#paperBox"), "Forecasting yesterday."); $("#paperBox").innerHTML = ""; if (state.view === "paper") redraw(); }
    catch (e) { $("#paperBox").innerHTML = `<p class="down-t">${esc(e.message)}</p>`; }
    if (state.view === "paper") busy(false);
  };
  $("#startBtn").onclick = async () => {
    busy(true);
    try {
      const rows = await runScan(0, $("#paperBox"), "Forecasting every coin."), pp = read(), alloc = allocate(rows, pp);
      store.set("live", { entryTs: rows[0].ts, sym: pp.sym, budget: pp.budget, fee: pp.fee, mode: pp.mode,
        positions: Object.fromEntries(rows.filter((r) => alloc[r.coin]).map((r) => [r.coin, { amount: alloc[r.coin].amount, side: alloc[r.coin].side, entry: r.now, expected: r.exp }])) });
      $("#paperBox").innerHTML = "";
      if (state.view === "paper") { $("#liveOut").innerHTML = await liveHtml(); bindLive(); }
    } catch (e) { $("#paperBox").innerHTML = `<p class="down-t">${esc(e.message)}</p>`; }
    if (state.view === "paper") busy(false);
  };
  const bindLive = () => { const b = $("#resetLive"); if (b) b.onclick = () => { store.del("live"); $("#liveOut").innerHTML = ""; }; };
  redraw();
  if (!state.replay && store.get("job24", null)) {
    busy(true);
    resumeScan(24, $("#paperBox"), "Forecasting yesterday.").then((r) => {
      if (state.view !== "paper") return;
      $("#paperBox").innerHTML = ""; busy(false);
      if (r) { state.replay = r.rows; redraw(); }
    });
  }
  const html = await liveHtml();
  if (tok === state.token) { $("#liveOut").innerHTML = html; bindLive(); }
}

/* ---------- router and timers ---------- */
function render() {
  clearInterval(state.timer);
  ({ forecast: viewForecast, accuracy: viewAccuracy, scan: viewScan, paper: viewPaper })[state.view]();
}
setInterval(refreshPrices, 30000);
setInterval(() => { if (state.view === "forecast" && state.forecastEnds && Date.now() > state.forecastEnds + 30000) { state.forecastEnds = 0; render(); } }, 60000);

syncSettingsForm(); renderCoins(); renderTabs(); refreshPrices(); render();
