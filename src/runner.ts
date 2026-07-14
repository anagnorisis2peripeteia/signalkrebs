import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ConcurrencyDefect,
  type ConcurrencyResult,
  type DetectorAdapter,
  type DetectorConfig,
  type DetectorTool,
  type ExerciseEvidence,
  type LivenessEvidence,
  type Verdict,
} from "./types.js";
import { goRaceAdapter } from "./detectors/go-race.js";
import { swiftTsanAdapter } from "./detectors/swift-tsan.js";
import { tsAsyncAdapter } from "./detectors/ts-async.js";

// A lane stays quarantined until its planted-defect fixture proves the detector
// actually catches a race via scripts/validate-detector.mjs. Same discipline as
// marmorkrebs QUARANTINED_TOOLS: a lane that has never been proven to catch a
// real defect must refuse to run rather than emit a plausible false-clean.
// (Both current lanes are validated; the map stays as the enforcement point for
// the next lane added.)
const QUARANTINED_TOOLS: Partial<Record<DetectorTool, string>> = {};

const ADAPTERS: Partial<Record<DetectorTool, DetectorAdapter>> = {
  "go-race": goRaceAdapter,
  "swift-tsan": swiftTsanAdapter,
  "ts-async": tsAsyncAdapter,
};

/**
 * Turn the raw adapter outputs into a fail-closed verdict. The ordering of the
 * guards is the contract:
 *   1. a tool spawn/timeout/parse failure is `error` — we cannot conclude anything.
 *   2. a lane that could not prove itself live this run is `lane-dead` — a clean
 *      result from an unproven detector is worthless.
 *   3. any UN-suppressed defect (dynamic or static anti-pattern) is `defect`.
 *   4. touched code not exercised under real parallelism is `insufficient` — a
 *      "clean" that never ran the changed code in parallel proves nothing (the
 *      concurrency analogue of marmorkrebs' zero-mutant guard).
 *   5. otherwise `clean`.
 * A defect outranks insufficiency (a real race we DID surface is worth reporting
 * even if coverage was thin); liveness/error outrank everything.
 */
export function reconcileVerdict(
  detector: DetectorTool,
  defects: ConcurrencyDefect[],
  exercise: ExerciseEvidence,
  liveness: LivenessEvidence,
  execError: string | null,
  config: DetectorConfig,
): ConcurrencyResult {
  const base = { detector, defects, exercise, liveness };

  if (execError) {
    return { ...base, verdict: "error", error: execError };
  }

  const livenessRequired = !config.skipLiveness;
  if (livenessRequired && (!liveness.checked || !liveness.plantedDefectCaught)) {
    return {
      ...base,
      verdict: "lane-dead",
      error:
        `the ${detector} lane was not proven live this run ` +
        `(${liveness.detail || "planted-defect fixture not caught"}) — ` +
        "refusing to score an unproven detector as clean; fix the lane or pass --skip-liveness to record an explicit downgrade",
    };
  }

  // Advisory findings (heuristic rules like require-atomic-updates) are surfaced
  // for discovery but do not hard-fail the gate; only precision-first findings do.
  const active = defects.filter((d) => !d.suppressed && !d.advisory);
  if (active.length > 0) {
    return { ...base, verdict: "defect" };
  }

  const parallelismProven = exercise.stress.gomaxprocs.some((n) => n >= 2);
  const allExercised = exercise.unexercisedPackages.length === 0;
  if (!config.allowUnexercised && (!allExercised || !parallelismProven)) {
    const why = !parallelismProven
      ? `the detector never ran with GOMAXPROCS>=2 (ran ${JSON.stringify(exercise.stress.gomaxprocs)}), so no real race could surface`
      : `touched packages were not exercised by the test suite: ${exercise.unexercisedPackages.join(", ")}`;
    return {
      ...base,
      verdict: "insufficient",
      error:
        `${why} — a "clean" result here proves nothing; ` +
        "add tests that exercise the changed code under parallelism, or pass --allow-unexercised to record the gap explicitly",
    };
  }

  return { ...base, verdict: "clean" };
}

// Per-repo lock: two concurrent detector runs on one checkout race each other's
// build cache and any in-repo scratch. Steal only from a dead pid or a >2h lock.
const LOCK_NAME = ".signalkrebs.lock";

function acquireRepoLock(repoDir: string): (() => void) | { error: string } {
  const lockPath = join(repoDir, LOCK_NAME);
  const claim = JSON.stringify({ pid: process.pid, started: new Date().toISOString() });
  const release = () => {
    try {
      unlinkSync(lockPath);
    } catch {
      // already gone — fine
    }
  };
  try {
    writeFileSync(lockPath, claim, { flag: "wx" });
    return release;
  } catch {
    let held: { pid?: number; started?: string } = {};
    try {
      held = JSON.parse(readFileSync(lockPath, "utf8"));
    } catch {
      // unreadable/corrupt lock — treat as stale
    }
    const alive = (() => {
      if (!held.pid) return false;
      try {
        process.kill(held.pid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    const ageMs = held.started ? Date.now() - Date.parse(held.started) : Infinity;
    if (alive && ageMs < 2 * 3_600_000) {
      return {
        error: `another signalkrebs run (pid ${held.pid}, since ${held.started}) holds ${lockPath} — concurrent detector runs on one checkout race the build cache`,
      };
    }
    try {
      writeFileSync(lockPath, claim, { flag: "w" });
      return release;
    } catch (e) {
      return { error: `cannot acquire ${lockPath}: ${(e as Error).message}` };
    }
  }
}

export function runConcurrencyAnalysis(
  repoDir: string,
  touchedFiles: string[],
  touchedRanges: string[],
  config: DetectorConfig,
): ConcurrencyResult {
  const started = Date.now();

  const quarantine = QUARANTINED_TOOLS[config.tool];
  if (quarantine) {
    return {
      detector: config.tool,
      verdict: "lane-dead",
      defects: [],
      exercise: emptyExercise(),
      liveness: { checked: false, plantedDefectCaught: false, detail: "lane quarantined" },
      error: `detector ${config.tool} is quarantined: ${quarantine}`,
    };
  }

  const adapter = ADAPTERS[config.tool];
  if (!adapter) {
    return {
      detector: config.tool,
      verdict: "error",
      defects: [],
      exercise: emptyExercise(),
      liveness: { checked: false, plantedDefectCaught: false, detail: "no adapter" },
      error: `no detector adapter registered for ${config.tool}`,
    };
  }

  // Lint-only: a pure static pass with no detector/liveness/exercise gating.
  // Verdict is `defect` on any un-suppressed anti-pattern hit, else `clean`.
  // Used by the hunt for a free repo-wide pre-filter and for a fast local check.
  if (config.lintOnly) {
    const lintDefects = adapter.lint(repoDir, touchedRanges);
    const active = lintDefects.filter((d) => !d.suppressed);
    return {
      detector: config.tool,
      verdict: active.length > 0 ? "defect" : "clean",
      defects: lintDefects,
      exercise: emptyExercise(),
      liveness: { checked: false, plantedDefectCaught: false, detail: "lint-only run" },
      durationMs: Date.now() - started,
    };
  }

  const lock = acquireRepoLock(repoDir);
  if ("error" in lock) {
    return {
      detector: config.tool,
      verdict: "error",
      defects: [],
      exercise: emptyExercise(),
      liveness: { checked: false, plantedDefectCaught: false, detail: "lock not acquired" },
      error: lock.error,
    };
  }

  try {
    const liveness = config.skipLiveness
      ? { checked: false, plantedDefectCaught: false, detail: "liveness skipped by flag (--skip-liveness)" }
      : adapter.runLiveness(config);

    const exercise = adapter.resolveExercise(repoDir, touchedFiles);
    const { defects: dynamicDefects, exec } = adapter.runDetector(repoDir, exercise, config);
    const lintDefects = adapter.lint(repoDir, touchedRanges);

    const execError =
      exec.spawnError !== null
        ? `detector process failed to spawn: ${exec.spawnError}`
        : exec.signal !== null
          ? `detector killed by ${exec.signal} (timeout?): ${exec.stderr.trim().slice(-300)}`
          : null;

    const result = reconcileVerdict(
      config.tool,
      [...dynamicDefects, ...lintDefects],
      exercise,
      liveness,
      execError,
      config,
    );
    result.durationMs = Date.now() - started;

    if (config.reportFile) {
      // Written BEFORE the caller evaluates the exit code, so a failing gate
      // keeps its evidence artifact.
      writeFileSync(config.reportFile, JSON.stringify(result, null, 2));
    }
    return result;
  } finally {
    lock();
  }
}

function emptyExercise(): ExerciseEvidence {
  return {
    touchedPackages: [],
    exercisedPackages: [],
    unexercisedPackages: [],
    stress: { reps: 0, gomaxprocs: [] },
  };
}

export function verdictSummary(r: ConcurrencyResult): string {
  const active = r.defects.filter((d) => !d.suppressed);
  const suppressed = r.defects.length - active.length;
  const parts = [
    `verdict=${r.verdict}`,
    `defects=${active.length}`,
    suppressed ? `suppressed=${suppressed}` : null,
    `exercised=${r.exercise.exercisedPackages.length}/${r.exercise.touchedPackages.length}pkg`,
    `liveness=${r.liveness.plantedDefectCaught ? "live" : r.liveness.checked ? "DEAD" : "skipped"}`,
  ].filter(Boolean);
  return parts.join(" ");
}

export { QUARANTINED_TOOLS };
