import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
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
import { hasTests, packageOf, parseRaceReports, runGo } from "./go-race.js";

// The interleaving-stress lane (#11). Timing-dependent concurrency tests are the #1 source of CI
// flakes (see #5). Instead of only reading the code (go-lint) or running it once (go-race), this
// lane re-runs the DIFF-SCOPED tests under scheduler PERTURBATION — a GOMAXPROCS sweep, a high
// `-count`, `-race`, and `-shuffle=on` — to surface a scheduler-dependent interleaving LOCALLY and
// deterministically, before CI's non-deterministic scheduler hits it in production. Go-first; the
// harness generalizes to other lanes (pytest stress, etc.).
//
// The discriminator vs a plain go-race run is the BASELINE: a serial `GOMAXPROCS=1 -count=1` run
// establishes that the test passes when nothing perturbs it. Only a stress config that then FAILS
// (a data race or a scheduling-dependent assertion) is a finding — "it fails where a single run
// passes", reported with the exact GOMAXPROCS + `-shuffle` seed that triggered it.

const SELF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RACY_FIXTURE = join(SELF_ROOT, "fixtures", "interleaving-stress");
// Heavier than go-race's 20: surfacing a rare interleaving needs more reps per GOMAXPROCS.
const STRESS_REPS = 50;

const BUILD_FAILURE_RE = /build failed|cannot find|undefined:|syntax error|no required module|# command-line-arguments/i;

/** `go test -shuffle=on` prints `-test.shuffle <seed>`; capture it so a catch is reproducible. */
export function shuffleSeed(output: string): string | null {
  const m = output.match(/-test\.shuffle (\d+)/);
  return m ? m[1] : null;
}

/** A genuine TEST failure (a `FAIL` summary / `--- FAIL:`) as opposed to a build/setup error. */
export function testFailed(output: string): boolean {
  return (/\n--- FAIL:|\nFAIL\b|^FAIL\b/m.test(output)) && !BUILD_FAILURE_RE.test(output);
}

export const interleavingStressAdapter: DetectorAdapter = {
  tool: "interleaving-stress",

  resolveExercise(repoDir: string, touchedFiles: string[]): ExerciseEvidence {
    // Same scoping as go-race: a touched package is exercisable iff it has *_test.go files, since
    // this lane perturbs the package's TESTS.
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
    const cpus = Math.max(4, availableParallelism());
    return {
      touchedPackages: [...touched].sort(),
      exercisedPackages: [...exercised].sort(),
      unexercisedPackages: [...unexercised].sort(),
      stress: { reps: STRESS_REPS, gomaxprocs: [2, cpus] },
    };
  },

  runDetector(
    repoDir: string,
    exercise: ExerciseEvidence,
    config: DetectorConfig,
  ): { defects: ConcurrencyDefect[]; exec: ExecEvidence } {
    const reps = config.reps ?? STRESS_REPS;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const cpus = Math.max(4, availableParallelism());
    const stressProcs = config.gomaxprocs ?? [2, cpus];
    exercise.stress.reps = reps;
    exercise.stress.gomaxprocs = [...stressProcs];

    const pkgs = exercise.exercisedPackages;
    if (pkgs.length === 0) {
      return { defects: [], exec: { exitCode: 0, signal: null, spawnError: null, stderr: "" } };
    }

    const defects: ConcurrencyDefect[] = [];
    let spawnError: string | null = null;
    let signal: string | null = null;
    let worstExit = 0;
    let stderrTail = "";

    for (const pkg of pkgs) {
      // Baseline — a single serial run. If it already fails to build, surface that; if it fails a
      // test, the test is broken independent of scheduling (leave it to CI). Only a GREEN baseline
      // lets a stress failure count as an interleaving finding.
      const base = runGo(repoDir, ["test", "-count=1", pkg], { GOMAXPROCS: "1" }, timeoutMs);
      if (base.spawnError) {
        spawnError = base.spawnError;
        continue;
      }
      const baseCombined = base.stdout + "\n" + base.stderr;
      if (base.exitCode !== 0) {
        if (BUILD_FAILURE_RE.test(baseCombined)) {
          worstExit = base.exitCode;
          stderrTail = baseCombined.slice(-2000);
        }
        continue; // baseline not green → nothing to attribute to scheduling
      }

      // Stress — perturb the scheduler and re-run.
      for (const procs of stressProcs) {
        const args = ["test", "-race", `-count=${reps}`, "-shuffle=on", pkg];
        const res = runGo(repoDir, args, { GOMAXPROCS: String(procs) }, timeoutMs);
        const combined = res.stdout + "\n" + res.stderr;
        const seed = shuffleSeed(combined);
        const knob = `GOMAXPROCS=${procs} -count=${reps} -shuffle=on(seed=${seed ?? "?"})`;

        const races = parseRaceReports(combined);
        for (const r of races) {
          defects.push({
            ...r,
            suppressed: false,
            summary: `interleaving-stress surfaced a data race under ${knob} that the serial baseline hid — ${r.summary}`,
            evidence: `${knob}\n${r.evidence}`,
          });
        }
        if (races.length === 0 && res.exitCode !== 0 && testFailed(combined)) {
          // No data race, but a test that PASSED serially now FAILS under perturbation: a
          // scheduling-dependent assertion (lost update, ordering assumption, missed signal).
          defects.push({
            kind: "toctou",
            source: "dynamic",
            file: pkg,
            line: 0,
            summary: `interleaving-stress: tests in ${pkg} FAILED under ${knob} but PASSED the serial baseline — a scheduler-dependent flake`,
            evidence: `${knob}\n${combined.slice(-2000)}`,
            suppressed: false,
          });
        }
        if (res.spawnError) spawnError = res.spawnError;
        if (res.signal) signal = res.signal;
      }
    }

    // Dedup by kind+anchor across the GOMAXPROCS sweep (the same bug fires at every procs level).
    const seen = new Set<string>();
    const deduped = defects.filter((d) => {
      const key = `${d.kind}:${d.file}:${d.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { defects: deduped, exec: { exitCode: worstExit, signal, spawnError, stderr: stderrTail } };
  },

  lint(): ConcurrencyDefect[] {
    // Purely dynamic: the static reading of Go concurrency is the go-lint lane. This lane's whole
    // value is RUNNING the tests under perturbation, so there is nothing to lint statically.
    return [];
  },

  runLiveness(config: DetectorConfig): LivenessEvidence {
    if (!existsSync(RACY_FIXTURE)) {
      return { checked: false, plantedDefectCaught: false, detail: `planted-flake fixture missing at ${RACY_FIXTURE}` };
    }
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const cpus = Math.max(4, availableParallelism());
    // Baseline must be green (proves the flake is scheduling-dependent, not just broken)…
    const base = runGo(RACY_FIXTURE, ["test", "-count=1", "-run", "TestPlantedFlake", "./..."], { GOMAXPROCS: "1" }, timeoutMs);
    if (base.spawnError) return { checked: false, plantedDefectCaught: false, detail: base.spawnError };
    const baselinePassed = base.exitCode === 0;
    // …and the stress sweep MUST surface the planted lost-update race — proving perturbation is live.
    const stress = runGo(
      RACY_FIXTURE,
      ["test", "-race", `-count=${STRESS_REPS}`, "-shuffle=on", "-run", "TestPlantedFlake", "./..."],
      { GOMAXPROCS: String(cpus) },
      timeoutMs,
    );
    const combined = stress.stdout + "\n" + stress.stderr;
    if (stress.spawnError) return { checked: false, plantedDefectCaught: false, detail: stress.spawnError };
    const caught = /WARNING: DATA RACE/.test(combined) || testFailed(combined);
    return {
      checked: true,
      plantedDefectCaught: caught,
      detail: caught
        ? `stress sweep (GOMAXPROCS=${cpus}, -count=${STRESS_REPS}, -race, -shuffle) surfaced the planted flake${baselinePassed ? " that the serial baseline passed" : " (note: baseline also failed)"}`
        : "fixtures/interleaving-stress planted flake was NOT surfaced by the stress sweep — the perturbation is not live on this host",
    };
  },
};
