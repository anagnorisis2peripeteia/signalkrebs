// signalkrebs — normalized concurrency-gate result shape.
//
// Unlike mutation testing (marmorkrebs) there is no killed/total score: a
// concurrency detector either surfaces a defect or it does not, and "no defect
// seen in N runs" is NOT proof of absence. So the verdict is fail-closed and
// evidence-bearing — a green means the lane was proven LIVE, the touched code
// was actually EXERCISED under parallelism, and nothing surfaced within the
// stress budget. Every degenerate state is an explicit non-passing verdict.

export type DetectorTool = "go-race" | "swift-tsan" | "ts-async";

export const DETECTOR_TOOLS: DetectorTool[] = ["go-race", "swift-tsan", "ts-async"];

/** Terminal verdicts, most-benign first. Only `clean` exits 0. */
export type Verdict =
  | "clean" // exercised under parallelism, lane live, nothing surfaced → PASS (exit 0)
  | "defect" // a race/leak/anti-pattern was found → FAIL (exit 2)
  | "insufficient" // touched code not exercised under real parallelism → FAIL-CLOSED (exit 3)
  | "lane-dead" // the detector could not be proven live this run → FAIL-CLOSED (exit 3)
  | "error"; // tool spawn/timeout/parse failure → ERROR (exit 1)

export const VERDICT_EXIT: Record<Verdict, number> = {
  clean: 0,
  error: 1,
  defect: 2,
  insufficient: 3,
  "lane-dead": 3,
};

/** How a defect was found — governs which evidence fields are populated. */
export type DefectKind =
  | "data-race" // dynamic detector (TSan) reported concurrent read/write
  | "goroutine-leak" // a spawned worker outlived its owner / never exited
  | "timer-leak" // a ticker/timer owned by a live object was never stopped
  | "toctou" // check-then-act across a released lock (logical race)
  | "channel-misuse" // send-on-closed, double-close, or blocked-forever receive
  | "waitgroup-misuse" // Add-after-Wait, missing Done on an error path
  | "anti-pattern"; // static lint hit on a touched line (hard-fail per gate policy)

/** Whether a defect came from running code (dynamic) or reading it (static). */
export type DefectSource = "dynamic" | "static";

export interface ConcurrencyDefect {
  kind: DefectKind;
  source: DefectSource;
  file: string;
  line: number;
  /** One-sentence statement of the defect. */
  summary: string;
  /**
   * For dynamic defects: the trimmed raw detector report (both stack frames of a
   * TSan race, the leak backtrace, etc.). For static defects: the matched rule id
   * plus the offending source line. This is the EVIDENCE — a defect with no
   * evidence is not a defect.
   */
  evidence: string;
  /** Static lint only: the rule that fired (e.g. "timer-without-stop"). */
  ruleId?: string;
  /**
   * True when a `// concurrency-ok: <reason>` pragma on or immediately above the
   * line suppressed this finding. Suppressed findings are retained for the report
   * but do not contribute to the `defect` verdict.
   */
  suppressed?: boolean;
  /** Suppression justification captured from the pragma, when suppressed. */
  suppressionReason?: string;
}

/**
 * Proof that the run actually exercised the touched code under parallelism.
 * Without this a "clean" result is vacuous — the exact failure mode marmorkrebs
 * guards with its zero-mutant rule. `exercisedPackages < touchedPackages` (with
 * no override) is an `insufficient` verdict.
 */
export interface ExerciseEvidence {
  /** Packages/targets containing at least one touched source file. */
  touchedPackages: string[];
  /** Of those, the ones whose tests actually RAN under the detector this session. */
  exercisedPackages: string[];
  /** Touched packages with zero test coverage reaching the changed code. */
  unexercisedPackages: string[];
  /** Stress budget actually applied. */
  stress: {
    /** `-count=N` repetitions (Go) or equivalent rerun count. */
    reps: number;
    /**
     * Parallelism the detector ran under. Go: GOMAXPROCS values swept. Swift:
     * host cores. ts-async: host cores (the event loop is single-threaded; the
     * value records that real async interleaving, not a mocked scheduler, ran).
     * A run that never reached >=2 cannot claim a concurrency-clean verdict.
     */
    gomaxprocs: number[];
  };
}

/**
 * Proof the lane is LIVE this run: the detector was exercised against a fixture
 * carrying a PLANTED defect and caught it. A detector that reports "clean" on a
 * known-racy fixture is lying — that is `lane-dead`, not a pass. Mirrors
 * marmorkrebs' validate-provider discipline, but checked inline per gate run
 * (opt-out only via an explicit, recorded flag) rather than trusted from CI.
 */
export interface LivenessEvidence {
  checked: boolean;
  /** True only if the planted-defect fixture was caught this run. */
  plantedDefectCaught: boolean;
  detail: string;
}

export interface ConcurrencyResult {
  detector: DetectorTool;
  verdict: Verdict;
  /** All findings, including suppressed ones (which do not drive `defect`). */
  defects: ConcurrencyDefect[];
  exercise: ExerciseEvidence;
  liveness: LivenessEvidence;
  /** Populated when verdict is `error`; carries the tool's own stderr tail. */
  error?: string;
  /** Wall-clock of the whole detector+lint pass. */
  durationMs?: number;
}

/**
 * A detector adapter. One per language. The runner drives these; the adapter
 * owns everything language-specific and returns the normalized shape above.
 * A lane stays in QUARANTINED_TOOLS until its fixture proves `runLiveness`
 * actually catches a planted defect via scripts/validate-detector.mjs.
 */
export interface DetectorAdapter {
  tool: DetectorTool;

  /**
   * Map touched source files to the packages/targets that must be exercised, and
   * report which of those the test suite actually reaches.
   */
  resolveExercise(repoDir: string, touchedFiles: string[]): ExerciseEvidence;

  /**
   * Run the dynamic detector under the stress budget over the touched packages.
   * Returns raw defects (unreconciled) plus the exec evidence the runner needs
   * to fail closed on spawn/timeout/signal.
   */
  runDetector(
    repoDir: string,
    exercise: ExerciseEvidence,
    config: DetectorConfig,
  ): { defects: ConcurrencyDefect[]; exec: ExecEvidence };

  /**
   * Static anti-pattern scan, scoped to the touched LINE RANGES. Honors the
   * `// concurrency-ok: <reason>` suppression pragma. Hits on touched lines are
   * hard-failing per gate policy; suppressed hits are retained but inert.
   */
  lint(repoDir: string, touchedRanges: string[]): ConcurrencyDefect[];

  /**
   * Prove the lane is live: run the detector against this adapter's planted-defect
   * fixture and confirm the defect is caught.
   */
  runLiveness(config: DetectorConfig): LivenessEvidence;
}

export interface ExecEvidence {
  exitCode: number;
  signal: string | null;
  spawnError: string | null;
  stderr: string;
}

export interface DetectorConfig {
  tool: DetectorTool;
  /** `-count=N` for the detector runs (default DEFAULT_REPS). */
  reps?: number;
  /** GOMAXPROCS values to sweep (default DEFAULT_GOMAXPROCS). */
  gomaxprocs?: number[];
  /** Per-detector run timeout in ms (default DEFAULT_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Custom test command override (default: tool-specific). */
  testCommand?: string;
  base?: string;
  /** Let a run that could not exercise every touched package still pass. */
  allowUnexercised?: boolean;
  /** Skip the inline liveness fixture check (records an explicit downgrade). */
  skipLiveness?: boolean;
  /**
   * Run ONLY the static anti-pattern lint — no detector, no liveness, no exercise
   * requirement. Used by the hunt for a free repo-wide pre-filter and for a fast
   * local check. Verdict is `defect` on any un-suppressed hit, else `clean`.
   */
  lintOnly?: boolean;
  /** Path for the JSON result artifact (written before exit-code evaluation). */
  reportFile?: string;
  /** Swift-lane fixture/target plumbing, filled per adapter as needed. */
  swiftPackagePath?: string;
  swiftTestTarget?: string;
}

export const DEFAULT_REPS = 20;
export const DEFAULT_GOMAXPROCS = [2, 8];
export const DEFAULT_TIMEOUT_MS = 480_000;
