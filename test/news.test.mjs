// Tests for the News panel: feed parsing, ticker tagging, story grouping and hot ranking
// (lib/news.mjs), the calendar (lib/calendar.mjs), markets outside the US (lib/markets.mjs)
// and the panel's helpers (public/js/news.js).
import assert from 'node:assert/strict';
import {
  decode, parseFeed, shortName, buildNameIndex, findTickers, tokens, sameStory, keywordWeight, hotScore, buildStories, rankStories, HOT_MIN,
} from '../lib/news.mjs';
import { nyTime, parseFomc, econTier, eventName, shapeEcon, shapeEarnings } from '../lib/calendar.mjs';
import {
  companyKey, usCountries, isForeign, toUsd, quoteCapUsd, shapeIntlEarnings, shapeListings, mergeMarkets,
} from '../lib/markets.mjs';
import {
  newsSymbol, ago, countdown, filterStories, fmtEcon, countryName, countryLabel, inCountries, countriesSummary, DEFAULT_COUNTRIES,
} from '../public/js/news.js';

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};
const NOW = 1_800_000_000;

test('decode: entities (also double-encoded), CDATA and tags', () => {
  assert.equal(decode('St. Louis Fed&apos;s Musalem'), "St. Louis Fed's Musalem");
  assert.equal(decode('Amazon&#x2019;s deals &#8212; really?'), 'Amazon’s deals — really?');
  assert.equal(decode('&amp;quot;Extreme Fear&amp;quot;'), '"Extreme Fear"');
  assert.equal(decode('<![CDATA[<b>Bold</b>  move]]>'), 'Bold move');
});

test('parseFeed: RSS items and Atom entries', () => {
  const rss = `<rss><channel><title>Feed</title>
    <item><title><![CDATA[Nvidia beats estimates]]></title><link>https://x.com/a</link><pubDate>Tue, 17 Nov 2026 14:00:00 GMT</pubDate><category>nvda</category></item>
    <item><title>No date</title><link>https://x.com/b</link></item>
    <item><title>Bad link</title><link>javascript:alert(1)</link><pubDate>Tue, 17 Nov 2026 14:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const items = parseFeed(rss, { id: 'f', source: 'Src' });
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], { title: 'Nvidia beats estimates', link: 'https://x.com/a', t: Date.UTC(2026, 10, 17, 14) / 1000, source: 'Src', feed: 'f', cats: ['nvda'] });
  const atom = `<feed><title>SEC</title><entry><title>8-K - Example Corp</title><link rel="alternate" href="https://sec.gov/x"/><updated>2026-11-17T09:22:25-05:00</updated></entry></feed>`;
  const a = parseFeed(atom, { source: 'SEC' });
  assert.equal(a.length, 1);
  assert.equal(a[0].link, 'https://sec.gov/x');
  assert.equal(a[0].t, Date.UTC(2026, 10, 17, 14, 22, 25) / 1000);
});

test('shortName: the name headlines use', () => {
  assert.equal(shortName('Meta Platforms Inc. Class A Common Stock'), 'Meta');
  assert.equal(shortName('Walt Disney Company (The)'), 'Walt Disney');
  assert.equal(shortName('Amazon.com Inc.'), 'Amazon');
  assert.equal(shortName('Eli Lilly and Company'), 'Eli Lilly');
  assert.equal(shortName('Cisco Systems Inc. Common Stock (DE)'), 'Cisco');
  assert.equal(shortName('JP Morgan Chase & Co.'), 'JP Morgan Chase');
  assert.equal(shortName('Alphabet Inc. Depositary Shares representing a 1/20th Interest'), null);
});

const LIST = [
  ['NVDA', 'NVIDIA Corporation', 4e12], ['AAPL', 'Apple Inc.', 3.9e12], ['AMD', 'Advanced Micro Devices Inc.', 4e11], ['TGT', 'Target Corporation', 7e10],
  ['HD', 'Home Depot Inc. (The)', 3.5e11], ['JPM', 'JP Morgan Chase & Co.', 8e11], ['USB', 'U.S. Bancorp', 8e10], ['NDAQ', 'Nasdaq Inc.', 5e10],
  ['DIS', 'Walt Disney Company (The)', 2e11], ['GM', 'General Motors Company', 7e10], ['ICE', 'Intercontinental Exchange Inc.', 9e10],
  ['SE', 'Sea Limited', 9e10], ['TSLA', 'Tesla Inc.', 1.2e12], ['XOM', 'ExxonMobil Holdings Corporation', 5e11],
].map(([s, n, m]) => ({ s, n, m }));
const index = buildNameIndex(LIST);

test('findTickers: names, aliases, exchange tags, cashtags, crypto', () => {
  assert.deepEqual(findTickers('Nvidia warns chip buyers of legal risks tied to China', index), ['NVDA']);
  assert.deepEqual(findTickers("AMD and Apple rally as Disney's parks shine", index), ['AMD', 'AAPL', 'DIS']);
  assert.deepEqual(findTickers('Acme Corp (NYSE: GM) signs deal', index), ['GM']);
  assert.deepEqual(findTickers('$TSLA shorts squeezed; Exxon slips', index), ['TSLA', 'XOM']);
  assert.deepEqual(findTickers('Bitcoin and Ether slide as crypto funds bleed', index), ['BTC', 'ETH']);
  assert.deepEqual(findTickers('Home Depot names a new CEO', index), ['HD']);
});

test('findTickers: avoids common false matches', () => {
  assert.deepEqual(findTickers('U.S. retail sales slow ahead of the holidays', index), []); // not U.S. Bancorp
  assert.deepEqual(findTickers('Nasdaq futures rise ahead of earnings', index), []); // the index, not the exchange company
  assert.deepEqual(findTickers('Fed Signals No Change To Its Inflation Target', index), []); // Title Case "Target"
  assert.deepEqual(findTickers('Target cuts its outlook as shoppers pull back', index), ['TGT']); // sentence case: the company
  assert.deepEqual(findTickers('ICE raids worry farm owners', index), []);
  assert.deepEqual(findTickers('Shipping costs rise in the Red Sea', index), []);
  assert.deepEqual(findTickers('apple pie prices', index), []); // lower case is not a company
});

test('tokens and sameStory: the same event from two outlets', () => {
  const a = { t: NOW, tickers: ['HD'], words: tokens('Home Depot names Richard McPhail as new CEO, beats earnings expectations') };
  const b = { t: NOW - 600, tickers: ['HD'], words: tokens('Home Depot Taps CFO Richard McPhail to Lead, Narrows Profit Outlook') };
  const c = { t: NOW, tickers: ['NVDA'], words: tokens('Nvidia warns chip buyers of legal risks tied to China AI access') };
  assert.ok(tokens('Beats estimates').has('beat'));
  assert.ok(sameStory(a, b));
  assert.ok(!sameStory(a, c));
  assert.ok(!sameStory(a, { ...b, t: NOW - 13 * 3600 }), 'more than 12 hours apart');
});

test('keywordWeight: shocks up, listicles down', () => {
  assert.ok(keywordWeight('Stocks plunge as Fed signals rate hikes') > keywordWeight('Apple unveils a new phone'));
  assert.ok(keywordWeight('3 Stocks to Buy Now and Hold Forever') < 1);
});

test('hotScore: fresher, wider coverage and big moves in big companies rank higher', () => {
  const base = { t: NOW, title: 'Company news', sources: [{}], tickers: ['A'] };
  const s = (x, opts = {}) => hotScore({ ...base, ...x }, { now: NOW, ...opts });
  assert.ok(s({}) > s({ t: NOW - 6 * 3600 }));
  assert.ok(s({ sources: [{}, {}, {}] }) > s({}));
  assert.ok(s({}, { moves: { A: 8 }, caps: { A: 3e11 } }) > s({}, { moves: { A: 8 }, caps: { A: 2e8 } }));
  assert.ok(s({}, { moves: { A: 8 }, caps: { A: 2e8 } }) > s({}, { caps: { A: 2e8 } }));
  assert.ok(s({}, { trending: new Set(['A']) }) > s({}));
});

test('buildStories + rankStories: groups outlets, tags, flags hot and breaking', () => {
  const feeds = { cnbc: { weight: 1.1 }, bz: { weight: 0.9 }, cd: { weight: 0.9, topic: 'crypto' } };
  const items = [
    { title: 'Home Depot names Richard McPhail as new CEO, beats earnings expectations', link: 'https://c/1', t: NOW - 300, source: 'CNBC', feed: 'cnbc', cats: [] },
    { title: 'Home Depot Taps CFO Richard McPhail to Lead, Narrows Profit Outlook', link: 'https://b/1', t: NOW - 120, source: 'Benzinga', feed: 'bz', cats: [] },
    { title: 'Bitcoin slips below $64,000 as ETF outflows continue', link: 'https://d/1', t: NOW - 3 * 3600, source: 'CoinDesk', feed: 'cd', cats: [] },
    { title: '3 Dividend Stocks to Buy and Hold Forever', link: 'https://n/1', t: NOW - 600, source: 'Nasdaq', feed: 'x', cats: [] },
    { title: 'Old news', link: 'https://n/2', t: NOW - 40 * 3600, source: 'Nasdaq', feed: 'x', cats: [] },
    { title: 'Home Depot names Richard McPhail as new CEO, beats earnings expectations', link: 'https://c/1?utm=x', t: NOW - 300, source: 'CNBC', feed: 'cnbc', cats: [] },
  ];
  const stories = buildStories(items, { now: NOW, index, feeds });
  assert.equal(stories.length, 3, 'grouped, deduplicated, old news dropped');
  const hd = stories.find((s) => s.tickers.includes('HD'));
  assert.equal(hd.sources.length, 2);
  assert.equal(hd.source, 'Benzinga', 'the newest headline leads');
  assert.ok(hd.topics.includes('earnings') && hd.topics.includes('stocks'));
  assert.deepEqual(stories.find((s) => s.tickers.includes('BTC')).topics, ['crypto']);
  const ranked = rankStories(stories, { now: NOW, moves: { HD: -3 }, caps: { HD: 3.5e11 } });
  assert.equal(ranked[0].tickers[0], 'HD');
  assert.ok(ranked[0].hot && ranked[0].breaking && ranked[0].score >= HOT_MIN);
  assert.ok(!ranked.at(-1).hot);
  assert.ok(ranked.every((s) => !('weight' in s)));
});

test('nyTime: New York time to UTC, with daylight saving', () => {
  assert.equal(nyTime(2026, 1, 28, 14, 0), Date.UTC(2026, 0, 28, 19, 0) / 1000); // EST
  assert.equal(nyTime(2026, 7, 29, 14, 0), Date.UTC(2026, 6, 29, 18, 0) / 1000); // EDT
});

test('parseFomc: decision days, projections, split months, notation votes skipped', () => {
  const panel = (year, rows) => `<div class="panel panel-default"><h4>${year} FOMC Meetings</h4>${rows.map(([m, d]) => `<div class="row fomc-meeting"><div class="fomc-meeting__month col-md-2"><strong>${m}</strong></div><div class="fomc-meeting__date col-md-1">${d}</div></div>`).join('')}</div>`;
  const html = panel(2026, [['January', '27-28'], ['March', '17-18*'], ['August', '22 (notation vote)']]) + panel(2024, [['Apr/May', '30-1']]);
  const ev = parseFomc(html);
  assert.equal(ev.length, 3);
  assert.deepEqual(ev.map((e) => new Date(e.t * 1000).toISOString()), ['2024-05-01T18:00:00.000Z', '2026-01-28T19:00:00.000Z', '2026-03-18T18:00:00.000Z']);
  assert.deepEqual(ev.map((e) => e.sep), [false, false, true]);
  assert.ok(ev.every((e) => e.tier === 3 && e.fed));
});

test('econTier and eventName', () => {
  assert.equal(econTier('CPI MM, SA'), 3);
  assert.equal(econTier('Initial Jobless Clm *'), 3);
  assert.equal(econTier('Housing Starts Number'), 2);
  assert.equal(econTier('WSD-Corn Output 26/27'), 1);
  assert.equal(eventName('Initial Jobless Clm *'), 'Initial Jobless Claims');
  assert.equal(eventName('Core CPI MM, SA'), 'Core CPI MoM, SA');
});

test('econTier and eventName: other countries', () => {
  assert.equal(econTier('CPI YY', 'GB'), 3);
  assert.equal(econTier('HICP Final YY *', 'EU'), 3);
  assert.equal(econTier('HICP-X Tobacco MM *', 'EU'), 2);
  assert.equal(econTier('BOE Bank Rate', 'GB'), 3);
  assert.equal(econTier('Riksbank Rate', 'SE'), 3); // rate decisions count everywhere
  assert.equal(econTier('Unem Rate Monthly SA*', 'NL'), 2); // smaller economy: key, not high impact
  assert.equal(econTier('ZEW Economic Sentiment', 'DE'), 3);
  assert.equal(econTier('Trade Balance Total Yen', 'JP'), 2);
  assert.equal(econTier('Labor Productivity Rate', 'CA'), 1);
  assert.equal(econTier('Non-Farm Payrolls', 'CH'), 2); // the US one is high impact, Switzerland's isn't
  assert.equal(eventName('Claimant Count Unem Chng'), 'Claimant Count Unemployment Change');
  assert.equal(eventName('Policy Int Rate*'), 'Policy Interest Rate');
  assert.equal(eventName('Consumer Confid. Flash *'), 'Consumer Confidence Flash');
});

test('shapeEcon: countries, and releases whose day isn\'t set yet', () => {
  const day = (d, h = 0) => `2026-11-${d}T${String(h).padStart(2, '0')}:00:00.000Z`;
  const rows = [
    { econ_release: 'CPI YY', country_code: 'GB', startdatetime: day(18, 7), period: 'Oct', after_release_actual: '3.6', prior_release_actual: '3.5' },
    { econ_release: 'CPI YY', country_code: 'GB', startdatetime: day(18, 7), period: 'Oct', after_release_actual: '3.6', prior_release_actual: '3.5' }, // duplicate
    ...[17, 18, 19, 20, 21].map((d) => ({ econ_release: 'FDI (YTD)*', country_code: 'CN', startdatetime: day(d), period: 'Oct', prior_release_actual: '-4.3' })),
    { econ_release: 'FX Reserves, USD*', country_code: 'IN', startdatetime: day(20, 11), period: null },
    { econ_release: 'FX Reserves, USD*', country_code: 'IN', startdatetime: day(27, 11), period: null }, // weekly: two real releases
  ];
  const out = shapeEcon(rows, { now: Date.UTC(2026, 10, 19, 9) / 1000 });
  assert.deepEqual(out.map((e) => `${e.c} ${e.name}${e.tbc ? ' TBC' : ''}`), ['GB CPI YoY', 'CN FDI (YTD) TBC', 'IN FX Reserves, USD', 'IN FX Reserves, USD']);
  assert.equal(out[1].t, Date.UTC(2026, 10, 19) / 1000); // shown on the first day from today
  assert.equal(out[0].tier, 3);
});

test('shapeEcon and shapeEarnings', () => {
  const e = shapeEcon([{ econ_release: 'Retail Sales MM', startdatetime: '2026-11-17T13:30:00.000Z', period: 'Oct', after_release_actual: '0.2', consensus_estimate: null, prior_release_actual: '0.8' }]);
  assert.deepEqual(e, [{ t: Date.UTC(2026, 10, 17, 13, 30) / 1000, c: 'US', name: 'Retail Sales MoM', period: 'Oct', actual: 0.2, forecast: null, prior: 0.8, tier: 3 }]);
  const rows = [
    { ticker: 'NVDA', companyshortname: 'NVIDIA', startdatetime: '2026-11-17T21:00:00.000Z', startdatetimetype: 'AMC', epsestimate: 2.47, epsactual: null, epssurprisepct: null, intradaymarketcap: 3.7e12 },
    { ticker: 'BABAF', companyshortname: 'Alibaba OTC', startdatetime: '2026-11-17T21:00:00.000Z', startdatetimetype: 'TNS', intradaymarketcap: 2e11 },
    { ticker: 'TINY', companyshortname: 'Tiny', startdatetime: '2026-11-17T13:30:00.000Z', startdatetimetype: 'BMO', intradaymarketcap: 5e8 },
    { ticker: 'HD', companyshortname: 'Home Depot', startdatetime: '2026-11-17T11:00:00.000Z', startdatetimetype: 'BMO', epsestimate: 3.84, epsactual: 3.86, epssurprisepct: 0.57, intradaymarketcap: 3.5e11 },
    { ticker: 'HD', companyshortname: 'Home Depot', startdatetime: '2026-11-18T11:00:00.000Z', startdatetimetype: 'BMO', intradaymarketcap: 3.5e11 },
  ];
  const out = shapeEarnings(rows, new Set(['NVDA', 'TINY', 'HD']), { minCap: 1e9 });
  assert.deepEqual(out.map((x) => `${x.s}:${x.when}`), ['HD:bmo', 'NVDA:amc']);
  assert.equal(out[0].surprise, 0.57);
});

const US_ROWS = [
  { s: 'WMT', n: 'Walmart Inc.', m: 9e11 }, { s: 'CSCO', n: 'Cisco Systems Inc. Common Stock (DE)', m: 3e11 },
  { s: 'HSBC', n: 'HSBC Holdings plc.', m: 2e11, co: 'United Kingdom' }, { s: 'SAP', n: 'SAP  SE ADS', m: 2.5e11, co: 'Germany' },
  { s: 'BABA', n: 'Alibaba Group Holding Limited', m: 3e11, co: 'China' }, { s: 'MDT', n: 'Medtronic plc.', m: 1e11 },
  { s: 'ACN', n: 'Accenture plc', m: 1.5e11, co: 'Ireland' }, { s: 'MCD', n: "McDonald's Corporation", m: 2e11 },
];
const US = usCountries(US_ROWS);
const FX = { EUR: 1.1, GBP: 1.3, HKD: 0.128, JPY: 0.0065, CHF: 1.2 };

test('markets: company keys, foreign lines, dollars', () => {
  assert.equal(companyKey('Cisco Systems Inc. Common Stock (DE)'), companyKey('Cisco Systems, Inc.'));
  assert.equal(companyKey('Dell Technologies Inc. Class C Common Stock'), 'dell technologies');
  assert.equal(companyKey('Nestlé S.A.'), 'nestle');
  assert.equal(isForeign('Walmart Inc.', 'DE', US), true); // a US company's line in Frankfurt
  assert.equal(isForeign('SAP SE', 'DE', US), false); // a German company with US shares
  assert.equal(isForeign('Alibaba Group Holding Limited', 'HK', US), false);
  assert.equal(isForeign('Alibaba Group Holding Limited', 'DE', US), true);
  assert.equal(isForeign('Accenture plc', 'DE', US), false); // registered in Ireland: can't tell
  assert.equal(isForeign('Prosus N.V.', 'CH', US), false); // not listed in the US: can't tell
  assert.equal(toUsd(3173e9, 'GBp', FX), 3173e9 / 100 * 1.3); // the calendar gives London caps in pence
  assert.equal(toUsd(100, 'USD', FX), 100);
  assert.equal(quoteCapUsd({ marketCap: 31.7e9, currency: 'GBp' }, FX), 31.7e9 * 1.3); // quotes give them in pounds
});

test('markets: earnings and company lists outside the US', () => {
  const at = '2026-11-18T07:00:00.000Z';
  const earn = shapeIntlEarnings([
    { ticker: '0Z4S.L', companyshortname: 'Tencent Holdings Limited', startdatetime: at, intradaymarketcap: 3e12 }, // foreign line in London
    { ticker: 'SSE.L', companyshortname: 'SSE plc', startdatetime: at, intradaymarketcap: 3173e9, epsestimate: '0.5' },
    { ticker: 'TINY.L', companyshortname: 'Tiny plc', startdatetime: at, intradaymarketcap: 5e9 }, // £50M
  ], 'GB', { fx: FX, us: US });
  assert.deepEqual(earn.map((e) => e.s), ['SSE.L']);
  assert.equal(earn[0].c, 'GB');
  assert.equal(earn[0].est, 0.5);
  const de = shapeIntlEarnings([{ ticker: 'WMT.DE', companyshortname: 'Walmart Inc.', startdatetime: at, intradaymarketcap: 9e11 }], 'DE', { fx: FX, us: US });
  assert.deepEqual(de, []);
  const lse = shapeListings([
    { symbol: 'TYT.L', longName: 'Toyota Motor Corporation', marketCap: 4e13, currency: 'JPY', quoteType: 'EQUITY' }, // quoted in yen
    { symbol: 'HSBA.L', longName: 'HSBC Holdings plc', marketCap: 2.2e11, currency: 'GBp', quoteType: 'EQUITY' },
    { symbol: 'BP-A.L', longName: 'BP p.l.c.', marketCap: NaN, currency: 'GBp', quoteType: 'EQUITY' },
  ], 'GB', { fx: FX, us: US });
  assert.deepEqual(lse.map((r) => r.s), ['HSBA.L']);
  const hk = shapeListings([{ symbol: '0005.HK', longName: 'HSBC Holdings plc', marketCap: 2.3e12, currency: 'HKD' },
    { symbol: '0700.HK', longName: 'Tencent Holdings Limited', marketCap: 3.3e12, currency: 'HKD' }], 'HK', { fx: FX, us: US });
  // HSBC's US listing says United Kingdom: London wins over Hong Kong.
  assert.deepEqual(mergeMarkets({ HK: hk, GB: lse }, US).map((r) => r.s), ['HSBA.L', '0700.HK']);
  const nl = [{ s: 'PRX.AS', n: 'Prosus N.V.', m: 7e10, k: companyKey('Prosus N.V.') }];
  const ch = [{ s: 'PRX.SW', n: 'Prosus N.V.', m: 7e10, k: companyKey('Prosus N.V.') }];
  assert.deepEqual(mergeMarkets({ CH: ch, NL: nl }, US).map((r) => r.s), ['PRX.AS']);
});

test('findTickers: a region\'s own companies', () => {
  const local = [
    { s: 'HSBA.L', n: 'HSBC Holdings plc', m: 2.9e11 }, { s: '7203.T', n: 'Toyota Motor Corporation', m: 2.6e11 },
    { s: '3017.TW', n: 'Asia Vital Components Co., Ltd.', m: 1.5e10 }, { s: '2702.T', n: "McDonald's Holdings Company (Japan), Ltd.", m: 5e9 },
    { s: 'NXT.L', n: 'Next plc', m: 2e10 }, { s: 'BP.L', n: 'BP p.l.c.', m: 8e10 },
  ];
  const idx = buildNameIndex(US_ROWS, { local });
  assert.deepEqual(findTickers('HSBC profits beat forecasts', idx), ['HSBA.L']); // not the US shares
  assert.deepEqual(findTickers('Toyota raises its outlook', idx), ['7203.T']); // a short name from the alias list
  assert.deepEqual(findTickers('BP and Walmart shares rise', idx), ['BP.L', 'WMT']);
  assert.deepEqual(findTickers('Asia stocks slip as yen firms', idx), []); // "Asia Vital Components" is matched in full only
  assert.deepEqual(findTickers("McDonald's raises prices again", idx), ['MCD']); // the US company keeps its name
  assert.deepEqual(findTickers('Next week: what to watch', idx), []);
  assert.deepEqual(findTickers('HSBC profits beat forecasts', buildNameIndex(US_ROWS)), ['HSBC']); // US news: the US shares
});

test('panel helpers: news symbol, times, filters, values', () => {
  assert.equal(newsSymbol('YAHOO:NVDA'), 'NVDA');
  assert.equal(newsSymbol('BINANCE:BTCUSDT'), 'BTC');
  assert.equal(newsSymbol('COINBASE:ETH-USD'), 'ETH');
  assert.equal(newsSymbol(''), '');
  assert.equal(ago(NOW - 30, NOW), 'now');
  assert.equal(ago(NOW - 300, NOW), '5m');
  assert.equal(ago(NOW - 7200, NOW), '2h');
  assert.equal(countdown(NOW + 8040, NOW), 'in 2h 14m');
  assert.equal(countdown(NOW + 2 * 86400 + 3600, NOW), 'in 2d 1h');
  assert.equal(countdown(NOW + 30, NOW), 'now');
  const stories = [{ t: 1, topics: ['crypto'] }, { t: 3, topics: ['stocks'] }, { t: 2, topics: ['stocks', 'earnings'] }];
  assert.deepEqual(filterStories(stories, { topic: 'stocks' }).map((s) => s.t), [3, 2]);
  assert.deepEqual(filterStories(stories, { view: 'latest' }).map((s) => s.t), [3, 2, 1]);
  assert.equal(fmtEcon(0.2, 'Retail Sales MoM'), '0.2%');
  assert.equal(fmtEcon(1250, 'Housing Starts'), '1,250');
  assert.equal(fmtEcon(null, 'x'), '—');
  assert.equal(countryName('EU'), 'Euro area');
  assert.equal(countryName('JP'), 'Japan');
  assert.equal(countryLabel('GB'), 'UK');
  assert.equal(inCountries('JP', ['*']), true);
  assert.equal(inCountries('JP', ['US', 'EU']), false);
  assert.equal(countriesSummary(['*']), 'All countries');
  assert.equal(countriesSummary(['JP']), 'Japan');
  assert.equal(countriesSummary(DEFAULT_COUNTRIES), 'US, EU, UK +6');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
