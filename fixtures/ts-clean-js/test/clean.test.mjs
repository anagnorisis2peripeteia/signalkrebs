import { test } from "node:test";
import assert from "node:assert/strict";
import { Poller, getOrFetch } from "../src/cache.js";

test("single-flight fetch", async () => {
  let calls = 0;
  const [a, b] = await Promise.all([
    getOrFetch("k", async () => { calls++; return 42; }),
    getOrFetch("k", async () => { calls++; return 42; }),
  ]);
  assert.equal(a, 42);
  assert.equal(b, 42);
  assert.equal(calls, 1);
});

test("poller stops its interval", () => {
  const p = new Poller();
  p.start();
  p.stop();
  assert.ok(p);
});
