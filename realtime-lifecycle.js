/* Reload coalescing and reconnect timing shared by the stock app and tests. */
(function (root) {
  "use strict";
  function timeoutError() { const error = new Error("โหลดข้อมูลเกินเวลาที่กำหนด"); error.name = "TimeoutError"; return error; }
  function reconnectDelay(attempt) { return Math.min(30000, 1000 * (2 ** Math.max(0, attempt))); }
  function createReloadCoordinator({ task, timeoutMs = 20000, onSuccess = () => {}, onError = () => {} }) {
    let loading = false, dirty = false, current = Promise.resolve();
    const request = () => {
      dirty = true;
      if (loading) return current;
      loading = true;
      current = (async () => {
        do {
          dirty = false;
          const controller = new AbortController();
          let timer;
          try {
            await Promise.race([
              task(controller.signal),
              new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(timeoutError()); }, timeoutMs); })
            ]);
            await onSuccess();
          } catch (error) {
            await onError(error);
          } finally {
            clearTimeout(timer);
          }
        } while (dirty);
      })().finally(() => { loading = false; });
      return current;
    };
    return { request, get loading() { return loading; }, get dirty() { return dirty; } };
  }
  root.SWEEO_REALTIME_LIFECYCLE = { createReloadCoordinator, reconnectDelay };
})(typeof window === "undefined" ? globalThis : window);
