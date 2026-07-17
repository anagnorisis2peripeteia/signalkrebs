import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConcurrencyDefect } from "../types.js";
import { parseScopeEntry } from "../git-changed-files.js";

// Static anti-pattern rules for Go. These HARD-FAIL the gate on a touched line
// (per gate policy), so every rule here is chosen to be high-precision: a hit is
// a real, well-known concurrency bug, not a style nit. Fuzzy heuristics (the
// partial-synchronization struct smell, goroutine-in-constructor) deliberately
// do NOT live here — they belong to the hunt skill's LLM discovery layer, where a
// false positive costs a wasted look, not a blocked PR. Every hit is suppressible
// with a `// concurrency-ok: <reason>` pragma on the offending line or the line
// directly above it.

const SUPPRESS_RE = /\/\/\s*concurrency-ok:\s*(.+)$/;

interface LineSuppression {
  reason: string;
}

/** A suppression applies to its own line and the immediately following line. */
function collectSuppressions(lines: string[]): Map<number, LineSuppression> {
  const map = new Map<number, LineSuppression>();
  lines.forEach((text, i) => {
    const m = text.match(SUPPRESS_RE);
    if (m) {
      const reason = m[1].trim();
      map.set(i + 1, { reason }); // 1-indexed: same line
      map.set(i + 2, { reason }); // and the line below
    }
  });
  return map;
}

interface RawHit {
  line: number; // 1-indexed
  ruleId: string;
  kind: ConcurrencyDefect["kind"];
  summary: string;
  evidenceLine: string;
  /** Advisory hits are surfaced for the hunt but do NOT hard-fail (e.g. test-quality nits). */
  advisory?: boolean;
}

/** R1: a ticker/timer stored in a struct field that is never Stop()ed in this file. */
function ruleTimerWithoutStop(lines: string[]): RawHit[] {
  const hits: RawHit[] = [];
  const joined = lines.join("\n");
  lines.forEach((text, i) => {
    // Match `s.foo = time.NewTicker(...)` / `p.timer = time.NewTimer(...)` — the
    // assignment target is a selector (a field), so the ticker outlives the call.
    const m = text.match(/(\w+)\.(\w+)\s*=\s*time\.New(Ticker|Timer)\s*\(/);
    if (!m) return;
    const field = m[2];
    const kind = m[3]; // Ticker | Timer
    // Look for any Stop() on that field name anywhere in the file. A field named
    // `ticker` stopped via `s.ticker.Stop()` or a captured `ticker.Stop()` clears it.
    const stopRe = new RegExp(`\\.${field}\\.Stop\\s*\\(|\\b${field}\\.Stop\\s*\\(`);
    if (stopRe.test(joined)) return;
    hits.push({
      line: i + 1,
      ruleId: "timer-without-stop",
      kind: "timer-leak",
      summary: `time.New${kind} stored in field '${field}' is never Stop()ed in this file — it fires for the lifetime of the owning object`,
      evidenceLine: text.trim(),
    });
  });
  return hits;
}

/** R2: a range/select loop over a ticker channel with no exit path (unstoppable goroutine). */
function ruleRangeOverTickerNoExit(lines: string[]): RawHit[] {
  const hits: RawHit[] = [];
  lines.forEach((text, i) => {
    // `for range x.C {` or `for range x.C` — a bare consume loop over a timer/ticker channel.
    const m = text.match(/for\s+range\s+([\w.]+)\.C\b/);
    if (!m) return;
    // Scan the loop body (until matching close-brace at the for's indent) for an exit:
    // return / break, or a select that watches a done/ctx channel. Absence => the
    // goroutine can never exit once the ticker is stopped elsewhere.
    const indent = text.match(/^\s*/)?.[0].length ?? 0;
    let hasExit = false;
    for (let j = i + 1; j < lines.length; j++) {
      const bodyLine = lines[j];
      const bodyIndent = bodyLine.match(/^\s*/)?.[0].length ?? 0;
      if (bodyLine.trim() === "}" && bodyIndent <= indent) break; // end of loop
      if (/\b(return|break)\b/.test(bodyLine)) hasExit = true;
      if (/select\s*\{/.test(bodyLine)) hasExit = true;
      if (/case\s+<-/.test(bodyLine)) hasExit = true;
    }
    if (hasExit) return;
    hits.push({
      line: i + 1,
      ruleId: "range-over-ticker-no-exit",
      kind: "goroutine-leak",
      summary: `'for range ${m[1]}.C' has no return/break/done-select — this goroutine cannot exit once the ticker is stopped, leaking it for the process lifetime`,
      evidenceLine: text.trim(),
    });
  });
  return hits;
}

/** R3: WaitGroup.Add called inside a spawned goroutine (classic Add-after-Wait race). */
function ruleWaitGroupAddInGoroutine(lines: string[]): RawHit[] {
  const hits: RawHit[] = [];
  let goDepth = -1; // brace depth at which the current `go func(` opened, or -1
  let depth = 0;
  lines.forEach((text, i) => {
    const opensGoFunc = /\bgo\s+func\s*\(/.test(text);
    // Track brace depth crudely to know if an Add() is lexically inside a go func literal.
    const opens = (text.match(/\{/g) || []).length;
    const closes = (text.match(/\}/g) || []).length;
    if (opensGoFunc && goDepth === -1) goDepth = depth;
    if (goDepth !== -1 && /\b\w+\.Add\s*\(/.test(text) && /wg|group|WaitGroup/i.test(text)) {
      hits.push({
        line: i + 1,
        ruleId: "waitgroup-add-in-goroutine",
        kind: "waitgroup-misuse",
        summary:
          "WaitGroup.Add() called inside a spawned goroutine — it can run after Wait() returns, a classic Add-after-Wait race; call Add() before `go`",
        evidenceLine: text.trim(),
      });
    }
    depth += opens - closes;
    if (goDepth !== -1 && depth <= goDepth) goDepth = -1; // left the go func literal
  });
  return hits;
}

/**
 * R4: destructive-before-confirm cutover. A function tears down a live resource
 * (stop/close/delete/...) and only THEN attempts a fallible acquisition of its
 * replacement (`x, err := coord.CreateEgressTicket(...)`-shaped), whose error
 * path bails without restoring what was destroyed. A transient acquisition
 * failure leaves the system worse off than before the function ran — see
 * crabbox #1103 (`stopEgressHostDaemonLocked` before `CreateEgressTicket`; a
 * ticket failure left egress dead). General rule: acquire/confirm the
 * replacement before destroying the incumbent.
 *
 * Scoped per function (brace-depth boundaries) so the local windows below never
 * bleed across unrelated functions. High-precision by construction: it only
 * fires on the exact destructive -> fallible-two-value-acquire -> bail-on-error
 * sequence, and abstains the moment a restart/re-acquire of the destroyed thing
 * appears in between (an independent teardown+setup is not this bug).
 */
function ruleDestructiveBeforeConfirm(lines: string[]): RawHit[] {
  const hits: RawHit[] = [];

  // A CALL (not a `func` definition) whose name reads as tearing something down.
  const DESTRUCTIVE_RE = /\b(stop|close|delete|remove|teardown|destroy|kill|unregister|revoke|release)\w*\s*\(/i;
  // The call/receiver snippet, for the message — best-effort, falls back to the raw line.
  const DESTRUCTIVE_CALL_RE =
    /[\w.]*\b(?:stop|close|delete|remove|teardown|destroy|kill|unregister|revoke|release)\w*\([^()]*\)/i;
  // `x, err := something.Create/New/Dial/...(...)` — a fallible two-value acquisition.
  const ACQUIRE_RE =
    /\b\w+\s*,\s*err\b\s*:?=\s*[\w.]+\.(Create|New|Dial|Acquire|Open|Start|Register|Provision|Prepare|Connect|Mint|Reserve)\w*\s*\(/;
  const ACQUIRE_CALL_RE =
    /\w+\s*,\s*err\b\s*:?=\s*[\w.]+\.(?:Create|New|Dial|Acquire|Open|Start|Register|Provision|Prepare|Connect|Mint|Reserve)\w*\([^()]*\)/;
  // Any call that could plausibly restore/re-create the just-destroyed thing —
  // if one appears between the destructive call and the acquisition, abstain.
  const RESTART_RE = /\b(start|restart|reopen|reconnect|recreate|restore|revive|renew)\w*\s*\(/i;
  const ERR_CHECK_RE = /if\s+err\s*!=\s*nil\s*\{/;
  const FUNC_DECL_RE = /^\s*func\b/;

  const WINDOW = 20; // lines to look forward for the acquisition
  const ERR_CHECK_WINDOW = 3; // lines to look forward for the `if err != nil {` itself
  const ERR_BODY_WINDOW = 3; // lines inside that if-block to look for `return`

  // Pass 1: function ranges by brace depth, matching the style of
  // ruleWaitGroupAddInGoroutine's depth tracking above.
  const ranges: Array<[number, number]> = [];
  {
    let depth = 0;
    let funcStart = -1;
    let funcDepth = -1;
    lines.forEach((text, i) => {
      if (funcDepth === -1 && FUNC_DECL_RE.test(text)) {
        funcStart = i;
        funcDepth = depth;
      }
      const opens = (text.match(/\{/g) || []).length;
      const closes = (text.match(/\}/g) || []).length;
      depth += opens - closes;
      if (funcDepth !== -1 && depth <= funcDepth) {
        ranges.push([funcStart, i]);
        funcDepth = -1;
        funcStart = -1;
      }
    });
  }

  // Pass 2: within each function, look for the destructive -> acquire -> bail sequence.
  for (const [start, end] of ranges) {
    for (let i = start; i <= end; i++) {
      const destructiveLine = lines[i];
      if (FUNC_DECL_RE.test(destructiveLine)) continue; // a `func stopFoo(...)` definition, not a call
      if (!DESTRUCTIVE_RE.test(destructiveLine)) continue;

      // Find the next fallible two-value acquisition within the window.
      const windowEnd = Math.min(end, i + WINDOW);
      let acquireLine = -1;
      for (let j = i + 1; j <= windowEnd; j++) {
        if (ACQUIRE_RE.test(lines[j])) {
          acquireLine = j;
          break;
        }
      }
      if (acquireLine === -1) continue;

      // Precision guard: if anything between the two looks like it re-acquires
      // or restarts the destroyed thing, this is not the destructive-before-confirm
      // shape — it's an independent (and already safe) teardown+setup.
      let restartSeen = false;
      for (let j = i + 1; j < acquireLine; j++) {
        if (RESTART_RE.test(lines[j])) {
          restartSeen = true;
          break;
        }
      }
      if (restartSeen) continue;

      // The acquisition's error path must bail (return) within a few lines.
      const errCheckEnd = Math.min(end, acquireLine + ERR_CHECK_WINDOW);
      let errCheckLine = -1;
      for (let k = acquireLine; k <= errCheckEnd; k++) {
        if (ERR_CHECK_RE.test(lines[k])) {
          errCheckLine = k;
          break;
        }
      }
      if (errCheckLine === -1) continue;

      let hasReturn = false;
      const bodyEnd = Math.min(end, errCheckLine + ERR_BODY_WINDOW);
      for (let k = errCheckLine; k <= bodyEnd; k++) {
        if (/\breturn\b/.test(lines[k])) {
          hasReturn = true;
          break;
        }
        if (k > errCheckLine && lines[k].trim() === "}") break; // end of the if-block
      }
      if (!hasReturn) continue;

      const destroyMatch = destructiveLine.match(DESTRUCTIVE_CALL_RE);
      const destroyCall = (destroyMatch ? destroyMatch[0] : destructiveLine).trim();
      const acquireMatch = lines[acquireLine].match(ACQUIRE_CALL_RE);
      const acquireCall = (acquireMatch ? acquireMatch[0] : lines[acquireLine]).trim();

      hits.push({
        line: i + 1,
        ruleId: "destructive-before-confirm",
        kind: "unsafe-cutover",
        summary: `destructive '${destroyCall}' runs before the fallible '${acquireCall}' whose failure returns without restoring it — acquire/confirm the replacement before destroying the incumbent`,
        evidenceLine: destructiveLine.trim(),
      });
    }
  }

  return hits;
}

/**
 * R5: leak-on-error-return (crabbox #1099 shape). A resource acquired via a fallible
 * two-value call (`x, err := conn.Dial(...)`, `.Connect/.Open/.Acquire/.New*`,
 * `os.Open*`) whose cleanup IS deferred later in the same function (`defer x.Close()`),
 * but an early/error `return` sits BETWEEN the acquisition and that defer — so the
 * return path leaks the resource before its cleanup is registered.
 *
 * High-precision by construction: it requires a real `defer x.<cleanup>()` to exist
 * (the code demonstrably intends local cleanup of x), and abstains when the only
 * pre-defer return is the acquisition's own `if err != nil { return }` (x is invalid
 * there) or when x is returned to the caller (ownership transfer, where you would not
 * defer-close it locally). The fix point is the acquisition: register the defer
 * immediately after it. Suppressible with `// concurrency-ok:`.
 */
function ruleLeakOnErrorReturn(lines: string[]): RawHit[] {
  const hits: RawHit[] = [];
  const ACQUIRE_RE =
    /\b(\w+)\s*,\s*err\b\s*:?=\s*[\w.]+\.(?:Dial|Connect|Open|Acquire|New\w*|Reserve|Provision)\s*\(/;
  const OSOPEN_RE = /\b(\w+)\s*,\s*err\b\s*:?=\s*os\.(?:Open|OpenFile|Create)\s*\(/;
  const ERR_CHECK_RE = /^\s*if\s+err\s*!=\s*nil\s*\{/;
  const FUNC_DECL_RE = /^\s*func\b/;
  const CLEANUP = "Close|Stop|Release|Cancel|Cleanup|Disconnect|Shutdown|Abort";

  // Function ranges by brace depth (same construction as ruleDestructiveBeforeConfirm)
  // so the acquisition/defer/return windows never bleed across unrelated functions.
  const ranges: Array<[number, number]> = [];
  {
    let depth = 0;
    let funcStart = -1;
    let funcDepth = -1;
    lines.forEach((text, i) => {
      if (funcDepth === -1 && FUNC_DECL_RE.test(text)) {
        funcStart = i;
        funcDepth = depth;
      }
      depth += (text.match(/\{/g) || []).length - (text.match(/\}/g) || []).length;
      if (funcDepth !== -1 && depth <= funcDepth) {
        ranges.push([funcStart, i]);
        funcDepth = -1;
        funcStart = -1;
      }
    });
  }

  for (const [start, end] of ranges) {
    for (let i = start; i <= end; i++) {
      const m = lines[i].match(ACQUIRE_RE) ?? lines[i].match(OSOPEN_RE);
      if (!m) continue;
      const x = m[1];

      // The first `defer x.<cleanup>()` (or `defer x()` for a captured cancel func).
      const deferRe = new RegExp(
        `^\\s*defer\\s+${x}[?]?\\.(?:${CLEANUP})\\w*\\s*\\(|^\\s*defer\\s+${x}\\s*\\(\\s*\\)`,
      );
      let deferLine = -1;
      for (let j = i + 1; j <= end; j++) {
        if (deferRe.test(lines[j])) {
          deferLine = j;
          break;
        }
      }
      if (deferLine === -1) continue; // no local cleanup for x → abstain (fuzzy, leave to the hunt)

      // Ownership transfer → abstain: x itself returned to the caller (a returned value,
      // not merely used as an argument like `return doWork(x)`).
      const returnsX = new RegExp(
        `return\\s+&?\\b${x}\\b(?![.(\\w])|return\\s+[\\w.]+\\s*,\\s*&?\\b${x}\\b(?![.(\\w])`,
      );
      let transferred = false;
      for (let j = i + 1; j <= end; j++) {
        if (returnsX.test(lines[j])) {
          transferred = true;
          break;
        }
      }
      if (transferred) continue;

      // Skip the acquisition's own immediate `if err != nil { ... return ... }` block —
      // on that path x is invalid, so bailing without closing it is correct.
      let scanStart = i + 1;
      if (ERR_CHECK_RE.test(lines[i + 1] ?? "")) {
        let d = 0;
        for (let j = i + 1; j <= end; j++) {
          d += (lines[j].match(/\{/g) || []).length - (lines[j].match(/\}/g) || []).length;
          if (j > i + 1 && d <= 0) {
            scanStart = j + 1;
            break;
          }
        }
      }

      // Any return between the acquisition (past its err-check) and the defer leaks x.
      for (let j = scanStart; j < deferLine; j++) {
        if (/^\s*return\b/.test(lines[j])) {
          hits.push({
            line: i + 1,
            ruleId: "leak-on-error-return",
            kind: "goroutine-leak",
            summary: `'${x}' is acquired here but an early return (line ${j + 1}) bails before its 'defer ${x}.Close()' (line ${deferLine + 1}) is registered — the resource leaks on that path; move the defer to immediately after acquiring '${x}'`,
            evidenceLine: lines[i].trim(),
          });
          break;
        }
      }
    }
  }
  return hits;
}

/**
 * R6: shadowed-retry-state (crabbox #1101). A backoff/attempt/delay counter declared
 * with `:=` INSIDE a retry loop body is re-created every iteration, so the backoff
 * never grows and the code hammers the peer at a fixed interval. Flags a `<name> :=`
 * whose name reads as retry state (attempt/backoff/retr/delay/wait/elapsed) inside a
 * `for` loop body — unless the same name is already declared before the loop (hoisted),
 * in which case the `:=` is a genuine inner scope and there is no reset bug.
 */
function ruleShadowedRetryState(lines: string[]): RawHit[] {
  const hits: RawHit[] = [];
  const RETRY_DECL = /^\s*(\w*(?:attempt|backoff|retr|delay|wait|elapsed)\w*)\s*:=/i;
  const FOR_RE = /^\s*for\b[^;]*\{\s*$/; // `for {`, `for cond {` — not a 3-clause `for i := ...`

  // Brace-matched ranges for each `for` loop.
  const loops: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!FOR_RE.test(lines[i])) continue;
    let depth = 0;
    let started = false;
    for (let j = i; j < lines.length; j++) {
      depth += (lines[j].match(/\{/g) || []).length - (lines[j].match(/\}/g) || []).length;
      if (!started && depth > 0) started = true;
      if (started && depth === 0) {
        loops.push([i, j]);
        break;
      }
    }
  }

  for (const [start, end] of loops) {
    for (let i = start + 1; i < end; i++) {
      const m = lines[i].match(RETRY_DECL);
      if (!m) continue;
      const name = m[1];
      // Only an ACCUMULATOR reset is the bug: the var must be grown later in the loop
      // (`name++`, `name += …`, `name *= …`, `name = …name…`). A derived per-iteration value
      // like `delay := backoffFor(attempt)` is correctly recomputed each pass — abstain.
      const accumulates = new RegExp(
        `\\b${name}\\s*(?:\\+\\+|--|\\+=|-=|\\*=)|\\b${name}\\s*=\\s*[^=][^\\n]*\\b${name}\\b`,
      );
      let grows = false;
      for (let j = i + 1; j < end; j++) {
        if (accumulates.test(lines[j])) {
          grows = true;
          break;
        }
      }
      if (!grows) continue;
      // Abstain if the name is already declared/assigned before the loop (hoisted → the
      // inner `:=` is a legitimately-scoped different variable, not a reset of retry state).
      const declBefore = new RegExp(`\\b${name}\\b\\s*(?::=|=[^=])|\\bvar\\s+${name}\\b`);
      let hoisted = false;
      for (let j = 0; j < start; j++) {
        if (declBefore.test(lines[j])) {
          hoisted = true;
          break;
        }
      }
      if (hoisted) continue;
      hits.push({
        line: i + 1,
        ruleId: "shadowed-retry-state",
        kind: "toctou",
        summary: `retry/backoff state '${name}' is re-declared with ':=' inside the loop — it resets every iteration, so the backoff never grows and the peer is hammered at a fixed interval; hoist '${name}' above the loop`,
        evidenceLine: lines[i].trim(),
      });
    }
  }
  return hits;
}

/**
 * R7: channel-misuse — an UNCONDITIONAL double `close(ch)` of the same channel in one
 * function. Both closes sit at function-body depth, so both run on every path and the
 * second panics. Branch-guarded closes (possibly mutually exclusive) and send-on-closed
 * races are control-flow-dependent → left to the hunt, not this hard-fail lint. Close a
 * channel exactly once (single owner, or `sync.Once`).
 */
function ruleChannelMisuse(lines: string[]): RawHit[] {
  const hits: RawHit[] = [];
  const CLOSE_RE = /\bclose\s*\(\s*([\w.]+)\s*\)/;
  const FUNC_DECL_RE = /^\s*func\b/;

  let depth = 0;
  let funcDepth = -1;
  let bodyCloses = new Map<string, number[]>();
  lines.forEach((text, i) => {
    if (funcDepth === -1 && FUNC_DECL_RE.test(text)) {
      funcDepth = depth;
      bodyCloses = new Map();
    }
    // A close at exactly func-body depth (funcDepth + 1) is unconditional. Checked
    // against `depth` BEFORE applying this line's own braces.
    if (funcDepth !== -1 && depth === funcDepth + 1) {
      const m = text.match(CLOSE_RE);
      if (m) {
        const ch = m[1];
        const arr = bodyCloses.get(ch) ?? [];
        arr.push(i);
        bodyCloses.set(ch, arr);
      }
    }
    depth += (text.match(/\{/g) || []).length - (text.match(/\}/g) || []).length;
    if (funcDepth !== -1 && depth <= funcDepth) {
      for (const [ch, ls] of bodyCloses) {
        if (ls.length >= 2) {
          hits.push({
            line: ls[1] + 1,
            ruleId: "channel-misuse",
            kind: "channel-misuse",
            summary: `channel '${ch}' is unconditionally closed more than once (lines ${ls.map((l) => l + 1).join(", ")}) — the second close panics; close exactly once (a single owner or sync.Once)`,
            evidenceLine: lines[ls[1]].trim(),
          });
        }
      }
      funcDepth = -1;
    }
  });
  return hits;
}

/**
 * R8 (test-only, ADVISORY): flaky timing-based concurrency test (crabbox §10b / #1098, #1102).
 * A concurrency regression test that asserts via a multi-second `time.After` timeout paired with a
 * `runtime.Stack` leak dump is a top CI-flake source — maintainers rewrite these to tight
 * synchronous/barriered assertions (`select { case <-done: default: t.Fatal }`) because the
 * production code already blocks until the goroutine exits. Surfaced for the hunt, NOT hard-fail
 * (it's the contributor's own test).
 */
function ruleFlakyTimingTest(lines: string[]): RawHit[] {
  const hits: RawHit[] = [];
  const joined = lines.join("\n");
  if (!/\bruntime\.Stack\s*\(/.test(joined)) return hits; // only the leak-dump shape
  const AFTER_SECONDS = /\btime\.After\s*\(\s*(?:\d+\s*\*\s*)?time\.Second\b|\btime\.After\s*\([^)]*\.Seconds?\b/;
  lines.forEach((text, i) => {
    if (!AFTER_SECONDS.test(text)) return;
    const near = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 8)).join("\n");
    if (!/\bruntime\.Stack\s*\(/.test(near)) return; // the time.After + stack-dump must co-occur
    hits.push({
      line: i + 1,
      ruleId: "flaky-timing-test",
      kind: "toctou",
      summary:
        "multi-second time.After timeout + runtime.Stack leak-dump is a flaky test shape (a top CI-flake source) — the production code likely already synchronizes; prefer a synchronous/barriered assertion (e.g. `select { case <-done: default: t.Fatal }` or wait on the real completion signal)",
      evidenceLine: text.trim(),
      advisory: true,
    });
  });
  return hits;
}

// Test files get only the advisory test-quality rules; production files get the hard-fail set.
const TEST_RULES = [ruleFlakyTimingTest];

const RULES = [
  ruleTimerWithoutStop,
  ruleRangeOverTickerNoExit,
  ruleWaitGroupAddInGoroutine,
  ruleDestructiveBeforeConfirm,
  ruleLeakOnErrorReturn,
  ruleShadowedRetryState,
  ruleChannelMisuse,
];

/**
 * Lint the touched line ranges of Go files. Only `.go` non-test files are scanned;
 * a hit is emitted only when its line falls inside a touched range. Suppressed
 * hits are retained (source of record) but marked so they do not drive the verdict.
 */
export function lintGo(repoDir: string, touchedRanges: string[]): ConcurrencyDefect[] {
  const defects: ConcurrencyDefect[] = [];
  const byFile = new Map<string, Array<[number, number] | null>>();

  for (const entry of touchedRanges) {
    const { file, start, end } = parseScopeEntry(entry);
    if (!file.endsWith(".go")) continue; // _test.go kept for the advisory test-quality rules
    const list = byFile.get(file) ?? [];
    list.push(start !== undefined && end !== undefined ? [start, end] : null); // null = whole file
    byFile.set(file, list);
  }

  for (const [file, ranges] of byFile) {
    let text: string;
    try {
      text = readFileSync(join(repoDir, file), "utf8");
    } catch {
      continue; // deleted or unreadable — nothing to lint
    }
    const lines = text.split("\n");
    const suppressions = collectSuppressions(lines);
    const wholeFile = ranges.includes(null);
    const inScope = (line: number) =>
      wholeFile ||
      ranges.some((r) => r !== null && line >= r[0] && line <= r[1]);

    const rulesForFile = file.endsWith("_test.go") ? TEST_RULES : RULES;
    for (const rule of rulesForFile) {
      for (const hit of rule(lines)) {
        if (!inScope(hit.line)) continue;
        const suppression = suppressions.get(hit.line);
        defects.push({
          kind: hit.kind,
          source: "static",
          file,
          line: hit.line,
          summary: hit.summary,
          evidence: `[${hit.ruleId}] ${file}:${hit.line}\n    ${hit.evidenceLine}`,
          ruleId: hit.ruleId,
          suppressed: suppression !== undefined,
          suppressionReason: suppression?.reason,
          advisory: hit.advisory || undefined,
        });
      }
    }
  }
  return defects;
}
