import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ConcurrencyDefect,
  type DetectorAdapter,
  type DetectorConfig,
  type ExecEvidence,
  type ExerciseEvidence,
  type LivenessEvidence,
  DEFAULT_REPS,
  DEFAULT_TIMEOUT_MS,
} from "../types.js";
import { parseScopeEntry } from "../git-changed-files.js";
import { applyAnalyzerMaturity } from "../lint/lint-common.js";
import { packageHasTests, runSwift, swiftPackageOf } from "./swift-tsan.js";

// The Swift structured-concurrency lane (swift-async). ThreadSanitizer (the swift-tsan lane) only
// sees DATA races; it is blind to Swift's modern concurrency bug class. This lane pairs a SwiftSyntax
// STATIC analyzer (runtime/swift-conc) — continuation resume-coverage, double-resume, AsyncStream
// finish-coverage, actor state across await, fire-and-forget Task — with a DYNAMIC hang probe over
// `swift test`: a test that hangs on an unresumed continuation is a runtime repro, the Swift analogue
// of the dotnet-conc blame-hang probe. Only SA001 (a continuation guaranteed to hang) hard-fails; the
// rest are advisory, like ts-async's require-atomic-updates.

const SELF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ANALYZER_DIR = join(SELF_ROOT, "runtime", "swift-conc");
const RACY_FIXTURE = join(SELF_ROOT, "fixtures", "swift-async");
const CLEAN_FIXTURE = join(SELF_ROOT, "fixtures", "swift-async-clean");
// swift test has no per-test inactivity timer (unlike VSTest), so the hang probe builds first, then
// runs the suite under a total-time budget; a test still executing past it is treated as hung. Keep
// the fixture suites tiny so this total-time proxy is unambiguous.
const HANG_SECONDS = 30;

interface RawFinding {
  Rule: string;
  Kind: string;
  File: string;
  Line: number;
  Message: string;
}

/** Invoke the bundled SwiftSyntax analyzer on a set of files; JSON findings + exec evidence. Empty
 * findings on any spawn/build/parse failure — the fail-closed layers surface a dead engine. */
function runAnalyzer(files: string[], timeoutMs: number): { findings: RawFinding[]; exec: ExecEvidence } {
  const parse = (out: string): RawFinding[] => {
    // The analyzer prints one JSON array line; `swift run` build chatter goes to stderr, but guard
    // anyway by taking the last line that parses as an array.
    const line = out.split("\n").reverse().find((l) => l.trim().startsWith("["));
    if (!line) return [];
    try {
      return JSON.parse(line.trim()) as RawFinding[];
    } catch {
      return [];
    }
  };
  const args = ["run", "--package-path", ANALYZER_DIR, "-c", "release", "swift-conc", ...files, "--json"];
  try {
    const out = execFileSync("swift", args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { findings: parse(out), exec: { exitCode: 0, signal: null, spawnError: null, stderr: "" } };
  } catch (e) {
    const err = e as { status?: number | null; signal?: string | null; stdout?: Buffer | string };
    const out = err.stdout?.toString() ?? "";
    const findings = parse(out);
    // The analyzer exits 1 when it FOUND findings — that is a result, not a failure.
    if (findings.length > 0 || (out.includes("[") && err.status === 1)) {
      return { findings, exec: { exitCode: 0, signal: null, spawnError: null, stderr: "" } };
    }
    return {
      findings: [],
      exec: {
        exitCode: err.status ?? -1,
        signal: err.signal ?? null,
        spawnError: err.status == null ? "swift analyzer spawn or timeout" : null,
        stderr: "",
      },
    };
  }
}

function toDefect(f: RawFinding, repoDir: string): ConcurrencyDefect {
  const file = f.File.startsWith(repoDir) ? relative(repoDir, f.File) : f.File;
  return {
    kind: f.Kind as ConcurrencyDefect["kind"],
    source: "static",
    file,
    line: f.Line,
    summary: f.Message,
    evidence: `[${f.Rule}] ${file}:${f.Line}`,
    ruleId: f.Rule,
    suppressed: false,
    // Only SA001 (a continuation GUARANTEED to hang) hard-fails; SA002–SA005 are heuristic → advisory.
    advisory: f.Rule.startsWith("SA001") ? undefined : true,
  };
}

/** The last test that started but never finished in `swift test` output — the hung test. Build-phase
 * kills produce no "Test Case … started", disambiguating a real hang from build slowness. */
export function parseHungTest(output: string): string | null {
  const started = [...output.matchAll(/Test Case '([^']+)' started/g)].map((m) => m[1]);
  if (started.length === 0) return null;
  const last = started[started.length - 1];
  const esc = last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const finished = new RegExp(`Test Case '${esc}' (passed|failed)`).test(output);
  return finished ? null : last;
}

/** Build the package's tests, then run the suite under a short budget. Because the build already
 * succeeded, a timeout-KILL of `swift test` (signal set) means the SUITE HUNG — not a build stall —
 * so the kill signal IS the hang verdict. (`swift test` block-buffers its piped stdout, so the
 * hung-test NAME is only recoverable when the buffer happens to flush; the detection never depends
 * on it.) */
function runHangProbe(pkgDir: string, buildTimeoutMs: number): { hung: boolean; test: string | null; exec: ExecEvidence } {
  const build = runSwift(pkgDir, ["build", "--build-tests"], buildTimeoutMs);
  if (build.spawnError) return { hung: false, test: null, exec: { exitCode: -1, signal: null, spawnError: build.spawnError, stderr: "" } };
  if (build.exitCode !== 0) {
    return { hung: false, test: null, exec: { exitCode: build.exitCode, signal: null, spawnError: null, stderr: (build.stdout + build.stderr).slice(-2000) } };
  }
  const test = runSwift(pkgDir, ["test"], HANG_SECONDS * 1000);
  const combined = test.stdout + "\n" + test.stderr;
  if (test.signal) {
    return { hung: true, test: parseHungTest(combined), exec: { exitCode: 0, signal: null, spawnError: null, stderr: "" } };
  }
  if (test.spawnError) return { hung: false, test: null, exec: { exitCode: -1, signal: null, spawnError: test.spawnError, stderr: "" } };
  return { hung: false, test: null, exec: { exitCode: 0, signal: null, spawnError: null, stderr: "" } };
}

export const swiftAsyncAdapter: DetectorAdapter = {
  tool: "swift-async",

  resolveExercise(repoDir: string, touchedFiles: string[]): ExerciseEvidence {
    const swiftFiles = touchedFiles.filter((f) => f.endsWith(".swift") && !f.endsWith("Package.swift"));
    const touched = new Set<string>();
    const exercised = new Set<string>();
    const unexercised = new Set<string>();
    for (const file of swiftFiles) {
      const pkg = swiftPackageOf(repoDir, file);
      if (!pkg) continue;
      touched.add(pkg);
      if (packageHasTests(repoDir, pkg)) exercised.add(pkg);
      else unexercised.add(pkg);
    }
    const cores = Math.max(2, availableParallelism());
    return {
      touchedPackages: [...touched].sort(),
      exercisedPackages: [...exercised].sort(),
      unexercisedPackages: [...unexercised].sort(),
      stress: { reps: DEFAULT_REPS, gomaxprocs: [cores] },
    };
  },

  runDetector(
    repoDir: string,
    exercise: ExerciseEvidence,
    config: DetectorConfig,
  ): { defects: ConcurrencyDefect[]; exec: ExecEvidence } {
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pkgs = exercise.exercisedPackages;
    if (pkgs.length === 0) {
      return { defects: [], exec: { exitCode: 0, signal: null, spawnError: null, stderr: "" } };
    }
    const defects: ConcurrencyDefect[] = [];
    let exec: ExecEvidence = { exitCode: 0, signal: null, spawnError: null, stderr: "" };
    for (const pkg of pkgs) {
      const pkgDir = pkg === "." ? repoDir : join(repoDir, pkg);
      const h = runHangProbe(pkgDir, timeoutMs);
      if (h.exec.spawnError || h.exec.exitCode !== 0) exec = h.exec;
      if (h.hung) {
        defects.push({
          kind: "deadlock",
          source: "dynamic",
          file: pkg,
          line: 0,
          summary: `test ${h.test ?? "(unnamed)"} hung — no completion within ${HANG_SECONDS}s (unresumed continuation / blocked await)`,
          evidence: `swift test in ${pkg} did not complete ${h.test ?? "a test"} within ${HANG_SECONDS}s`,
          suppressed: false,
        });
      }
    }
    return { defects, exec };
  },

  lint(repoDir: string, touchedRanges: string[]): ConcurrencyDefect[] {
    // Run the analyzer on the touched .swift files, then keep only hits inside a touched range.
    const files: string[] = [];
    const fileRanges = new Map<string, Array<[number, number] | null>>();
    for (const entry of touchedRanges) {
      const { file, start, end } = parseScopeEntry(entry);
      if (!file.endsWith(".swift") || file.endsWith("Package.swift")) continue;
      const abs = join(repoDir, file);
      if (!files.includes(abs)) files.push(abs);
      const fr = fileRanges.get(file) ?? [];
      fr.push(start !== undefined && end !== undefined ? [start, end] : null);
      fileRanges.set(file, fr);
    }
    if (files.length === 0) return [];
    const { findings } = runAnalyzer(files, DEFAULT_TIMEOUT_MS);
    const out: ConcurrencyDefect[] = [];
    for (const f of findings) {
      const rel = f.File.startsWith(repoDir) ? relative(repoDir, f.File) : f.File;
      const ranges = fileRanges.get(rel);
      if (!ranges) continue;
      const inScope = ranges.includes(null) || ranges.some((r) => r !== null && f.Line >= r[0] && f.Line <= r[1]);
      if (inScope) out.push(toDefect(f, repoDir));
    }
    return applyAnalyzerMaturity(repoDir, out);
  },

  runLiveness(config: DetectorConfig): LivenessEvidence {
    if (!existsSync(RACY_FIXTURE)) {
      return { checked: false, plantedDefectCaught: false, detail: `planted fixture missing at ${RACY_FIXTURE}` };
    }
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Static: the analyzer must flag the planted SA001 leak and stay silent on the clean twin.
    const racySrc = join(RACY_FIXTURE, "Sources", "Leak", "Leak.swift");
    const cleanSrc = join(CLEAN_FIXTURE, "Sources", "Clean", "Clean.swift");
    const racy = runAnalyzer([racySrc], timeoutMs);
    if (racy.exec.spawnError) return { checked: false, plantedDefectCaught: false, detail: racy.exec.spawnError };
    const staticCaught =
      racy.findings.some((f) => f.Rule.startsWith("SA001")) &&
      (!existsSync(cleanSrc) || runAnalyzer([cleanSrc], timeoutMs).findings.every((f) => !f.Rule.startsWith("SA001")));
    const staticDetail = staticCaught
      ? "static: planted continuation-leak (SA001) caught by the SwiftSyntax analyzer; clean twin reports no false positive"
      : "static: fixtures/swift-async planted SA001 leak was NOT caught — the analyzer is not detecting on this host";

    // Dynamic: the hang probe must catch the planted hanging test. Graceful when swift-test is
    // unavailable so the independently-proven static analyzer is not blocked.
    const probe = runHangProbe(RACY_FIXTURE, timeoutMs);
    let probeBroken = false;
    let probeDetail: string;
    if (probe.exec.spawnError) {
      probeDetail = "dynamic: hang probe unavailable on this host (no swift test) — static analyzer still gated";
    } else if (probe.hung) {
      probeDetail = `dynamic: hang probe caught the planted hanging test (${probe.test ?? "unnamed"})`;
    } else {
      probeDetail = "dynamic: hang probe RAN but did NOT catch the planted hanging test — probe broken";
      probeBroken = true;
    }
    return {
      checked: true,
      plantedDefectCaught: staticCaught && !probeBroken,
      detail: `${staticDetail}; ${probeDetail}`,
    };
  },
};
