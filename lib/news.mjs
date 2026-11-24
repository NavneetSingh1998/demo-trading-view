// News for the News panel: reads RSS/Atom feeds, tags the tickers a headline is about,
// groups the same story from several outlets, and scores how "hot" each story is.
// Pure functions (no network), so they're unit-tested in test/news.test.mjs.

import { companyKey } from './markets.mjs';

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…' };

/** Decodes HTML entities (twice: some feeds double-encode, e.g. &amp;quot;) and strips tags. */
export function decode(s) {
  let out = String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  for (let i = 0; i < 2; i++) {
    out = out.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] !== '#') return NAMED[e.toLowerCase()] ?? m;
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    });
  }
  return out.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

const field = (xml, tag) => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m ? decode(m[1]) : '';
};

/**
 * Items from an RSS or Atom feed: { title, link, t (unix seconds), source, feed, cats }.
 * Items without a title, link or date are skipped.
 */
export function parseFeed(xml, feed = {}) {
  const atom = !/<item[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const blocks = [...String(xml).matchAll(atom ? /<entry[\s>]([\s\S]*?)<\/entry>/gi : /<item[\s>]([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  const out = [];
  for (const b of blocks) {
    const title = field(b, 'title');
    const link = atom ? decode(/<link[^>]*href="([^"]+)"/i.exec(b)?.[1] || '') : field(b, 'link') || field(b, 'guid');
    const date = field(b, 'pubDate') || field(b, 'dc:date') || field(b, 'published') || field(b, 'updated');
    const t = Math.floor(Date.parse(date) / 1000);
    if (!title || !/^https?:\/\//.test(link) || !Number.isFinite(t)) continue;
    const cats = [...b.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)].map((m) => decode(m[1])).filter(Boolean);
    out.push({ title, link, t, source: feed.source || '', feed: feed.id || '', cats });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tickers in headlines
// ---------------------------------------------------------------------------

/** Crypto names, with the chart symbol and the Yahoo symbol used for the day's change. */
export const CRYPTO = {
  BTC: { names: ['Bitcoin', 'BTC'], full: 'BINANCE:BTCUSDT', quote: 'BTC-USD' },
  ETH: { names: ['Ethereum', 'Ether', 'ETH'], full: 'BINANCE:ETHUSDT', quote: 'ETH-USD' },
  SOL: { names: ['Solana'], full: 'BINANCE:SOLUSDT', quote: 'SOL-USD' },
  XRP: { names: ['XRP', 'Ripple'], full: 'BINANCE:XRPUSDT', quote: 'XRP-USD' },
  DOGE: { names: ['Dogecoin'], full: 'BINANCE:DOGEUSDT', quote: 'DOGE-USD' },
  ADA: { names: ['Cardano'], full: 'BINANCE:ADAUSDT', quote: 'ADA-USD' },
  BNB: { names: ['BNB'], full: 'BINANCE:BNBUSDT', quote: 'BNB-USD' },
};

/** Names headlines use that differ from the listed company name. */
const ALIASES = {
  Google: 'GOOGL', YouTube: 'GOOGL', Facebook: 'META', Instagram: 'META', WhatsApp: 'META', Exxon: 'XOM', 'Exxon Mobil': 'XOM',
  JPMorgan: 'JPM', 'J.P. Morgan': 'JPM', TSMC: 'TSM', SpaceX: 'SPCX', Lilly: 'LLY', 'Eli Lilly': 'LLY', Pepsi: 'PEP', Disney: 'DIS',
  'J&J': 'JNJ', Supermicro: 'SMCI', 'Super Micro': 'SMCI', Citi: 'C', Citigroup: 'C', Berkshire: 'BRK-B', 'Novo Nordisk': 'NVO',
  'Bank of America': 'BAC', BofA: 'BAC', Schwab: 'SCHW', MicroStrategy: 'MSTR', 'Philip Morris': 'PM', 'Home Depot': 'HD',
  'Goldman Sachs': 'GS', 'Morgan Stanley': 'MS', 'Wells Fargo': 'WFC', 'Johnson & Johnson': 'JNJ', AMD: 'AMD', 'AT&T': 'T',
};

/**
 * Short names headlines use for companies listed outside the US (their full names are matched
 * too): name → local tickers, the first one the region's company list has wins.
 */
const LOCAL_ALIASES = {
  // UK
  BP: ['BP.L'], Lloyds: ['LLOY.L'], 'M&S': ['MKS.L'], 'JD Sports': ['JD.L'], IAG: ['IAG.L'], LSEG: ['LSEG.L'], StanChart: ['STAN.L'],
  Barratt: ['BTRW.L'], 'Rio Tinto': ['RIO.L', 'RIO.AX'],
  // Europe
  'Deutsche Bank': ['DBK.DE'], 'Deutsche Telekom': ['DTE.DE'], 'Deutsche Boerse': ['DB1.DE'], 'Deutsche Börse': ['DB1.DE'],
  BMW: ['BMW.DE'], Mercedes: ['MBG.DE'], VW: ['VOW3.DE'], Porsche: ['P911.DE'], 'Munich Re': ['MUV2.DE'], LVMH: ['MC.PA'], "L'Oreal": ['OR.PA'],
  "L'Oréal": ['OR.PA'], Hermes: ['RMS.PA'], 'Hermès': ['RMS.PA'], 'Societe Generale': ['GLE.PA'], 'Société Générale': ['GLE.PA'],
  'Credit Agricole': ['ACA.PA'], 'Crédit Agricole': ['ACA.PA'], Michelin: ['ML.PA'], Generali: ['G.MI'], Intesa: ['ISP.MI'], Santander: ['SAN.MC'],
  BBVA: ['BBVA.MC'], Inditex: ['ITX.MC'], Telefonica: ['TEF.MC'], 'Telefónica': ['TEF.MC'], ING: ['INGA.AS'], Philips: ['PHIA.AS'], Ahold: ['AD.AS'],
  Nestle: ['NESN.SW'], 'Nestlé': ['NESN.SW'], Richemont: ['CFR.SW'], 'Swiss Re': ['SREN.SW'], 'H&M': ['HM-B.ST'], Volvo: ['VOLV-B.ST'],
  Ericsson: ['ERIC-B.ST'], SEB: ['SEB-A.ST'], Handelsbanken: ['SHB-A.ST'],
  // Asia
  Toyota: ['7203.T'], Honda: ['7267.T'], Nissan: ['7201.T'], Takeda: ['4502.T'], MUFG: ['8306.T'], Uniqlo: ['9983.T'], Samsung: ['005930.KS'],
  Hyundai: ['005380.KS'], Hynix: ['000660.KS'], TSMC: ['2330.TW'], Foxconn: ['2317.TW'], 'Hon Hai': ['2317.TW'], ICBC: ['1398.HK', '601398.SS'],
  CATL: ['3750.HK', '300750.SZ'], 'JD.com': ['9618.HK'], 'Ping An': ['2318.HK', '601318.SS'], Moutai: ['600519.SS'], SMIC: ['0981.HK', '688981.SS'],
  HKEX: ['0388.HK'], 'Trip.com': ['9961.HK'],
  // India
  HDFC: ['HDFCBANK.NS'], ICICI: ['ICICIBANK.NS'], SBI: ['SBIN.NS'], TCS: ['TCS.NS'], 'L&T': ['LT.NS'], HUL: ['HINDUNILVR.NS'], Kotak: ['KOTAKBANK.NS'],
  Maruti: ['MARUTI.NS'], Mahindra: ['M&M.NS'], Adani: ['ADANIENT.NS'], 'Sun Pharma': ['SUNPHARMA.NS'], ONGC: ['ONGC.NS'], Airtel: ['BHARTIARTL.NS'],
  // Australia
  CommBank: ['CBA.AX'], CBA: ['CBA.AX'], NAB: ['NAB.AX'], Westpac: ['WBC.AX'], Woodside: ['WDS.AX'], Qantas: ['QAN.AX'],
  // Canada
  RBC: ['RY.TO'], 'TD Bank': ['TD.TO'], BMO: ['BMO.TO'], Scotiabank: ['BNS.TO'], CIBC: ['CM.TO'], 'Couche-Tard': ['ATD.TO'], Suncor: ['SU.TO'],
  Barrick: ['ABX.TO'], 'Agnico Eagle': ['AEM.TO'], Manulife: ['MFC.TO'], Cenovus: ['CVE.TO'], Teck: ['TECK-B.TO'], CPKC: ['CP.TO'],
};

// Words that look like company names in a Title Case headline ("Inflation Target") but usually aren't.
const AMBIGUOUS = new Set(['target', 'visa', 'block', 'shell', 'carrier', 'progressive', 'southern', 'gap', 'snap', 'match', 'ball',
  'monster', 'coherent', 'waters', 'carnival', 'rocket', 'williams', 'travelers', 'viking', 'fox', 'vale', 'orange', 'kingfisher',
  'persimmon', 'leonardo', 'hexagon', 'canon', 'aristocrat', 'goodman', 'quanta', 'cathay', 'titan', 'weir', 'pearson', 'keller',
  'grafton', 'babcock', 'signify', 'valiant', 'cosmo', 'bellevue', 'orion', 'dixon', 'descartes', 'santos', 'cochlear', 'steadfast',
  'endeavour', 'sims', 'redox', 'aeon', 'olympus', 'momo']);
// Names that mostly mean something else (the Nasdaq index, S&P PMIs, CME FedWatch, Next plc, the ASX market).
const NEVER = new Set(['nasdaq', 'strategy', 's&p global', 's&p', 'cme', 'cboe global markets', 'marsh', 'next', 'sage', 'diploma',
  'admiral', 'seek', 'intact', 'recruit', 'investor', 'disco', 'eternal', 'evolution', 'origin', 'compass', 'phoenix', 'berkeley',
  'smiths', 'wise', 'unite', 'metro', 'asx', 'aberdeen', 'partners', 'vat', 'also', 'tx', 'screen', 'brother', 'trip', 'wharf', 'tse',
  'bse', 'persistent', 'cgi', 'empire', 'lottery', 'als', 'gpt', 'car', 'challenger', 'nrw', 'chorus', 'region', 'nickel', 'zip',
  'elders', 'bitcoin', 'galaxy', 'prim', 'comet']);
// First words of company names that are too common to stand for the company on their own.
const COMMON = new Set(['american', 'bank', 'banco', 'general', 'united', 'first', 'southern', 'public', 'progressive', 'digital',
  'global', 'international', 'national', 'royal', 'texas', 'applied', 'analog', 'advanced', 'automatic', 'capital', 'charles',
  'home', 'live', 'waste', 'western', 'eastern', 'union', 'canadian', 'british', 'real', 'realty', 'simon', 'state', 'fifth',
  'kinder', 'dominion', 'consolidated', 'arthur', 'cardinal', 'enterprise', 'imperial', 'boston', 'intuitive', 'monolithic',
  'illinois', 'crown', 'rocket', 'coherent', 'johnson', 'morgan', 'taiwan', 'space', 'marsh', 'motorola', 'keurig', 'brookfield',
  'parker-hannifin', 'universal', 'micro', 'super', 'air', 'well', 'walt', 'philip', 'republic', 'baker', 'phillips', 'marathon',
  'toronto', 'edwards', 'mitsubishi', 'd.r.', 'dba', 's&p', 'u.s.', 'asia', 'gold', 'silver', 'solar', 'energy', 'james', 'pacific',
  'dollar', 'china', 'shenzhen']);
// Upper-case tickers that are usually something else in a headline.
const NOT_TICKERS = new Set(['ICE', 'ALL', 'NOW', 'NET', 'WELL', 'LOW', 'KEY', 'ARE', 'CAT', 'FAST', 'AI', 'CEO', 'CFO', 'ETF', 'IPO',
  'GDP', 'CPI', 'PPI', 'PCE', 'EPS', 'FDA', 'SEC', 'FTC', 'DOJ', 'EU', 'UK', 'US', 'USA', 'UN', 'IMF', 'EV', 'EVS', 'IT', 'TV',
  'ON', 'BE', 'SO', 'ED', 'MA', 'MS', 'HD', 'KO', 'PM', 'AM', 'OR', 'IN', 'A', 'B', 'C', 'D', 'E', 'F', 'O', 'T', 'V', 'BIG', 'FUN',
  'CME', 'CASH', 'LIFE', 'PLAY', 'RUN', 'TRUE', 'TECH', 'OPEN', 'GOOD', 'HOPE', 'NEXT', 'REAL', 'SAFE', 'SAVE', 'BEST', 'GAIN', 'PEAK',
  // stock exchanges and indexes
  'ASX', 'TSX', 'TSE', 'BSE', 'NSE', 'LSE', 'JSE', 'SGX', 'FTSE', 'DAX', 'CAC', 'HSI', 'IBEX', 'SMI']);
const TWO_LETTER_OK = new Set(['GM', 'GE', 'BP']);

const SUFFIX = /\s*(?:,|\(the\)|\bthe\b|\binc\b\.?|\bincorporated\b|\bcorporation\b|\bcorp\b\.?|\bcompany\b|\bco\b\.?|\bltd\b\.?|\blimited\b|\bplc\b\.?|\bp\.l\.c\.|\bn\.v\.|\bs\.a\.|\bag\b|\bse\b|\ba\/s\b|\basa\b|\bllc\b|\blp\b|\bl\.p\.|\bholdings?\b|\bgroup\b|\btechnologies\b|\bplatforms\b|\bsystems\b|\binternational\b|\bindustries\b|\bcompanies\b|\band\b|\bsa\b|\bentertainment\b|\blaboratories\b|\baktiengesellschaft\b|\bkgaa\b|\bs\.p\.a\.|\bspa\b|\boyj\b|\bsponsored\b|\bunsponsored\b|\bregistered\b|\bads\b|\badr\b|\(new\)|\bnew\b|\(de\)|\.com\b)\s*$/i;

/** "Meta Platforms Inc. Class A Common Stock" → "Meta". Null for preferreds, notes and units. */
export function shortName(n) {
  let s = String(n || '');
  if (/preferred|depositary|notes due|\bunits?\b|tangible equity|perpetual|warrant|\brights?\b|zones/i.test(s)) return null;
  s = s.replace(/\([^)]*\)/g, (m) => (/^\(the\)$/i.test(m) ? m : ' ')).replace(/\b(class [a-c]\b.*|common stock.*|ordinary shares?.*|new york registry.*|capital stock.*|subordinate voting.*|limited voting.*|reit\b.*)$/i, '');
  s = s.replace(/^the\s+/i, '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 6; i++) {
    const next = s.replace(SUFFIX, '').trim();
    if (next === s || !next) break;
    s = next;
  }
  return s.replace(/[\s,&]+$/, '') || null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A matcher for the companies headlines talk about, from market-list rows { s, n, m }
 * (largest first). Returns { names: Map(lowercase name → ticker), re, tickers: Set }.
 * local: a region's own companies ({ s, n, m } from lib/markets.mjs), matched first, so UK news
 * links "HSBC" to HSBA.L rather than the US listing.
 */
export function buildNameIndex(rows, { top = 500, local = [] } = {}) {
  const localSyms = new Set(local.map((r) => r.s));
  const localKeys = new Set(local.map((r) => r.k || companyKey(r.n)));
  // US listings of the region's own companies (HSBC's US shares) give way to the local ones.
  const usKey = new Map(rows.map((r) => [r.s, companyKey(r.n)]));
  const isLocalCompany = (s) => localKeys.size > 0 && localKeys.has(usKey.get(s));
  const tickers = new Set([...rows.map((r) => r.s), ...localSyms]);
  const largest = rows.filter((r) => r.m && !isLocalCompany(r.s)).sort((a, b) => b.m - a.m).slice(0, top);
  const names = new Map();
  // Two-letter names only for local companies ("BP" in UK news).
  const add = (name, s, short = false) => { const k = name.toLowerCase(); if ((name.length >= 3 || (short && /^[A-Z]{2}$/.test(name))) && !names.has(k)) names.set(k, s); };
  const usNames = new Set(largest.filter((r) => !r.co).map((r) => shortName(r.n)?.toLowerCase()).filter(Boolean));
  const addCompany = (r, short) => {
    const name = shortName(r.n);
    if (!name || NEVER.has(name.toLowerCase())) return;
    if (short && usNames.has(name.toLowerCase())) return;
    add(name, r.s, short);
    if (short) return; // a local company: full name only (LOCAL_ALIASES has its short names)
    const first = name.split(/\s+/)[0];
    if (first !== name && first.length >= 4 && !COMMON.has(first.toLowerCase())) add(first, r.s);
  };
  for (const [name, list] of Object.entries(LOCAL_ALIASES)) {
    const s = list.find((x) => localSyms.has(x));
    if (s) add(name, s, true);
  }
  for (const r of local) addCompany(r, true);
  for (const [name, s] of Object.entries(ALIASES)) if (tickers.has(s) && !isLocalCompany(s)) add(name, s);
  for (const r of largest) addCompany(r);
  const upper = new Set(largest.map((r) => r.s).filter((s) => !NOT_TICKERS.has(s) && (s.length >= 3 || TWO_LETTER_OK.has(s)) && /^[A-Z]+$/.test(s)));
  for (const k of names.keys()) if (localSyms.has(names.get(k))) upper.delete(k.toUpperCase());
  const crypto = new Map();
  for (const [sym, c] of Object.entries(CRYPTO)) for (const n of c.names) crypto.set(n.toLowerCase(), sym);
  const all = [...names.keys(), ...crypto.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
  const re = new RegExp(`(?<![\\w&])(${all.join('|')})(?![\\w&])`, 'gi');
  return { names, crypto, upper, tickers, re };
}

/** Most words capitalised: "Stocks Sink In Broad AI Rout" (where "Target" may just be a word). */
const titleCase = (t) => {
  const words = t.split(/\s+/).filter((w) => /^[a-z]{4,}/i.test(w));
  return words.length >= 3 && words.filter((w) => /^[A-Z]/.test(w)).length / words.length >= 0.75;
};

/**
 * Tickers a headline is about: "(NASDAQ: NVDA)", "$NVDA", "(NVDA)", a well-known upper-case
 * ticker ("AMD"), or a company/crypto name ("Nvidia", "Bitcoin"). Returns stock tickers and
 * crypto symbols (as "BTC" etc.), at most 4.
 */
export function findTickers(title, index, extra = []) {
  const found = [];
  const add = (s) => { if (s && !found.includes(s)) found.push(s); };
  for (const s of extra) if (index.tickers.has(s) || CRYPTO[s]) add(s);
  for (const m of title.matchAll(/\((?:NASDAQ|NYSE(?: American| Arca)?|AMEX|NYSEARCA|CBOE|OTC)\s*:\s*([A-Z][A-Z.-]{0,5})\)/gi)) add(m[1].toUpperCase().replace('.', '-'));
  for (const m of title.matchAll(/\$([A-Z]{1,5})\b/g)) if (index.tickers.has(m[1]) || CRYPTO[m[1]]) add(m[1]);
  for (const m of title.matchAll(/\(([A-Z]{1,5}(?:-[A-Z])?)\)/g)) if (index.tickers.has(m[1]) && !NOT_TICKERS.has(m[1])) add(m[1]);
  const tc = titleCase(title);
  for (const m of title.matchAll(index.re)) {
    const word = m[1];
    const key = word.toLowerCase();
    if (!/^[A-Z0-9]/.test(word)) continue; // proper nouns only
    if (word.length <= 3 && word !== word.toUpperCase()) continue; // "Sea", "Arm": only as SEA, ARM
    if (index.crypto.has(key)) { add(index.crypto.get(key)); continue; }
    if (tc && AMBIGUOUS.has(key)) continue;
    add(index.names.get(key));
  }
  for (const m of title.matchAll(/\b([A-Z]{2,5})\b/g)) if (index.upper.has(m[1])) add(m[1]);
  return found.filter((s) => index.tickers.has(s) || CRYPTO[s]).slice(0, 4);
}

// ---------------------------------------------------------------------------
// Grouping and scoring
// ---------------------------------------------------------------------------

const STOP = new Set(('the a an and or of to in on for with at by from as is are was were be been it its this that these those after '
  + 'before over under into amid about than more most says said say will would could may might can just not how why what when who '
  + 'which while ahead per vs via new report reports stock stocks shares share market markets investors today week year here heres '
  + 'its their they them you your our we his her has have had amid big top first last next now also still says up down').split(' '));

/** Content words of a headline, lightly stemmed ("beats" → "beat"). */
export function tokens(title) {
  return new Set(String(title).toLowerCase().replace(/[’']s\b/g, '').split(/[^a-z0-9$%]+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)));
}

const overlap = (a, b) => {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return { n, ratio: n / Math.max(1, Math.min(a.size, b.size)) };
};

/** Two headlines about the same event. */
export function sameStory(a, b) {
  if (Math.abs(a.t - b.t) > 12 * 3600) return false;
  const { n, ratio } = overlap(a.words, b.words);
  if (n >= 3 && ratio >= 0.5) return true;
  const sharedTicker = a.tickers.some((s) => b.tickers.includes(s));
  return sharedTicker && n >= 3 && ratio >= 0.4;
}

const HIGH = /\b(fed|fomc|powell|rate (?:cut|hike)s?|interest rates?|inflation|cpi|jobs report|payrolls|unemployment|recession|tariffs?|sanctions?|war|invasion|missiles?|attacks?|default|bankrupt(?:cy)?|chapter 11|halt(?:ed|s)?|crash(?:es|ed)?|plunges?|plummets?|soars?|surges?|skyrockets?|tanks?|tumbles?|sinks?|rout|sell-?off|record high|all-time high|breaking|just in)\b/i;
const MEDIUM = /\b(earnings|results|beats?|miss(?:es|ed)?|guidance|outlook|forecasts?|downgrades?|upgrades?|price target|acquires?|acquisition|merger|buyout|takeover|to buy|deal|ipo|lawsuit|probe|investigation|charges|fda|approv(?:al|es|ed)|layoffs?|job cuts|resigns?|steps? down|ceo|stock split|buybacks?|dividend|short seller|rall(?:y|ies)|jumps?|slumps?|drops?|falls?|rises?|gains?|yields?|treasur(?:y|ies)|oil|gold|bitcoin|live updates?)\b/i;
const LOW = /\b(should you|is it time|best .{0,20}stocks?|stocks? to buy|buy (?:now|right now)|millionaire|retire(?:ment|d)?|forever|could (?:make|turn|soar)|\d+ (?:stocks?|reasons|things|ways)|here'?s (?:why|what|how)|what to (?:know|expect|watch)|prediction|transcript|mortgage rates? today|savings|credit cards?|cd rates|top picks|smartest|no-brainer|motley fool|zacks|vs\.? .{0,30}which)\b/i;

/** How much a headline's words suggest it moves markets: about 0.45 (listicle) to 2.4 (shock). */
export function keywordWeight(title) {
  let w = 1;
  if (HIGH.test(title)) w *= 1.8;
  if (MEDIUM.test(title)) w *= 1.35;
  if (LOW.test(title)) w *= 0.45;
  return w;
}

const CRYPTO_RE = /\b(bitcoin|crypto|ethereum|ether|stablecoins?|blockchain|solana|xrp|dogecoin|defi|token|altcoins?|btc|eth)\b/i;
const ECONOMY_RE = /\b(fed|fomc|powell|inflation|cpi|ppi|pce|gdp|jobs report|payrolls|unemployment|jobless|treasury yields?|treasuries|bond yields?|tariffs?|recession|economy|economic|retail sales|housing|home sales|consumer (?:confidence|sentiment)|rate (?:cut|hike)s?|interest rates?|central bank|ecb|boj|boe)\b/i;
const EARNINGS_RE = /\b(earnings|results|eps|revenue|quarter(?:ly)?|q[1-4]\b|guidance|beats? (?:estimates|expectations)|misses|profit|sales forecast)\b/i;

/** Topic tags for the filter chips. */
export function topics(story, feedTopic) {
  const out = new Set();
  if (feedTopic) out.add(feedTopic);
  if (CRYPTO_RE.test(story.title) || story.tickers.some((s) => CRYPTO[s])) out.add('crypto');
  if (ECONOMY_RE.test(story.title)) out.add('economy');
  if (EARNINGS_RE.test(story.title)) out.add('earnings');
  if (story.tickers.some((s) => !CRYPTO[s])) out.add('stocks');
  return [...out];
}

// News about the largest companies matters to more people.
const sizeWeight = (m) => (m == null ? 1 : m >= 2e11 ? 1.25 : m >= 1e10 ? 1.1 : m >= 1e9 ? 1 : m >= 3e8 ? 0.75 : 0.5);
// Big moves in tiny stocks are common and rarely market news.
const moveWeight = (m) => (m == null ? 1 : m >= 1e10 ? 1 : m >= 2e9 ? 0.8 : m >= 3e8 ? 0.5 : 0.25);

/**
 * Hot score: newer, covered by more outlets, market-moving words, about large companies, and
 * about stocks that are moving a lot or trending. moves: { TICKER: % change }, caps: { TICKER:
 * market cap } (unknown counts as mid-size), trending: Set of tickers.
 */
export function hotScore(story, { now, moves = {}, caps = {}, trending = new Set() }) {
  const ageH = Math.max(0, (now - story.t) / 3600);
  let s = 0.5 ** (ageH / 4); // halves every 4 hours
  s *= 1 + 0.6 * (story.sources.length - 1);
  s *= keywordWeight(story.title);
  s *= story.weight || 1;
  if (story.tickers.length) {
    s *= Math.max(...story.tickers.map((t) => sizeWeight(caps[t])));
    s *= Math.max(...story.tickers.map((t) => 1 + (Math.min(Math.abs(moves[t] ?? 0), 20) / 8) * moveWeight(caps[t])));
  }
  if (story.tickers.some((t) => trending.has(t))) s *= 1.3;
  return s;
}

// A brand-new headline scores 1; it takes a shock word, a second outlet or a big move to be "hot".
export const HOT_MIN = 1.6;

/**
 * Feed items → stories (the same event from several outlets grouped), newest first. Each story:
 * { id, title, link, t, first, source, sources: [{ source, title, link }], tickers, topics, weight }.
 * Items older than maxAgeH are dropped. Rank them with rankStories().
 */
export function buildStories(items, { now, index, maxAgeH = 36, feeds = {} }) {
  const seen = new Set();
  const fresh = items
    .filter((x) => x.t <= now + 600 && now - x.t <= maxAgeH * 3600)
    .sort((a, b) => b.t - a.t)
    .filter((x) => {
      const k1 = x.link.replace(/[?#].*$/, ''), k2 = x.title.toLowerCase();
      if (seen.has(k1) || seen.has(k2)) return false;
      seen.add(k1); seen.add(k2);
      return true;
    })
    .map((x) => {
      const feed = feeds[x.feed] || {};
      const extra = feed.tickerCategories ? x.cats.map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{1,5}(-[A-Z])?$/.test(c)) : [];
      return { ...x, tickers: x.tickers || (index ? findTickers(x.title, index, extra) : extra), words: tokens(x.title), weight: feed.weight || 1, topic: feed.topic };
    });

  const stories = [];
  for (const item of fresh) {
    const home = stories.find((s) => s.members.some((m) => sameStory(m, item)));
    if (home) home.members.push(item);
    else stories.push({ members: [item] });
  }

  return stories.map(({ members }) => {
    const lead = members[0]; // newest
    const tickers = [...new Set(members.flatMap((m) => m.tickers))].slice(0, 4);
    const sources = [];
    for (const m of members) if (!sources.some((x) => x.source === m.source)) sources.push({ source: m.source, title: m.title, link: m.link });
    const story = {
      id: lead.link, title: lead.title, link: lead.link, t: lead.t, first: members.at(-1).t, source: lead.source,
      sources, tickers, weight: Math.max(...members.map((m) => m.weight)),
    };
    story.topics = topics(story, lead.topic);
    return story;
  });
}

/**
 * Scores stories and sorts them hottest first: adds score, hot (the top ten at most, and only
 * clearly market-moving ones) and breaking (hot and under 20 minutes old).
 */
export function rankStories(stories, { now, moves = {}, caps = {}, trending = new Set() }) {
  const out = stories.map(({ weight, ...s }) => ({ ...s, score: Math.round(hotScore({ ...s, weight }, { now, moves, caps, trending }) * 1000) / 1000 }))
    .sort((a, b) => b.score - a.score);
  const bar = Math.max(HOT_MIN, out[Math.min(9, out.length - 1)]?.score || 0);
  for (const s of out) {
    s.hot = s.score >= bar;
    s.breaking = s.hot && now - s.t < 20 * 60;
  }
  return out;
}
