import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
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
  };
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
      const r = runAnalyzer(join(repoDir, proj), timeoutMs);
      if (r.exec.spawnError || r.exec.signal) exec = r.exec;
      for (const f of r.findings) defects.push(toDefect(f, repoDir));
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
    const caught = racy.findings.some((f) => f.Rule.startsWith("CC001"));
    const cleanIsClean = clean.findings.length === 0;
    return {
      checked: true,
      plantedDefectCaught: caught && cleanIsClean,
      detail: caught
        ? cleanIsClean
          ? "planted sync-over-async in fixtures/dotnet-conc caught by the Roslyn analyzer; clean fixture reports no false positive"
          : "planted defect caught but the clean fixture produced a false positive — lane not trustworthy"
        : "fixtures/dotnet-conc planted defect was NOT caught — the dotnet-conc lane is not detecting on this host (missing dotnet SDK or a broken analyzer build)",
    };
  },
};
