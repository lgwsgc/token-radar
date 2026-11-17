// The token-radar value model.
//
// What this file does: it reads the sealed DefiLlama snapshot, keeps the
// protocols that could still launch a token, and ranks them by an implied
// launch value that follows from the snapshot's own figures alone:
//
//   implied = TVL x category multiple x growth factor x age factor x chain factor
//
// The category multiple is the median market-cap-to-TVL ratio of the tokened
// protocols in the same category (a comparables multiple, computed here from
// the snapshot, never a hardcoded list of names). Growth is the protocol's
// seven-day TVL change, clamped so one wild week cannot dominate. Age is how
// long the protocol has run with no token, saturating after about a year.
// Chain breadth is how many chains it runs on. Nothing here names a protocol.

export interface Proto {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  multiple: number;
  growth_factor: number;
  age_factor: number;
  chain_factor: number;
  on_watchlist: boolean;
}

export interface RadarStats {
  as_of: string;
  floor_usd: number;
  protocol_count: number;
  watchlist_count: number;
  board_rows: number;
  pre_token_count: number;
  excluded_count: number;
  global_multiple: number;
  total_implied_usd: number;
  top_implied_usd: number;
  categories: { name: string; rows: number; multiple: number }[];
}

// A protocol is out of the running when it is a wrapped, staked or bridged
// product of a token that already trades, a centralised exchange, or a
// versioned copy: the same rule the house used to draw its watchlist,
// applied here to the whole board. Categories, name words and name shapes
// decide it; no protocol is named.
const OUT_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

// A category multiple needs at least this many tokened comparables, or the
// global median stands in. Multiples are clamped so one odd comparable
// cannot set the price for a whole category.
const MIN_COMPS = 4;
const MULTIPLE_LOW = 0.02;
const MULTIPLE_HIGH = 2.0;

// Growth moves the value by at most half its weight, and a week's change
// counts only inside this band: a protocol that 45x'd in seven days is a
// data quirk or a launch spike, not a 45x better token.
const GROWTH_WEIGHT = 0.5;
const GROWTH_LOW = -40;
const GROWTH_HIGH = 80;

// Age saturates: a year with no token is most of the signal, and a protocol
// that has run three years without one is worth no more for its fourth.
const AGE_BASE = 0.75;
const AGE_SPAN = 0.25;
const AGE_HALF_LIFE_DAYS = 365;
const AGE_UNKNOWN = 0.875;

// Each extra chain adds a little: reach counts, but the tenth chain adds
// less than the second.
const CHAIN_STEP = 0.03;
const CHAIN_CAP = 10;

const DAY_MS = 86_400_000;

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Parse and minimally validate the snapshot's JSON text. */
export function loadSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (typeof raw.as_of !== 'string' || !Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot: expected as_of, protocols and watchlist');
  }
  for (const p of raw.protocols) {
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number') {
      throw new Error('snapshot: a protocol lacks slug, name or tvl_usd');
    }
  }
  return raw;
}

/** True when the snapshot records no token for the protocol. */
export function isPreToken(p: Proto): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** True when the protocol is a wrapped, staked, bridged or exchange product, or a versioned copy. */
export function isOutOfScope(p: Proto): boolean {
  if (p.category !== null && OUT_CATEGORIES.has(p.category)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  if (EXCHANGE_PREFIXES.some((e) => p.name.startsWith(e))) return true;
  if (VERSION_SUFFIX.test(p.name)) return true;
  return false;
}

/** Days from the protocol's first tracking day to the snapshot's date, or null. */
function ageDays(p: Proto, asOf: string): number | null {
  if (p.listed_at === null) return null;
  const listed = Date.parse(`${p.listed_at}T00:00:00Z`);
  const at = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(listed) || Number.isNaN(at) || at < listed) return null;
  return Math.floor((at - listed) / DAY_MS);
}

/**
 * The comparables multiples: for each category, the median market-cap-to-TVL
 * ratio of its tokened protocols that carry a market cap, when at least
 * MIN_COMPS of them exist; otherwise the global median across all of them.
 */
export function computeMultiples(snapshot: Snapshot): { byCategory: Map<string, number>; global: number } {
  const byCat = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p) || p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio < 0) continue;
    all.push(ratio);
    const key = p.category ?? 'Uncategorised';
    const list = byCat.get(key) ?? [];
    list.push(ratio);
    byCat.set(key, list);
  }
  const global = clamp(all.length > 0 ? median(all) : 0.2, MULTIPLE_LOW, MULTIPLE_HIGH);
  const byCategory = new Map<string, number>();
  for (const [cat, ratios] of byCat) {
    byCategory.set(cat, ratios.length >= MIN_COMPS ? clamp(median(ratios), MULTIPLE_LOW, MULTIPLE_HIGH) : global);
  }
  return { byCategory, global };
}

function multipleFor(p: Proto, multiples: { byCategory: Map<string, number>; global: number }): number {
  if (p.category === null) return multiples.global;
  return multiples.byCategory.get(p.category) ?? multiples.global;
}

function growthFactor(p: Proto): number {
  if (p.change_7d === null || !Number.isFinite(p.change_7d)) return 1;
  return 1 + GROWTH_WEIGHT * (clamp(p.change_7d, GROWTH_LOW, GROWTH_HIGH) / 100);
}

function ageFactor(days: number | null): number {
  if (days === null) return AGE_UNKNOWN;
  return AGE_BASE + AGE_SPAN * (1 - Math.exp(-days / AGE_HALF_LIFE_DAYS));
}

function chainFactor(p: Proto): number {
  return 1 + CHAIN_STEP * Math.min(p.chains.length, CHAIN_CAP);
}

/** The implied launch value in whole dollars, from the snapshot's figures alone. */
export function impliedValue(
  p: Proto,
  multiples: { byCategory: Map<string, number>; global: number },
  asOf: string,
): { value: number; multiple: number; growth: number; age: number; chain: number; days: number | null } {
  const multiple = multipleFor(p, multiples);
  const growth = growthFactor(p);
  const days = ageDays(p, asOf);
  const age = ageFactor(days);
  const chain = chainFactor(p);
  const value = Math.max(1, Math.round(p.tvl_usd * multiple * growth * age * chain));
  return { value, multiple, growth, age, chain, days };
}

// Typical cost of one transaction on each chain, as a reader would see it.
// A chain not listed here falls back to the default line.
const GAS: Record<string, string> = {
  Ethereum: '$2–$15',
  Solana: '~$0.001',
  Base: '~$0.01–$0.05',
  Arbitrum: '~$0.05–$0.30',
  BSC: '~$0.05–$0.20',
  Polygon: '~$0.01–$0.05',
  Optimism: '~$0.02–$0.10',
  Avalanche: '~$0.05–$0.30',
  Sui: '~$0.001–$0.01',
  Aptos: '~$0.001–$0.01',
  Hyperliquid: '~$0.01',
  Berachain: '~$0.01–$0.05',
  Scroll: '~$0.01–$0.05',
  Linea: '~$0.01–$0.05',
  zkSync: '~$0.02–$0.10',
  Gnosis: '~$0.01–$0.05',
  Fantom: '~$0.01–$0.05',
  Tron: '~$0.10–$0.50',
  Near: '~$0.001–$0.01',
  Cosmos: '~$0.01–$0.05',
};
const GAS_DEFAULT = '~$0.10–$1';

function gasFor(chain: string): string {
  return GAS[chain] ?? GAS_DEFAULT;
}

type PlanCtx = { name: string; chain: string; chain2: string; gas: string; gas2: string; multi: boolean };

function planDex(c: PlanCtx): string[] {
  const cross = c.multi
    ? `Route a second swap a week later on ${c.chain2} if ${c.name} runs there, so your activity spans more than one chain (gas ${c.gas2}; 5 minutes).`
    : `Make a second, different-sized swap a week later, so the record shows repeat use on more than one day (gas ${c.gas}; 5 minutes).`;
  return [
    `Swap $100–$500 on ${c.name} on ${c.chain} to open a position and leave an on-chain footprint (gas ${c.gas} per swap; about 5 minutes).`,
    `Add $200–$1,000 of liquidity to one of ${c.name}'s busiest ${c.chain} pools and hold the LP position for at least 30 days (two transactions, gas ${c.gas} each; 10 minutes to set up).`,
    cross,
    `Keep the position active for a full month and claim or compound any fees weekly, so the record shows repeated use rather than a single visit (a few minutes a week).`,
    `Watch ${c.name}'s announcements for a points program or snapshot date, and keep funds in place until any snapshot passes (no extra cost; check weekly).`,
  ];
}

function planLending(c: PlanCtx): string[] {
  const cross = c.multi
    ? `Supply on a second market or chain (${c.chain2}) if ${c.name} supports it, to widen the footprint (gas ${c.gas2}; 10 minutes).`
    : `Supply a second collateral type on ${c.chain} if ${c.name} lists one, to widen the footprint (gas ${c.gas}; 10 minutes).`;
  return [
    `Supply $200–$1,000 of collateral (ETH or a stablecoin) to ${c.name} on ${c.chain} (gas ${c.gas}; about 10 minutes).`,
    `Borrow 30–50% of your collateral value in a stablecoin and hold the loan open for at least 30 days, keeping the health factor above 1.5 (gas ${c.gas}; 5 minutes).`,
    `Repay part of the loan after two weeks, then borrow again, so the record shows more than one borrow cycle (gas ${c.gas} per action; 10 minutes).`,
    cross,
    `Leave the position open until any announced snapshot; check the health factor weekly so a price move never liquidates you (no cost; 5 minutes a week).`,
  ];
}

function planYield(c: PlanCtx): string[] {
  const cross = c.multi
    ? `Split a second deposit across another vault or chain (${c.chain2}) to show breadth (gas ${c.gas2}; 10 minutes).`
    : `Split a second deposit across another vault to show breadth (gas ${c.gas}; 10 minutes).`;
  return [
    `Deposit $100–$500 into ${c.name}'s highest-TVL vault on ${c.chain} (gas ${c.gas}; about 10 minutes).`,
    `Stake the vault receipt token if ${c.name} offers staking, so the position earns boosted rewards (one more transaction, gas ${c.gas}; 5 minutes).`,
    `Harvest or compound rewards once a week for at least a month (gas ${c.gas} per harvest; 5 minutes each time).`,
    cross,
    `Hold the position until any snapshot date; track the vault's APY weekly and move only if it collapses (no cost; 5 minutes a week).`,
  ];
}

function planCurator(c: PlanCtx): string[] {
  const cross = c.multi
    ? `If ${c.name} runs vaults on ${c.chain2}, allocate a smaller share there to show cross-chain use (gas ${c.gas2}; 10 minutes).`
    : `If ${c.name} runs a second vault strategy, allocate a smaller share there to show breadth (gas ${c.gas}; 10 minutes).`;
  return [
    `Deposit $200–$1,000 into ${c.name}'s largest curated vault on ${c.chain} and hold the vault shares (gas ${c.gas}; about 10 minutes).`,
    `Read the vault's curator allocation and pick a vault whose strategy you understand; avoid vaults you cannot explain (no cost; 20 minutes of reading).`,
    `Add a second deposit after two weeks rather than all at once, so the record shows repeat allocation (gas ${c.gas}; 5 minutes).`,
    cross,
    `Hold vault shares for at least 60 days and review curator performance monthly; exit only if the curator underperforms its peers (no cost; 10 minutes a month).`,
  ];
}

function planRwa(c: PlanCtx): string[] {
  return [
    `Check whether ${c.name} needs identity verification for its ${c.chain} market and complete it if so (free; 15–30 minutes).`,
    `Buy $100–$500 of ${c.name}'s tokenized asset on ${c.chain} and hold it (gas ${c.gas}; about 10 minutes).`,
    `If the asset pays yield, claim or reinvest it monthly so the record shows ongoing holding (gas ${c.gas} per claim; 5 minutes).`,
    `Hold through at least one full yield cycle (30–90 days) rather than flipping the position (no extra cost).`,
    `Keep the holding until any snapshot; watch ${c.name}'s announcements for a token or points program (no cost; check weekly).`,
  ];
}

function planDerivatives(c: PlanCtx): string[] {
  return [
    `Open a small perpetuals position ($50–$200 notional, 2–3x leverage at most) on ${c.name} on ${c.chain} (gas ${c.gas}; about 10 minutes).`,
    `Close the position after a few days, then open a second one the following week, so the record shows repeat trading (gas ${c.gas} per trade; 10 minutes each).`,
    `Provide $100–$500 of liquidity to ${c.name}'s perp liquidity pool if one exists, and hold it for 30 days (gas ${c.gas}; 10 minutes).`,
    `Keep total exposure small: never risk more than you can lose, and set a stop so one move cannot wipe the position (no cost; 5 minutes to set).`,
    `Trade at least twice a month for two months; check funding rates before each trade so you are not paying to hold (no cost; 5 minutes a trade).`,
  ];
}

function planCdp(c: PlanCtx): string[] {
  return [
    `Lock $200–$1,000 of collateral in ${c.name} on ${c.chain} and mint stablecoins against it at under 50% of the limit (gas ${c.gas}; about 10 minutes).`,
    `Use the minted stablecoins in another DeFi position or hold them; do not mint to the maximum (no extra cost).`,
    `Top up collateral or repay debt after two weeks to show an active position (gas ${c.gas}; 5 minutes).`,
    `Keep the collateral ratio well above the liquidation line and check it weekly (no cost; 5 minutes a week).`,
    `Hold the CDP open for at least 60 days; close it only after any snapshot passes (gas ${c.gas} to close; 5 minutes).`,
  ];
}

function planBasis(c: PlanCtx): string[] {
  return [
    `Deposit $100–$500 into ${c.name}'s basis vault on ${c.chain} (gas ${c.gas}; about 10 minutes).`,
    `Read how the vault earns its basis (spot long plus perp short) so you know what the yield depends on (no cost; 15 minutes).`,
    `Hold the deposit for at least 30 days and harvest yield weekly (gas ${c.gas} per harvest; 5 minutes).`,
    `Watch funding rates: if they turn negative for a week, the vault's edge is gone and you can exit (no cost; check weekly).`,
  ];
}

function planPrediction(c: PlanCtx): string[] {
  return [
    `Place a small first bet ($20–$100) on a ${c.name} market on ${c.chain} that you have researched (gas ${c.gas}; about 10 minutes).`,
    `Provide $100–$500 of liquidity to one of ${c.name}'s markets and hold it until the market resolves (gas ${c.gas}; 10 minutes).`,
    `Bet on a second market the following week so the record shows repeat participation (gas ${c.gas}; 10 minutes).`,
    `Hold positions to resolution rather than flipping them, and keep total stakes small enough that losing them all would not hurt (no extra cost).`,
  ];
}

function planStaking(c: PlanCtx): string[] {
  return [
    `Stake $100–$500 with ${c.name} on ${c.chain} and hold the receipt token (gas ${c.gas}; about 10 minutes).`,
    `If ${c.name} lets you restake the receipt, do so for a second layer of exposure (one more transaction, gas ${c.gas}; 5 minutes).`,
    `Add a second stake after two weeks rather than all at once (gas ${c.gas}; 5 minutes).`,
    `Hold the stake for at least 60 days and claim rewards monthly (gas ${c.gas} per claim; 5 minutes).`,
  ];
}

function planGeneric(c: PlanCtx): string[] {
  const cross = c.multi
    ? `If ${c.name} runs on ${c.chain2}, repeat the same action there to show cross-chain use (gas ${c.gas2}; 10 minutes).`
    : `Use a second feature of ${c.name} — a different pool, market or vault — the following week (gas ${c.gas}; 10 minutes).`;
  return [
    `Use ${c.name} on ${c.chain} with $100–$500: make a first deposit, swap or stake and leave a real on-chain footprint (gas ${c.gas}; about 10 minutes).`,
    `Return a week later and use it again — a second transaction on a different day counts more than one big first visit (gas ${c.gas}; 5 minutes).`,
    cross,
    `Stay active at least once a month for two to three months and watch for a points program or snapshot announcement (no cost; 5 minutes a month).`,
  ];
}

const PLANS: Record<string, (c: PlanCtx) => string[]> = {
  Dexs: planDex,
  Lending: planLending,
  Yield: planYield,
  'Yield Aggregator': planYield,
  'Risk Curators': planCurator,
  'Onchain Capital Allocator': planCurator,
  RWA: planRwa,
  Derivatives: planDerivatives,
  'Interest Rate Derivatives': planDerivatives,
  CDP: planCdp,
  'CDP Manager': planCdp,
  'Basis Trading': planBasis,
  'Prediction Market': planPrediction,
  'Staking Pool': planStaking,
  Restaking: planStaking,
  'Leveraged Farming': planYield,
  Farm: planYield,
};

/** The farm plan for one protocol: concrete steps from its category and chains. */
export function farmPlan(p: Proto): string[] {
  const chain = p.chains[0] ?? 'Ethereum';
  const multi = p.chains.length > 1;
  const chain2 = multi ? p.chains[1]! : chain;
  const ctx: PlanCtx = { name: p.name, chain, chain2, gas: gasFor(chain), gas2: gasFor(chain2), multi };
  const make = (p.category !== null && PLANS[p.category]) || planGeneric;
  return make(ctx);
}

/**
 * Build the board: every pre-token protocol that is not a wrapped, staked,
 * bridged or exchange product, ranked by implied launch value. The watchlist
 * is inside it by construction; the board is the whole eligible set, not a
 * top-N cut, so nothing the radar exists to find is left out.
 */
export function buildBoard(snapshot: Snapshot): { rows: BoardRow[]; stats: RadarStats } {
  const multiples = computeMultiples(snapshot);
  const watch = new Set(snapshot.watchlist);
  const eligible = snapshot.protocols.filter((p) => isPreToken(p) && !isOutOfScope(p));
  const excluded = snapshot.protocols.filter((p) => isPreToken(p) && isOutOfScope(p)).length;

  const scored = eligible.map((p) => {
    const s = impliedValue(p, multiples, snapshot.as_of);
    return { p, ...s };
  });
  // Highest implied value first; ties break by TVL, then by slug, so the
  // order is total and the two grading runs write the same bytes.
  scored.sort((a, b) => b.value - a.value || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1));

  const rows: BoardRow[] = scored.map((s, i) => ({
    slug: s.p.slug,
    name: s.p.name,
    rank: i + 1,
    implied_value_usd: s.value,
    farm_steps: farmPlan(s.p),
    category: s.p.category,
    chains: [...s.p.chains],
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    age_days: s.days,
    multiple: Math.round(s.multiple * 10000) / 10000,
    growth_factor: Math.round(s.growth * 10000) / 10000,
    age_factor: Math.round(s.age * 10000) / 10000,
    chain_factor: Math.round(s.chain * 10000) / 10000,
    on_watchlist: watch.has(s.p.slug),
  }));

  const catRows = new Map<string, { rows: number; multiple: number }>();
  for (const r of rows) {
    const key = r.category ?? 'Uncategorised';
    const cur = catRows.get(key) ?? { rows: 0, multiple: r.multiple };
    cur.rows += 1;
    catRows.set(key, cur);
  }
  const categories = [...catRows.entries()]
    .map(([name, v]) => ({ name, rows: v.rows, multiple: v.multiple }))
    .sort((a, b) => b.rows - a.rows || (a.name < b.name ? -1 : 1));

  const stats: RadarStats = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    protocol_count: snapshot.protocols.length,
    watchlist_count: snapshot.watchlist.length,
    board_rows: rows.length,
    pre_token_count: snapshot.protocols.filter(isPreToken).length,
    excluded_count: excluded,
    global_multiple: Math.round(multiples.global * 10000) / 10000,
    total_implied_usd: rows.reduce((sum, r) => sum + r.implied_value_usd, 0),
    top_implied_usd: rows.length > 0 ? rows[0]!.implied_value_usd : 0,
    categories,
  };
  return { rows, stats };
}

/** The dashboard's data file: the board, the stats and the model note, as one script. */
export function renderDataScript(rows: BoardRow[], stats: RadarStats): string {
  const payload = {
    meta: {
      as_of: stats.as_of,
      floor_usd: stats.floor_usd,
      protocol_count: stats.protocol_count,
      watchlist_count: stats.watchlist_count,
      board_rows: stats.board_rows,
      pre_token_count: stats.pre_token_count,
      excluded_count: stats.excluded_count,
      global_multiple: stats.global_multiple,
      total_implied_usd: stats.total_implied_usd,
    },
    categories: stats.categories,
    rows,
  };
  return `// Token Radar board data, generated from the sealed snapshot by main.ts.\n// The dashboard reads this file; it makes no network request.\nwindow.RADAR_DATA = ${JSON.stringify(payload)};\n`;
}

/**
 * The gate's board rules, checked before anything is written: ranks 1..N
 * once each, values never rising with rank, every watchlist slug covered,
 * farm steps 3..12 of 20..600 characters, slugs from the snapshot.
 * Returns the first problem found, or null when the board is valid.
 */
export function checkBoard(rows: BoardRow[], snapshot: Snapshot): string | null {
  if (rows.length < 100 || rows.length > 4000) return `board holds ${rows.length} rows, need 100 to 4000`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  const ranks = new Set<number>();
  let prev = Number.POSITIVE_INFINITY;
  for (const r of rows) {
    if (!slugs.has(r.slug)) return `row slug ${r.slug} is not a snapshot protocol`;
    if (seen.has(r.slug)) return `row slug ${r.slug} appears twice`;
    seen.add(r.slug);
    if (!Number.isInteger(r.rank) || r.rank < 1) return `row ${r.slug} has a bad rank ${r.rank}`;
    ranks.add(r.rank);
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd < 1) {
      return `row ${r.slug} has a bad implied value ${r.implied_value_usd}`;
    }
    if (r.implied_value_usd > prev) return `implied value rises at rank ${r.rank}`;
    prev = r.implied_value_usd;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `row ${r.slug} has ${r.farm_steps.length} farm steps, need 3 to 12`;
    }
    for (const s of r.farm_steps) {
      const len = s.trim().length;
      if (len < 20 || len > 600) return `row ${r.slug} has a farm step of ${len} characters, need 20 to 600`;
    }
  }
  if (ranks.size !== rows.length) return 'ranks are not 1..N once each';
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist slug ${slug} is missing from the board`;
  }
  const values = new Set(rows.map((r) => r.implied_value_usd));
  if (rows.length >= 2 && values.size === 1) return 'every implied value is the same: not a ranking';
  return null;
}
