# signalkrebs

PR-scoped **concurrency gate**. Instead of trusting that CI happened to run the race
detector on the one interleaving that fires, signalkrebs runs a language's race/leak
detector **under a stress budget** on the packages a PR touched, adds a hard-failing
**anti-pattern lint** on the touched lines, and **fails closed** on every degenerate state —
a green means something was proven, never "nothing obvious happened".

> Named after the signal crayfish (*Pacifastacus leniusculus*) — an aggressive invasive that
> outcompetes the natives, the way a race condition quietly creeps in and wins. Sibling to
> [marmorkrebs](https://github.com/anagnorisis2peripeteia/marmorkrebs) (mutation) and
> [einsiedlerkrebs](https://github.com/anagnorisis2peripeteia/einsiedlerkrebs) (invariants) in
> the fail-closed PR-gate family.

## Why not "just run `-race` in CI"

`go test -race` (and every ThreadSanitizer lane) only catches races that **actually execute**.
A single CI run on `GOMAXPROCS=1` with tests that never overlap the changed code proves nothing,
yet exits 0. signalkrebs closes that gap:

- **Stress budget** — repeats the detector (`-count=N`) across a **GOMAXPROCS sweep**, widening
  the timing windows a single run misses.
- **Detector-blind classes** — the anti-pattern lint catches bugs ThreadSanitizer cannot see:
  timers/tickers stored in a field and never stopped, `for range ticker.C` loops with no exit
  path, `WaitGroup.Add` inside a spawned goroutine.
- **Fail-closed verdict** — a run that never exercised the touched code under real parallelism,
  or a lane that could not prove it still catches a planted race, is an explicit non-passing
  verdict, not a silent green.

## Verdicts

| Verdict | Exit | Meaning |
|---|---|---|
| `clean` | 0 | touched code exercised under parallelism, lane proven live, nothing surfaced |
| `error` | 1 | detector spawn / timeout / parse failure — nothing could be concluded |
| `defect` | 2 | a data race, leak, or anti-pattern was found (evidence in the report) |
| `insufficient` | 3 | touched packages not exercised under real parallelism (fail-closed) |
| `lane-dead` | 3 | the detector did not catch its planted-race fixture this run (fail-closed) |

## Lanes

| Lane | Detector | Status |
|---|---|---|
| `go-race` | `go test -race` (ThreadSanitizer) + goroutine/timer lint | **validated** (`npm run validate:detector go-race`) |
| `swift-tsan` | Xcode Thread Sanitizer + Swift 6 concurrency | **validated** (`npm run validate:detector swift-tsan`) |

A lane stays in `runner.ts` `QUARANTINED_TOOLS` until its **planted-defect fixture** proves the
detector actually catches a race on the host. This is the load-bearing discipline: a detector
that reports a known-racy fixture *clean* is lying, and must refuse to run rather than emit a
false green (`fixtures/go-race` holds the planted race; `fixtures/go-clean` guards against
false positives).

## Usage

```bash
# PR-scoped: derive touched files + line ranges from the local diff vs a base ref
signalkrebs --dir ~/myrepo --tool go-race --base origin/main

# explicit file set (whole-file lint scope, no line ranges)
signalkrebs --dir ~/myrepo --tool go-race --changed-files internal/cli/run.go,internal/cli/ssh.go
```

### Flags

| Flag | Effect |
|---|---|
| `--base <ref>` | derive changed files + touched line ranges from the local diff vs `<ref>` |
| `--changed-files <a,b>` | explicit changed-file set (lint scopes to whole file) |
| `--reps <n>` | detector repetitions per GOMAXPROCS (`-count=n`; default 20) |
| `--gomaxprocs <a,b>` | GOMAXPROCS values to sweep (default `2,8`; a passing run must include ≥2) |
| `--allow-unexercised` | let a run that could not exercise every touched package still pass (records the gap) |
| `--skip-liveness` | skip the inline planted-defect fixture check (records an explicit downgrade) |
| `--report-file <path>` | also write the `ConcurrencyResult` JSON (written **before** exit-code eval, so a failing gate keeps its evidence) |

### Suppressing an anti-pattern hit

The lint hard-fails on a touched line. When a hit is a deliberate, understood exception, suppress
it inline with a pragma on the offending line or the line directly above:

```go
// concurrency-ok: ticker is stopped in Close(), verified
s.ticker = time.NewTicker(time.Second)
```

Suppressed hits are retained in the report (marked `suppressed`) but do not drive the verdict.

## Development

```bash
npm install
npm run build                       # tsc → dist/
npm run validate:detector go-race   # prove the lane catches a planted race, fail-closed
npm run check                        # tsc --noEmit
npm test                             # unit tests
```

## Companion: the hunt

signalkrebs is the deterministic **engine**. The `signalkrebs-hunt` agent skill orchestrates
LLM fan-out (hunt → prove → verify → cross-check) *over* this engine to discover latent
concurrency bugs in existing repos — turning "popular repos we haven't onboarded" into a
stream of provable, unclaimed, issue-first contributions. The engine defines *what a
concurrency defect is*; the skill finds them.
