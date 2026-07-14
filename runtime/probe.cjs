// signalkrebs ts-async handle-leak probe. Preloaded into the target's test
// process via NODE_OPTIONS=--require. Records whether the event loop ever
// drained naturally (beforeExit fires only when nothing is keeping it alive)
// and which async resources were still active at exit. A suite whose tests
// finish but whose process never drains is holding leaked handles — the
// event-loop analog of a leaked goroutine.
//
// NODE_OPTIONS propagates to EVERY node process in the tree, including the npm/
// pnpm/yarn wrapper that spawns the test runner. Those wrappers legitimately
// hold a ProcessWrap + stdio PipeWraps while waiting on their child, so they
// always look "leaky" — reporting from them is a false positive. So: skip
// package-manager processes entirely, and write one report PER PID so a later
// process can never clobber an earlier one's verdict.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const outDir = process.env.SIGNALKREBS_PROBE_OUT;
const mainScript = process.argv[1] || "";
const isPackageManager = /(npm-cli\.js|npx-cli\.js|[\\/]npm[\\/]bin|pnpm|yarn|corepack)/i.test(mainScript);

if (outDir && !isPackageManager) {
  let drained = false;
  process.on("beforeExit", () => {
    drained = true;
  });

  const outPath = path.join(outDir, `${process.pid}.json`);
  const report = (signal) => {
    try {
      const active =
        typeof process.getActiveResourcesInfo === "function" ? process.getActiveResourcesInfo() : [];
      fs.writeFileSync(outPath, JSON.stringify({ pid: process.pid, drained, signal: signal || null, active }));
    } catch {
      // never let the probe break the target process
    }
  };

  process.on("exit", () => report(null));
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      report(sig);
      process.exit(199);
    });
  }

  // Orphan self-reaper: when the harness times out it can only kill the direct
  // child (npm / the shell); a leak-hung node grandchild would outlive the run
  // forever. Detect re-parenting to init (ppid 1) and exit, reporting the live
  // handles — the best possible leak evidence. unref()ed so it never keeps a
  // healthy loop alive itself.
  const reaper = setInterval(() => {
    if (process.ppid === 1) {
      report("orphaned");
      process.exit(198);
    }
  }, 2000);
  if (typeof reaper.unref === "function") reaper.unref();
}
