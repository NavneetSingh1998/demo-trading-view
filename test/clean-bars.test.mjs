// Tests for lib/clean-bars.mjs: bad prints are clipped, real moves are kept.
import assert from 'node:assert/strict';
import { cleanSpikes } from '../lib/clean-bars.mjs';

const bar = (i, o, h, l, c) => ({ time: i * 300, open: o, high: h, low: l, close: c, volume: 100 });
// A quiet stretch around 100: bodies 99.9-100.2, wicks +-0.2.
const quiet = (n, base = 100) => Array.from({ length: n }, (_, i) => bar(i, base, base + 0.3, base - 0.2, base + 0.1));
let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

test('clips a wick far below the neighbours (bad print)', () => {
  const bars = quiet(30);
  bars[15] = bar(15, 100, 100.3, 19.5, 100.1); // like AMD trading at 610 printing 119
  const out = cleanSpikes(bars);
  assert.ok(out[15].low > 99, `low ${out[15].low}`);
  assert.equal(out[15].open, 100);
  assert.equal(out[15].close, 100.1);
});

test('clips a wick far above the neighbours', () => {
  const bars = quiet(30);
  bars[10] = bar(10, 100, 133, 99.8, 100.1);
  const out = cleanSpikes(bars);
  assert.ok(out[10].high < 101, `high ${out[10].high}`);
});

test('fixes an isolated open/close print far away', () => {
  const bars = quiet(30);
  bars[12] = bar(12, 100, 100.3, 40, 40.5);
  const out = cleanSpikes(bars);
  assert.ok(out[12].close > 99 && out[12].low > 99, JSON.stringify(out[12]));
});

test('clips two bad bars next to each other', () => {
  const bars = quiet(30);
  bars[14] = bar(14, 100, 100.3, 99.8, 66); // a bad close...
  bars[15] = bar(15, 66, 100.3, 66, 100.1); // ...and the next bar opening from it
  const out = cleanSpikes(bars);
  for (const i of [14, 15]) assert.ok(out[i].low > 99 && out[i].open > 99 && out[i].close > 99, JSON.stringify(out[i]));
});

test('clips a bad print during a volatile stretch', () => {
  // 1-hour bars on a wild day (+-3% per bar), with one print 40% below.
  const bars = Array.from({ length: 30 }, (_, i) => {
    const c = 100 + i * 1.5;
    return bar(i, c - 1.5, c + 1.5, c - 3, c);
  });
  bars[15] = { ...bars[15], low: 70 };
  const out = cleanSpikes(bars);
  assert.ok(out[15].low > 110, `low ${out[15].low}`);
});

test('keeps a real jump (the following bars move too)', () => {
  const bars = quiet(30).map((b, i) => (i >= 15 ? { ...b, open: b.open + 10, high: b.high + 10, low: b.low + 10, close: b.close + 10 } : b));
  bars[15] = bar(15, 100.1, 111, 100, 110); // the jump bar itself
  const out = cleanSpikes(bars);
  assert.deepEqual(out.slice(14, 18), bars.slice(14, 18));
});

test('keeps normal volatility untouched', () => {
  const bars = Array.from({ length: 60 }, (_, i) => {
    const c = 100 + Math.sin(i / 3) * 2;
    return bar(i, c - 0.3, c + 0.6, c - 0.7, c);
  });
  assert.deepEqual(cleanSpikes(bars), bars);
});

test('leaves the newest bars alone (nothing after them yet)', () => {
  const bars = quiet(30);
  bars[29] = bar(29, 100, 140, 99.8, 139); // breaking news on the live bar
  assert.deepEqual(cleanSpikes(bars)[29], bars[29]);
});

test('does not modify its input', () => {
  const bars = quiet(30);
  bars[15] = bar(15, 100, 100.3, 19.5, 100.1);
  const copy = JSON.parse(JSON.stringify(bars));
  cleanSpikes(bars);
  assert.deepEqual(bars, copy);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
