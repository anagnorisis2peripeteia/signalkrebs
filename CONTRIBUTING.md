# Contributing to signalkrebs

signalkrebs is a fail-closed concurrency gate. The cardinal rule mirrors its
siblings marmorkrebs and einsiedlerkrebs: **a result only counts with evidence.**
Every degenerate state is an explicit non-passing verdict, never a silent green.

## Development

```bash
npm install
npm run build                        # tsc → dist/
npm run check                        # tsc --noEmit
npm test                             # unit tests (node --test)
npm run validate:detector go-race    # prove a lane catches a planted race, fail-closed
npm run validate:detectors           # every lane whose toolchain is present
```

Commit messages use Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`), like marmorkrebs.

## Adding a detector lane

A lane is one `DetectorAdapter` (`src/types.ts`) plus its fixtures and a validator
spec. The adapter owns everything language-specific and returns the normalized
`ConcurrencyResult`; the runner drives it and applies the fail-closed verdict.

`DetectorAdapter` has four methods:

- `resolveExercise(repoDir, touchedFiles)` — map touched files to the packages/targets
  that must be exercised, and report which the test suite actually reaches
  (`unexercisedPackages` drives the `insufficient` verdict). Populate `stress` with the
  parallelism the detector actually ran under; a passing run must reflect ≥2-way parallelism.
- `runDetector(repoDir, exercise, config)` — run the dynamic detector under the stress
  budget over the exercised packages; return raw defects plus `ExecEvidence` so the runner
  can fail closed on spawn/timeout/signal. A non-zero exit **with** a parsed race is the
  detector working, not an error — only treat a non-zero exit as an error when nothing was
  parsed and the output is a build failure.
- `lint(repoDir, touchedRanges)` — static anti-pattern scan scoped to touched line ranges.
  Rules here **hard-fail** the gate, so every rule must be high-precision. Honor the
  `// concurrency-ok: <reason>` suppression pragma (own line or the line directly above).
  Fuzzy heuristics belong in the hunt skill, not here.
- `runLiveness(config)` — run the detector against this lane's planted-defect fixture and
  confirm the defect is caught this run.

### The quarantine discipline (non-negotiable)

A new lane is added to `QUARANTINED_TOOLS` in `src/runner.ts` and **stays there** until it
ships all three of:

1. `fixtures/<lane>/` — a project carrying a **planted defect** the detector must catch.
2. `fixtures/<clean-lane>/` — a correctly-synchronized twin the detector must **not** flag.
3. A spec in `scripts/validate-detector.mjs` asserting: the planted defect is caught, the
   clean twin is clean, and **with the toolchain hidden from PATH the run fails closed**
   (never `clean`/`defect`).

`npm run validate:detector <lane>` must pass against the real toolchain before the lane
leaves quarantine. A detector's unit tests feed it hand-shaped input and cannot prove it
catches a race on the host — only the live validator can. This is the exact discipline that
would have caught marmorkrebs' gomu lane shipping broken for three weeks.

## Verdict invariants

Do not add a code path that returns `clean` when:

- the lane was not proven live this run (`lane-dead`),
- the touched code was not exercised under real parallelism (`insufficient`), or
- the detector spawn/timeout/parse failed (`error`).

If you are unsure whether a state should pass, it should not. Fail closed.
