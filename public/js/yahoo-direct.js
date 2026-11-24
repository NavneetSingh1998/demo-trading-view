// Yahoo's public live price stream, straight from the browser (no server, no key).
// Messages are base64 protobuf "PricingData"; we decode the few fields we use.

const STREAM_URL = 'wss://streamer.finance.yahoo.com/?version=2';
const text = new TextDecoder();

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function decodePricing(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const f = {};
  let i = 0;
  const varint = () => {
    let r = 0n, shift = 0n, b;
    do { b = buf[i++]; r |= BigInt(b & 0x7f) << shift; shift += 7n; } while (b & 0x80 && i < buf.length);
    return r;
  };
  const zigzag = (v) => Number((v >> 1n) ^ -(v & 1n));
  while (i < buf.length) {
    const key = Number(varint());
    const field = key >>> 3, wire = key & 7;
    if (wire === 0) f[field] = varint();
    else if (wire === 1) { f[field] = dv.getFloat64(i, true); i += 8; }
    else if (wire === 2) { const len = Number(varint()); f[field] = text.decode(buf.subarray(i, i + len)); i += len; }
    else if (wire === 5) { f[field] = dv.getFloat32(i, true); i += 4; }
    else break;
  }
  return {
    s: f[1],
    p: typeof f[2] === 'number' ? Number(f[2].toPrecision(7)) : NaN,
    t: f[3] != null ? zigzag(f[3]) : Date.now(),
    m: f[7] != null ? Number(f[7]) : 0,
    cp: typeof f[8] === 'number' ? f[8] : undefined, // % change since the previous close
    v: f[9] != null ? zigzag(f[9]) : undefined,
  };
}

/** One WebSocket for the whole page; subscriptions change without reconnecting. */
export class YahooDirectStream {
  constructor(onTick) {
    this.onTick = onTick;
    this.ws = null;
    this.symbols = new Set();
    this.retry = 0;
  }

  setSymbols(list) {
    const next = new Set(list);
    const added = [...next].filter((s) => !this.symbols.has(s));
    const removed = [...this.symbols].filter((s) => !next.has(s));
    this.symbols = next;
    if (!next.size) { const ws = this.ws; this.ws = null; ws?.close(); return; }
    if (!this.ws) { this.connect(); return; }
    if (this.ws.readyState === 1) {
      if (added.length) this.ws.send(JSON.stringify({ subscribe: added }));
      if (removed.length) this.ws.send(JSON.stringify({ unsubscribe: removed }));
    }
  }

  connect() {
    const ws = new WebSocket(STREAM_URL);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      if (this.symbols.size) ws.send(JSON.stringify({ subscribe: [...this.symbols] }));
    };
    ws.onmessage = (ev) => {
      let tick;
      try {
        const msg = JSON.parse(ev.data);
        if (!msg.message) return;
        tick = decodePricing(b64ToBytes(msg.message));
      } catch {
        return;
      }
      if (tick.s && Number.isFinite(tick.p)) this.onTick(tick);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.symbols.size) setTimeout(() => { if (!this.ws && this.symbols.size) this.connect(); }, Math.min(1000 * 2 ** this.retry++, 30000));
    };
    ws.onerror = () => {};
  }
}
