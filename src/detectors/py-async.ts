import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ConcurrencyDefect,
  DetectorAdapter,
  DetectorConfig,
  ExecEvidence,
  ExerciseEvidence,
  LivenessEvidence,
} from "../types.js";
import { parseScopeEntry } from "../git-changed-files.js";
import { HASH_SUPPRESS_RE, applyPragmaSuppression, downgradeTestFileDefect } from "../lint/lint-common.js";

// The Python asyncio/threading lane. No TSan equivalent, so the DYNAMIC detector runs the touched
// package's tests under runtime/py-probe.py — a faulthandler dump-on-timeout that turns a deadlock/
// blocked-forever hang into a defect anchored at the stuck line. A small static lint rides alongside
// for the two highest-signal event-loop anti-patterns.

const SELF_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROBE = join(SELF_ROOT, "runtime", "py-probe.py");
const RACY_FIXTURE = join(SELF_ROOT, "fixtures", "py-async");
const CLEAN_FIXTURE = join(SELF_ROOT, "fixtures", "py-clean");
const DEFAULT_TIMEOUT_MS = 60_000;
const HANG_SECONDS = 8;

/** Nearest dir up from a `.py` file that holds tests / a project marker (else the file's own dir). */
function packageOf(repoDir: string, file: string): string {
  let dir = dirname(join(repoDir, file));
  while (dir.startsWith(repoDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      break;
    }
    if (entries.some((n) => /^test_.*\.py$/.test(n) || n === "pyproject.toml" || n === "setup.py" || n === "conftest.py"))
      return relative(repoDir, dir) || ".";
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return relative(repoDir, dirname(join(repoDir, file))) || ".";
}

/** Run the probe on a package dir; a faulthandler "Timeout" dump ⇒ a deadlock anchored at a line. */
function runProbe(pkgDir: string, timeoutMs: number): { deadlock: { file: string; line: number } | null; exec: ExecEvidence } {
  try {
    execFileSync("python3", [PROBE, pkgDir], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, SK_TIMEOUT: String(HANG_SECONDS) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    return { deadlock: null, exec: { exitCode: 0, signal: null, spawnError: null, stderr: "" } };
  } catch (e) {
    const err = e as { status?: number | null; signal?: string | null; stderr?: Buffer | string };
    const stderr = err.stderr?.toString() ?? "";
    if (/^Timeout \(/m.test(stderr)) {
      // faulthandler dumps "most recent call first", so the stuck call is the FIRST frame —
      // and the first that is user code (skip this probe launcher and the Python stdlib).
      const frames = [...stderr.matchAll(/File "([^"]+)", line (\d+)/g)];
      const userFrames = frames.filter(
        (fr) => !fr[1].includes("py-probe.py") && !/\/(?:lib\/python|python3\.\d+)\//.test(fr[1]),
      );
      const f = userFrames[0] ?? frames[0];
      return {
        deadlock: f ? { file: f[1], line: Number(f[2]) } : { file: pkgDir, line: 0 },
        exec: { exitCode: 0, signal: null, spawnError: null, stderr: "" },
      };
    }
    if (err.status == null) {
      // Spawn failure or the outer safety-net timeout fired without a dump → fail closed.
      return {
        deadlock: null,
        exec: { exitCode: -1, signal: err.signal ?? null, spawnError: "python3 not found or probe killed", stderr },
      };
    }
    // Non-zero exit without a Timeout header = an ordinary test failure, not a concurrency defect.
    return { deadlock: null, exec: { exitCode: 0, signal: null, spawnError: null, stderr: "" } };
  }
}

// Static lint: R1 `time.sleep(...)` inside an `async def` (blocks the event loop); R2 a bare
// `asyncio.create_task(...)` statement (fire-and-forget → GC'd mid-flight, exceptions swallowed).
/** A match is inside a Python string literal if an odd number of quotes precede it on the line —
 * enough to reject `"time.sleep(30)\n"` written as a fixture script (shellbench), without a parser. */
function inPyString(line: string, idx: number): boolean {
  const before = line.slice(0, idx);
  return (before.match(/"/g) || []).length % 2 === 1 || (before.match(/'/g) || []).length % 2 === 1;
}

function lintFile(repoDir: string, file: string, ranges: Array<[number, number] | null>): ConcurrencyDefect[] {
  let text: string;
  try {
    text = readFileSync(join(repoDir, file), "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  const wholeFile = ranges.includes(null);
  const inScope = (line: number) => wholeFile || ranges.some((r) => r !== null && line >= r[0] && line <= r[1]);
  const out: ConcurrencyDefect[] = [];

  let asyncDefIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (text.trim() === "" || text.trim().startsWith("#")) continue;
    const indent = text.match(/^\s*/)?.[0].length ?? 0;
    const asyncDef = text.match(/^(\s*)async\s+def\s/);
    if (asyncDef) {
      asyncDefIndent = asyncDef[1].length;
      continue;
    }
    // left the async def's body (a regular def or dedent below it) closes the scope
    if (asyncDefIndent >= 0 && indent <= asyncDefIndent && text.trim() !== "") asyncDefIndent = -1;

    const sleepMatch = text.match(/\btime\.sleep\s*\(/);
    if (asyncDefIndent >= 0 && indent > asyncDefIndent && sleepMatch && !inPyString(text, sleepMatch.index ?? 0) && inScope(i + 1)) {
      out.push(defect("channel-misuse", "py-blocking-in-async", file, i + 1,
        "time.sleep() inside an 'async def' blocks the whole event loop — use 'await asyncio.sleep(...)'", text.trim()));
    }
    if (/^\s*asyncio\.create_task\s*\(/.test(text) && inScope(i + 1)) {
      out.push(defect("goroutine-leak", "py-fire-and-forget-task", file, i + 1,
        "a bare asyncio.create_task(...) is discarded — the task can be garbage-collected mid-flight and its exceptions are swallowed; keep a reference and await it", text.trim()));
    }
    // R3: a common coroutine invoked as a BARE statement (line starts with the call, so it is not
    // awaited, assigned, returned, or wrapped in create_task) — the coroutine object is created and
    // immediately discarded, so it never runs (RuntimeWarning: coroutine was never awaited).
    if (/^\s*asyncio\.(?:sleep|gather|wait|wait_for|shield)\s*\(/.test(text) && inScope(i + 1)) {
      out.push(defect("channel-misuse", "py-unawaited-coroutine", file, i + 1,
        "this coroutine is created as a bare statement and never awaited — it does not run; prefix with 'await' (or wrap in asyncio.create_task and keep the handle)", text.trim()));
    }
  }
  // Maturity floor (#16): `# concurrency-ok:` suppression + downgrade hits in test files to advisory
  // (tests deliberately block/fire-and-forget — e.g. shellbench's create_task in a mock).
  applyPragmaSuppression(out, lines, HASH_SUPPRESS_RE);
  return out.map(downgradeTestFileDefect);
}

function defect(kind: string, ruleId: string, file: string, line: number, summary: string, evidenceLine: string): ConcurrencyDefect {
  return {
    kind: kind as ConcurrencyDefect["kind"],
    source: "static",
    file,
    line,
    summary,
    evidence: `[${ruleId}] ${file}:${line}\n    ${evidenceLine}`,
    ruleId,
    suppressed: false,
  };
}

export const pyAsyncAdapter: DetectorAdapter = {
  tool: "py-async",

  resolveExercise(repoDir: string, touchedFiles: string[]): ExerciseEvidence {
    const pyFiles = touchedFiles.filter((f) => f.endsWith(".py"));
    const touched = new Set<string>();
    for (const f of pyFiles) touched.add(packageOf(repoDir, f));
    const pkgs = [...touched].sort();
    return {
      touchedPackages: pkgs,
      exercisedPackages: pkgs, // the probe discovers + runs the package's tests
      unexercisedPackages: [],
      stress: { reps: 1, gomaxprocs: [Math.max(2, availableParallelism())] },
    };
  },

  runDetector(repoDir: string, exercise: ExerciseEvidence, config: DetectorConfig): { defects: ConcurrencyDefect[]; exec: ExecEvidence } {
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const defects: ConcurrencyDefect[] = [];
    let exec: ExecEvidence = { exitCode: 0, signal: null, spawnError: null, stderr: "" };
    for (const pkg of exercise.exercisedPackages) {
      const { deadlock, exec: e } = runProbe(pkg === "." ? repoDir : join(repoDir, pkg), timeoutMs);
      if (e.spawnError || e.signal) exec = e;
      if (deadlock) {
        const rel = deadlock.file.startsWith(repoDir) ? relative(repoDir, deadlock.file) : deadlock.file;
        defects.push({
          kind: "channel-misuse",
          source: "dynamic",
          file: rel,
          line: deadlock.line,
          summary: `the test suite deadlocked / blocked forever (no progress in ${HANG_SECONDS}s) — a lock or await never completes`,
          evidence: `faulthandler hang dump anchored at ${rel}:${deadlock.line}`,
          suppressed: false,
        });
      }
    }
    return { defects, exec };
  },

  lint(repoDir: string, touchedRanges: string[]): ConcurrencyDefect[] {
    const byFile = new Map<string, Array<[number, number] | null>>();
    for (const entry of touchedRanges) {
      const { file, start, end } = parseScopeEntry(entry);
      if (!file.endsWith(".py")) continue;
      const fr = byFile.get(file) ?? [];
      fr.push(start !== undefined && end !== undefined ? [start, end] : null);
      byFile.set(file, fr);
    }
    const out: ConcurrencyDefect[] = [];
    for (const [file, ranges] of byFile) out.push(...lintFile(repoDir, file, ranges));
    return out;
  },

  runLiveness(config: DetectorConfig): LivenessEvidence {
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const racy = runProbe(RACY_FIXTURE, timeoutMs);
    const clean = runProbe(CLEAN_FIXTURE, timeoutMs);
    const caught = racy.deadlock !== null;
    const cleanIsClean = clean.deadlock === null && clean.exec.spawnError === null;
    return {
      checked: true,
      plantedDefectCaught: caught && cleanIsClean,
      detail: caught
        ? cleanIsClean
          ? "planted deadlock in fixtures/py-async caught by the faulthandler probe; clean fixture completes"
          : "planted deadlock caught but the clean fixture did not complete cleanly — lane not trustworthy"
        : "fixtures/py-async planted deadlock was NOT caught — the py-async probe is not detecting on this host (missing python3)",
    };
  },
};
