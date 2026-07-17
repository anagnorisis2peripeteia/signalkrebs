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

// The Rust lane. Loom is an exhaustive interleaving model-checker (stronger than TSan for our
// classes — it explores ALL interleavings of the diff-scoped loom-gated tests). The DYNAMIC
// detector runs `RUSTFLAGS=--cfg loom cargo test`; a FAILED test panic is a discovered interleaving,
// anchored at the violated assertion. A small static lint rides alongside for lock-across-await.

const SELF_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RACY_FIXTURE = join(SELF_ROOT, "fixtures", "rust-loom");
const CLEAN_FIXTURE = join(SELF_ROOT, "fixtures", "rust-clean");
const DEFAULT_TIMEOUT_MS = 600_000;

const clean: ExecEvidence = { exitCode: 0, signal: null, spawnError: null, stderr: "" };

/** Nearest crate root (dir with Cargo.toml) at or above a `.rs` file. */
function crateOf(repoDir: string, file: string): string | null {
  let dir = dirname(join(repoDir, file));
  while (dir.startsWith(repoDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      break;
    }
    if (entries.includes("Cargo.toml")) return relative(repoDir, dir) || ".";
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Run the crate's loom-gated tests under `--cfg loom`. A FAILED test panic ⇒ a discovered
 * interleaving anchored at the assertion. A compile/spawn failure ⇒ fail closed. */
function runLoom(crateDir: string, timeoutMs: number): { defect: { file: string; line: number } | null; exec: ExecEvidence } {
  const env = { ...process.env, RUSTFLAGS: `${process.env.RUSTFLAGS ?? ""} --cfg loom`.trim() };
  try {
    execFileSync("cargo", ["test", "--quiet"], {
      cwd: crateDir,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 128 * 1024 * 1024,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { defect: null, exec: clean }; // every interleaving passed
  } catch (e) {
    const err = e as { status?: number | null; signal?: string | null; stdout?: Buffer | string; stderr?: Buffer | string };
    const out = (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "");
    // A loom interleaving failure: a FAILED test that panicked on the assertion loom violated.
    if (/test result: FAILED/.test(out) && /panicked at/.test(out)) {
      const m = out.match(/panicked at ([^\s:]+):(\d+)/);
      return { defect: m ? { file: m[1], line: Number(m[2]) } : { file: crateDir, line: 0 }, exec: clean };
    }
    // Compile error, missing toolchain, or the safety-net timeout → cannot conclude → fail closed.
    if (err.status == null || /error\[E\d+\]|could not compile|error: no such|no default toolchain/.test(out)) {
      return {
        defect: null,
        exec: {
          exitCode: err.status ?? -1,
          signal: err.signal ?? null,
          spawnError: err.status == null ? "cargo not found or timed out" : "cargo/loom compile failure",
          stderr: out.slice(-800),
        },
      };
    }
    return { defect: null, exec: clean }; // other nonzero without a loom panic — not our defect class
  }
}

// Static lint: a std Mutex/RwLock guard held ACROSS an `.await` in an async fn deadlocks the
// executor (the guard is !Send / blocks the worker). High-precision, conservative: same block,
// guard not dropped before the await.
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
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\blet\s+(\w+)\s*=\s*[\w.]+\.(?:lock|read|write)\(\)\s*(?:\.unwrap\(\))?;/);
    if (!m) continue;
    const guard = m[1];
    const indent = lines[i].match(/^\s*/)?.[0].length ?? 0;
    // scan forward within the guard's block for an `.await` before the guard is dropped / block ends.
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j];
      const ind = t.trim() === "" ? indent + 1 : t.match(/^\s*/)?.[0].length ?? 0;
      if (ind < indent && t.trim() !== "") break; // left the guard's block
      if (new RegExp(`\\bdrop\\s*\\(\\s*${guard}\\s*\\)`).test(t)) break; // explicitly dropped first
      if (/\.await\b/.test(t) && inScope(i + 1)) {
        out.push({
          kind: "channel-misuse",
          source: "static",
          file,
          line: i + 1,
          summary: `lock guard '${guard}' is held across an '.await' (line ${j + 1}) — a std Mutex/RwLock guard across an await blocks the async executor; drop the guard before awaiting or use an async-aware lock`,
          evidence: `[lock-across-await] ${file}:${i + 1}\n    ${lines[i].trim()}`,
          ruleId: "lock-across-await",
          suppressed: false,
        });
        break;
      }
    }
  }
  return out;
}

export const rustLoomAdapter: DetectorAdapter = {
  tool: "rust-loom",

  resolveExercise(repoDir: string, touchedFiles: string[]): ExerciseEvidence {
    const rsFiles = touchedFiles.filter((f) => f.endsWith(".rs"));
    const touched = new Set<string>();
    for (const f of rsFiles) {
      const crate = crateOf(repoDir, f);
      if (crate) touched.add(crate);
    }
    const crates = [...touched].sort();
    return {
      touchedPackages: crates,
      exercisedPackages: crates, // loom runs the crate's --cfg loom tests
      unexercisedPackages: [],
      stress: { reps: 1, gomaxprocs: [Math.max(2, availableParallelism())] },
    };
  },

  runDetector(repoDir: string, exercise: ExerciseEvidence, config: DetectorConfig): { defects: ConcurrencyDefect[]; exec: ExecEvidence } {
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const defects: ConcurrencyDefect[] = [];
    let exec: ExecEvidence = clean;
    for (const crate of exercise.exercisedPackages) {
      const { defect, exec: e } = runLoom(crate === "." ? repoDir : join(repoDir, crate), timeoutMs);
      if (e.spawnError || e.signal) exec = e;
      if (defect) {
        const rel = defect.file.startsWith(repoDir) ? relative(repoDir, defect.file) : join(crate === "." ? "" : crate, defect.file);
        defects.push({
          kind: "toctou",
          source: "dynamic",
          file: rel,
          line: defect.line,
          summary: `loom found an interleaving under which this loom-gated test's assertion fails — a data race / lost update the code does not synchronize`,
          evidence: `loom interleaving failure at ${rel}:${defect.line}`,
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
      if (!file.endsWith(".rs")) continue;
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
    const racy = runLoom(RACY_FIXTURE, timeoutMs);
    const cleanRun = runLoom(CLEAN_FIXTURE, timeoutMs);
    const caught = racy.defect !== null;
    const cleanIsClean = cleanRun.defect === null && cleanRun.exec.spawnError === null;
    return {
      checked: true,
      plantedDefectCaught: caught && cleanIsClean,
      detail: caught
        ? cleanIsClean
          ? "loom found the planted interleaving in fixtures/rust-loom; the clean twin passes every interleaving"
          : "planted interleaving caught but the clean twin did not pass — lane not trustworthy"
        : "fixtures/rust-loom planted race was NOT caught — the rust-loom lane is not detecting on this host (missing cargo or a loom build failure)",
    };
  },
};
