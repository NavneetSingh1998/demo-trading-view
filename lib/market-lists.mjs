// Every US-listed stock and ETF with last price, change and (for stocks) sector and market cap,
// from Nasdaq's public screener. Used by the optional server (live) and by
// scripts/update-data.mjs (the snapshot a static site ships with).

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: 'https://www.nasdaq.com',
  Referer: 'https://www.nasdaq.com/',
};

/** Nasdaq writes some tickers differently from Yahoo (which the charts use). */
export function toYahooTicker(s) {
  return s
    .replace(/\.WS$/, '-WT')
    .replace(/\.U$/, '-UN')
    .replace(/\.R$/, '-RI')
    .replace(/\^/g, '-P')
    .replace(/\//g, '-');
}

const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[$,%]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const cleanName = (n) => String(n || '')
  .replace(/\s+(Common Stock|Ordinary Shares|Class [A-Z] (Common Stock|Ordinary Shares)|American Depositary Shares.*|Common Shares.*)$/i, '')
  .trim();

/**
 * id: 'us-stocks' | 'us-etfs'. Returns compact rows: { s, n, p, c, v?, m?, sec?, ind?, co? }.
 * co: the company's country when it isn't the United States ('?' when Nasdaq doesn't say).
 */
export async function fetchUsList(id) {
  const url = id === 'us-stocks'
    ? 'https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true'
    : 'https://api.nasdaq.com/api/screener/etf?tableonly=true&download=true';
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Nasdaq HTTP ${r.status}`);
  const j = await r.json();
  const rows = j?.data?.rows || j?.data?.data?.rows || [];
  const list = id === 'us-stocks'
    ? rows.map((x) => ({
      s: toYahooTicker(x.symbol), n: cleanName(x.name), p: num(x.lastsale), c: num(x.pctchange),
      v: num(x.volume), m: num(x.marketCap), sec: x.sector || 'Other', ind: x.industry || '',
      ...(x.country === 'United States' ? {} : { co: x.country || '?' }),
    }))
    : rows.map((x) => ({ s: toYahooTicker(x.symbol), n: x.companyName, p: num(x.lastSalePrice), c: num(x.percentageChange) }));
  const out = list.filter((x) => x.s);
  if (out.length < 100) throw new Error(`Nasdaq returned only ${out.length} rows`);
  return out;
}
