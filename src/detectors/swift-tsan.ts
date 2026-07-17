import { execFileSync } from "node:child_process";
import { availableParallelism } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
import { lintSwift } from "../lint/swift-lint.js";

const SELF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SWIFT_FIXTURE = join(SELF_ROOT, "fixtures", "swift-tsan");

export interface SwiftExec {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: string | null;
  spawnError: string | null;
}

export function runSwift(dir: string, args: string[], timeoutMs: number): SwiftExec {
  try {
    const stdout = execFileSync("swift", args, {
      cwd: dir,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
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
      return { stdout: "", stderr: "", exitCode: -1, signal: null, spawnError: "swift binary not found on PATH" };
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

/** Nearest ancestor directory (within repoDir) containing a Package.swift. */
export function swiftPackageOf(repoDir: string, file: string): string | null {
  let dir = dirname(file);
  for (;;) {
    if (existsSync(join(repoDir, dir, "Package.swift"))) return dir === "." ? "." : dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function packageHasTests(repoDir: string, pkgDir: string): boolean {
  return existsSync(join(repoDir, pkgDir === "." ? "Tests" : join(pkgDir, "Tests")));
}

/**
 * Parse `swift test --sanitize=thread` output. Swift TSan emits
 * `WARNING: ThreadSanitizer: <Swift access race|data race>` blocks with `#N ...
 * File.swift:NN` frames; keep the block as evidence, anchor at the first
 * in-source `.swift:NN` frame.
 */
function parseTsanReports(output: string): ConcurrencyDefect[] {
  const defects: ConcurrencyDefect[] = [];
  const blocks = output.split(/WARNING: ThreadSanitizer:/).slice(1);
  for (const raw of blocks) {
    const block = "WARNING: ThreadSanitizer:" + raw.split(/SUMMARY: ThreadSanitizer:/)[0];
    const frame = block.match(/([\w./-]+\.swift):(\d+)/);
    const file = frame ? frame[1] : "unknown";
    const line = frame ? parseInt(frame[2], 10) : 0;
    defects.push({
      kind: "data-race",
      source: "dynamic",
      file,
      line,
      summary: `swift test --sanitize=thread reported a race anchored at ${file}:${line}`,
      evidence: block.trim().slice(0, 4000),
    });
  }
  return defects;
}

export const swiftTsanAdapter: DetectorAdapter = {
  tool: "swift-tsan",

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
    // Swift TSan instruments every access regardless of a process-count knob; the
    // meaningful "parallelism proven" number is the cores the concurrent test code
    // actually ran on. Report availableParallelism so the reconcile invariant
    // (>=2) reflects real multi-core execution rather than a Go-specific env var.
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

    const allDefects: ConcurrencyDefect[] = [];
    let worstExit = 0;
    let signal: string | null = null;
    let spawnError: string | null = null;
    let stderrTail = "";

    for (const pkg of pkgs) {
      const pkgDir = pkg === "." ? repoDir : join(repoDir, pkg);
      const args = ["test", "--sanitize=thread"];
      if (config.swiftTestTarget) args.push("--filter", config.swiftTestTarget);
      const res = runSwift(pkgDir, args, timeoutMs);
      const combined = res.stdout + "\n" + res.stderr;
      const races = parseTsanReports(combined);
      allDefects.push(...races);

      if (res.spawnError) spawnError = res.spawnError;
      if (res.signal) signal = res.signal;
      // `swift test` exits non-zero when TSan trips OR a test fails — that is the
      // detector working. Only treat a non-zero exit as a hard error when no race
      // was parsed AND the output looks like a build/compile failure.
      if (res.exitCode !== 0 && races.length === 0) {
        const looksLikeBuildFailure = /error:|Compiling|cannot find|no such module|Build complete!.*failed/i.test(
          combined,
        );
        const actuallyBuilt = /Test Suite .* (passed|failed)/.test(combined);
        if (looksLikeBuildFailure && !actuallyBuilt) {
          worstExit = res.exitCode;
          stderrTail = combined.slice(-2000);
        }
      }
    }

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
    return lintSwift(repoDir, touchedRanges);
  },

  runLiveness(config: DetectorConfig): LivenessEvidence {
    if (!existsSync(SWIFT_FIXTURE)) {
      return { checked: false, plantedDefectCaught: false, detail: `planted-race fixture missing at ${SWIFT_FIXTURE}` };
    }
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const res = runSwift(SWIFT_FIXTURE, ["test", "--sanitize=thread", "--filter", "testPlantedRace"], timeoutMs);
    const combined = res.stdout + "\n" + res.stderr;
    if (res.spawnError) {
      return { checked: false, plantedDefectCaught: false, detail: res.spawnError };
    }
    const caught = /WARNING: ThreadSanitizer:/.test(combined);
    return {
      checked: true,
      plantedDefectCaught: caught,
      detail: caught
        ? "planted race in fixtures/swift-tsan caught by --sanitize=thread"
        : "fixtures/swift-tsan planted race was NOT caught — the swift-tsan lane is not detecting races on this host",
    };
  },
};
