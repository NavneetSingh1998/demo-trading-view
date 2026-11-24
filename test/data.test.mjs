// Tests for the data helpers: ticker mapping, Yahoo's live-price decoding, colors.
import assert from 'node:assert/strict';
import { toYahooTicker } from '../lib/market-lists.mjs';
import { decodePricing } from '../public/js/yahoo-direct.js';
import { toTd } from '../public/js/twelvedata.js';
import { withAlpha } from '../public/js/util.js';

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

test('Nasdaq tickers map to Yahoo tickers', () => {
  assert.equal(toYahooTicker('AAPL'), 'AAPL');
  assert.equal(toYahooTicker('BRK/B'), 'BRK-B');
  assert.equal(toYahooTicker('BAC^K'), 'BAC-PK');
});

test('Yahoo tickers map to Twelve Data symbols', () => {
  assert.equal(toTd('AAPL').symbol, 'AAPL');
  assert.equal(toTd('^GSPC').symbol, 'SPX');
  assert.equal(toTd('EURUSD=X').symbol, 'EUR/USD');
  assert.equal(toTd('JPY=X').symbol, 'USD/JPY');
  assert.equal(toTd('BTC-USD').symbol, 'BTC/USD');
  assert.equal(toTd('GC=F').symbol, 'XAU/USD');
  assert.equal(toTd('BRK-B').symbol, 'BRK.B');
});

// Minimal protobuf writer for Yahoo's PricingData message.
const varint = (n) => { const out = []; let v = BigInt(n); do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v); return out; };
const zigzag = (n) => (BigInt(n) << 1n) ^ (BigInt(n) < 0n ? -1n : 0n);
const key = (field, wire) => varint((field << 3) | wire);
const f32 = (x) => { const b = Buffer.alloc(4); b.writeFloatLE(x); return [...b]; };
const str = (s) => { const b = Buffer.from(s); return [...varint(b.length), ...b]; };

test('decodes a live price message', () => {
  const msg = Uint8Array.from([
    ...key(1, 2), ...str('NVDA'),
    ...key(2, 5), ...f32(166.59),
    ...key(3, 0), ...varint(zigzag(1794554658000)),
    ...key(7, 0), ...varint(4),
    ...key(8, 5), ...f32(-0.55),
    ...key(9, 0), ...varint(zigzag(123456789)),
  ]);
  const t = decodePricing(msg);
  assert.equal(t.s, 'NVDA');
  assert.ok(Math.abs(t.p - 166.59) < 1e-3, `price ${t.p}`);
  assert.equal(t.t, 1794554658000);
  assert.equal(t.m, 4);
  assert.ok(Math.abs(t.cp + 0.55) < 1e-4, `change ${t.cp}`);
  assert.equal(t.v, 123456789);
});

test('a missing session field means pre-market (protobuf default 0)', () => {
  const t = decodePricing(Uint8Array.from([...key(1, 2), ...str('AAPL'), ...key(2, 5), ...f32(355)]));
  assert.equal(t.m, 0);
  assert.equal(t.cp, undefined);
});

test('hex colors with opacity', () => {
  assert.equal(withAlpha('#E5484D', 0.5), 'rgba(229, 72, 77, 0.5)');
  assert.equal(withAlpha('#fff', 1), 'rgba(255, 255, 255, 1)');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
