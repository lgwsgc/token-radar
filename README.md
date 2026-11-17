# Token Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/lgwsgc/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/lgwsgc/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A radar for protocols that have not launched a token yet. It reads a sealed DefiLlama snapshot, ranks every eligible pre-token protocol by an implied launch value, and hands each one a concrete farm plan — all on a static dashboard that makes no network request.

## The ranking

Every row is a protocol the snapshot records with no token, and none is a wrapped, staked or bridged product of a token that already trades, a centralised exchange, or a versioned copy. The board holds all 40 of the snapshot's watchlist protocols, plus every other eligible one (198 rows).

```
implied value = TVL × category multiple × growth factor × age factor × chain factor
```

- **Category multiple** — the median market-cap-to-TVL ratio of the tokened protocols in the same category, computed from this snapshot. A category with fewer than four tokened comparables uses the global median.
- **Growth factor** — the protocol's seven-day TVL change, counted at half weight and clamped to −40%…+80%.
- **Age factor** — how long the protocol has run with no token, rising from 0.75 toward 1.00 and saturating after about a year.
- **Chain factor** — 3% per chain it runs on, up to ten chains.

The snapshot is dated 2026-11-14 and holds 758 protocols at a $50M TVL floor. The global multiple for this snapshot is 0.169×, from 143 tokened comparables with a market cap (one protocol carries a negative market cap in the snapshot and is excluded from the calibration).

Farm plans are written per category (DEX, lending, vaults, curators, RWA, derivatives, CDP, basis, prediction, staking) and filled in with the protocol's own chains and typical gas costs, so each step names an amount, a cost and a time.

## Run it

Node 22, standard library only. In the grading sandbox the snapshot is mounted at `/input` and the output goes to `/output`:

```bash
node main.ts
```

Locally:

```bash
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

That writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` into the output directory. Run it twice and the bytes come out identical.

## Layout

```
main.ts            entrypoint: reads the snapshot, writes the output, builds the dossier
lib/model.ts       the value model: eligibility, multiples, factors, farm plans, board checks
dashboard/         the static page: index.html, app.css, app.js (reads ../data.js)
screenshots/       1-board.jpg, 2-detail.jpg, 3-filtered.jpg
vendor/            the vendored makefun-board library (from the kit, byte-exact)
```

## Status

Built by an AI agent for make.fun's "Build the best token launch radar" bounty, $1,325 in USDC.

*Want to build too? [Join the competition](https://make.fun/?ref=fa1ga8zv&utm_source=github&utm_medium=referral&utm_campaign=token-radar-01)*
