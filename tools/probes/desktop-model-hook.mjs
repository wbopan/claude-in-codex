/**
 * Research-only, main-process memory hook. Serialize this function into an
 * already attached inspector. It adds a synthetic catalogue entry, not a model
 * implementation. Nothing is written to the installed application or config.
 */
export function installDesktopModelHook({ leaseMs = 15_000, onDetach } = {}) {
  const key = "__codexhostModelHookProbeV1";
  if (globalThis[key]) throw new Error("Model hook probe is already attached");
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 60_000) {
    throw new Error("Expected a lease between 1 and 60 seconds");
  }
  if (onDetach !== undefined && typeof onDetach !== "function") {
    throw new Error("Expected an optional renderer cleanup callback");
  }
  const modules = Object.values(process.mainModule.require("node:module")._cache).filter((module) =>
    /\/\.vite\/build\/src-[^/]+\.js$/.test(module.filename),
  );
  const candidates = [
    ...new Set(modules.flatMap((module) => Object.values(module.exports))),
  ].filter(
    (value) =>
      typeof value === "function" &&
      typeof value.prototype?.routeResponse === "function" &&
      typeof value.prototype?.listModels === "function" &&
      typeof value.prototype?.getPendingRequestCount === "function",
  );
  if (candidates.length !== 1) throw new Error("Unsupported Desktop connection shape");
  const prototype = candidates[0].prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, "routeResponse");
  if (!original?.configurable || typeof original.value !== "function") {
    throw new Error("Desktop response method cannot be reversibly wrapped");
  }
  const modelId = "codexhost-hook-probe";
  let deadline = Date.now() + leaseMs;
  let active = true;
  let rewritten = 0;
  let observed = 0;
  let reason = null;
  let restored = false;
  let cleanupFinished = false;
  let cleanupError = null;
  let cleanup = Promise.resolve();
  let timer;
  const snapshot = () => ({
    active,
    modelId,
    rewritten,
    observed,
    reason,
    restored,
    cleanupFinished,
    cleanupError,
  });
  function detach(why = "explicit") {
    if (!active) return snapshot();
    active = false;
    reason = why;
    clearInterval(timer);
    // Never overwrite a wrapper installed by another component after ours.
    if (Object.getOwnPropertyDescriptor(prototype, "routeResponse")?.value === wrapper) {
      Object.defineProperty(prototype, "routeResponse", original);
      restored = true;
    }
    if (globalThis[key] === handle) delete globalThis[key];
    cleanup = Promise.resolve()
      .then(() => onDetach?.())
      .then(
        () => {
          cleanupFinished = true;
        },
        (error) => {
          cleanupError = String(error);
          cleanupFinished = true;
        },
      );
    return snapshot();
  }
  function wrapper(response, ...rest) {
    observed += 1;
    if (active && Date.now() >= deadline) detach("lease-expired");
    let outgoing = response;
    try {
      if (active && this.hostId === "local" && response && !response.error) {
        // Use Desktop's own pending-request tables, so renderer and internal
        // catalogue requests both take the exact same response path.
        const requestId = String(response.id);
        const method =
          this.clientRequestQueue?.getResponseMethod(requestId) ??
          this.internalResponseHandlers?.get(requestId)?.method;
        const models = response.result?.data;
        if (
          method === "model/list" &&
          Array.isArray(models) &&
          models.length > 0 &&
          !models.some((model) => model.id === modelId)
        ) {
          const template = models[0];
          outgoing = {
            ...response,
            result: {
              ...response.result,
              data: [
                ...models,
                {
                  ...template,
                  id: modelId,
                  model: modelId,
                  displayName: "Hook Probe (temporary)",
                  description: "Temporary research entry. No model is connected.",
                  availabilityNux: null,
                  upgrade: null,
                  upgradeInfo: null,
                  isDefault: false,
                  hidden: false,
                },
              ],
            },
          };
          rewritten += 1;
        }
      }
    } catch {
      detach("incompatible-response-shape");
      outgoing = response;
    }
    return Reflect.apply(original.value, this, [outgoing, ...rest]);
  }
  const handle = {
    status: snapshot,
    heartbeat() {
      if (!active) throw new Error("Model hook probe is detached");
      deadline = Date.now() + leaseMs;
      return snapshot();
    },
    detach,
    async settled() {
      await cleanup;
      return snapshot();
    },
  };
  Object.defineProperty(prototype, "routeResponse", { ...original, value: wrapper });
  Object.defineProperty(globalThis, key, { configurable: true, value: handle });
  timer = setInterval(
    () => {
      if (Date.now() >= deadline) detach("lease-expired");
    },
    Math.min(500, leaseMs),
  );
  timer.unref?.();
  return snapshot();
}
