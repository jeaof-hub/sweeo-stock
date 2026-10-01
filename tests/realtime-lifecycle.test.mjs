import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const lifecycleSource = fs.readFileSync(new URL("../realtime-lifecycle.js", import.meta.url), "utf8");
const appSource = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const context = { AbortController, DOMException, Error, Promise, setTimeout, clearTimeout };
context.globalThis = context;
vm.runInNewContext(lifecycleSource, context);
const { createReloadCoordinator, reconnectDelay } = context.SWEEO_REALTIME_LIFECYCLE;

test("reload requests received during a load coalesce into one immediate follow-up", async () => {
  let releaseFirst;
  const first = new Promise(resolve => { releaseFirst = resolve; });
  let calls = 0, successes = 0;
  const coordinator = createReloadCoordinator({
    timeoutMs: 1000,
    task: async () => { calls++; if (calls === 1) await first; },
    onSuccess: () => { successes++; }
  });
  const running = coordinator.request();
  await Promise.resolve();
  coordinator.request();
  coordinator.request();
  assert.equal(coordinator.dirty, true);
  releaseFirst();
  await running;
  assert.equal(calls, 2);
  assert.equal(successes, 2);
  assert.equal(coordinator.loading, false);
});

test("a stuck request times out, aborts and allows the next reload", async () => {
  let calls = 0, aborted = false, errors = [];
  const coordinator = createReloadCoordinator({
    timeoutMs: 15,
    task: signal => {
      calls++;
      if (calls > 1) return Promise.resolve();
      signal.addEventListener("abort", () => { aborted = true; });
      return new Promise(() => {});
    },
    onError: error => { errors.push(error); }
  });
  await coordinator.request();
  assert.equal(aborted, true);
  assert.equal(errors[0].name, "TimeoutError");
  assert.equal(coordinator.loading, false);
  await coordinator.request();
  assert.equal(calls, 2);
});

test("reconnect uses capped exponential backoff", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 8].map(reconnectDelay), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test("app covers mobile lifecycle, realtime recovery, token refresh and approver polling", () => {
  for (const event of ["visibilitychange", "pageshow", "focus", "online", "offline"]) assert.ok(appSource.includes(`\"${event}\"`), `missing ${event}`);
  for (const status of ["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT", "CLOSED"]) assert.ok(appSource.includes(`\"${status}\"`), `missing ${status}`);
  assert.match(appSource, /sb\.realtime\.setAuth\(s\.access_token\)/);
  assert.match(appSource, /setInterval\([^]*60000\)/);
  assert.match(appSource, /\["admin", "owner", "founder"\]\.includes\(currentRole\)/);
  assert.match(appSource, /abortSignal/);
});
