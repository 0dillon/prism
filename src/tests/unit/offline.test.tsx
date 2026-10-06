// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { renderHook, waitFor } from "@testing-library/react";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOfflineReady } from "@/app/demo/offline";

afterEach(() => vi.unstubAllGlobals());

describe("useOfflineReady", () => {
  it("is unsupported where service workers are not available", () => {
    vi.stubGlobal("navigator", {});
    const { result } = renderHook(() => useOfflineReady({ register: true, warm: async () => {} }));
    expect(result.current).toBe("unsupported");
  });

  it("is unsupported when it is not asked to register, as in development", () => {
    vi.stubGlobal("navigator", { serviceWorker: { register: vi.fn(), ready: Promise.resolve() } });
    const { result } = renderHook(() => useOfflineReady({ register: false }));
    expect(result.current).toBe("unsupported");
  });

  it("registers the worker, loads every layout, then says it is ready", async () => {
    const register = vi.fn(async () => ({}));
    vi.stubGlobal("navigator", { serviceWorker: { register, ready: Promise.resolve({}) } });
    const warm = vi.fn(async () => {});
    const { result } = renderHook(() => useOfflineReady({ register: true, warm }));
    expect(result.current).toBe("preparing");
    await waitFor(() => expect(result.current).toBe("ready"));
    expect(register).toHaveBeenCalledWith("/sw.js");
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("stays preparing, without an error, if registration fails", async () => {
    vi.stubGlobal("navigator", {
      serviceWorker: {
        register: async () => {
          throw new Error("blocked");
        },
        ready: new Promise(() => {}),
      },
    });
    const { result } = renderHook(() => useOfflineReady({ register: true, warm: async () => {} }));
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current).toBe("preparing");
  });

  it("stays preparing if a layout cannot be loaded", async () => {
    vi.stubGlobal("navigator", {
      serviceWorker: { register: async () => ({}), ready: Promise.resolve({}) },
    });
    const { result } = renderHook(() =>
      useOfflineReady({
        register: true,
        warm: async () => {
          throw new Error("offline");
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current).toBe("preparing");
  });
});

/** Runs public/sw.js against fake caches and records what it does. */
function loadWorker() {
  const store = new Map<string, Response>();
  const handlers: Record<string, (event: unknown) => void> = {};
  const cache = {
    add: async (path: string) => void store.set(path, new Response("shell")),
    put: async (key: string | Request, value: Response) =>
      void store.set(typeof key === "string" ? key : new URL(key.url).pathname, value),
  };
  const match = async (key: string | Request) =>
    store.get(typeof key === "string" ? key : new URL(key.url).pathname);
  let online = true;
  const network: string[] = [];
  const fetchFn = async (request: Request) => {
    network.push(new URL(request.url).pathname);
    if (!online) throw new TypeError("offline");
    return new Response(`from network: ${new URL(request.url).pathname}`);
  };
  const self = {
    location: { origin: "https://prism.test" },
    addEventListener: (type: string, fn: (e: unknown) => void) => void (handlers[type] = fn),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  const context = vm.createContext({
    self,
    caches: {
      open: async () => cache,
      match,
      keys: async () => ["prism-demo-v1", "old-cache"],
      delete: async (name: string) => void store.set(`deleted:${name}`, new Response("")),
    },
    fetch: fetchFn,
    URL,
    Request,
    Response,
    Promise,
  });
  vm.runInContext(readFileSync("public/sw.js", "utf8"), context);

  const request = (path: string, init: { method?: string; mode?: string } = {}) => {
    const r = new Request(`https://prism.test${path}`, { method: init.method ?? "GET" });
    Object.defineProperty(r, "mode", { value: init.mode ?? "no-cors" });
    return r;
  };
  /** Dispatches a fetch and returns the response, or "ignored" if the worker did not respond. */
  const fetchEvent = async (req: Request) => {
    let responded: Promise<Response> | undefined;
    handlers.fetch({ request: req, respondWith: (p: Promise<Response>) => void (responded = p) });
    if (!responded) return "ignored" as const;
    const res = await responded;
    await new Promise((r) => setTimeout(r, 0));
    return res.status === 0 ? ("error" as const) : await res.text();
  };
  return { handlers, store, network, setOnline: (v: boolean) => (online = v), request, fetchEvent };
}

describe("public/sw.js", () => {
  it("saves the demo page when it is installed", async () => {
    const w = loadWorker();
    let done: Promise<unknown> | undefined;
    w.handlers.install({ waitUntil: (p: Promise<unknown>) => void (done = p) });
    await done;
    expect(w.store.has("/demo")).toBe(true);
  });

  it("removes older caches when it takes over", async () => {
    const w = loadWorker();
    let done: Promise<unknown> | undefined;
    w.handlers.activate({ waitUntil: (p: Promise<unknown>) => void (done = p) });
    await done;
    expect(w.store.has("deleted:old-cache")).toBe(true);
    expect(w.store.has("deleted:prism-demo-v1")).toBe(false);
  });

  it("serves the demo page from the network when online, and keeps a copy", async () => {
    const w = loadWorker();
    expect(await w.fetchEvent(w.request("/demo", { mode: "navigate" }))).toBe(
      "from network: /demo",
    );
    expect(w.store.has("/demo")).toBe(true);
  });

  it("serves the saved demo page when the network is gone", async () => {
    const w = loadWorker();
    await w.fetchEvent(w.request("/demo", { mode: "navigate" }));
    w.setOnline(false);
    expect(await w.fetchEvent(w.request("/demo", { mode: "navigate" }))).toBe(
      "from network: /demo",
    );
  });

  it("uses a saved script or font first, and saves one the first time it is fetched", async () => {
    const w = loadWorker();
    expect(await w.fetchEvent(w.request("/_next/static/chunks/a.js"))).toBe(
      "from network: /_next/static/chunks/a.js",
    );
    w.network.length = 0;
    w.setOnline(false);
    expect(await w.fetchEvent(w.request("/_next/static/chunks/a.js"))).toBe(
      "from network: /_next/static/chunks/a.js",
    );
    expect(w.network).toEqual([]);
    await w.fetchEvent(w.request("/fonts/lexend.woff2")).catch(() => {});
  });

  it("never touches the API, so no answer from the server is saved", async () => {
    const w = loadWorker();
    expect(await w.fetchEvent(w.request("/api/tutor/turn"))).toBe("ignored");
    expect(await w.fetchEvent(w.request("/api/profile/parse"))).toBe("ignored");
    expect([...w.store.keys()]).toEqual([]);
  });

  it("leaves other pages, other methods and other sites alone", async () => {
    const w = loadWorker();
    expect(await w.fetchEvent(w.request("/learn", { mode: "navigate" }))).toBe("ignored");
    expect(await w.fetchEvent(w.request("/sign-in", { mode: "navigate" }))).toBe("ignored");
    expect(await w.fetchEvent(w.request("/demo", { method: "POST", mode: "navigate" }))).toBe(
      "ignored",
    );
    const other = new Request("https://elsewhere.test/_next/static/x.js");
    let responded = false;
    w.handlers.fetch({ request: other, respondWith: () => (responded = true) });
    expect(responded).toBe(false);
  });

  it("says plainly in its source what it saves, and that it never saves /api", () => {
    const source = readFileSync("public/sw.js", "utf8");
    expect(source).toMatch(/never saves anything under \/api\//);
  });
});
