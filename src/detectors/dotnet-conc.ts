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

// The C#/.NET concurrency lane. The Roslyn analyzer in runtime/csharp-conc IS the detector
// (C# has no runtime race-runner analogous to `go test -race`/TSan; concurrency defects here are
// found statically through a real compilation), the way ESLint is the engine for the ts-async lane.
// A runtime task/deadlock probe over the xunit/nunit suite is a planned dynamic extension.

const SELF_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ANALYZER = join(SELF_ROOT, "runtime", "csharp-conc", "csharp-conc.csproj");
const RACY_FIXTURE = join(SELF_ROOT, "fixtures", "dotnet-conc", "Fixture.csproj");
const CLEAN_FIXTURE = join(SELF_ROOT, "fixtures", "dotnet-clean", "Fixture.csproj");
const DEFAULT_TIMEOUT_MS = 300_000;
const HANG_FIXTURE = join(SELF_ROOT, "fixtures", "dotnet-hang", "Fixture.csproj");
// Seconds of test-host INACTIVITY (not total runtime) that VSTest's blame-hang collector waits
// before declaring a hang. Inactivity — not wall-clock — so a large suite of fast tests never
// trips it; only a genuinely stuck test does. A hang is ground truth (a repro), not a heuristic.
const HANG_INACTIVITY_SECONDS = 10;

interface RawFinding {
  Rule: string;
  Kind: string;
  File: string;
  Line: number;
  Message: string;
}

/** Nearest `.csproj` at or above `file`'s directory — the C# "package". */
function csprojOf(repoDir: string, file: string): string | null {
  let dir = dirname(join(repoDir, file));
  while (dir.startsWith(repoDir)) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return null;
    }
    const csproj = entries.find((n) => n.endsWith(".csproj"));
    if (csproj) return join(dir, csproj);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Invoke the bundled Roslyn analyzer on one project; findings + exec evidence. Empty findings on
 * any spawn/parse failure — the fail-closed layers (runLiveness must catch the planted defect)
 * surface a dead engine rather than a silent green. */
function runAnalyzer(projectPath: string, timeoutMs: number): { findings: RawFinding[]; exec: ExecEvidence } {
  const parse = (out: string): RawFinding[] => {
    const t = out.trim();
    if (!t.startsWith("[")) return [];
    try {
      return JSON.parse(t) as RawFinding[];
    } catch {
      return [];
    }
  };
  try {
    const out = execFileSync(
      "dotnet",
      ["run", "--project", ANALYZER, "-c", "Release", "--", projectPath, "--json"],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    return { findings: parse(out), exec: { exitCode: 0, signal: null, spawnError: null, stderr: "" } };
  } catch (e) {
    const err = e as { status?: number | null; signal?: string | null; stdout?: Buffer | string };
    const out = err.stdout?.toString() ?? "";
    // The analyzer exits 1 when it FOUND defects — that is a result, not a failure.
    const findings = parse(out);
    if (findings.length > 0 || (out.trim().startsWith("[") && err.status === 1)) {
      return { findings, exec: { exitCode: 0, signal: null, spawnError: null, stderr: "" } };
    }
    return {
      findings: [],
      exec: {
        exitCode: err.status ?? -1,
        signal: err.signal ?? null,
        spawnError: err.status == null ? "dotnet spawn or timeout" : null,
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
    // CC004 (field-across-await) is a heuristic that over-fires on lock/SemaphoreSlim-serialized
    // sections — advisory, like ts-async's require-atomic-updates: surfaced but not hard-failing.
    advisory: f.Rule.startsWith("CC004") || undefined,
  };
}

/** Is this `.csproj` a test project (has a test SDK / framework reference)? Only those can be
 * driven with `dotnet test`; the hang probe skips library projects. */
function isTestProject(csprojPath: string): boolean {
  try {
    const xml = readFileSync(csprojPath, "utf8");
    return /Microsoft\.NET\.Test\.Sdk|xunit|nunit|MSTest|<IsTestProject>\s*true/i.test(xml);
  } catch {
    return false;
  }
}

interface HangResult {
  hung: boolean;
  test: string | null;
  exec: ExecEvidence;
}

/** Extract the hang verdict + hung-test name from `dotnet test --blame-hang` output. Exported for
 * deterministic testing against captured VSTest output (no dotnet run needed in the unit suite). */
export function parseHangOutput(out: string): { hung: boolean; test: string | null } {
  const hung = /inactivity time of \d+ seconds has elapsed/i.test(out);
  // VSTest prints the hung test on the line after "The test running when the crash occurred:".
  const m = out.match(/The test running when the crash occurred:\s*\r?\n\s*(\S+)/);
  return { hung, test: m ? m[1] : null };
}

/** Run a test project under VSTest's `--blame-hang` collector: a test that makes no progress for
 * `hangSeconds` is aborted and NAMED — the .NET analogue of py-probe's faulthandler dump. This is
 * the DYNAMIC half of the C# lane (#1): a deadlock/undrained-task/blocked-join is a runtime repro,
 * where the Roslyn analyzer only sees the static shape. */
function runHangProbe(projectPath: string, hangSeconds: number, timeoutMs: number): HangResult {
  try {
    execFileSync(
      "dotnet",
      ["test", projectPath, "-c", "Release", "--blame-hang",
       "--blame-hang-timeout", `${hangSeconds}s`, "--blame-hang-dump-type", "none"],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
    // Exit 0 → the suite terminated: no hang.
    return { hung: false, test: null, exec: { exitCode: 0, signal: null, spawnError: null, stderr: "" } };
  } catch (e) {
    const err = e as { status?: number | null; signal?: string | null; stdout?: Buffer | string; stderr?: Buffer | string };
    const out = (err.stdout?.toString() ?? "") + "\n" + (err.stderr?.toString() ?? "");
    const p = parseHangOutput(out);
    if (p.hung) {
      // A detected hang is the probe WORKING; VSTest exits non-zero after aborting the suite.
      return { hung: true, test: p.test, exec: { exitCode: 0, signal: null, spawnError: null, stderr: "" } };
    }
    // Non-hang non-zero: build failure, an ordinary failing test (not our concern), or no dotnet
    // host. Surface only genuine spawn/setup failures — a plain test failure is left to CI.
    return {
      hung: false,
      test: null,
      exec: {
        exitCode: err.status ?? -1,
        signal: err.signal ?? null,
        spawnError: err.status == null ? "dotnet test spawn or timeout" : null,
        stderr: out.slice(-2000),
      },
    };
  }
}

export const dotnetConcAdapter: DetectorAdapter = {
  tool: "dotnet-conc",

  resolveExercise(repoDir: string, touchedFiles: string[]): ExerciseEvidence {
    const csFiles = touchedFiles.filter((f) => f.endsWith(".cs") && !f.includes("/obj/"));
    const touched = new Set<string>();
    for (const f of csFiles) {
      const proj = csprojOf(repoDir, f);
      if (proj) touched.add(relative(repoDir, proj));
    }
    const projects = [...touched].sort();
    // Roslyn "exercises" a project by compiling it — no test run needed, so every touched
    // project is exercised (the static analysis always reaches the changed code).
    return {
      touchedPackages: projects,
      exercisedPackages: projects,
      unexercisedPackages: [],
      stress: { reps: 1, gomaxprocs: [Math.max(2, availableParallelism())] },
    };
  },

  runDetector(
    repoDir: string,
    exercise: ExerciseEvidence,
    config: DetectorConfig,
  ): { defects: ConcurrencyDefect[]; exec: ExecEvidence } {
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const defects: ConcurrencyDefect[] = [];
    let exec: ExecEvidence = { exitCode: 0, signal: null, spawnError: null, stderr: "" };
    for (const proj of exercise.exercisedPackages) {
      const abs = join(repoDir, proj);
      const r = runAnalyzer(abs, timeoutMs);
      if (r.exec.spawnError || r.exec.signal) exec = r.exec;
      for (const f of r.findings) defects.push(toDefect(f, repoDir));

      // Dynamic half (#1): drive the touched TEST projects under blame-hang. A hung test is a
      // runtime repro the static analyzer can't see (undrained task, self-deadlock, blocked join).
      if (isTestProject(abs)) {
        const h = runHangProbe(abs, HANG_INACTIVITY_SECONDS, timeoutMs);
        if (h.exec.spawnError) exec = h.exec;
        if (h.hung) {
          defects.push({
            kind: "deadlock",
            source: "dynamic",
            file: proj,
            line: 0,
            summary: h.test
              ? `test '${h.test}' hung — no progress for ${HANG_INACTIVITY_SECONDS}s (deadlock / undrained task)`
              : `a test in ${proj} hung for ${HANG_INACTIVITY_SECONDS}s`,
            evidence: `dotnet test --blame-hang aborted the suite after ${HANG_INACTIVITY_SECONDS}s of inactivity; hung test: ${h.test ?? "unknown"}`,
            suppressed: false,
          });
        }
      }
    }
    return { defects, exec };
  },

  lint(repoDir: string, touchedRanges: string[]): ConcurrencyDefect[] {
    // Run the analyzer on the projects owning the touched files, then keep only hits that fall in
    // a touched line range (whole-file when no range was given).
    const projects = new Set<string>();
    const fileRanges = new Map<string, Array<[number, number] | null>>();
    for (const entry of touchedRanges) {
      const { file, start, end } = parseScopeEntry(entry);
      if (!file.endsWith(".cs")) continue;
      const proj = csprojOf(repoDir, file);
      if (!proj) continue;
      projects.add(relative(repoDir, proj));
      const fr = fileRanges.get(file) ?? [];
      fr.push(start !== undefined && end !== undefined ? [start, end] : null);
      fileRanges.set(file, fr);
    }
    const out: ConcurrencyDefect[] = [];
    for (const proj of projects) {
      const { findings } = runAnalyzer(join(repoDir, proj), DEFAULT_TIMEOUT_MS);
      for (const f of findings) {
        const rel = f.File.startsWith(repoDir) ? relative(repoDir, f.File) : f.File;
        const ranges = fileRanges.get(rel);
        if (!ranges) continue; // finding not in a touched file
        const inScope = ranges.includes(null) || ranges.some((r) => r !== null && f.Line >= r[0] && f.Line <= r[1]);
        if (inScope) out.push(toDefect(f, repoDir));
      }
    }
    return out;
  },

  runLiveness(config: DetectorConfig): LivenessEvidence {
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const racy = runAnalyzer(RACY_FIXTURE, timeoutMs);
    const clean = runAnalyzer(CLEAN_FIXTURE, timeoutMs);
    const staticCaught = racy.findings.some((f) => f.Rule.startsWith("CC001")) && clean.findings.length === 0;
    const staticDetail = racy.findings.some((f) => f.Rule.startsWith("CC001"))
      ? clean.findings.length === 0
        ? "static: planted sync-over-async in fixtures/dotnet-conc caught by Roslyn; clean fixture reports no false positive"
        : "static: planted defect caught but the clean fixture produced a false positive — lane not trustworthy"
      : "static: fixtures/dotnet-conc planted defect was NOT caught (missing dotnet SDK or a broken analyzer build)";

    // Dynamic-probe liveness: the planted deadlock in fixtures/dotnet-hang must be caught. A probe
    // that RAN but missed is a real breakage (fail-closed); a probe that simply can't run here (no
    // dotnet test host) must NOT block the independently-proven static lane.
    const probe = runHangProbe(HANG_FIXTURE, HANG_INACTIVITY_SECONDS, timeoutMs);
    let probeBroken = false;
    let probeDetail: string;
    if (probe.exec.spawnError) {
      probeDetail = "dynamic: hang probe unavailable on this host (no dotnet test host) — static lane still gated";
    } else if (probe.hung) {
      probeDetail = `dynamic: hang probe caught the planted deadlock (${probe.test ?? "unnamed"})`;
    } else {
      probeDetail = "dynamic: hang probe RAN but did NOT catch the planted deadlock — probe broken";
      probeBroken = true;
    }
    return {
      checked: true,
      plantedDefectCaught: staticCaught && !probeBroken,
      detail: `${staticDetail}; ${probeDetail}`,
    };
  },
};
