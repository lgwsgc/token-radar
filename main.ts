// Token Radar entrypoint (Node 22, standard library only).
//
// Reads the sealed snapshot, scores every protocol that could still launch
// a token with the model in lib/model.ts, and writes the graded output:
//
//   /output/board.json     the ranked board (rows with implied values + farm plans)
//   /output/data.js        the same board as a script the dashboard reads
//   /output/dashboard/     the static page (copied from this repository)
//   /output/screenshots/   the three screenshots (copied from this repository)
//   /output/dossier.json   the judge's summary, written by the vendored library
//
// The grader runs this twice in a sandbox with no network; both runs must
// write the same bytes, so nothing here reads the clock or rolls dice.
// Outside the sandbox, MAKEFUN_OUTPUT_DIR stands in for /output and --input
// names the snapshot:
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBoard, checkBoard, loadSnapshot, renderDataScript } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));

// The gate's own caps, as the rules state them.
const DOSSIER_TEXT_BYTES = 65_536;
const SHOT_LIMIT = { max: 4, max_bytes: 524_288 };
const DASH_LIMIT = { max_files: 400, max_bytes: 4_194_304 };
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function fail(message: string): never {
  process.stderr.write(`token-radar: ${message}\n`);
  process.exit(1);
}

/** Read --flag <value> and --flag=<value> out of the arguments. */
function flagValue(name: string): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === `--${name}` && i + 1 < args.length) return args[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}

/** Copy a directory's files (recursively) into a target, skipping dot-names. */
function copyTree(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const done: string[] = [];
  const walk = (src: string, dst: string): void => {
    for (const name of readdirSync(src)) {
      if (name.startsWith('.')) continue;
      const srcPath = join(src, name);
      const dstPath = join(dst, name);
      const info = statSync(srcPath);
      if (info.isDirectory()) {
        walk(srcPath, dstPath);
      } else if (info.isFile()) {
        mkdirSync(dst, { recursive: true });
        copyFileSync(srcPath, dstPath);
        done.push(name);
      }
    }
  };
  walk(from, to);
  return done;
}

function run(): void {
  const inputArg = flagValue('input') ?? '/input';
  const snapshotPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
  if (!existsSync(snapshotPath)) {
    fail(`no snapshot at ${snapshotPath}: pass --input <snapshot.json|directory> or mount the sealed /input`);
  }
  const outDir = flagValue('output') ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

  const snapshot = loadSnapshot(readFileSync(snapshotPath, 'utf8'));
  const { rows, stats } = buildBoard(snapshot);
  const problem = checkBoard(rows, snapshot);
  if (problem !== null) fail(`the model wrote a board the gate refuses: ${problem}`);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows })}\n`);
  writeFileSync(join(outDir, 'data.js'), renderDataScript(rows, stats));

  const pageFiles = copyTree(join(REPO_ROOT, 'dashboard'), join(outDir, 'dashboard'));
  if (!pageFiles.includes('index.html')) fail('dashboard/ holds no index.html');
  const shots = copyTree(join(REPO_ROOT, 'screenshots'), join(outDir, 'screenshots'));
  if (shots.length < 3) fail(`screenshots/ holds ${shots.length} images: hand in 3, the board, a detail view and a filtered view`);
  for (const name of shots) {
    if (!FILE_NAME.test(name)) fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
  }

  // The dossier is written last: the scorer rebuilds it from this /output
  // and compares the bytes, so it must see the finished files.
  const dossier = buildDossier(outDir, {
    text_max_bytes: DOSSIER_TEXT_BYTES,
    screenshots: SHOT_LIMIT,
    dashboard: DASH_LIMIT,
  });
  writeFileSync(join(outDir, 'dossier.json'), dossier);

  process.stdout.write(
    `token-radar: ${stats.protocol_count} protocols in the snapshot, ${stats.watchlist_count} on the watchlist, ` +
      `${stats.board_rows} rows on the board (${stats.excluded_count} wrapped, staked or exchange products set aside)\n` +
      `token-radar: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ` +
      `${join(outDir, 'dashboard')} (${pageFiles.length} files), ${join(outDir, 'screenshots')} (${shots.length} images) and ${join(outDir, 'dossier.json')}\n`,
  );
}

run();
