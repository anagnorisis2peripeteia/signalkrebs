// PLANTED dynamic leak: the test passes, but the started Poller keeps an
// interval alive so the process never drains its event loop — the probe must
// report drained=false with an active Timeout when the timeout reaps it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Poller, getOrFetch } from "../src/cache.js";

test("poller starts (and leaks its interval)", () => {
  const p = new Poller();
  p.start();
  assert.ok(p);
});

test("getOrFetch fetches", async () => {
  const v = await getOrFetch("k", async () => 42);
  assert.equal(v, 42);
});
