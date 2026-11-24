// Bar-by-bar backtest engine for strategy scripts.
//
// How orders are simulated (and how to read the results):
//  - Signals are evaluated on a bar's close. With fillOn 'open' (default) the order fills at the
//    NEXT bar's open; with 'close' it fills at the same bar's close. No signal ever sees the future.
//  - One net position: an entry in the opposite direction first closes the open position (a reversal).
//    `pyramiding` sets how many entries may stack in the same direction.
//  - Stop-loss / take-profit / trailing exits are checked against each bar's high and low.
//    If a bar opens beyond a level, the exit fills at the open (a gap). If a bar touches both the
//    stop and the target, the stop is assumed to have been hit first (the conservative choice).
//  - Commission (percent of trade value) is charged on every fill; slippage (percent) moves every
//    fill price against you.

const DEFAULTS = {
  initialCapital: 10000,
  sizeType: 'percent', // 'percent' of equity, 'cash' amount, or 'fixed' quantity
  sizeValue: 100,
  commission: 0,       // percent per fill
  slippage: 0,         // percent per fill
  pyramiding: 1,
  fillOn: 'open',      // 'open' = next bar's open, 'close' = this bar's close
};

export const STRATEGY_DEFAULTS = DEFAULTS;

const truthy = (when, i) => {
  if (when === true) return true;
  if (!when) return false;
  if (typeof when === 'function') return !!when(i);
  const v = when[i];
  return !!v && !Number.isNaN(v);
};

const valueAt = (v, i) => {
  if (v == null) return null;
  const x = typeof v === 'number' ? v : v[i];
  return Number.isFinite(x) ? x : null;
};

/**
 * bars:  [{ time, open, high, low, close, volume }]
 * rules: { entries: [{ id, dir, when, qty?, comment? }], closes: [{ id|null, when }],
 *          exits: [{ from|null, stopLoss?, takeProfit?, trailing?, stopPrice?, limitPrice? }] }
 * onBar: optional (i, s) => void for stateful logic (see strategy.onBar in the docs)
 */
export function runBacktest(bars, rules, props = {}, onBar = null, tfSec = 86400) {
  const P = { ...DEFAULTS, ...Object.fromEntries(Object.entries(props).filter(([, v]) => v != null)) };
  P.pyramiding = Math.max(1, Math.floor(P.pyramiding));
  const n = bars.length;
  const lots = [];
  const trades = [];
  const markers = [];
  const equity = new Float64Array(n);
  const drawdown = new Float64Array(n);
  const buyHold = new Float64Array(n);
  let realized = 0;
  let commissionPaid = 0;
  let pending = [];
  let barsInMarket = 0;

  const slip = (price, isBuy) => price * (1 + ((isBuy ? 1 : -1) * P.slippage) / 100);
  const openPnl = (price) => lots.reduce((a, l) => a + (l.side === 'long' ? price - l.price : l.price - price) * l.qty, 0);
  const equityAt = (price) => P.initialCapital + realized + openPnl(price);
  const side = () => lots[0]?.side || null;

  function closeLot(lot, price, i, reason) {
    const px = slip(price, lot.side === 'short');
    const comm = (Math.abs(px * lot.qty) * P.commission) / 100;
    const gross = (lot.side === 'long' ? px - lot.price : lot.price - px) * lot.qty;
    realized += gross - comm;
    commissionPaid += comm;
    const pnl = gross - comm - lot.entryComm;
    trades.push({
      id: lot.id, side: lot.side, qty: lot.qty, comment: lot.comment,
      entryIndex: lot.i, entryPrice: lot.price, exitIndex: i, exitPrice: px, reason,
      pnl, pnlPct: (pnl / (lot.price * lot.qty)) * 100,
      commission: comm + lot.entryComm,
      runup: lot.runup, runupPct: (lot.runup / (lot.price * lot.qty)) * 100,
      drawdown: lot.dd, drawdownPct: (lot.dd / (lot.price * lot.qty)) * 100,
      bars: i - lot.i,
    });
    lots.splice(lots.indexOf(lot), 1);
    markers.push({ i, kind: 'exit', side: lot.side, reason, id: lot.id, price: px });
  }

  function openLot(order, price, i) {
    const px = slip(price, order.dir === 'long');
    const eq = equityAt(price);
    let qty = order.qty;
    if (!(qty > 0)) {
      qty = P.sizeType === 'fixed' ? P.sizeValue : P.sizeType === 'cash' ? P.sizeValue / px : (eq * P.sizeValue) / 100 / px;
    }
    if (!(qty > 0) || !Number.isFinite(qty) || eq <= 0) return;
    const comm = (Math.abs(px * qty) * P.commission) / 100;
    realized -= comm;
    commissionPaid += comm;
    lots.push({
      id: order.id, side: order.dir, qty, price: px, i, entryComm: comm, comment: order.comment || '',
      best: order.dir === 'long' ? -Infinity : Infinity, runup: 0, dd: 0,
    });
    markers.push({ i, kind: 'entry', side: order.dir, id: order.id, price: px, comment: order.comment || '' });
  }

  function execute(order, price, i) {
    if (order.type === 'close') {
      for (const lot of [...lots]) if (order.id == null || lot.id === order.id) closeLot(lot, price, i, order.reason || 'Close');
      return;
    }
    if (side() && side() !== order.dir) for (const lot of [...lots]) closeLot(lot, price, i, 'Reverse');
    if (lots.length >= P.pyramiding) return;
    openLot(order, price, i);
  }

  function executeAll(orders, price, i) {
    // Closes first, then entries (so "close long, go short" on the same bar works).
    for (const o of orders) if (o.type === 'close') execute(o, price, i);
    for (const o of orders) if (o.type === 'entry') execute(o, price, i);
  }

  /** Stop-loss, take-profit and trailing exits during bar i. */
  function checkExits(i, b) {
    if (!rules.exits.length || !lots.length) return;
    for (const lot of [...lots]) {
      if (P.fillOn === 'close' && lot.i === i) continue; // opened at this close
      const long = lot.side === 'long';
      let stop = null, stopReason = 'Stop loss', target = null;
      const addStop = (price, reason) => {
        if (price != null && (stop == null || (long ? price > stop : price < stop))) { stop = price; stopReason = reason; }
      };
      const addTarget = (price) => {
        if (price != null && (target == null || (long ? price < target : price > target))) target = price;
      };
      const ref = i > 0 ? i - 1 : i; // price levels are known at the previous close
      for (const r of rules.exits) {
        if (r.from != null && r.from !== lot.id) continue;
        if (r.stopLoss > 0) addStop(long ? lot.price * (1 - r.stopLoss / 100) : lot.price * (1 + r.stopLoss / 100), 'Stop loss');
        if (r.takeProfit > 0) addTarget(long ? lot.price * (1 + r.takeProfit / 100) : lot.price * (1 - r.takeProfit / 100));
        addStop(valueAt(r.stopPrice, ref), 'Stop');
        addTarget(valueAt(r.limitPrice, ref));
        if (r.trailing > 0 && Number.isFinite(lot.best)) {
          addStop(long ? lot.best * (1 - r.trailing / 100) : lot.best * (1 + r.trailing / 100), 'Trailing stop');
        }
      }
      if (long) {
        if (stop != null && b.open <= stop) closeLot(lot, b.open, i, stopReason);
        else if (target != null && b.open >= target) closeLot(lot, b.open, i, 'Take profit');
        else if (stop != null && b.low <= stop) closeLot(lot, stop, i, stopReason);
        else if (target != null && b.high >= target) closeLot(lot, target, i, 'Take profit');
      } else if (stop != null && b.open >= stop) closeLot(lot, b.open, i, stopReason);
      else if (target != null && b.open <= target) closeLot(lot, b.open, i, 'Take profit');
      else if (stop != null && b.high >= stop) closeLot(lot, stop, i, stopReason);
      else if (target != null && b.low <= target) closeLot(lot, target, i, 'Take profit');
    }
  }

  // The object strategy.onBar callbacks receive.
  let queue = [];
  const s = {
    get position() {
      if (!lots.length) return { side: null, qty: 0, avgPrice: null, openProfit: 0, barsInTrade: 0 };
      const qty = lots.reduce((a, l) => a + l.qty, 0);
      const avg = lots.reduce((a, l) => a + l.price * l.qty, 0) / qty;
      return { side: side(), qty, avgPrice: avg, openProfit: openPnl(bars[s.i].close), barsInTrade: s.i - lots[0].i };
    },
    get equity() { return equityAt(bars[s.i].close); },
    i: 0,
    long(id = 'Long', opts = {}) { queue.push({ type: 'entry', id: String(id), dir: 'long', qty: opts.qty, comment: opts.comment }); },
    short(id = 'Short', opts = {}) { queue.push({ type: 'entry', id: String(id), dir: 'short', qty: opts.qty, comment: opts.comment }); },
    close(id = null, opts = {}) { queue.push({ type: 'close', id: id == null ? null : String(id), reason: opts.comment || 'Close' }); },
  };

  for (let i = 0; i < n; i++) {
    const b = bars[i];
    if (pending.length) { executeAll(pending, b.open, i); pending = []; }
    checkExits(i, b);
    for (const lot of lots) {
      // track the best price (for trailing stops) and each trade's run-up / drawdown
      lot.best = lot.side === 'long' ? Math.max(lot.best, b.high) : Math.min(lot.best, b.low);
      const fav = (lot.side === 'long' ? b.high - lot.price : lot.price - b.low) * lot.qty;
      const adv = (lot.side === 'long' ? lot.price - b.low : b.high - lot.price) * lot.qty;
      lot.runup = Math.max(lot.runup, fav);
      lot.dd = Math.max(lot.dd, adv);
    }
    // signals on this bar's close
    queue = [];
    for (const r of rules.closes) if (truthy(r.when, i)) queue.push({ type: 'close', id: r.id, reason: 'Close' });
    for (const r of rules.entries) if (truthy(r.when, i)) queue.push({ type: 'entry', id: r.id, dir: r.dir, qty: r.qty, comment: r.comment });
    if (onBar) { s.i = i; onBar(i, s); }
    if (P.fillOn === 'close') executeAll(queue, b.close, i);
    else pending = queue;
    if (lots.length) barsInMarket++;
    equity[i] = equityAt(b.close);
  }

  // Report
  const first = bars[0]?.close;
  let peak = -Infinity, maxDD = 0, maxDDPct = 0;
  for (let i = 0; i < n; i++) {
    peak = Math.max(peak, equity[i]);
    const dd = peak - equity[i];
    drawdown[i] = peak > 0 ? -(dd / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
    if (peak > 0 && dd / peak > maxDDPct) maxDDPct = dd / peak;
    buyHold[i] = first ? (P.initialCapital * bars[i].close) / first : P.initialCapital;
  }
  const last = bars[n - 1];
  const openTrades = lots.map((l) => {
    const pnl = (l.side === 'long' ? last.close - l.price : l.price - last.close) * l.qty - l.entryComm;
    return { id: l.id, side: l.side, qty: l.qty, entryIndex: l.i, entryPrice: l.price, pnl, pnlPct: (pnl / (l.price * l.qty)) * 100, bars: n - 1 - l.i, comment: l.comment };
  });

  const rets = [];
  for (let i = 1; i < n; i++) if (equity[i - 1] > 0) rets.push(equity[i] / equity[i - 1] - 1);
  const mean = rets.reduce((a, r) => a + r, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length || 1));
  const downside = Math.sqrt(rets.reduce((a, r) => a + Math.min(r, 0) ** 2, 0) / (rets.length || 1));
  const perYear = Math.sqrt((365 * 86400) / Math.max(60, tfSec));

  const summary = {
    ...stats(trades, P.initialCapital),
    long: stats(trades.filter((t) => t.side === 'long'), P.initialCapital),
    short: stats(trades.filter((t) => t.side === 'short'), P.initialCapital),
    maxDrawdown: maxDD,
    maxDrawdownPct: maxDDPct * 100,
    openPnl: openTrades.reduce((a, t) => a + t.pnl, 0),
    finalEquity: equity[n - 1] ?? P.initialCapital,
    buyHoldPct: first && last ? (last.close / first - 1) * 100 : null,
    sharpe: sd > 0 ? (mean / sd) * perYear : null,
    sortino: downside > 0 ? (mean / downside) * perYear : null,
    exposurePct: n ? (barsInMarket / n) * 100 : 0,
    commissionPaid,
    bars: n,
  };

  return { props: P, trades, openTrades, markers, equity, drawdown, buyHold, summary };
}

function stats(list, capital) {
  const wins = list.filter((t) => t.pnl > 0);
  const losses = list.filter((t) => t.pnl <= 0);
  const sum = (a, k = 'pnl') => a.reduce((x, t) => x + t[k], 0);
  const gp = sum(wins), gl = sum(losses);
  let streakW = 0, streakL = 0, maxW = 0, maxL = 0;
  for (const t of list) {
    if (t.pnl > 0) { streakW++; streakL = 0; } else { streakL++; streakW = 0; }
    maxW = Math.max(maxW, streakW);
    maxL = Math.max(maxL, streakL);
  }
  const avg = (a, k = 'pnl') => (a.length ? sum(a, k) / a.length : null);
  return {
    netProfit: gp + gl,
    netProfitPct: ((gp + gl) / capital) * 100,
    grossProfit: gp,
    grossLoss: gl,
    profitFactor: gl < 0 ? gp / -gl : gp > 0 ? Infinity : null,
    trades: list.length,
    wins: wins.length,
    losses: losses.length,
    winRate: list.length ? (wins.length / list.length) * 100 : null,
    avgTrade: avg(list),
    avgTradePct: avg(list, 'pnlPct'),
    avgWin: avg(wins),
    avgLoss: avg(losses),
    ratioWinLoss: wins.length && losses.length && avg(losses) < 0 ? avg(wins) / -avg(losses) : null,
    largestWin: wins.length ? Math.max(...wins.map((t) => t.pnl)) : null,
    largestLoss: losses.length ? Math.min(...losses.map((t) => t.pnl)) : null,
    avgBars: avg(list, 'bars'),
    maxConsecWins: maxW,
    maxConsecLosses: maxL,
    commission: sum(list, 'commission'),
  };
}
