// Economic and earnings calendar for the News panel: economic releases for about 60 countries
// and US earnings (from Yahoo's calendar data) plus Fed rate decisions (from the Fed's FOMC
// schedule). Earnings elsewhere: lib/markets.mjs. Pure functions, unit-tested in test/news.test.mjs.

/** Unix seconds for a New York wall-clock time (handles daylight saving). */
export function nyTime(y, month, d, hh = 0, mm = 0) {
  const guess = Date.UTC(y, month - 1, d, hh, mm);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return Math.round((2 * guess - shown) / 1000);
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthIndex = (s) => MONTHS.findIndex((m) => m.startsWith(s.toLowerCase().slice(0, 3)));

/**
 * Fed rate decisions from the Fed's FOMC calendar page: [{ t, name, tier, sep }], announced at
 * 2:00 pm New York time on a meeting's last day. sep: comes with the Fed's economic projections.
 */
export function parseFomc(html) {
  const out = [];
  for (const panel of String(html).split(/<div class="panel panel-default">/).slice(1)) {
    const year = Number(/(\d{4}) FOMC Meetings/.exec(panel)?.[1]);
    if (!year) continue;
    for (const m of panel.matchAll(/fomc-meeting__month[^>]*>\s*<strong>([^<]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]+)</g)) {
      const months = m[1].trim().split('/');
      const date = m[2].trim();
      const days = /^(\d{1,2})-(\d{1,2})(\*?)/.exec(date); // "17-18*"; skips "22 (notation vote)"
      if (!days) continue;
      const mi = monthIndex(months.at(-1));
      if (mi < 0) continue;
      // "Jan/Feb 31-1": the decision is in the second month.
      const t = nyTime(year, mi + 1, Number(days[2]), 14, 0);
      out.push({ t, name: 'Fed interest rate decision', tier: 3, sep: !!days[3], fed: true });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// How much markets usually care about a US release: 3 high, 2 medium, 1 low.
const HIGH = [/^core cpi (mm|yy)/i, /^cpi (mm|yy)/i, /^ppi final demand mm/i, /^core pce price index (mm|yy)/i, /^pce price index (mm|yy)/i,
  /non-?farm payrolls/i, /^unemployment rate/i, /^average earnings mm/i, /^retail sales mm/i, /^gdp (advance|2nd estimate|3rd estimate|final)/i,
  /fed funds|fomc|rate decision/i, /^ism (manufacturing|mfg) pmi/i, /^ism n-?mfg pmi/i, /^initial jobless cl/i, /jolts job openings/i,
  /^u mich sentiment/i, /^consumer confidence/i];
const MEDIUM = [/^core cpi index/i, /^ppi ex ?food\/energy mm/i, /^durable goods/i, /^housing starts number/i, /^building permits: number/i,
  /^existing home sales$/i, /^new home sales-units/i, /^industrial production mm/i, /^philly fed business/i, /^ny fed manufacturing/i,
  /^adp national employ/i, /^s&p global (mfg|svcs|comp)/i, /^trade balance|^goods trade balance/i, /^retail control/i, /^import prices mm/i,
  /^pending sales change/i, /^chicago pmi/i, /^eia wkly crude stk/i, /^caseshiller 20 yy/i, /^personal income mm/i, /^consumption, adjusted mm/i,
  /^u mich (1|5)-?yr inf/i, /^cont jobless cl/i, /^nahb housing/i, /^leading index/i, /^gdp (deflator|cons spending|sales)/i, /^core pce prices/i,
  /^corporate profits/i, /^ism (manufacturing|mfg) prices/i, /^ism n-?mfg (bus|price)/i, /^atlanta fed gdpnow/i];

const clean = (n) => String(n || '').replace(/\s*\*+\s*$/, '').replace(/\s+/g, ' ').trim();

// Other countries: the same kinds of releases, named many ways ("CPI Inflation MM", "HICP Final YY",
// "BOE Bank Rate", "Claimant Count Unem Chng").
const RATE = /rate decision|bank rate|cash rate|refinancing rate|deposit (facility )?rate|policy (int(erest)? )?rate|key (policy )?rate|base rate|repo rate|selic|^interest rate|loan prime rate|riksbank rate|benchmark interest|fed funds|fomc/i;
const INTL_HIGH = [RATE, /\b(cpi|hicp)\b(?!.*(tobacco|f, ?e, ?a|a ?& ?t|\bnsa\b|index))/i, /\bgdp\b(?!.*(deflator|detailed|nominal|capex|per capita))/i,
  /unemployment rate|\bunem(p|ployment)?\.? rate|employment change|claimant count|jobless rate/i, /^retail sales (mm|mom)\b/i,
  /\b(manufacturing|mfg|services|composite|nbs|caixin|official)\b.*\bpmi\b|\bpmi\b.*\b(manufacturing|mfg|services|composite)\b/i,
  /zew economic sentiment|ifo business climate|tankan/i];
const INTL_MEDIUM = [/\b(cpi|hicp|inflation)\b/i, /\bgdp\b/i, /\bpmi\b/i, /retail sales/i, /\bppi\b|producer prices|\bwpi\b|\brpi/i,
  /trade balance|exports|imports|current account/i, /industrial (production|output)|manufacturing (production|output)|machinery orders|factory orders/i,
  /consumer confid|consumer sentiment|gfk|business (climate|confidence|sentiment)|\bzew\b|\bifo\b|\bcbi\b|investor sentiment/i,
  /wage|earnings|labou?r cost|employment|participation rate|payrolls/i, /house prices|housing|house starts|home sales|building (approvals|permits)/i,
  /\bm3\b|money supply|new (yuan )?loans|total social financing|lending/i, /capex|capital expenditure|construction work/i];
// Where only the biggest economies' releases count as high impact.
const MAJOR = new Set(['US', 'EU', 'GB', 'DE', 'FR', 'JP', 'CN', 'CA', 'AU', 'NZ', 'CH']);

/** How much markets usually care about a release: 3 high, 2 medium, 1 low. */
export function econTier(name, country = 'US') {
  const n = clean(name);
  if (country === 'US') {
    if (HIGH.some((re) => re.test(n))) return 3;
    if (MEDIUM.some((re) => re.test(n))) return 2;
    return 1;
  }
  if (INTL_HIGH.some((re) => re.test(n))) return MAJOR.has(country) || RATE.test(n) ? 3 : 2;
  if (INTL_MEDIUM.some((re) => re.test(n))) return 2;
  return 1;
}

/** Yahoo's terse release names, made readable: "Initial Jobless Clm" → "Initial Jobless Claims". */
export function eventName(name) {
  return clean(name)
    .replace(/\bMM\b/g, 'MoM').replace(/\bYY\b/g, 'YoY').replace(/\bQQ\b/g, 'QoQ')
    .replace(/\bClm\b/g, 'Claims').replace(/\bWkly\b/g, 'Weekly').replace(/\bStk\b/g, 'Stocks').replace(/\bIndx\b/g, 'Index')
    .replace(/\bExist\./g, 'Existing').replace(/\bChg\b/g, 'Change').replace(/\bN-Mfg\b/g, 'Services').replace(/\bMfg\b/g, 'Manufacturing')
    .replace(/\bU Mich\b/g, 'UMich').replace(/\bCont\b/g, 'Continuing').replace(/\bBuild\b/g, 'Building').replace(/\bProds\b/g, 'Products')
    .replace(/\bUnem\b/g, 'Unemployment').replace(/\bChng\b/g, 'Change').replace(/\bConfid\./g, 'Confidence').replace(/\bGrwth\b/g, 'Growth')
    .replace(/\bAvg\b/g, 'Average').replace(/\bWk\b/g, 'Weekly').replace(/\bInt(?= Rate)/g, 'Interest').replace(/\bO\/N\b/g, 'Overnight')
    .replace(/\s+([,.])/g, '$1');
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Yahoo "economic_event" rows → [{ t, c, name, period, actual, forecast, prior, tier, tbc? }], c: country
 * code ("EU" is the euro area). Yahoo lists releases whose day isn't set yet once a day at midnight
 * UTC ("FDI (YTD)" every day for a week); those become one event with tbc: true.
 */
export function shapeEcon(rows, { now = Date.now() / 1000 } = {}) {
  const uniq = new Map();
  for (const r of rows) {
    const c = String(r.country_code || 'US').toUpperCase();
    const e = {
      t: Math.floor(Date.parse(r.startdatetime) / 1000),
      c,
      name: eventName(r.econ_release),
      period: r.period && r.period !== 'N/A' ? r.period : '',
      actual: num(r.after_release_actual),
      forecast: num(r.consensus_estimate),
      prior: num(r.prior_release_actual),
      tier: econTier(r.econ_release, c),
    };
    if (Number.isFinite(e.t) && e.name) uniq.set(`${c}|${e.name}|${e.period}|${e.t}`, e);
  }
  const groups = new Map();
  for (const e of uniq.values()) {
    const k = `${e.c}|${e.name}|${e.period}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const today = Math.floor(now / 86400) * 86400;
  const out = [];
  for (const g of groups.values()) {
    if (g.length < 3 || !g.every((e) => e.t % 86400 === 0)) { out.push(...g); continue; }
    g.sort((a, b) => a.t - b.t);
    const out1 = g.find((e) => e.actual != null);
    out.push(out1 || { ...(g.find((e) => e.t >= today) || g.at(-1)), tbc: true });
  }
  return out.sort((a, b) => a.t - b.t);
}

const WHEN = { BMO: 'bmo', AMC: 'amc' };

/**
 * Yahoo "sp_earnings" rows → [{ t, s, n, when ('bmo' before the open, 'amc' after the close, or null),
 * est, act, surprise, m }], only for stocks in `listed` (US-listed tickers) worth at least minCap.
 */
export function shapeEarnings(rows, listed, { minCap = 1e9 } = {}) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const s = r.ticker;
    if (!s || seen.has(s) || (listed && !listed.has(s)) || (r.intradaymarketcap || 0) < minCap) continue;
    seen.add(s);
    out.push({
      t: Math.floor(Date.parse(r.startdatetime) / 1000), s, n: r.companyshortname || '', when: WHEN[r.startdatetimetype] || null,
      est: num(r.epsestimate), act: num(r.epsactual), surprise: num(r.epssurprisepct), m: r.intradaymarketcap || null,
    });
  }
  return out.filter((e) => Number.isFinite(e.t)).sort((a, b) => a.t - b.t || (b.m || 0) - (a.m || 0));
}
