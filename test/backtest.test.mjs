// Unit tests for the backtest engine. Run: npm test
import { runBacktest } from '../public/js/backtest.js';

let failed = 0;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}
const bar = (t, o, h, l, c) => ({ time: t, open: o, high: h, low: l, close: c, volume: 1 });
const flags = (n, idx) => Array.from({ length: n }, (_, i) => idx.includes(i));
const rules = (r = {}) => ({ entries: [], closes: [], exits: [], ...r });

// open = previous close, simple ramps
const bars = [
  bar(0, 100, 101, 99, 100),
  bar(1, 100, 102, 99, 101),  // signal here
  bar(2, 102, 104, 101, 103), // entry fills at open 102
  bar(3, 103, 106, 102, 105),
  bar(4, 105, 108, 104, 107), // close signal here
  bar(5, 110, 111, 108, 109), // exit fills at open 110
  bar(6, 109, 110, 107, 108),
];
const n = bars.length;

console.log('next-open fills');
{
  const r = runBacktest(bars, rules({ entries: [{ id: 'L', dir: 'long', when: flags(n, [1]) }], closes: [{ id: null, when: flags(n, [4]) }] }));
  const t = r.trades[0];
  check('one trade', r.trades.length === 1);
  check('entry at next open (bar 2 @ 102)', t.entryIndex === 2 && t.entryPrice === 102);
  check('exit at next open (bar 5 @ 110)', t.exitIndex === 5 && t.exitPrice === 110);
  const qty = 10000 / 102;
  check('qty = 100% of equity', near(t.qty, qty));
  check('pnl = (110-102)*qty', near(t.pnl, 8 * qty), `${t.pnl}`);
  check('net profit matches', near(r.summary.netProfit, 8 * qty));
  check('equity at end = capital + pnl', near(r.equity[n - 1], 10000 + 8 * qty));
}

console.log('fill on close');
{
  const r = runBacktest(bars, rules({ entries: [{ id: 'L', dir: 'long', when: flags(n, [1]) }], closes: [{ id: null, when: flags(n, [4]) }] }), { fillOn: 'close' });
  const t = r.trades[0];
  check('entry at signal close (bar 1 @ 101)', t.entryIndex === 1 && t.entryPrice === 101);
  check('exit at signal close (bar 4 @ 107)', t.exitIndex === 4 && t.exitPrice === 107);
}

console.log('commission and slippage');
{
  const r = runBacktest(bars, rules({ entries: [{ id: 'L', dir: 'long', when: flags(n, [1]) }], closes: [{ id: null, when: flags(n, [4]) }] }), { commission: 0.1, slippage: 0.05 });
  const t = r.trades[0];
  const ein = 102 * 1.0005, eout = 110 * 0.9995;
  check('slippage worsens entry and exit', near(t.entryPrice, ein) && near(t.exitPrice, eout));
  const qty = 10000 / ein;
  const comm = (ein * qty + eout * qty) * 0.001;
  check('commission on both fills', near(t.commission, comm), `${t.commission} vs ${comm}`);
  check('pnl net of commission', near(t.pnl, (eout - ein) * qty - comm));
}

console.log('stop loss, take profit, gaps, same-bar ambiguity');
{
  const b2 = [
    bar(0, 100, 100, 100, 100),
    bar(1, 100, 100, 100, 100), // signal
    bar(2, 100, 101, 99, 100),  // entry @100
    bar(3, 100, 100.5, 94, 96), // low 94 hits the 5% stop at 95
    bar(4, 96, 96, 96, 96),
  ];
  const r = runBacktest(b2, rules({ entries: [{ id: 'L', dir: 'long', when: flags(5, [1]) }], exits: [{ from: null, stopLoss: 5 }] }));
  check('stop fills at the stop price', r.trades[0]?.exitPrice === 95 && r.trades[0].reason === 'Stop loss', JSON.stringify(r.trades[0]));

  const gap = b2.map((b) => ({ ...b }));
  gap[3] = bar(3, 90, 92, 89, 91); // opens below the stop
  const g = runBacktest(gap, rules({ entries: [{ id: 'L', dir: 'long', when: flags(5, [1]) }], exits: [{ from: null, stopLoss: 5 }] }));
  check('gap through stop fills at the open', g.trades[0]?.exitPrice === 90);

  const both = b2.map((b) => ({ ...b }));
  both[3] = bar(3, 100, 111, 94, 100); // touches stop (95) and target (110)
  const s = runBacktest(both, rules({ entries: [{ id: 'L', dir: 'long', when: flags(5, [1]) }], exits: [{ from: null, stopLoss: 5, takeProfit: 10 }] }));
  check('stop wins when both are touched', s.trades[0]?.reason === 'Stop loss');

  const tp = b2.map((b) => ({ ...b }));
  tp[3] = bar(3, 100, 111, 99, 108);
  const t = runBacktest(tp, rules({ entries: [{ id: 'L', dir: 'long', when: flags(5, [1]) }], exits: [{ from: null, stopLoss: 5, takeProfit: 10 }] }));
  check('take profit fills at the target', near(t.trades[0]?.exitPrice, 110) && t.trades[0].reason === 'Take profit');

  const short = [
    bar(0, 100, 100, 100, 100), bar(1, 100, 100, 100, 100),
    bar(2, 100, 100, 100, 100), // short entry @100
    bar(3, 100, 106, 99, 104),  // high 106 hits the 5% stop at 105
    bar(4, 104, 104, 104, 104),
  ];
  const sh = runBacktest(short, rules({ entries: [{ id: 'S', dir: 'short', when: flags(5, [1]) }], exits: [{ from: null, stopLoss: 5 }] }));
  check('short stop fills above entry', sh.trades[0]?.exitPrice === 105 && near(sh.trades[0].pnl, -5 * sh.trades[0].qty));
}

console.log('short trades and reversals');
{
  const r = runBacktest(bars, rules({
    entries: [{ id: 'L', dir: 'long', when: flags(n, [1]) }, { id: 'S', dir: 'short', when: flags(n, [3]) }],
  }));
  check('long closed by reversal at bar 4 open', r.trades[0]?.reason === 'Reverse' && r.trades[0].exitIndex === 4 && r.trades[0].exitPrice === 105);
  check('short is open at the end', r.openTrades.length === 1 && r.openTrades[0].side === 'short' && r.openTrades[0].entryPrice === 105);
  check('short open P&L = (105 - last close) * qty', near(r.openTrades[0].pnl, (105 - 108) * r.openTrades[0].qty));
}

console.log('pyramiding');
{
  const one = runBacktest(bars, rules({ entries: [{ id: 'L', dir: 'long', when: flags(n, [1, 2]) }], closes: [{ id: null, when: flags(n, [4]) }] }));
  check('pyramiding 1 ignores the second entry', one.trades.length === 1);
  const two = runBacktest(bars, rules({ entries: [{ id: 'L', dir: 'long', when: flags(n, [1, 2]) }], closes: [{ id: null, when: flags(n, [4]) }] }), { pyramiding: 2, sizeType: 'fixed', sizeValue: 1 });
  check('pyramiding 2 opens two lots', two.trades.length === 2, `${two.trades.length}`);
  check('fixed size of 1', two.trades.every((t) => t.qty === 1));
}

console.log('trailing stop');
{
  const b3 = [
    bar(0, 100, 100, 100, 100), bar(1, 100, 100, 100, 100), // signal at 1
    bar(2, 100, 110, 100, 110), // entry @100, best becomes 110
    bar(3, 110, 120, 109, 119), // trail 104.5 not hit; best becomes 120
    bar(4, 119, 119, 112, 113), // trail = 120 * 0.95 = 114 → hit
    bar(5, 113, 113, 113, 113),
  ];
  const r = runBacktest(b3, rules({ entries: [{ id: 'L', dir: 'long', when: flags(6, [1]) }], exits: [{ from: null, trailing: 5 }] }));
  check('trailing stop exit at 114', near(r.trades[0]?.exitPrice, 114) && r.trades[0].reason === 'Trailing stop', JSON.stringify(r.trades[0]));
}

console.log('onBar: stateful time stop');
{
  const r = runBacktest(bars, rules(), {}, (i, s) => {
    if (i === 1) s.long('L');
    if (s.position.side === 'long' && s.position.barsInTrade >= 2) s.close();
  });
  check('entered at bar 2, closed after 2 bars (fills bar 5)', r.trades[0]?.entryIndex === 2 && r.trades[0].exitIndex === 5, JSON.stringify(r.trades[0]));
}

console.log('statistics');
{
  const b4 = [100, 100, 110, 110, 100, 100, 90, 90].map((p, i) => bar(i, p, p, p, p));
  const r = runBacktest(b4, rules({
    entries: [{ id: 'L', dir: 'long', when: flags(8, [0, 4]) }],
    closes: [{ id: null, when: flags(8, [2, 6]) }],
  }), { sizeType: 'fixed', sizeValue: 1 });
  const s = r.summary;
  check('two trades, one win', s.trades === 2 && s.wins === 1 && s.losses === 1);
  check('net profit = +10 - 10 = 0', near(s.netProfit, 0), `${s.netProfit}`);
  check('profit factor 1', near(s.profitFactor, 1));
  check('win rate 50%', s.winRate === 50);
  check('max drawdown 10', near(s.maxDrawdown, 10), `${s.maxDrawdown}`);
  check('buy & hold -10%', near(s.buyHoldPct, -10));
  check('long-side stats match', s.long.trades === 2 && s.short.trades === 0);
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
