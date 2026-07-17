import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { reconcileVerdict } = await import(pathToFileURL(join(ROOT, "dist/runner.js")).href);
const { lintGo } = await import(pathToFileURL(join(ROOT, "dist/lint/go-lint.js")).href);
const { lintSwift } = await import(pathToFileURL(join(ROOT, "dist/lint/swift-lint.js")).href);
const { lintTs } = await import(pathToFileURL(join(ROOT, "dist/lint/ts-lint.js")).href);
const { parseScopeEntry } = await import(pathToFileURL(join(ROOT, "dist/git-changed-files.js")).href);

function exercise(over) {
  return {
    touchedPackages: ["p"],
    exercisedPackages: ["p"],
    unexercisedPackages: [],
    stress: { reps: 20, gomaxprocs: [2, 8] },
    ...over,
  };
}
const live = { checked: true, plantedDefectCaught: true, detail: "" };
const cfg = { tool: "go-race" };

test("reconcile: clean when exercised, live, no defects", () => {
  const r = reconcileVerdict("go-race", [], exercise(), live, null, cfg);
  assert.equal(r.verdict, "clean");
});

test("reconcile: a defect fails even if coverage is thin", () => {
  const d = [{ kind: "data-race", source: "dynamic", file: "a.go", line: 1, summary: "", evidence: "" }];
  const r = reconcileVerdict("go-race", d, exercise({ unexercisedPackages: ["p"] }), live, null, cfg);
  assert.equal(r.verdict, "defect");
});

test("reconcile: suppressed defects do NOT drive the verdict", () => {
  const d = [{ kind: "anti-pattern", source: "static", file: "a.go", line: 1, summary: "", evidence: "", suppressed: true }];
  const r = reconcileVerdict("go-race", d, exercise(), live, null, cfg);
  assert.equal(r.verdict, "clean");
});

test("reconcile: advisory findings (e.g. require-atomic-updates) do NOT hard-fail", () => {
  // The clawrouter dogfood lesson: require-atomic-updates over-fires; it is
  // surfaced for the hunt but must not block the gate.
  const d = [{ kind: "toctou", source: "static", file: "a.ts", line: 9, summary: "", evidence: "", advisory: true }];
  const r = reconcileVerdict("ts-async", d, exercise(), live, null, { ...cfg, tool: "ts-async" });
  assert.equal(r.verdict, "clean");
});

test("reconcile: unexercised touched code is insufficient (fail-closed)", () => {
  const r = reconcileVerdict("go-race", [], exercise({ unexercisedPackages: ["p"] }), live, null, cfg);
  assert.equal(r.verdict, "insufficient");
});

test("reconcile: --allow-unexercised lets the gap pass", () => {
  const r = reconcileVerdict("go-race", [], exercise({ unexercisedPackages: ["p"] }), live, null, { ...cfg, allowUnexercised: true });
  assert.equal(r.verdict, "clean");
});

test("reconcile: GOMAXPROCS pinned to 1 is insufficient (no parallelism)", () => {
  const r = reconcileVerdict("go-race", [], exercise({ stress: { reps: 20, gomaxprocs: [1] } }), live, null, cfg);
  assert.equal(r.verdict, "insufficient");
});

test("reconcile: a lane that missed its planted race is lane-dead", () => {
  const dead = { checked: true, plantedDefectCaught: false, detail: "missed" };
  const r = reconcileVerdict("go-race", [], exercise(), dead, null, cfg);
  assert.equal(r.verdict, "lane-dead");
});

test("reconcile: exec error outranks everything", () => {
  const r = reconcileVerdict("go-race", [], exercise(), live, "spawn failed", cfg);
  assert.equal(r.verdict, "error");
});

test("parseScopeEntry: file:range and whole-file", () => {
  assert.deepEqual(parseScopeEntry("a/b.go:10-20"), { file: "a/b.go", start: 10, end: 20 });
  assert.deepEqual(parseScopeEntry("a/b.go"), { file: "a/b.go" });
});

// --- lint rules over a scratch repo ---
function withRepo(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "sk-lint-"));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("lint: timer-without-stop fires on a touched line, not off it", () => {
  const src = [
    "package p",
    "import \"time\"",
    "type S struct{ t *time.Ticker }",
    "func New() *S { s := &S{}; s.t = time.NewTicker(time.Second); return s }",
  ].join("\n");
  withRepo({ "s.go": src }, (dir) => {
    const onLine = lintGo(dir, ["s.go:4-4"]);
    assert.equal(onLine.filter((d) => !d.suppressed).length, 1);
    assert.equal(onLine[0].ruleId, "timer-without-stop");
    const offLine = lintGo(dir, ["s.go:1-2"]);
    assert.equal(offLine.length, 0, "hit outside the touched range must not fire");
  });
});

test("lint: // concurrency-ok suppresses the hit", () => {
  const src = [
    "package p",
    "import \"time\"",
    "type S struct{ t *time.Ticker }",
    "func New() *S {",
    "  s := &S{}",
    "  // concurrency-ok: stopped in Close()",
    "  s.t = time.NewTicker(time.Second)",
    "  return s",
    "}",
  ].join("\n");
  withRepo({ "s.go": src }, (dir) => {
    const hits = lintGo(dir, ["s.go:1-9"]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].suppressed, true);
    assert.match(hits[0].suppressionReason, /Close/);
  });
});

test("lint: a stopped ticker is not flagged", () => {
  const src = [
    "package p",
    "import \"time\"",
    "type S struct{ t *time.Ticker }",
    "func New() *S { s := &S{}; s.t = time.NewTicker(time.Second); return s }",
    "func (s *S) Close() { s.t.Stop() }",
  ].join("\n");
  withRepo({ "s.go": src }, (dir) => {
    assert.equal(lintGo(dir, ["s.go:1-5"]).length, 0);
  });
});

test("lint: range-over-ticker with no exit fires", () => {
  const src = [
    "package p",
    "import \"time\"",
    "func run(t *time.Ticker) {",
    "  for range t.C {",
    "    println(\"tick\")",
    "  }",
    "}",
  ].join("\n");
  withRepo({ "r.go": src }, (dir) => {
    const hits = lintGo(dir, ["r.go:4-4"]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].ruleId, "range-over-ticker-no-exit");
  });
});

// --- destructive-before-confirm cutover (crabbox #1103 bug class) ---

test("lint: destructive-before-confirm fires on the #1103 shape (stop daemon, then fallible ticket create, then bail)", () => {
  const src = [
    "package cli",
    "",
    "func (a *App) egressStart(daemon *bool, leaseID string) error {",
    "  if *daemon {",
    "    a.stopEgressHostDaemonLocked(leaseID)",
    "  }",
    "  clientTicket, err := coord.CreateEgressTicket(ctx, leaseID, \"client\")",
    "  if err != nil {",
    "    return err",
    "  }",
    "  _ = clientTicket",
    "  return nil",
    "}",
  ].join("\n");
  withRepo({ "egress.go": src }, (dir) => {
    const hits = lintGo(dir, ["egress.go"]).filter((d) => !d.suppressed);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].ruleId, "destructive-before-confirm");
    assert.equal(hits[0].line, 5, "fires at the destructive call's line — that's the fix point");
    assert.match(hits[0].summary, /stopEgressHostDaemonLocked/);
    assert.match(hits[0].summary, /CreateEgressTicket/);
  });
});

// --- leak-on-error-return (crabbox #1099 bug class) ---

test("lint: leak-on-error-return fires on the #1099 shape (bail before the defer-close is registered)", () => {
  const src = [
    "package cli",
    "func fetch(pool *Pool) error {",
    "  client, err := pool.Dial(ctx)",
    "  if err != nil {",
    "    return err",
    "  }",
    "  if err := client.Ping(); err != nil {",
    "    return err",
    "  }",
    "  defer client.Close()",
    "  return nil",
    "}",
  ].join("\n");
  withRepo({ "x.go": src }, (dir) => {
    const hits = lintGo(dir, ["x.go"]).filter((d) => !d.suppressed);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].ruleId, "leak-on-error-return");
    assert.equal(hits[0].line, 3, "fires at the acquisition — the fix point");
    assert.match(hits[0].summary, /client/);
  });
});

test("lint: leak-on-error-return abstains when the defer precedes the fallible return", () => {
  const src = [
    "package cli",
    "func fetch(pool *Pool) error {",
    "  client, err := pool.Dial(ctx)",
    "  if err != nil { return err }",
    "  defer client.Close()",
    "  if err := client.Ping(); err != nil {",
    "    return err",
    "  }",
    "  return nil",
    "}",
  ].join("\n");
  withRepo({ "x.go": src }, (dir) => {
    assert.equal(lintGo(dir, ["x.go"]).filter((d) => !d.suppressed).length, 0);
  });
});

test("lint: leak-on-error-return abstains when only the acquisition's own err-check returns", () => {
  const src = [
    "package cli",
    "func fetch(pool *Pool) error {",
    "  client, err := pool.Dial(ctx)",
    "  if err != nil {",
    "    return err",
    "  }",
    "  defer client.Close()",
    "  return doWork(client)",
    "}",
  ].join("\n");
  withRepo({ "x.go": src }, (dir) => {
    assert.equal(lintGo(dir, ["x.go"]).filter((d) => !d.suppressed).length, 0);
  });
});

// --- shadowed-retry-state (crabbox #1101 bug class) ---

test("lint: shadowed-retry-state fires on an accumulating backoff counter :='d inside the loop", () => {
  const src = [
    "package cli",
    "func reconnect() {",
    "  for {",
    "    attempt := 0",
    "    delay := backoffFor(attempt)",
    "    time.Sleep(delay)",
    "    attempt++",
    "  }",
    "}",
  ].join("\n");
  withRepo({ "r.go": src }, (dir) => {
    const hits = lintGo(dir, ["r.go"]).filter((d) => d.ruleId === "shadowed-retry-state" && !d.suppressed);
    assert.equal(hits.length, 1, "the accumulating 'attempt' reset fires; the derived 'delay' does not");
    assert.match(hits[0].summary, /attempt/);
  });
});

test("lint: shadowed-retry-state abstains when the counter is hoisted above the loop", () => {
  const src = [
    "package cli",
    "func reconnect() {",
    "  attempt := 0",
    "  for {",
    "    delay := backoffFor(attempt)",
    "    time.Sleep(delay)",
    "    attempt++",
    "  }",
    "}",
  ].join("\n");
  withRepo({ "r.go": src }, (dir) => {
    const hits = lintGo(dir, ["r.go"]).filter((d) => d.ruleId === "shadowed-retry-state" && !d.suppressed);
    assert.equal(hits.length, 0);
  });
});

// --- channel-misuse: unconditional double close (#8) ---

test("lint: channel-misuse fires on an unconditional double close(ch)", () => {
  const src = [
    "package p",
    "func run(done chan int) {",
    "  close(done)",
    "  work()",
    "  close(done)",
    "}",
  ].join("\n");
  withRepo({ "c.go": src }, (dir) => {
    const hits = lintGo(dir, ["c.go"]).filter((d) => d.ruleId === "channel-misuse" && !d.suppressed);
    assert.equal(hits.length, 1);
    assert.match(hits[0].summary, /done/);
  });
});

test("lint: channel-misuse abstains on branch-guarded closes (possibly exclusive)", () => {
  const src = [
    "package p",
    "func run(done chan int, ok bool) {",
    "  if ok {",
    "    close(done)",
    "  } else {",
    "    close(done)",
    "  }",
    "}",
  ].join("\n");
  withRepo({ "c.go": src }, (dir) => {
    const hits = lintGo(dir, ["c.go"]).filter((d) => d.ruleId === "channel-misuse" && !d.suppressed);
    assert.equal(hits.length, 0);
  });
});

test("lint: destructive-before-confirm does NOT fire on the safe order (acquire first, destroy after)", () => {
  // steipete's actual fix: create the ticket first, only stop the old daemon
  // once the replacement is confirmed obtainable.
  const src = [
    "package cli",
    "",
    "func (a *App) egressStart(daemon *bool, leaseID string) error {",
    "  clientTicket, err := coord.CreateEgressTicket(ctx, leaseID, \"client\")",
    "  if err != nil {",
    "    return err",
    "  }",
    "  if *daemon {",
    "    a.stopEgressHostDaemonLocked(leaseID)",
    "  }",
    "  _ = clientTicket",
    "  return nil",
    "}",
  ].join("\n");
  withRepo({ "egress.go": src }, (dir) => {
    assert.equal(lintGo(dir, ["egress.go"]).length, 0);
  });
});

test("lint: destructive-before-confirm does NOT fire when the destroyed thing is re-created before the error path (precision)", () => {
  const src = [
    "package cli",
    "",
    "func (a *App) rotate(leaseID string) error {",
    "  a.stopEgressHostDaemonLocked(leaseID)",
    "  a.startEgressHostDaemonLocked(leaseID)",
    "  ticket, err := coord.CreateEgressTicket(ctx, leaseID, \"client\")",
    "  if err != nil {",
    "    return err",
    "  }",
    "  _ = ticket",
    "  return nil",
    "}",
  ].join("\n");
  withRepo({ "rotate.go": src }, (dir) => {
    assert.equal(lintGo(dir, ["rotate.go"]).length, 0, "independent teardown+setup must not fire");
  });
});

test("lint: // concurrency-ok suppresses a destructive-before-confirm hit", () => {
  const src = [
    "package cli",
    "",
    "func (a *App) egressStart(daemon *bool, leaseID string) error {",
    "  if *daemon {",
    "    // concurrency-ok: daemon restart is externally supervised, ticket retried",
    "    a.stopEgressHostDaemonLocked(leaseID)",
    "  }",
    "  clientTicket, err := coord.CreateEgressTicket(ctx, leaseID, \"client\")",
    "  if err != nil {",
    "    return err",
    "  }",
    "  _ = clientTicket",
    "  return nil",
    "}",
  ].join("\n");
  withRepo({ "egress.go": src }, (dir) => {
    const hits = lintGo(dir, ["egress.go"]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].ruleId, "destructive-before-confirm");
    assert.equal(hits[0].suppressed, true);
    assert.match(hits[0].suppressionReason, /externally supervised/);
  });
});

// --- Swift lint (precision fix found by dogfooding on steipete/CodexBar) ---

test("swift lint: a self-property timer never cancelled fires", () => {
  const src = [
    "final class Poller {",
    "  private var source: DispatchSourceTimer?",
    "  func start() {",
    "    self.source = DispatchSource.makeTimerSource(queue: .main)",
    "    self.source?.resume()",
    "  }",
    "}",
  ].join("\n");
  withRepo({ "p.swift": src }, (dir) => {
    const hits = lintSwift(dir, ["p.swift"]).filter((d) => !d.suppressed);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].ruleId, "dispatchsource-timer-never-cancelled");
  });
});

test("swift lint: a local timer that escapes into a box does NOT fire (CodexBar pattern)", () => {
  // Reproduces SubprocessRunner.swift: the timer is a local `let`, wrapped into a
  // box that is cancelled elsewhere — its lifecycle is owned by the receiver, so
  // flagging it would be a false positive on a hard-fail rule.
  const src = [
    "func makeTimer() -> TimeoutTimer {",
    "  let timeoutTimer = DispatchSource.makeTimerSource(queue: q)",
    "  timeoutTimer.schedule(deadline: .now() + 1)",
    "  timeoutTimer.resume()",
    "  return TimeoutTimer(timer: timeoutTimer)",
    "}",
  ].join("\n");
  withRepo({ "s.swift": src }, (dir) => {
    assert.equal(lintSwift(dir, ["s.swift"]).length, 0, "escaping local must not fire");
  });
});

test("swift lint: a self-property timer that IS invalidated does not fire", () => {
  const src = [
    "final class P {",
    "  var t: Timer?",
    "  func go() { self.t = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in } }",
    "  func stop() { self.t?.invalidate() }",
    "}",
  ].join("\n");
  withRepo({ "t.swift": src }, (dir) => {
    assert.equal(lintSwift(dir, ["t.swift"]).length, 0);
  });
});

// --- TS/JS async-safety lint (custom leak rules; ESLint rules covered by the lane validator) ---

test("ts lint: a field setInterval never cleared fires", () => {
  const src = [
    "class Poller {",
    "  start() { this.h = setInterval(() => {}, 1000); }",
    "}",
  ].join("\n");
  withRepo({ "p.js": src }, (dir) => {
    const hits = lintTs(dir, ["p.js"]).filter((d) => !d.suppressed);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].ruleId, "interval-never-cleared");
  });
});

test("ts lint: a field setInterval that IS cleared does not fire", () => {
  const src = [
    "class Poller {",
    "  start() { this.h = setInterval(() => {}, 1000); }",
    "  stop() { clearInterval(this.h); }",
    "}",
  ].join("\n");
  withRepo({ "p.js": src }, (dir) => {
    assert.equal(lintTs(dir, ["p.js"]).length, 0);
  });
});

test("ts lint: // concurrency-ok suppresses a TS leak hit", () => {
  const src = [
    "class Poller {",
    "  start() {",
    "    // concurrency-ok: cleared by the DI container on dispose",
    "    this.h = setInterval(() => {}, 1000);",
    "  }",
    "}",
  ].join("\n");
  withRepo({ "p.js": src }, (dir) => {
    const hits = lintTs(dir, ["p.js"]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].suppressed, true);
  });
});

test("ts lint: test files are not scanned", () => {
  const src = "class Poller { start() { this.h = setInterval(() => {}, 1000); } }";
  withRepo({ "p.test.js": src }, (dir) => {
    assert.equal(lintTs(dir, ["p.test.js"]).length, 0);
  });
});

// Precision fixes found dogfooding openclaw (6/6 hard-fail hits were false positives).
test("ts lint: a setInterval field cleared via clearTimeout is not flagged (Node aliases them)", () => {
  const src = [
    "class P {",
    "  private t;",
    "  start() { this.t = setInterval(() => {}, 1000); }",
    "  stop() { clearTimeout(this.t); }",
    "}",
  ].join("\n");
  withRepo({ "p.ts": src }, (dir) => {
    assert.equal(lintTs(dir, ["p.ts"]).length, 0);
  });
});

test("ts lint: a protected timer field never cleared is advisory, not hard-fail", () => {
  const src = [
    "class P {",
    "  protected t;",
    "  start() { this.t = setInterval(() => {}, 1000); }",
    "}",
  ].join("\n");
  withRepo({ "p.ts": src }, (dir) => {
    const hits = lintTs(dir, ["p.ts"]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].advisory, true, "protected field can be torn down cross-file → advisory");
  });
});

test("ts lint: process-lifecycle singleton listeners are not flagged", () => {
  const src = [
    "class App {",
    "  init() {",
    "    process.on('uncaughtException', () => {});",
    "    process.on('SIGTERM', () => {});",
    "  }",
    "}",
  ].join("\n");
  withRepo({ "a.ts": src }, (dir) => {
    assert.equal(lintTs(dir, ["a.ts"]).length, 0);
  });
});

test("ts lint: a listener pattern inside a string literal (codegen) is not flagged", () => {
  const src = [
    "class G {",
    "  build() {",
    "    return [",
    "      \"process.on('customEvent', () => {})\",",
    "    ];",
    "  }",
    "}",
  ].join("\n");
  withRepo({ "g.ts": src }, (dir) => {
    assert.equal(lintTs(dir, ["g.ts"]).length, 0);
  });
});

// Regression for the path-reconciliation bug found dogfooding on clawsweeper:
// eslint returns absolute (/private-symlinked on macOS) paths, and the merge
// dropped every finding when they didn't string-match the relative input key.
// This drives the REAL type-aware eslint engine end to end, so it also guards the
// no-floating-promises rule that was never otherwise validated.
test("ts lint: type-aware no-floating-promises is caught end-to-end", () => {
  const tsconfig = JSON.stringify({
    compilerOptions: { strict: true, module: "nodenext", moduleResolution: "nodenext" },
    include: ["*.ts"],
  });
  const src = "export async function f(): Promise<number> { return 1; }\nexport function g(): void { f(); }\n";
  withRepo({ "tsconfig.json": tsconfig, "x.ts": src }, (dir) => {
    const hits = lintTs(dir, ["x.ts"]).filter((d) => !d.suppressed);
    assert.equal(hits.length, 1, "the floating promise must be caught through the real engine");
    assert.match(hits[0].ruleId, /no-floating-promises/);
    assert.equal(hits[0].line, 2);
  });
});

// --- unsafe-cutover ports (#3): Swift try + TS await ---

test("swift lint: unsafe-cutover fires on teardown before a fallible try-acquire", () => {
  const src = [
    "func cutover() throws {",
    "  self.timer.invalidate()",
    "  let fresh = try makeConnection()",
    "  self.conn = fresh",
    "}",
  ].join("\n");
  withRepo({ "c.swift": src }, (dir) => {
    const hits = lintSwift(dir, ["c.swift"]).filter((d) => d.ruleId === "destructive-before-confirm" && !d.suppressed);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].kind, "unsafe-cutover");
  });
});

test("swift lint: unsafe-cutover abstains when the thing is re-created between teardown and acquire", () => {
  const src = [
    "func cutover() throws {",
    "  self.old.stop()",
    "  self.old = restartOld()",
    "  let fresh = try makeThing()",
    "}",
  ].join("\n");
  withRepo({ "c.swift": src }, (dir) => {
    const hits = lintSwift(dir, ["c.swift"]).filter((d) => d.ruleId === "destructive-before-confirm" && !d.suppressed);
    assert.equal(hits.length, 0);
  });
});

test("ts lint: unsafe-cutover fires on teardown before an awaited acquire", () => {
  const src = [
    "async function cutover() {",
    "  this.socket.close()",
    "  const fresh = await dialUpstream()",
    "  this.socket = fresh",
    "}",
  ].join("\n");
  withRepo({ "c.ts": src }, (dir) => {
    const hits = lintTs(dir, ["c.ts"]).filter((d) => d.ruleId === "destructive-before-confirm" && !d.suppressed);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].kind, "unsafe-cutover");
  });
});

test("ts lint: unsafe-cutover abstains when the failure path restores", () => {
  const src = [
    "async function cutover() {",
    "  this.session.destroy()",
    "  const fresh = await acquire()",
    "  if (!fresh) { await reconnect() }",
    "}",
  ].join("\n");
  withRepo({ "c.ts": src }, (dir) => {
    const hits = lintTs(dir, ["c.ts"]).filter((d) => d.ruleId === "destructive-before-confirm" && !d.suppressed);
    assert.equal(hits.length, 0);
  });
});

// --- flaky-timing-test advisory lint (#5) ---

test("lint: flaky-timing-test flags the multi-second time.After + runtime.Stack shape (advisory)", () => {
  const src = [
    "package p",
    "import (\"testing\"; \"time\"; \"runtime\")",
    "func TestLeak(t *testing.T) {",
    "  done := make(chan struct{})",
    "  go func() { work(); close(done) }()",
    "  select {",
    "  case <-done:",
    "  case <-time.After(3 * time.Second):",
    "    buf := make([]byte, 1<<16)",
    "    runtime.Stack(buf, true)",
    "    t.Fatalf(\"leak: %s\", buf)",
    "  }",
    "}",
  ].join("\n");
  withRepo({ "x_test.go": src }, (dir) => {
    const hits = lintGo(dir, ["x_test.go"]).filter((d) => d.ruleId === "flaky-timing-test");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].advisory, true);
  });
});

test("lint: flaky-timing-test is silent on a synchronous test (no runtime.Stack)", () => {
  const src = [
    "package p",
    "import \"testing\"",
    "func TestSync(t *testing.T) {",
    "  done := make(chan struct{})",
    "  go func() { work(); close(done) }()",
    "  select { case <-done: default: t.Fatal(\"leak\") }",
    "}",
  ].join("\n");
  withRepo({ "x_test.go": src }, (dir) => {
    const hits = lintGo(dir, ["x_test.go"]).filter((d) => d.ruleId === "flaky-timing-test");
    assert.equal(hits.length, 0);
  });
});

// --- unsafe-cutover precision + single-value (#2) ---

test("lint: unsafe-cutover abstains on UNRELATED teardown+setup (no shared resource)", () => {
  const src = [
    "package cli",
    "func f(tmp *os.File, addr string) error {",
    "  tmp.Close()",
    "  c, err := net.Dial(\"tcp\", addr)",
    "  if err != nil {",
    "    return err",
    "  }",
    "  _ = c",
    "  return nil",
    "}",
  ].join("\n");
  withRepo({ "u.go": src }, (dir) => {
    const hits = lintGo(dir, ["u.go"]).filter((d) => d.ruleId === "destructive-before-confirm" && !d.suppressed);
    assert.equal(hits.length, 0, "closing tmp is unrelated to dialing c");
  });
});

test("lint: unsafe-cutover fires on a single-value acquisition sharing the resource (err := ...Start)", () => {
  const src = [
    "package cli",
    "func (a *App) restartEgress(leaseID string) error {",
    "  a.stopEgress(leaseID)",
    "  err := a.ProvisionEgress(leaseID)",
    "  if err != nil {",
    "    return err",
    "  }",
    "  return nil",
    "}",
  ].join("\n");
  withRepo({ "s.go": src }, (dir) => {
    const hits = lintGo(dir, ["s.go"]).filter((d) => d.ruleId === "destructive-before-confirm" && !d.suppressed);
    assert.equal(hits.length, 1, "stopEgress then single-value startEgress, both on leaseID");
  });
});

// --- suppression-rot audit (#13) ---

test("lint: suppression-rot flags a reasonless // concurrency-ok pragma", () => {
  const src = [
    "package p",
    "import \"time\"",
    "type S struct{ t *time.Ticker }",
    "func New() *S {",
    "  s := &S{}",
    "  // concurrency-ok:",
    "  s.t = time.NewTicker(time.Second)",
    "  return s",
    "}",
  ].join("\n");
  withRepo({ "s.go": src }, (dir) => {
    const hits = lintGo(dir, ["s.go"]).filter((d) => d.ruleId === "reasonless-suppression");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].advisory, true);
  });
});

test("lint: suppression-rot flags a dangling // concurrency-ok that suppresses nothing", () => {
  const src = [
    "package p",
    "func f() {",
    "  // concurrency-ok: guards nothing now",
    "  doSomethingSafe()",
    "}",
  ].join("\n");
  withRepo({ "s.go": src }, (dir) => {
    const hits = lintGo(dir, ["s.go"]).filter((d) => d.ruleId === "stale-suppression");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].advisory, true);
  });
});

test("lint: suppression-rot silent on a pragma that actually suppresses a hit", () => {
  const src = [
    "package p",
    "import \"time\"",
    "type S struct{ t *time.Ticker }",
    "func New() *S {",
    "  s := &S{}",
    "  // concurrency-ok: stopped in Close()",
    "  s.t = time.NewTicker(time.Second)",
    "  return s",
    "}",
  ].join("\n");
  withRepo({ "s.go": src }, (dir) => {
    const rot = lintGo(dir, ["s.go"]).filter((d) => d.ruleId === "reasonless-suppression" || d.ruleId === "stale-suppression");
    assert.equal(rot.length, 0, "the pragma suppresses the timer-without-stop hit → not stale");
  });
});
