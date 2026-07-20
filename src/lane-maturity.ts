// Lane-maturity floor + gate (signalkrebs #16, item 2). Every registered lane must clear a minimum
// bar so a new lane can't ship half-built (as py-async nearly did — 2 rules, hard-firing on tests,
// no suppression). The registry DECLARES each lane's maturity attributes; verifyLaneMaturity checks
// the mechanical ones (fixtures on disk, ≥1 hard rule, static lanes declare suppression + a test-file
// policy), and the meta-test in the suite BEHAVIOURALLY confirms suppression + test-file downgrade
// for the lanes it can drive. A lane that regresses fails CI.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DETECTOR_TOOLS, type DetectorTool } from "./types.js";

export interface LaneMaturity {
  /** Does the lane do STATIC analysis (a lint / analyzer), vs dynamic-only? */
  hasStaticLint: boolean;
  /** Rule ids / defect kinds that HARD-FAIL the gate (≥1 required). */
  hardRules: readonly string[];
  /** `concurrency-ok:` pragma support — required for static-lint lanes. */
  suppression: "pragma" | "n/a";
  /** How test files are treated — required (non-"n/a") for static-lint lanes. */
  testFilePolicy: "advisory" | "skip" | "n/a";
  racyFixture: string;
  cleanFixture: string;
}

export const LANE_MATURITY: Record<DetectorTool, LaneMaturity> = {
  "go-race": {
    hasStaticLint: true,
    hardRules: ["timer-without-stop", "leak-on-error-return", "shadowed-retry-state", "channel-double-close", "destructive-before-confirm"],
    suppression: "pragma",
    testFilePolicy: "advisory",
    racyFixture: "fixtures/go-race",
    cleanFixture: "fixtures/go-clean",
  },
  "swift-tsan": {
    hasStaticLint: true,
    hardRules: ["data-race", "destructive-before-confirm", "leak-on-error-return"],
    suppression: "pragma",
    testFilePolicy: "advisory",
    racyFixture: "fixtures/swift-tsan",
    cleanFixture: "fixtures/swift-clean",
  },
  "ts-async": {
    hasStaticLint: true,
    hardRules: ["destructive-before-confirm", "leak-on-error-return"],
    suppression: "pragma",
    testFilePolicy: "advisory",
    racyFixture: "fixtures/ts-async",
    cleanFixture: "fixtures/ts-clean-js",
  },
  "dotnet-conc": {
    hasStaticLint: true,
    hardRules: ["CC001", "CC002", "CC003", "deadlock"],
    suppression: "pragma",
    testFilePolicy: "advisory",
    racyFixture: "fixtures/dotnet-conc",
    cleanFixture: "fixtures/dotnet-clean",
  },
  "py-async": {
    hasStaticLint: true,
    hardRules: ["py-blocking-in-async", "py-fire-and-forget-task", "py-unawaited-coroutine"],
    suppression: "pragma",
    testFilePolicy: "advisory",
    racyFixture: "fixtures/py-async",
    cleanFixture: "fixtures/py-clean",
  },
  "rust-loom": {
    hasStaticLint: true,
    hardRules: ["lock-guard-across-await", "toctou"],
    suppression: "pragma",
    testFilePolicy: "advisory",
    racyFixture: "fixtures/rust-loom",
    cleanFixture: "fixtures/rust-clean",
  },
  "interleaving-stress": {
    hasStaticLint: false, // dynamic-only: perturbs the scheduler, no static rules to suppress
    hardRules: ["data-race", "toctou"],
    suppression: "n/a",
    testFilePolicy: "n/a",
    racyFixture: "fixtures/interleaving-stress",
    cleanFixture: "fixtures/interleaving-clean",
  },
  "swift-async": {
    hasStaticLint: true,
    hardRules: ["SA001", "deadlock"],
    suppression: "pragma",
    testFilePolicy: "advisory",
    racyFixture: "fixtures/swift-async",
    cleanFixture: "fixtures/swift-async-clean",
  },
};

/** Mechanical maturity checks. Returns a list of violations (empty = every lane clears the floor). */
export function verifyLaneMaturity(rootDir: string): string[] {
  const v: string[] = [];
  for (const tool of DETECTOR_TOOLS) {
    const m = LANE_MATURITY[tool];
    if (!m) {
      v.push(`${tool}: no maturity descriptor`);
      continue;
    }
    if (m.hardRules.length === 0) v.push(`${tool}: declares no hard rules`);
    if (!existsSync(join(rootDir, m.racyFixture))) v.push(`${tool}: racy fixture missing (${m.racyFixture})`);
    if (!existsSync(join(rootDir, m.cleanFixture))) v.push(`${tool}: clean fixture missing (${m.cleanFixture})`);
    if (m.hasStaticLint) {
      if (m.suppression !== "pragma") v.push(`${tool}: static lint without pragma suppression`);
      if (m.testFilePolicy === "n/a") v.push(`${tool}: static lint without an explicit test-file policy`);
    }
  }
  return v;
}
