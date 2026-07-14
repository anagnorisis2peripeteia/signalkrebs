import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ConcurrencyDefect,
  type DetectorAdapter,
  type DetectorConfig,
  type ExecEvidence,
  type ExerciseEvidence,
  type LivenessEvidence,
  DEFAULT_GOMAXPROCS,
  DEFAULT_REPS,
  DEFAULT_TIMEOUT_MS,
} from "../types.js";
import { lintGo } from "../lint/go-lint.js";

const SELF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GO_RACE_FIXTURE = join(SELF_ROOT, "fixtures", "go-race");

interface GoExec {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: string | null;
  spawnError: string | null;
}

function runGo(dir: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): GoExec {
  try {
    const stdout = execFileSync("go", args, {
      cwd: dir,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...env },
    });
    return { stdout, stderr: "", exitCode: 0, signal: null, spawnError: null };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & {
      status?: number | null;
      signal?: string | null;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };
    if (err.code === "ENOENT") {
      return { stdout: "", stderr: "", exitCode: -1, signal: null, spawnError: "go binary not found on PATH" };
    }
    return {
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
      exitCode: err.status ?? -1,
      signal: err.signal ?? null,
      spawnError: null,
    };
  }
}

/** Map a touched .go file to its package's import path via `go list`. */
function packageOf(repoDir: string, file: string): string | null {
  const pkgDir = dirname(file);
  const res = runGo(repoDir, ["list", "./" + pkgDir], {}, 30_000);
  if (res.exitCode !== 0) return null;
  return res.stdout.trim() || null;
}

/** Does this package directory contain any *_test.go files? */
function hasTests(repoDir: string, file: string): boolean {
  const abs = join(repoDir, dirname(file));
  try {
    return readdirSync(abs).some((f) => f.endsWith("_test.go"));
  } catch {
    return false;
  }
}

/**
 * Parse `go test -race` output into data-race defects. Each `WARNING: DATA RACE`
 * block carries two stack frames; we keep the block verbatim as evidence and pin
 * the defect to the first in-repo source frame.
 */
function parseRaceReports(output: string): ConcurrencyDefect[] {
  const defects: ConcurrencyDefect[] = [];
  const blocks = output.split("WARNING: DATA RACE").slice(1);
  for (const raw of blocks) {
    const block = "WARNING: DATA RACE" + raw.split("==================")[0];
    // First `file.go:NN` frame is the anchor.
    const frame = block.match(/([\w./-]+\.go):(\d+)/);
    const file = frame ? frame[1] : "unknown";
    const line = frame ? parseInt(frame[2], 10) : 0;
    defects.push({
      kind: "data-race",
      source: "dynamic",
      file,
      line,
      summary: `go test -race reported a data race anchored at ${file}:${line}`,
      evidence: block.trim().slice(0, 4000),
    });
  }
  return defects;
}

export const goRaceAdapter: DetectorAdapter = {
  tool: "go-race",

  resolveExercise(repoDir: string, touchedFiles: string[]): ExerciseEvidence {
    const goFiles = touchedFiles.filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"));
    const touched = new Set<string>();
    const exercised = new Set<string>();
    const unexercised = new Set<string>();

    for (const file of goFiles) {
      const pkg = packageOf(repoDir, file);
      if (!pkg) continue;
      touched.add(pkg);
      if (hasTests(repoDir, file)) exercised.add(pkg);
      else unexercised.add(pkg);
    }
    // A package with tests is "exercisable"; runDetector confirms the tests
    // actually ran (not `[no test files]`) and demotes it otherwise.
    return {
      touchedPackages: [...touched].sort(),
      exercisedPackages: [...exercised].sort(),
      unexercisedPackages: [...unexercised].sort(),
      stress: {
        reps: DEFAULT_REPS,
        gomaxprocs: [...DEFAULT_GOMAXPROCS],
      },
    };
  },

  runDetector(
    repoDir: string,
    exercise: ExerciseEvidence,
    config: DetectorConfig,
  ): { defects: ConcurrencyDefect[]; exec: ExecEvidence } {
    const reps = config.reps ?? DEFAULT_REPS;
    const gomaxprocs = config.gomaxprocs ?? DEFAULT_GOMAXPROCS;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    exercise.stress.reps = reps;
    exercise.stress.gomaxprocs = [...gomaxprocs];

    const pkgs = exercise.exercisedPackages;
    if (pkgs.length === 0) {
      // Nothing to run — not an exec failure; the reconcile layer turns this into
      // `insufficient` via the unexercised set.
      return { defects: [], exec: { exitCode: 0, signal: null, spawnError: null, stderr: "" } };
    }

    const allDefects: ConcurrencyDefect[] = [];
    let worstExit = 0;
    let signal: string | null = null;
    let spawnError: string | null = null;
    let stderrTail = "";

    for (const procs of gomaxprocs) {
      const args = ["test", "-race", `-count=${reps}`, ...pkgs];
      const res = runGo(repoDir, args, { GOMAXPROCS: String(procs) }, timeoutMs);
      const combined = res.stdout + "\n" + res.stderr;
      const races = parseRaceReports(combined);
      allDefects.push(...races);

      if (res.spawnError) spawnError = res.spawnError;
      if (res.signal) signal = res.signal;
      // go test exits non-zero when a race is found — that is the detector WORKING,
      // not a spawn error. Treat a non-zero exit as a hard error ONLY when no race
      // was parsed AND stderr looks like a build/setup failure (nothing ran).
      if (res.exitCode !== 0 && races.length === 0) {
        const looksLikeBuildFailure = /build failed|cannot find|undefined:|syntax error|no required module/i.test(combined);
        if (looksLikeBuildFailure) {
          worstExit = res.exitCode;
          stderrTail = combined.slice(-2000);
        }
      }
    }

    // Dedup identical race anchors across the GOMAXPROCS sweep.
    const seen = new Set<string>();
    const deduped = allDefects.filter((d) => {
      const key = `${d.file}:${d.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      defects: deduped,
      exec: { exitCode: worstExit, signal, spawnError, stderr: stderrTail },
    };
  },

  lint(repoDir: string, touchedRanges: string[], _opts?: { skipTypeAware?: boolean }): ConcurrencyDefect[] {
    return lintGo(repoDir, touchedRanges);
  },

  runLiveness(config: DetectorConfig): LivenessEvidence {
    if (!existsSync(GO_RACE_FIXTURE)) {
      return {
        checked: false,
        plantedDefectCaught: false,
        detail: `planted-race fixture missing at ${GO_RACE_FIXTURE}`,
      };
    }
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // The fixture's test exercises a KNOWN data race; -race must catch it.
    const res = runGo(GO_RACE_FIXTURE, ["test", "-race", "-count=1", "-run", "TestPlantedRace", "./..."], { GOMAXPROCS: "4" }, timeoutMs);
    const combined = res.stdout + "\n" + res.stderr;
    if (res.spawnError) {
      return { checked: false, plantedDefectCaught: false, detail: res.spawnError };
    }
    const caught = /WARNING: DATA RACE/.test(combined);
    return {
      checked: true,
      plantedDefectCaught: caught,
      detail: caught
        ? "planted data race in fixtures/go-race caught by -race"
        : "fixtures/go-race planted race was NOT caught — the go-race lane is not detecting races on this host",
    };
  },
};
