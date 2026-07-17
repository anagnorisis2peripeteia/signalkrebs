import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConcurrencyDefect } from "../types.js";
import { parseScopeEntry } from "../git-changed-files.js";
import { type ReassignCutoverConfig, detectReassignCutover } from "./cutover-core.js";

// Static anti-pattern rules for Swift. Like the Go set, these HARD-FAIL on a
// touched line, so each is high-precision. Swift 6's actor/Sendable checking
// already eliminates most data races at compile time, so the residual hard-fail
// classes here are the timer/observer LEAKS the compiler does not catch. Every
// hit is suppressible with `// concurrency-ok: <reason>`.

const SUPPRESS_RE = /\/\/\s*concurrency-ok:\s*(.+)$/;

function collectSuppressions(lines: string[]): Map<number, string> {
  const map = new Map<number, string>();
  lines.forEach((text, i) => {
    const m = text.match(SUPPRESS_RE);
    if (m) {
      map.set(i + 1, m[1].trim());
      map.set(i + 2, m[1].trim());
    }
  });
  return map;
}

interface RawHit {
  line: number;
  ruleId: string;
  kind: ConcurrencyDefect["kind"];
  summary: string;
  evidenceLine: string;
}

// A timer bound to a stored PROPERTY (`self.x = …` or `x.y = …`) leaks for the
// owning object's lifetime if never torn down. A timer bound to a local `let`/`var`
// is only a leak here if it does NOT escape the function — once it is `return`ed or
// handed to an initializer/call (e.g. wrapped in a lifecycle box, as CodexBar's
// SubprocessRunner does), its teardown is the receiver's responsibility, not this
// scope's, and flagging it is a false positive on a hard-fail rule. So: fire on a
// property target always; fire on a local only when it does not escape.
function bindingEscapes(target: string, joined: string): boolean {
  // returned, or passed as an argument into a call/initializer
  return (
    new RegExp(`\\breturn\\b[^\\n]*\\b${target}\\b`).test(joined) ||
    new RegExp(`\\(\\s*[^)]*\\b${target}\\b`).test(joined.replace(new RegExp(`\\b${target}\\s*=`), "")) ||
    new RegExp(`:\\s*${target}\\b`).test(joined) // labeled initializer arg, e.g. TimeoutTimer(timer: timeoutTimer)
  );
}
function isPropertyTarget(text: string): boolean {
  // LHS is a member access (self.x / obj.field), not a bare local declaration.
  const lhs = text.split("=")[0];
  return /\.\w+\s*$/.test(lhs.trim()) && !/\b(let|var)\s+\w+\s*$/.test(lhs.trim());
}

/** R1: a Timer bound to a stored property (or a non-escaping local) never invalidate()d. */
function ruleTimerNeverInvalidated(lines: string[]): RawHit[] {
  const hits: RawHit[] = [];
  const joined = lines.join("\n");
  lines.forEach((text, i) => {
    const m = text.match(/(\w+)\s*=\s*Timer(?:\.scheduledTimer|\s*\()/);
    if (!m) return;
    const target = m[1];
    if (new RegExp(`${target}[?!]?\\.invalidate\\s*\\(`).test(joined)) return;
    if (!isPropertyTarget(text) && bindingEscapes(target, joined)) return; // owned elsewhere
    hits.push({
      line: i + 1,
      ruleId: "timer-never-invalidated",
      kind: "timer-leak",
      summary: `Timer stored in '${target}' is never invalidate()d in this file — it retains its target and fires for the object's lifetime`,
      evidenceLine: text.trim(),
    });
  });
  return hits;
}

/** R2: a DispatchSource timer bound to a stored property (or non-escaping local) never cancel()ed. */
function ruleDispatchSourceNeverCancelled(lines: string[]): RawHit[] {
  const hits: RawHit[] = [];
  const joined = lines.join("\n");
  lines.forEach((text, i) => {
    const m = text.match(/(\w+)\s*=\s*DispatchSource\.makeTimerSource/);
    if (!m) return;
    const target = m[1];
    if (new RegExp(`${target}[?!]?\\.cancel\\s*\\(`).test(joined)) return;
    if (!isPropertyTarget(text) && bindingEscapes(target, joined)) return; // owned elsewhere
    hits.push({
      line: i + 1,
      ruleId: "dispatchsource-timer-never-cancelled",
      kind: "timer-leak",
      summary: `DispatchSourceTimer '${target}' is never cancel()ed — the source keeps firing its handler for the process lifetime`,
      evidenceLine: text.trim(),
    });
  });
  return hits;
}

/** R3: unsafe-cutover (port of go-lint's destructive-before-confirm; crabbox #1103 class).
 * A destructive teardown (`x.stop()/invalidate()/cancel()/close()/…`) that runs BEFORE a
 * fallible `try` acquisition of its replacement, with no re-create in between — if the
 * acquisition throws, the torn-down resource is gone and unrestored. Acquire/confirm the
 * replacement before destroying the incumbent. Abstains when a restart/re-acquire appears
 * between the teardown and the acquisition, or in the failure path just after it. */
// Swift cutover: the acquisition is a fallible `try`, the failure a thrown error. Delegates to the
// shared reassign-slot core (signalkrebs #16) — the same precision gates as the TS lane, which this
// rule previously lacked (it was the naive pre-hardening version).
const SWIFT_CUTOVER_CFG: ReassignCutoverConfig = {
  teardownRe: /([\w.$]+)\.(?:stop|invalidate|cancel|close|teardown|dispose|shutdown|deactivate|kill)\w*\s*\(/i,
  declRe: /\b(?:let|var)\s+(\w+)\s*=\s*try\b/,
  acquireAssignRe: /=\s*try\b/,
  restartRe: /\b(?:start|restart|reopen|reconnect|recreate|restore|revive|renew|reactivate)\w*\s*\(/i,
};
function ruleUnsafeCutover(lines: string[]): RawHit[] {
  return detectReassignCutover(lines, SWIFT_CUTOVER_CFG).map((h) => ({ ...h, kind: h.kind as RawHit["kind"] }));
}

const RULES = [ruleTimerNeverInvalidated, ruleDispatchSourceNeverCancelled, ruleUnsafeCutover];

export function lintSwift(repoDir: string, touchedRanges: string[]): ConcurrencyDefect[] {
  const defects: ConcurrencyDefect[] = [];
  const byFile = new Map<string, Array<[number, number] | null>>();

  for (const entry of touchedRanges) {
    const { file, start, end } = parseScopeEntry(entry);
    if (!file.endsWith(".swift")) continue;
    const list = byFile.get(file) ?? [];
    list.push(start !== undefined && end !== undefined ? [start, end] : null);
    byFile.set(file, list);
  }

  for (const [file, ranges] of byFile) {
    let text: string;
    try {
      text = readFileSync(join(repoDir, file), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    const suppressions = collectSuppressions(lines);
    const wholeFile = ranges.includes(null);
    const inScope = (line: number) =>
      wholeFile || ranges.some((r) => r !== null && line >= r[0] && line <= r[1]);

    for (const rule of RULES) {
      for (const hit of rule(lines)) {
        if (!inScope(hit.line)) continue;
        const reason = suppressions.get(hit.line);
        defects.push({
          kind: hit.kind,
          source: "static",
          file,
          line: hit.line,
          summary: hit.summary,
          evidence: `[${hit.ruleId}] ${file}:${hit.line}\n    ${hit.evidenceLine}`,
          ruleId: hit.ruleId,
          suppressed: reason !== undefined,
          suppressionReason: reason,
        });
      }
    }
  }
  return defects;
}
