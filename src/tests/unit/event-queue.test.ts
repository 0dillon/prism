import { describe, expect, it, vi } from "vitest";
import { LearningEvent } from "@/lib/schemas/events";
import {
  createEventQueue,
  EVENTS_STORAGE_KEY,
  SendError,
  sendToServer,
  type KeyValueStore,
  type QueuedEvent,
  type TrackInput,
} from "@/lib/session/events";

const input: TrackInput = {
  type: "concept_viewed",
  lessonId: "l1",
  graphVersion: 2,
  conceptId: "c1",
};

function memory(initial?: string): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (initial) data.set(EVENTS_STORAGE_KEY, initial);
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

/** Timers the test runs by hand. */
function manualTimers() {
  let next = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id: unknown) => void pending.delete(id as number),
    waits: () => [...pending.values()].map((t) => t.ms),
    count: () => pending.size,
    /** Runs the oldest timer. */
    fire: async () => {
      const [id, timer] = [...pending.entries()][0];
      pending.delete(id);
      timer.fn();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function setup(over: Partial<Parameters<typeof createEventQueue>[0]> = {}) {
  const timers = manualTimers();
  const sent: QueuedEvent[][] = [];
  const send = vi.fn(async (batch: QueuedEvent[]) => {
    sent.push(batch);
  });
  let online = true;
  const queue = createEventQueue({
    send,
    isOnline: () => online,
    now: () => new Date("2026-10-06T10:00:00.000Z"),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...over,
  });
  return { queue, send, sent, timers, setOnline: (v: boolean) => (online = v) };
}

describe("track", () => {
  it("gives each event an id, a time and the layout on screen", () => {
    const { queue } = setup();
    queue.setLayout("cards");
    const a = queue.track(input);
    const b = queue.track(input);
    expect(a.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(a.id).not.toBe(b.id);
    expect(a.occurredAt).toBe("2026-10-06T10:00:00.000Z");
    expect(a.layout).toBe("cards");
    expect(queue.pending()).toEqual([a, b]);
  });

  it("lets an event name its own layout", () => {
    const { queue } = setup();
    queue.setLayout("cards");
    expect(queue.track({ ...input, layout: "visual" }).layout).toBe("visual");
  });

  it("builds events the schema accepts once the server adds the user", () => {
    const { queue } = setup();
    expect(LearningEvent.safeParse({ ...queue.track(input), userId: "u1" }).success).toBe(true);
  });

  it("tells subscribers, until they leave", () => {
    const { queue } = setup();
    const seen: string[] = [];
    const off = queue.subscribe((e) => seen.push(e.type));
    queue.track(input);
    off();
    queue.track(input);
    expect(seen).toEqual(["concept_viewed"]);
  });

  it("does not schedule a send until the app has started syncing", () => {
    const { queue, timers } = setup();
    queue.track(input);
    expect(timers.count()).toBe(0);
  });
});

describe("flush", () => {
  it("sends what is waiting, and removes it once acknowledged", async () => {
    const { queue, sent } = setup();
    const a = queue.track(input);
    const b = queue.track(input);
    await queue.flush();
    expect(sent).toEqual([[a, b]]);
    expect(queue.pending()).toEqual([]);
  });

  it("sends nothing when nothing is waiting", async () => {
    const { queue, send } = setup();
    await queue.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("splits a long queue into batches no larger than the limit", async () => {
    const { queue, sent } = setup({ maxBatch: 3 });
    for (let i = 0; i < 7; i++) queue.track(input);
    await queue.flush();
    expect(sent.map((b) => b.length)).toEqual([3, 3, 1]);
    expect(queue.pending()).toEqual([]);
  });

  it("never sends a batch bigger than the server accepts", async () => {
    const { queue, sent } = setup({ maxBatch: 10_000 });
    for (let i = 0; i < 250; i++) queue.track(input);
    await queue.flush();
    expect(Math.max(...sent.map((b) => b.length))).toBe(200);
  });

  it("keeps events tracked while a batch was out", async () => {
    let release!: () => void;
    let calls = 0;
    const { queue } = setup({
      // The first send waits to be released; any later one succeeds at once.
      send: () =>
        calls++ === 0 ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve(),
    });
    const first = queue.track(input);
    const flushing = queue.flush();
    const late = queue.track(input);
    release();
    await flushing;
    // The late event was not lost by the first acknowledgement: it went out in a second batch.
    expect(calls).toBe(2);
    expect(queue.pending()).toEqual([]);
    expect(first.id).not.toBe(late.id);
  });

  it("runs one send at a time", async () => {
    let calls = 0;
    let release!: () => void;
    const { queue } = setup({
      send: () => {
        calls++;
        return new Promise<void>((resolve) => (release = resolve));
      },
    });
    queue.track(input);
    const a = queue.flush();
    const b = queue.flush();
    release();
    await Promise.all([a, b]);
    expect(calls).toBe(1);
  });
});

describe("failures", () => {
  it("keeps events after a failed send", async () => {
    const { queue } = setup({
      send: async () => {
        throw new SendError("down");
      },
    });
    queue.track(input);
    await queue.flush();
    expect(queue.pending()).toHaveLength(1);
  });
});

describe("with the app started (timers, page events)", () => {
  // Starting syncing needs a document and a window, so run these with a small stand-in.
  function withPage<T>(run: (page: { hide: () => void; online: () => void }) => Promise<T>) {
    const doc = new EventTarget() as EventTarget & { visibilityState: string };
    doc.visibilityState = "visible";
    const win = new EventTarget();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", win);
    return run({
      hide: () => {
        doc.visibilityState = "hidden";
        doc.dispatchEvent(new Event("visibilitychange"));
      },
      online: () => win.dispatchEvent(new Event("online")),
    }).finally(() => vi.unstubAllGlobals());
  }

  it("sends a batch five seconds after the first event", () =>
    withPage(async () => {
      const { queue, timers, sent } = setup();
      const stop = queue.start();
      queue.track(input);
      expect(timers.waits()).toEqual([5000]);
      await timers.fire();
      expect(sent).toHaveLength(1);
      stop();
    }));

  it("sends at once when the page is hidden", () =>
    withPage(async (page) => {
      const { queue, sent } = setup();
      const stop = queue.start();
      queue.track(input);
      page.hide();
      await Promise.resolve();
      await Promise.resolve();
      expect(sent).toHaveLength(1);
      stop();
    }));

  it("retries after 1, 2, 4 seconds and so on, up to a cap, and clears the wait on success", () =>
    withPage(async () => {
      let failures = 0;
      const { queue, timers, sent } = setup({
        send: async (batch) => {
          if (failures < 7) {
            failures++;
            throw new SendError("down");
          }
          sent.push(batch);
        },
        backoffMaxMs: 20_000,
      });
      const stop = queue.start();
      queue.track(input);
      const waits: number[] = [];
      await timers.fire(); // 5s: first try fails
      for (let i = 0; i < 7; i++) {
        waits.push(timers.waits()[0]);
        await timers.fire();
      }
      expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 20000, 20000]);
      expect(queue.pending()).toHaveLength(0);
      expect(sent).toHaveLength(1);
      stop();
    }));

  it("waits while offline instead of using up attempts, and sends when the connection returns, once", () =>
    withPage(async (page) => {
      const { queue, send, sent, setOnline, timers } = setup();
      const stop = queue.start();
      setOnline(false);
      const a = queue.track(input);
      const b = queue.track(input);
      await timers.fire();
      expect(send).not.toHaveBeenCalled();
      expect(queue.pending()).toHaveLength(2);

      setOnline(true);
      page.online();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(sent).toEqual([[a, b]]);
      expect(queue.pending()).toEqual([]);

      page.online();
      await Promise.resolve();
      expect(send).toHaveBeenCalledTimes(1); // nothing is sent twice
      stop();
    }));

  it("sends again after a lost reply with the same ids, so the server can ignore repeats", () =>
    withPage(async () => {
      let lose = true;
      const seen: string[][] = [];
      const { queue, timers } = setup({
        send: async (batch) => {
          seen.push(batch.map((e) => e.id));
          if (lose) {
            lose = false;
            throw new SendError("reply lost");
          }
        },
      });
      const stop = queue.start();
      const event = queue.track(input);
      await timers.fire();
      await timers.fire();
      expect(seen).toEqual([[event.id], [event.id]]);
      expect(queue.pending()).toEqual([]);
      stop();
    }));

  it("stops its timer and listeners when told to", () =>
    withPage(async (page) => {
      const { queue, send, timers } = setup();
      const stop = queue.start();
      queue.track(input);
      stop();
      expect(timers.count()).toBe(0);
      page.hide();
      await Promise.resolve();
      expect(send).not.toHaveBeenCalled();
    }));
});

describe("a batch the server refuses", () => {
  it("is dropped, so it cannot block the events behind it", async () => {
    let first = true;
    const { queue, sent } = setup({
      maxBatch: 1,
      send: async (batch) => {
        if (first) {
          first = false;
          throw new SendError("bad batch", false);
        }
        sent.push(batch);
      },
    });
    queue.track(input);
    const good = queue.track(input);
    await queue.flush();
    expect(sent).toEqual([[good]]);
    expect(queue.pending()).toEqual([]);
  });
});

describe("saving on the device", () => {
  it("saves each event, so closing the tab loses nothing", () => {
    const storage = memory();
    const { queue } = setup({ storage });
    const event = queue.track(input);
    expect(JSON.parse(storage.data.get(EVENTS_STORAGE_KEY)!)).toEqual([event]);
  });

  it("brings saved events back in a new visit, and sends them", async () => {
    const storage = memory();
    const first = setup({ storage });
    const event = first.queue.track(input);
    const second = setup({ storage });
    expect(second.queue.pending()).toEqual([event]);
    await second.queue.flush();
    expect(second.sent).toEqual([[event]]);
    expect(JSON.parse(storage.data.get(EVENTS_STORAGE_KEY)!)).toEqual([]);
  });

  it("ignores damaged storage", () => {
    for (const bad of [
      "{not json",
      "42",
      JSON.stringify([1, "x", null, { id: 5 }]),
      JSON.stringify({ a: 1 }),
    ]) {
      expect(setup({ storage: memory(bad) }).queue.pending()).toEqual([]);
    }
  });

  it("keeps only well-formed saved events", () => {
    const good = {
      id: "e1",
      type: "concept_viewed",
      lessonId: "l",
      graphVersion: 1,
      layout: "reader",
      occurredAt: "x",
    };
    expect(
      setup({ storage: memory(JSON.stringify([good, { nope: true }])) }).queue.pending(),
    ).toEqual([good]);
  });

  it("carries on in memory when storage is full or blocked", async () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    const { queue, sent } = setup({ storage: broken });
    queue.track(input);
    await queue.flush();
    expect(sent).toHaveLength(1);
  });

  it("works with no storage at all", () => {
    const { queue } = setup({ storage: null });
    expect(() => queue.track(input)).not.toThrow();
  });

  it("drops the oldest events beyond the cap, so a long offline spell cannot fill the device", () => {
    const { queue } = setup({ maxPending: 3 });
    const events = [1, 2, 3, 4, 5].map(() => queue.track(input));
    expect(queue.pending()).toEqual(events.slice(2));
  });

  it("can be emptied", () => {
    const storage = memory();
    const { queue } = setup({ storage });
    queue.track(input);
    queue.clear();
    expect(queue.pending()).toEqual([]);
    expect(JSON.parse(storage.data.get(EVENTS_STORAGE_KEY)!)).toEqual([]);
  });
});

describe("sendToServer", () => {
  const events = [{ id: "e1" }] as unknown as QueuedEvent[];
  const reply = (status: number) =>
    vi.fn(async () => new Response("{}", { status })) as unknown as typeof fetch;

  it("posts the batch as JSON, in a request that survives the page closing", async () => {
    const fetchFn = reply(200);
    await sendToServer(events, fetchFn);
    const [url, init] = vi.mocked(fetchFn).mock.calls[0];
    expect(url).toBe("/api/events");
    expect(init).toMatchObject({ method: "POST", keepalive: true });
    expect(JSON.parse(init!.body as string)).toEqual({ events });
  });

  it("treats a refused batch as final, and everything else as worth another try", async () => {
    for (const status of [400, 413, 422]) {
      await expect(sendToServer(events, reply(status))).rejects.toMatchObject({ retryable: false });
    }
    for (const status of [401, 403, 429, 500, 503]) {
      await expect(sendToServer(events, reply(status))).rejects.toMatchObject({ retryable: true });
    }
  });

  it("treats a lost connection as worth another try", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    await expect(sendToServer(events, fetchFn)).rejects.toMatchObject({ retryable: true });
  });
});
