#!/usr/bin/env node
import { getChangedFilesFromGit, getChangedLineRangesFromGit, parseScopeEntry } from "./git-changed-files.js";
import { runConcurrencyAnalysis, verdictSummary } from "./runner.js";
import { VERDICT_EXIT } from "./types.js";
import { parseCliArgs, UsageError } from "./cli-args.js";

function usage(): never {
  console.error(`signalkrebs - PR-scoped concurrency gate

Usage:
  signalkrebs --dir <path> --tool <tool> --base <ref> [options]
  signalkrebs --dir <path> --tool <tool> --changed-files <a,b,...> [options]

Options:
  --dir <path>             Local checkout directory
  --tool <tool>            Detector lane: go-race | swift-tsan
  --base <ref>             Derive changed files + touched line ranges from the local diff vs <ref>
  --changed-files <files>  Comma-separated changed files (no line-scoped lint without --base)
  --reps <n>               Detector repetitions per GOMAXPROCS (-count=n; default 20)
  --gomaxprocs <a,b>       GOMAXPROCS values to sweep (default 2,8); a run must include >=2
  --timeout <ms>           Per-detector run timeout (default 480000)
  --allow-unexercised      Let a run that could not exercise every touched package pass
  --skip-liveness          Skip the inline planted-defect fixture check (records a downgrade)
  --report-file <path>     Also write the ConcurrencyResult JSON (written before exit-code eval)
  --swift-package-path <p> swift-tsan only: SwiftPM package path
  --swift-test-target <t>  swift-tsan only: test target

Verdicts (exit codes):
  clean        0   exercised under parallelism, lane live, nothing surfaced
  error        1   detector spawn/timeout/parse failure
  defect       2   a race/leak/anti-pattern was found (see report)
  insufficient 3   touched code not exercised under real parallelism (fail-closed)
  lane-dead    3   the detector could not be proven live this run (fail-closed)
`);
  process.exit(64);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) usage();

  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`signalkrebs: ${e.message}\n`);
      usage();
    }
    throw e;
  }

  const { dir, config, base, changedFiles } = parsed;

  let touchedFiles: string[];
  let touchedRanges: string[];
  if (base) {
    touchedFiles = getChangedFilesFromGit(dir, base);
    touchedRanges = getChangedLineRangesFromGit(dir, base);
  } else {
    touchedFiles = changedFiles ?? [];
    // No diff base → no line ranges; lint scopes to whole touched files.
    touchedRanges = touchedFiles.slice();
  }

  const result = runConcurrencyAnalysis(dir, touchedFiles, touchedRanges, config);

  console.error(`[signalkrebs] ${verdictSummary(result)}`);
  if (result.error) console.error(`[signalkrebs] ${result.error}`);
  for (const d of result.defects) {
    const tag = d.suppressed ? "SUPPRESSED" : d.advisory ? "ADVISORY" : d.kind.toUpperCase();
    console.error(`\n[${tag}] ${d.file}:${d.line} — ${d.summary}`);
    if (d.suppressed) console.error(`    (concurrency-ok: ${d.suppressionReason})`);
    else console.error(d.evidence.split("\n").map((l) => "    " + l).join("\n"));
  }

  // The JSON result goes to stdout for machine consumers (pr-gate); human summary is stderr.
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(VERDICT_EXIT[result.verdict]);
}

main();

export { parseScopeEntry };
