#!/usr/bin/env node
// signalkrebs #14 — regression-fixture autoharvest.
//
// Turn a confirmed true-positive lint hit into a planted-defect fixture: extract the minimal
// enclosing function into fixtures/<lane>/harvested/<name>.<ext>, then run the lane's static lint on
// it and CONFIRM the same rule still fires (the fixture reproduces the original detection). This
// grows the quarantine validation corpus for free and guards against future rule regressions.
//
//   node scripts/harvest-fixture.mjs --repo <dir> --file <rel-path> --line <N> --lane <go-race|...> \
//        [--name <fixture-name>] [--out <dir>]
//
// The extracted fixture reproduces the STATIC detection (the regex lint fires on the function text);
// it is not guaranteed to compile (imports are dropped) — that only matters for the dynamic lanes.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, required = true) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (required) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return undefined;
}

const LANES = {
  "go-race": { ext: "go", pkg: "package harvested", import: (m) => `../../dist/lint/go-lint.js:lintGo` },
};

const repo = resolve(arg("repo"));
const file = arg("file");
const line = Number(arg("line"));
const lane = arg("lane");
const name = arg("name", false) ?? `harvested_${line}`;

if (!LANES[lane]) {
  console.error(`unsupported lane '${lane}' (have: ${Object.keys(LANES).join(", ")})`);
  process.exit(2);
}
const spec = LANES[lane];

// --- extract the enclosing function (brace-matched around `line`) ---
const src = readFileSync(join(repo, file), "utf8").split("\n");
let start = -1;
for (let i = line - 1; i >= 0; i--) {
  if (/^\s*func\b/.test(src[i])) {
    start = i;
    break;
  }
}
if (start === -1) {
  console.error(`no enclosing 'func' found above ${file}:${line}`);
  process.exit(1);
}
let depth = 0;
let end = -1;
let opened = false;
for (let i = start; i < src.length; i++) {
  depth += (src[i].match(/\{/g) || []).length - (src[i].match(/\}/g) || []).length;
  if (!opened && depth > 0) opened = true;
  if (opened && depth === 0) {
    end = i;
    break;
  }
}
if (end === -1) end = src.length - 1;
const func = src.slice(start, end + 1);

// --- capture the rule that fires at the reported hit in the ORIGINAL source ---
// A rule anchors where the evidence lives (e.g. leak-on-error anchors at the ACQUIRE, not the
// error-return the user reported), so match by rule identity, not by line — extraction renumbers
// lines anyway. Prefer the hit nearest the reported line that lies inside the enclosing function.
const { lintGo } = await import(pathToFileURL(join(ROOT, "dist/lint/go-lint.js")).href);
const origHits = lintGo(repo, [file]).filter((d) => !d.suppressed);
const inFunc = origHits.filter((h) => h.line >= start + 1 && h.line <= end + 1);
const orig = inFunc.sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line))[0];
if (!orig) {
  console.error(`no lint hit fires inside ${file}'s enclosing function — nothing to harvest`);
  console.error(`  (hits in file: ${origHits.map((h) => `${h.ruleId}@${h.line}`).join(", ") || "none"})`);
  process.exit(1);
}

// --- write the fixture ---
const outArg = arg("out", false);
const outDir = outArg ? resolve(outArg) : join(ROOT, "fixtures", lane, "harvested");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `${name}.${spec.ext}`);
const body = [spec.pkg, "", ...func, ""].join("\n");
writeFileSync(outFile, body);

// --- verify the SAME rule reproduces on the extracted fixture ---
const hits = lintGo(outDir, [`${name}.${spec.ext}`]).filter((d) => !d.suppressed);
const repro = hits.find((h) => h.ruleId === orig.ruleId);

console.log(`harvested → fixtures/${lane}/harvested/${name}.${spec.ext} (${func.length} lines, from ${file}:${orig.line} [${orig.ruleId}])`);
if (repro) {
  console.log(`✓ reproduces detection: [${repro.ruleId}] fires on the extracted function (line ${repro.line})`);
  console.log(`  expected-verdict spec: { fixture: "fixtures/${lane}/harvested/${name}", verdict: "defect", kind: "${repro.kind}", rule: "${repro.ruleId}" }`);
  process.exit(0);
} else {
  console.error(`✗ [${orig.ruleId}] did NOT reproduce on the extracted function (fixture hits: ${hits.map((h) => `${h.ruleId}@${h.line}`).join(", ") || "none"})`);
  console.error(`  the surrounding context the rule needs may extend beyond the function — widen the extraction`);
  process.exit(1);
}
