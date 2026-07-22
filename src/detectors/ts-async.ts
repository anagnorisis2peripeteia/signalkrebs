import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ConcurrencyDefect,
  type DetectorAdapter,
  type DetectorConfig,
  type ExecEvidence,
  type ExerciseEvidence,
  type LivenessEvidence,
  DEFAULT_TIMEOUT_MS,
} from "../types.js";
import { lintTs } from "../lint/ts-lint.js";

const SELF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROBE = join(SELF_ROOT, "runtime", "probe.cjs");
const TS_FIXTURE = join(SELF_ROOT, "fixtures", "ts-async");

const SRC_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** Nearest ancestor dir (within repoDir) containing a package.json. */
function packageOf(repoDir: string, file: string): string | null {
  let dir = dirname(file);
  for (;;) {
    if (existsSync(join(repoDir, dir === "." ? "package.json" : join(dir, "package.json")))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function testCommandOf(repoDir: string, pkgDir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(repoDir, pkgDir === "." ? "package.json" : join(pkgDir, "package.json")), "utf8"));
    const script = pkg.scripts?.test;
    if (!script || /no test specified/i.test(script)) return null;
    return "npm test --silent";
  } catch {
    return null;
  }
}

/**
 * Handle types that mean TEST CODE leaked a resource: timers, sockets, servers,
 * and fs-watchers. Deliberately EXCLUDES ProcessWrap/PipeWrap/TTYWrap/MessagePort
 * — those are the test-runner/wrapper's own child-process, stdio, and worker
 * machinery, which are legitimately live while a wrapper manages its child and
 * would otherwise fire on every clean run (the false positive that surfaced
 * dogfooding this lane).
 */
const LEAK_HANDLE = /Timeout|Immediate|Timer|TCPSocketWrap|TCPServerWrap|UDPWrap|FSEventWrap|StatWatcher/;

interface ProbeReport {
  drained: boolean;
  signal: string | null;
  active: string[];
}

/** Sleep without probe pollution (clean env so the sleeper writes no report). */
function sleep(ms: number): void {
  try {
    execSync(`${process.execPath} -e "setTimeout(()=>{}, ${ms})"`, {
      timeout: ms + 2000,
      stdio: "ignore",
      env: { PATH: process.env.PATH }, // no NODE_OPTIONS/SIGNALKREBS_PROBE_OUT
    });
  } catch {
    /* best effort */
  }
}

function readReports(probeDir: string): ProbeReport[] {
  const reports: ProbeReport[] = [];
  try {
    for (const f of readdirSync(probeDir)) {
      if (f.endsWith(".json")) {
        try {
          reports.push(JSON.parse(readFileSync(join(probeDir, f), "utf8")));
        } catch {
          /* partially-written report — next poll gets it */
        }
      }
    }
  } catch {
    /* dir gone / unreadable */
  }
  return reports;
}

const isLeaky = (r: ProbeReport) => !r.drained && r.active.some((a) => LEAK_HANDLE.test(a));

/**
 * A leaked handle can be reported by the leaf test process either immediately (it
 * exited with the handle live) or up to ~2s later (it was orphaned when the run
 * timed out and its reaper flushed on reparent). Poll until a leaky report shows
 * or the deadline passes, so detection does not depend on which path fired.
 */
function pollForLeak(probeDir: string, deadlineMs: number): { reports: ProbeReport[]; leaky?: ProbeReport } {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const reports = readReports(probeDir);
    const leaky = reports.find(isLeaky);
    if (leaky || Date.now() >= end) return { reports, leaky };
    sleep(500);
  }
}

export const tsAsyncAdapter: DetectorAdapter = {
  tool: "ts-async",

  resolveExercise(repoDir: string, touchedFiles: string[]): ExerciseEvidence {
    const srcFiles = touchedFiles.filter((f) => SRC_EXT.test(f));
    const touched = new Set<string>();
    const exercised = new Set<string>();
    const unexercised = new Set<string>();

    for (const file of srcFiles) {
      const pkg = packageOf(repoDir, file);
      if (pkg === null) continue;
      touched.add(pkg);
      if (testCommandOf(repoDir, pkg)) exercised.add(pkg);
      else unexercised.add(pkg);
    }
    return {
      touchedPackages: [...touched].sort(),
      exercisedPackages: [...exercised].sort(),
      unexercisedPackages: [...unexercised].sort(),
      // Single-threaded event loop: the recorded parallelism is the host cores the
      // real async interleaving ran on (see types.ts stress doc).
      stress: { reps: 1, gomaxprocs: [Math.max(2, availableParallelism())] },
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
    let signal: string | null = null;
    let spawnError: string | null = null;
    let worstExit = 0;
    let stderrTail = "";

    for (const pkg of pkgs) {
      const pkgDir = pkg === "." ? repoDir : join(repoDir, pkg);
      const cmd = config.testCommand ?? testCommandOf(repoDir, pkg);
      if (!cmd) continue;

      const probeDir = mkdtempSync(join(tmpdir(), "sk-probe-"));
      try {
        let hung = false;
        let testsFailed = false;
        let output = "";
        try {
          output = execSync(cmd, {
            cwd: pkgDir,
            encoding: "utf8",
            timeout: timeoutMs,
            maxBuffer: 64 * 1024 * 1024,
            env: {
              ...process.env,
              NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${PROBE}`.trim(),
              SIGNALKREBS_PROBE_OUT: probeDir,
            },
          });
        } catch (e) {
          const err = e as NodeJS.ErrnoException & {
            status?: number | null;
            signal?: string | null;
            stdout?: Buffer | string;
            stderr?: Buffer | string;
          };
          output = (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "");
          if (err.code === "ETIMEDOUT") {
            // Command timed out: tests may have finished but the process never
            // drained — the leak symptom this probe exists to catch. The child
            // can absorb the kill SIGTERM (a probe-armed npm exits 199 instead
            // of dying by signal), so err.signal is not a reliable timeout
            // marker — ETIMEDOUT alone is.
            hung = true;
          } else if (err.signal) {
            signal = err.signal;
          } else if (err.status !== 0) {
            testsFailed = true;
            worstExit = err.status ?? 1;
            stderrTail = output.slice(-2000);
          }
        }

        // One report per test-process pid (package managers excluded by the probe).
        // Poll so a leaky report written late (orphan-reaped after a timeout) is
        // not missed; a hang gets a longer grace window than a clean fast exit.
        const { reports, leaky: leakyReport } = pollForLeak(probeDir, hung ? 7000 : 1500);

        if (leakyReport || (hung && !reports.some((r) => r.drained))) {
          const active = leakyReport?.active ?? ["unknown (process killed before probe could report)"];
          defects.push({
            kind: "timer-leak",
            source: "dynamic",
            file: pkg === "." ? "package.json" : join(pkg, "package.json"),
            line: 0,
            summary:
              `the '${pkg}' test process never drained its event loop — leaked handles kept it alive` +
              (hung ? " until the timeout killed it" : ""),
            evidence:
              `probe: drained=${leakyReport?.drained ?? false} signal=${leakyReport?.signal ?? "timeout"}\n` +
              `active resources at exit: ${JSON.stringify(active)}\n` +
              `test command: ${cmd}\n--- output tail ---\n${output.slice(-1500)}`,
          });
        } else if (testsFailed) {
          // A failing suite is not a concurrency defect and not our exit either —
          // but nothing was proven. Surface as exec evidence; reconcile decides.
          stderrTail = output.slice(-2000);
        }
      } finally {
        rmSync(probeDir, { recursive: true, force: true });
      }
    }

    return {
      defects,
      exec: { exitCode: worstExit, signal, spawnError, stderr: stderrTail },
    };
  },

  lint(repoDir: string, touchedRanges: string[], opts?: { skipTypeAware?: boolean }): ConcurrencyDefect[] {
    return lintTs(repoDir, touchedRanges, opts);
  },

  runLiveness(config: DetectorConfig): LivenessEvidence {
    if (!existsSync(TS_FIXTURE)) {
      return { checked: false, plantedDefectCaught: false, detail: `planted fixture missing at ${TS_FIXTURE}` };
    }
    // Two planted defects must BOTH be caught for the lane to be live:
    // 1. static — the fixture's src carries a require-atomic-updates violation and
    //    a field interval never cleared;
    // 2. dynamic — the fixture's test leaks an interval so the process never drains.
    const lintHits = lintTs(TS_FIXTURE, ["src/cache.js"]);
    const staticCaught =
      lintHits.some((d) => d.ruleId === "require-atomic-updates") &&
      lintHits.some((d) => d.ruleId === "interval-never-cleared");

    const exercise: ExerciseEvidence = {
      touchedPackages: ["."],
      exercisedPackages: ["."],
      unexercisedPackages: [],
      stress: { reps: 1, gomaxprocs: [Math.max(2, availableParallelism())] },
    };
    const { defects } = this.runDetector(TS_FIXTURE, exercise, {
      tool: "ts-async",
      // the fixture's leak test must hang; keep the timeout short so liveness is fast
      timeoutMs: Math.min(config.timeoutMs ?? 20_000, 20_000),
    });
    const dynamicCaught = defects.some((d) => d.kind === "timer-leak" && d.source === "dynamic");

    const caught = staticCaught && dynamicCaught;
    return {
      checked: true,
      plantedDefectCaught: caught,
      detail: caught
        ? "planted await-race + interval leak caught (static) and undrained test process caught (dynamic)"
        : `fixtures/ts-async planted defects NOT fully caught (static=${staticCaught}, dynamic=${dynamicCaught}) — the ts-async lane is not detecting on this host`,
    };
  },
};
