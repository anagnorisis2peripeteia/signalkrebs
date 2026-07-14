#!/usr/bin/env node
// Live detector validation — fires the REAL detector through
// runConcurrencyAnalysis against fixtures with a KNOWN outcome. This is the
// marmorkrebs discipline applied to a concurrency lane: a detector's unit tests
// feed it hand-shaped input and cannot tell whether the lane actually catches a
// race on THIS host with THIS toolchain — only invoking the real detector can.
//
// A lane may not leave runner.ts QUARANTINED_TOOLS until its spec here passes.
//
// Each spec asserts the failure modes that actually matter:
//   1. a PLANTED race IS caught (verdict=defect, liveness live)  — the lane works
//   2. a CLEAN, correctly-synchronized neighbour is NOT flagged  — no false positive
//   3. with the detector binary hidden from PATH, the run FAILS CLOSED (never clean)
//
// Usage:
//   node scripts/validate-detector.mjs <tool>   validate one lane (exit 3 if toolchain absent)
//   node scripts/validate-detector.mjs --all     validate every lane whose toolchain is present

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { runConcurrencyAnalysis } = await import(pathToFileURL(join(ROOT, "dist/runner.js")).href);

const SPECS = {
  "go-race": {
    toolchain: "go",
    racyFixture: "fixtures/go-race",
    racyChanged: ["counter.go"],
    cleanFixture: "fixtures/go-clean",
    cleanChanged: ["counter.go"],
    config: { reps: 5, gomaxprocs: [4] },
  },
  "swift-tsan": {
    toolchain: "swift",
    racyFixture: "fixtures/swift-tsan",
    racyChanged: ["Sources/Counter/Counter.swift"],
    cleanFixture: "fixtures/swift-clean",
    cleanChanged: ["Sources/Counter/Counter.swift"],
    config: {},
  },
};

function haveBinary(bin) {
  const which = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" });
  return which.status === 0;
}

function pass(msg) {
  console.log(`  ✓ ${msg}`);
}
function fail(tool, msg, extra) {
  console.error(`  ✗ [${tool}] ${msg}`);
  if (extra) console.error(String(extra).split("\n").map((l) => "      " + l).join("\n"));
  return false;
}

function validate(tool, spec) {
  console.log(`\n[${tool}] validating against real ${spec.toolchain} toolchain`);
  if (!haveBinary(spec.toolchain)) {
    console.error(`  - ${spec.toolchain} not on PATH; cannot validate ${tool} (exit 3)`);
    process.exitCode = 3;
    return null;
  }

  // SPEC 1 — planted race caught.
  const racy = runConcurrencyAnalysis(
    join(ROOT, spec.racyFixture),
    spec.racyChanged,
    spec.racyChanged,
    { tool, ...spec.config },
  );
  if (racy.verdict !== "defect") return fail(tool, `planted race NOT caught (verdict=${racy.verdict})`, racy.error);
  if (!racy.liveness.plantedDefectCaught) return fail(tool, "liveness fixture did not catch its planted race");
  const anchorBase = spec.racyChanged[0].split("/").pop(); // e.g. counter.go | Counter.swift
  const anchored = racy.defects.some((d) => d.kind === "data-race" && d.file.includes(anchorBase));
  if (!anchored) return fail(tool, `race not anchored in ${anchorBase}`, JSON.stringify(racy.defects, null, 1));
  pass(`planted race caught, anchored in ${anchorBase}, liveness live`);

  // SPEC 2 — clean neighbour not flagged.
  const clean = runConcurrencyAnalysis(
    join(ROOT, spec.cleanFixture),
    spec.cleanChanged,
    spec.cleanChanged,
    { tool, ...spec.config },
  );
  if (clean.verdict !== "clean") {
    return fail(tool, `correctly-synchronized fixture was not clean (verdict=${clean.verdict})`, clean.error);
  }
  pass("clean fixture reports verdict=clean (no false positive)");

  // SPEC 3 — hidden binary fails closed.
  const savedPath = process.env.PATH;
  process.env.PATH = join(ROOT, "no-such-dir");
  try {
    const blind = runConcurrencyAnalysis(
      join(ROOT, spec.racyFixture),
      spec.racyChanged,
      spec.racyChanged,
      { tool, ...spec.config },
    );
    if (blind.verdict === "clean" || blind.verdict === "defect") {
      return fail(tool, `hidden ${spec.toolchain} did not fail closed (verdict=${blind.verdict})`);
    }
    pass(`hidden ${spec.toolchain} fails closed (verdict=${blind.verdict})`);
  } finally {
    process.env.PATH = savedPath;
  }

  console.log(`[${tool}] OK`);
  return true;
}

const arg = process.argv[2];
const tools = arg === "--all" ? Object.keys(SPECS) : [arg];
if (!arg || (arg !== "--all" && !SPECS[arg])) {
  console.error(`usage: validate-detector.mjs <${Object.keys(SPECS).join("|")}|--all>`);
  process.exit(64);
}

let allOk = true;
for (const tool of tools) {
  const result = validate(tool, SPECS[tool]);
  if (result === false) allOk = false;
}
if (!allOk) process.exit(1);
