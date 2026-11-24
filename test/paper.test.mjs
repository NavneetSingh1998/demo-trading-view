// Tests for paper trading (public/js/paper.js): fills, netting, stops, P&L and buying power.
import assert from 'node:assert/strict';
import { PaperAccount, PAPER_DEFAULTS } from '../public/js/paper.js';

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.stack.split('\n').slice(0, 3).join('\n       ')}`); }
};
const S = 'BINANCE:BTCUSDT';
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('market orders: open, add, average price, close with P&L', () => {
  const a = new PaperAccount();
  assert.equal(a.cash, PAPER_DEFAULTS.balance);
  let r = a.placeOrder({ symbol: S, side: 'buy', type: 'market', qty: 1 }, { price: 100, time: 1 });
  assert.ok(r.ok);
  r = a.placeOrder({ symbol: S, side: 'buy', type: 'market', qty: 1 }, { price: 110, time: 2 });
  assert.equal(a.positions[S].qty, 2);
  near(a.positions[S].avg, 105);
  a.tick(S, 120, 3);
  near(a.openPnl, 30);
  near(a.equity, 100030);
  r = a.closePosition(S, { time: 4 });
  assert.ok(r.ok);
  assert.equal(a.positions[S], undefined);
  near(a.cash, 100030);
  assert.equal(a.trades.length, 1);
  assert.equal(a.trades[0].side, 'long');
  near(a.trades[0].pnl, 30);
});

test('selling while long reduces, closes, then flips to short', () => {
  const a = new PaperAccount();
  a.placeOrder({ symbol: S, side: 'buy', qty: 10 }, { price: 50 });
  a.placeOrder({ symbol: S, side: 'sell', qty: 4 }, { price: 60 });
  assert.equal(a.positions[S].qty, 6);
  near(a.positions[S].avg, 50); // reducing keeps the average
  a.placeOrder({ symbol: S, side: 'sell', qty: 10, sl: 70, tp: 40 }, { price: 55 });
  assert.equal(a.positions[S].qty, -4); // closed 6, opened a 4 short
  near(a.positions[S].avg, 55);
  assert.equal(a.positions[S].sl, 70);
  assert.equal(a.trades.length, 2);
  near(a.trades[0].pnl, 40); // 4 × (60 − 50)
  near(a.trades[1].pnl, 30); // 6 × (55 − 50)
  a.tick(S, 45);
  near(a.unrealized(S), 40); // short 4 from 55 to 45
});

test('limit and stop orders wait for their price, then fill there', () => {
  const a = new PaperAccount();
  a.tick(S, 100);
  let r = a.placeOrder({ symbol: S, side: 'buy', type: 'limit', qty: 1, price: 95 });
  assert.ok(r.ok);
  assert.equal(r.fills.length, 0);
  r = a.placeOrder({ symbol: S, side: 'buy', type: 'stop', qty: 1, price: 105 });
  assert.equal(a.orders.length, 2);
  assert.deepEqual(a.tick(S, 98), []);
  const f = a.tick(S, 94, 10); // traded through the limit: it filled at its own price
  assert.equal(f.length, 1);
  assert.equal(f[0].price, 95);
  assert.equal(f[0].reason, 'Limit');
  const g = a.tick(S, 106, 11);
  assert.equal(g[0].reason, 'Stop');
  assert.equal(a.positions[S].qty, 2);
  assert.equal(a.orders.length, 0);
});

test('marketable limit and stop orders fill right away', () => {
  const a = new PaperAccount();
  let r = a.placeOrder({ symbol: S, side: 'buy', type: 'limit', qty: 1, price: 110 }, { price: 100 });
  assert.equal(r.fills.length, 1);
  assert.equal(r.fills[0].price, 100); // a buy limit above the market fills at the market
  r = a.placeOrder({ symbol: S, side: 'sell', type: 'stop', qty: 1, price: 105 }, { price: 100 });
  assert.equal(r.fills.length, 1); // a sell stop above the market triggers now
  assert.equal(a.positions[S], undefined);
});

test('an order that fills right away checks its stops against the fill price', () => {
  const a = new PaperAccount();
  // A buy limit at 110 fills at the market (100): a stop loss at 105 would sit above the position.
  assert.match(a.placeOrder({ symbol: S, side: 'buy', type: 'limit', qty: 1, price: 110, sl: 105 }, { price: 100 }).error, /below the entry/);
  // A buy stop at 105 with the market at 110 fills at 110: a take profit at 108 would be below it.
  assert.match(a.placeOrder({ symbol: S, side: 'buy', type: 'stop', qty: 1, price: 105, tp: 108 }, { price: 110 }).error, /above the entry/);
  assert.equal(a.trades.length + Object.keys(a.positions).length, 0);
});

test('a level the price already passed fills at the next trade, not the stale price', () => {
  const a = new PaperAccount();
  a.placeOrder({ symbol: S, side: 'buy', qty: 1, sl: 95 }, { price: 100 });
  a.last[S] = 94; // e.g. prices moved while nothing was checking
  const f = a.tick(S, 93);
  assert.equal(f[0].reason, 'Stop loss');
  assert.equal(f[0].price, 93);
});

test('stop loss and take profit close the position', () => {
  const a = new PaperAccount();
  a.placeOrder({ symbol: S, side: 'buy', qty: 2, sl: 90, tp: 120 }, { price: 100 });
  assert.equal(a.positions[S].sl, 90);
  a.tick(S, 95);
  const f = a.tick(S, 89, 5);
  assert.equal(f[0].reason, 'Stop loss');
  assert.equal(f[0].price, 89); // jumped through the stop: filled at the next trade
  assert.equal(a.positions[S], undefined);
  near(a.trades[0].pnl, -22);

  a.placeOrder({ symbol: S, side: 'sell', qty: 1, sl: 110, tp: 80 }, { price: 100 });
  const g = a.tick(S, 79);
  assert.equal(g[0].reason, 'Take profit');
  assert.equal(g[0].price, 80); // a take profit is a limit: filled at its price, not the better next trade
  near(a.trades[1].pnl, 20);
});

test('bracket prices must be on the right side', () => {
  const a = new PaperAccount();
  assert.match(a.placeOrder({ symbol: S, side: 'buy', qty: 1, sl: 105 }, { price: 100 }).error, /below/);
  assert.match(a.placeOrder({ symbol: S, side: 'sell', qty: 1, tp: 105 }, { price: 100 }).error, /below/);
  assert.match(a.placeOrder({ symbol: S, side: 'buy', type: 'limit', qty: 1, price: 90, tp: 85 }, { price: 100 }).error, /above the entry/);
  assert.match(a.placeOrder({ symbol: S, side: 'buy', qty: 0 }, { price: 100 }).error, /quantity/);
  assert.match(a.placeOrder({ symbol: 'X', side: 'buy', qty: 1 }).error, /No price/);
  a.placeOrder({ symbol: S, side: 'buy', qty: 1 }, { price: 100 });
  assert.ok(a.setBracket(S, { sl: 95, tp: 120 }).ok);
  assert.match(a.setBracket(S, { sl: 101 }).error, /below the current price/);
  assert.ok(a.setBracket(S, { sl: null }).ok);
  assert.equal(a.positions[S].sl, null);
});

test('candles: gaps fill at the open, ranges at the level, both stops in one candle', () => {
  const a = new PaperAccount();
  a.tick(S, 100);
  a.placeOrder({ symbol: S, side: 'buy', type: 'limit', qty: 1, price: 97, sl: 94, tp: 104 });
  // Gap down to 96 at the open: the limit fills at the open (better than 97).
  let f = a.bar(S, { open: 96, high: 99, low: 95, close: 98 }, 1);
  assert.equal(f[0].price, 96);
  assert.equal(a.positions[S].qty, 1);
  // A falling candle rallies first: the take profit (104) fills before the stop (94).
  f = a.bar(S, { open: 98, high: 105, low: 93, close: 94 }, 2);
  assert.equal(f.length, 1);
  assert.equal(f[0].reason, 'Take profit');
  assert.equal(f[0].price, 104);

  // Entry and stop loss inside the same candle.
  const b = new PaperAccount();
  b.tick(S, 100);
  b.placeOrder({ symbol: S, side: 'buy', type: 'limit', qty: 1, price: 98, sl: 95 });
  f = b.bar(S, { open: 100, high: 101, low: 90, close: 92 }, 3);
  assert.deepEqual(f.map((x) => x.reason), ['Limit', 'Stop loss']);
  assert.deepEqual(f.map((x) => x.price), [98, 95]);
});

test('commission and slippage', () => {
  const a = new PaperAccount({ commission: 0.1, slippage: 0.05 });
  const r = a.placeOrder({ symbol: S, side: 'buy', qty: 10 }, { price: 100 });
  near(r.fills[0].price, 100.05);
  near(r.fills[0].commission, 1.0005);
  a.closePosition(S, { price: 110 });
  const t = a.trades[0];
  near(t.exit, 109.945);
  // (109.945 − 100.05) × 10 − entry commission − exit commission
  near(t.pnl, 98.95 - 1.0005 - 1.09945, 1e-4);
  near(a.cash, 100000 + t.pnl, 1e-4);
});

test('buying power: positions can total equity × leverage', () => {
  const a = new PaperAccount({ balance: 1000 });
  assert.match(a.placeOrder({ symbol: S, side: 'buy', qty: 11 }, { price: 100 }).error, /buying power/);
  assert.ok(a.placeOrder({ symbol: S, side: 'buy', qty: 10 }, { price: 100 }).ok);
  assert.ok(a.placeOrder({ symbol: S, side: 'sell', qty: 5 }, { price: 100 }).ok); // reducing is always fine
  const b = new PaperAccount({ balance: 1000, leverage: 4 });
  assert.ok(b.placeOrder({ symbol: S, side: 'sell', qty: 40 }, { price: 100 }).ok);
});

test('working orders: cancel, modify (and fill when moved through the price)', () => {
  const a = new PaperAccount();
  a.tick(S, 100);
  const { order } = a.placeOrder({ symbol: S, side: 'sell', type: 'limit', qty: 1, price: 110 });
  let r = a.modifyOrder(order.id, { price: 108 });
  assert.ok(r.ok);
  assert.equal(a.orders[0].id, order.id);
  assert.equal(a.orders[0].price, 108);
  r = a.modifyOrder(order.id, { price: 99 }); // now below the market: a sell limit fills
  assert.equal(r.fills.length, 1);
  assert.equal(r.fills[0].orderId, order.id);
  assert.equal(a.positions[S].qty, -1);
  a.placeOrder({ symbol: S, side: 'buy', type: 'stop', qty: 1, price: 120 });
  assert.ok(a.cancelOrder(a.orders[0].id));
  assert.equal(a.orders.length, 0);
});

test('save and restore, stats and reset', () => {
  const a = new PaperAccount({ balance: 5000 });
  a.placeOrder({ symbol: S, side: 'buy', qty: 1 }, { price: 100 });
  a.closePosition(S, { price: 120 });
  a.placeOrder({ symbol: S, side: 'buy', qty: 1 }, { price: 100 });
  a.closePosition(S, { price: 90 });
  a.placeOrder({ symbol: S, side: 'buy', type: 'limit', qty: 1, price: 80 });
  const b = new PaperAccount({}, JSON.parse(JSON.stringify(a.toJSON())));
  assert.equal(b.cash, a.cash);
  assert.equal(b.orders.length, 1);
  assert.equal(b.settings.balance, 5000);
  const s = b.stats();
  assert.equal(s.trades, 2);
  assert.equal(s.winRate, 50);
  near(s.profitFactor, 2);
  near(s.net, 10);
  b.reset({ balance: 2000 });
  assert.equal(b.cash, 2000);
  assert.equal(b.trades.length, 0);
  assert.equal(b.orders.length, 0);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
