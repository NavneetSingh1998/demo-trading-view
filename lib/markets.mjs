// Stock markets outside the US, for the News panel's earnings calendar and for tagging companies
// in regional headlines: which exchanges belong to a country, telling a company's own listing
// from a foreign company's secondary line there (Walmart in Frankfurt), and market caps in US
// dollars. Pure functions, unit-tested in test/news.test.mjs.

const EURO = ['Germany', 'France', 'Netherlands', 'Italy', 'Spain', 'Belgium', 'Ireland', 'Luxembourg', 'Austria', 'Finland', 'Portugal', 'Greece'];

/**
 * ex: Yahoo exchange codes. cur: the currency Yahoo's earnings calendar gives market caps in
 * (London: pence). home: Nasdaq country names that count as local. skip: tickers of foreign
 * companies' lines (London "0ABC.L", Milan "1WMT.MI", Brazilian depositary receipts).
 */
export const MARKETS = {
  GB: { ex: ['LSE'], cur: 'GBp', home: ['United Kingdom', 'Jersey', 'Guernsey', 'Isle of Man'], skip: /^0[A-Z0-9]{3}\.L$/ },
  DE: { ex: ['GER'], cur: 'EUR', home: EURO },
  FR: { ex: ['PAR'], cur: 'EUR', home: EURO },
  NL: { ex: ['AMS'], cur: 'EUR', home: EURO },
  IT: { ex: ['MIL'], cur: 'EUR', home: EURO, skip: /^1[A-Z]/ },
  ES: { ex: ['MCE'], cur: 'EUR', home: EURO },
  CH: { ex: ['EBS'], cur: 'CHF', home: ['Switzerland'] },
  SE: { ex: ['STO'], cur: 'SEK', home: ['Sweden'] },
  JP: { ex: ['JPX'], cur: 'JPY', home: ['Japan'] },
  HK: { ex: ['HKG'], cur: 'HKD', home: ['Hong Kong', 'China'] },
  CN: { ex: ['SHH', 'SHZ'], cur: 'CNY', home: ['China'] },
  KR: { ex: ['KSC', 'KOE'], cur: 'KRW', home: ['South Korea'] },
  TW: { ex: ['TAI', 'TWO'], cur: 'TWD', home: ['Taiwan'] },
  IN: { ex: ['NSI'], cur: 'INR', home: ['India'] },
  CA: { ex: ['TOR'], cur: 'CAD', home: ['Canada'] },
  AU: { ex: ['ASX'], cur: 'AUD', home: ['Australia', 'New Zealand'] },
  BR: { ex: ['SAO'], cur: 'BRL', home: ['Brazil'], skip: /3[1-5]\.SA$/ },
};

// When one company trades in several of these markets and its country doesn't settle it,
// the earlier market wins (Prosus: Amsterdam before Zurich).
export const MARKET_ORDER = ['GB', 'NL', 'FR', 'IT', 'ES', 'SE', 'CH', 'DE', 'JP', 'HK', 'CN', 'KR', 'TW', 'IN', 'CA', 'AU', 'BR'];

// Where companies are registered rather than run: says nothing about their home market.
const HAVENS = new Set(['?', 'Ireland', 'Bermuda', 'Cayman Islands', 'Luxembourg', 'Jersey', 'Guernsey', 'Isle of Man',
  'British Virgin Islands', 'Bahamas', 'Panama', 'Marshall Islands', 'Curacao', 'Cyprus', 'Monaco']);

const KEY_DROP = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'companies', 'ltd', 'limited', 'plc', 'p', 'l', 'c',
  'sa', 's', 'a', 'se', 'ag', 'nv', 'n', 'v', 'ab', 'publ', 'asa', 'spa', 'oyj', 'kgaa', 'sca', 'holdings', 'holding', 'group', 'the',
  'and', 'of', 'class', 'common', 'stock', 'shares', 'ordinary', 'ads', 'adr', 'registry', 'new', 'york', 'llc', 'lp', 'llp',
  'aktiengesellschaft']);

/** "Cisco Systems Inc. Common Stock (DE)" and "Cisco Systems, Inc." → "cisco systems". */
export function companyKey(name) {
  return String(name || '').replace(/\((?:[A-Z]{2}|the)\)/gi, ' ').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w && !KEY_DROP.has(w)).slice(0, 3).join(' ');
}

/** Company key → the countries of its US listings (from the Nasdaq list's `co`). */
export function usCountries(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const k = companyKey(r.n);
    if (!k) continue;
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(r.co || 'United States');
  }
  return map;
}

const isHome = (code, set) => !!set && [...set].some((c) => MARKETS[code].home.includes(c));

/** True for a foreign company's secondary line on this market: Walmart in Frankfurt, Toyota in London. */
export function isForeign(name, code, us) {
  const set = us?.get(companyKey(name));
  if (!set) return false;
  return ![...set].some((c) => MARKETS[code].home.includes(c) || HAVENS.has(c));
}

// Rough rates for when live ones can't be fetched (only used to compare company sizes).
export const FX_FALLBACK = { EUR: 1.1, GBP: 1.3, CHF: 1.2, SEK: 0.1, JPY: 0.0065, HKD: 0.128, CNY: 0.14, KRW: 0.0007, TWD: 0.031,
  INR: 0.011, CAD: 0.71, AUD: 0.66, BRL: 0.18 };
const MINOR = { GBp: 'GBP', GBX: 'GBP', ZAc: 'ZAR', ILA: 'ILS' };

/** An amount in US dollars. fx: { EUR: 1.09, ... } (dollars per unit). Pence ("GBp") count as 1/100 pound. */
export function toUsd(v, cur, fx = FX_FALLBACK) {
  if (!Number.isFinite(v)) return null;
  if (!cur || cur === 'USD') return v;
  const major = MINOR[cur];
  const rate = fx[major || cur] ?? FX_FALLBACK[major || cur];
  return rate ? (major ? v / 100 : v) * rate : null;
}

/** A Yahoo quote's market cap in dollars. (Quotes give London caps in pounds even when prices are in pence.) */
export const quoteCapUsd = (q, fx) => toUsd(q?.marketCap, MINOR[q?.currency] || q?.currency, fx);

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Yahoo "sp_earnings" rows from one market's exchanges → [{ t, s, n, when, est, act, surprise, m, c, k }]
 * for its own companies worth at least minCap dollars (m in dollars; EPS in the local currency).
 */
export function shapeIntlEarnings(rows, code, { fx, us, minCap = 1e9 } = {}) {
  const mk = MARKETS[code];
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const s = r.ticker;
    const n = r.companyshortname || '';
    const k = companyKey(n);
    if (!s || !k || seen.has(s) || seen.has(k) || mk.skip?.test(s) || isForeign(n, code, us)) continue;
    const m = toUsd(r.intradaymarketcap, mk.cur, fx);
    if (!m || m < minCap) continue;
    const t = Math.floor(Date.parse(r.startdatetime) / 1000);
    if (!Number.isFinite(t)) continue;
    seen.add(s);
    seen.add(k);
    out.push({ t, s, n, when: null, est: num(r.epsestimate), act: num(r.epsactual), surprise: num(r.epssurprisepct), m, c: code, k });
  }
  return out;
}

/**
 * Yahoo screener quotes for one market → its own companies [{ s, n, m, c, k }], largest first, one
 * line per company. Lines quoted in another currency (Samsung's dollar GDRs in London) are left out.
 */
export function shapeListings(quotes, code, { fx, us } = {}) {
  const mk = MARKETS[code];
  const major = (c) => MINOR[c] || c;
  const seen = new Set();
  const out = [];
  for (const q of quotes) {
    const s = q.symbol;
    const n = q.longName || q.shortName || '';
    const k = companyKey(n);
    if (!s || !k || seen.has(k) || mk.skip?.test(s) || (q.quoteType && q.quoteType !== 'EQUITY') || isForeign(n, code, us)) continue;
    if (q.currency && major(q.currency) !== major(mk.cur)) continue;
    const m = quoteCapUsd({ ...q, currency: q.currency || mk.cur }, fx);
    if (!m) continue;
    seen.add(k);
    out.push({ s, n, m, c: code, k });
  }
  return out.sort((a, b) => b.m - a.m);
}

/**
 * Rows from several markets ({ GB: [...], HK: [...] }) with each company kept once: in the market
 * of its country when the Nasdaq list knows it (HSBC: London, not Hong Kong), else by MARKET_ORDER.
 */
export function mergeMarkets(byCode, us) {
  const rank = (code, k) => (isHome(code, us?.get(k)) ? 0 : 100) + MARKET_ORDER.indexOf(code);
  const best = new Map();
  for (const code of MARKET_ORDER) {
    for (const r of byCode[code] || []) {
      const prev = best.get(r.k);
      if (prev == null || rank(code, r.k) < rank(prev, r.k)) best.set(r.k, code);
    }
  }
  return MARKET_ORDER.flatMap((code) => (byCode[code] || []).filter((r) => best.get(r.k) === code));
}
