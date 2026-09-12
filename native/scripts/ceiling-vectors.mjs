// Read-side ceiling-draw oracle: the retained JavaScript computes the figures.
//
// spent/consumed come from the retained ledger (lib/metering/ledger.js):
// `currentPeriod().drawn` is fresh tokens only (CEILING_KINDS: input, output,
// cacheWrite) and `.total` is the display figure over all four kinds. The
// combination with commitments is the two retained lines of `remainingFor`
// (backend-v2.js:14052-14053), mirrored verbatim below:
//
//   const drawn = spent === null ? reserved : Math.max(reserved, spent);
//
// An absent period bucket is unknown, never zero, so the commitment figure
// stands alone. Both source files are pinned by sha256 so a drifted oracle
// fails --check instead of silently re-blessing different arithmetic.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createUsageLedger } from '../../lib/metering/ledger.js';

const sha = (p) => createHash('sha256').update(readFileSync(new URL(p, import.meta.url), 'utf8').replaceAll('\r\n', '\n')).digest('hex');
const ledgerSha256 = sha('../../lib/metering/ledger.js');
const backendSha256 = sha('../../backend-v2.js');

// The Rust fixture (native/hagency-store/tests/usage.rs Fixture::new) commits
// exactly one approved 100-token engagement on the resource, so reserved is
// this literal on both sides of the oracle.
const RESERVED = 100;
const T0 = Date.parse('2026-08-15T12:00:00.000Z');
const HOUR = 3_600_000;
const NEXT_MONTH = Date.parse('2026-09-15T12:00:00.000Z');
const counts = (input, output, cacheWrite, cacheRead) => ({ input, output, cacheWrite, cacheRead });

const cases = [
  // The lockout that motivated the operator ruling: 13.6M measured against a
  // 10M ceiling of which only 681k is fresh work (BigLittle, 2026-08-12).
  { name: 'lockout-cache-swamp', sources: [{ key: 'a', observations: [[T0, counts(604_823, 76_266, 0, 12_928_512)]] }] },
  // The counter-case: the spend is fresh, the ceiling is genuinely gone.
  { name: 'fresh-exhaustion', sources: [{ key: 'a', observations: [[T0, counts(9_500_000, 500_000, 0, 0)]] }] },
  // With no cache reads the two figures agree; cacheWrite draws because it
  // bills above fresh input.
  { name: 'no-cache-parity', sources: [{ key: 'a', observations: [[T0, counts(1000, 500, 250, 0)]] }] },
  { name: 'cache-write-draws', sources: [{ key: 'a', observations: [[T0, counts(0, 0, 5000, 0)]] }] },
  // Below the commitment: committed allocations are the binding draw.
  { name: 'committed-binding', sources: [{ key: 'a', observations: [[T0, counts(40, 0, 0, 0)]] }] },
  // Cache-read growth moves consumption but never the draw.
  { name: 'cache-read-growth-never-draws', sources: [{ key: 'a', observations: [[T0, counts(100, 50, 0, 0)], [T0 + HOUR, counts(100, 50, 0, 5000)]] }] },
  // A query in a period nobody measured is unknown, so commitments stand alone.
  { name: 'month-roll-unknown', sources: [{ key: 'a', observations: [[T0, counts(700, 0, 0, 0)]] }], queryAt: NEXT_MONTH },
  // Two sources on the same engagement add per-kind before the draw is taken.
  { name: 'two-sources-additive', sources: [
    { key: 'a', observations: [[T0, counts(100, 0, 0, 0)]] },
    { key: 'b', observations: [[T0 + HOUR, counts(0, 50, 0, 0)]] },
  ] },
];

const vectors = cases.map(({ name, sources, queryAt }) => {
  // One merged chronological timeline so every record happens at its own
  // observation instant, exactly like the native writer transaction does.
  const events = sources.flatMap((s) => s.observations.map(([at, totals]) => ({ at, key: s.key, totals })))
    .sort((x, y) => x.at - y.at);
  let now = events[0].at;
  const ledger = createUsageLedger({ now: () => now });
  for (const event of events) {
    now = event.at;
    ledger.record([{ agent: 'bound-agent', framework: 'claude', sessions: [{ key: event.key, totals: event.totals }] }]);
  }
  const at = queryAt ?? events[events.length - 1].at;
  const bucket = ledger.currentPeriod('bound-agent', 'monthly', at);
  const spent = bucket ? bucket.drawn : null;
  const consumed = bucket ? bucket.total : null;
  // backend-v2.js:14052-14053, mirrored verbatim.
  const drawn = spent === null ? RESERVED : Math.max(RESERVED, spent);
  return {
    name,
    reserved: RESERVED,
    ceilingTokens: 1000,
    period: 'monthly',
    queryAt: at,
    sources: sources.map((s) => ({ key: s.key, observations: s.observations.map(([at2, totals]) => ({ at: at2, totals })) })),
    expected: { reserved: RESERVED, spent, consumed, drawn, spendPeriodKey: bucket ? bucket.key : null },
  };
});

const output = JSON.stringify({
  source: 'lib/metering/ledger.js + backend-v2.js remainingFor drawn rule',
  ledgerSha256,
  backendSha256,
  semantics: 'fresh-token draw per current period; max(reserved, spent) with unknown fallback',
  vectors,
}, null, 2) + '\n';
const path = new URL('../hagency-store/tests/fixtures/ceiling-vectors.json', import.meta.url);
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8').replaceAll('\r\n', '\n') !== output) throw new Error('Ceiling vectors differ from retained JavaScript');
} else writeFileSync(path, output);
console.log(JSON.stringify({ vectors: vectors.length }));
