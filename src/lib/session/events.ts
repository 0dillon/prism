import { ulid } from "ulid";
import { MAX_EVENTS_PER_BATCH, type LearningEvent } from "@/lib/schemas/events";

/**
 * The learning event queue (PRD 5.7, P5-01). Events are raised by the session as the
 * learner works, kept safely on the device, and sent to the server in batches:
 *
 * - `track` gives an event its own id and time, and the layout the learner is using.
 * - A batch goes out every five seconds, when the page is hidden, and when the connection
 *   comes back. Events are also saved on the device, so closing the tab loses nothing.
 * - A failed send is tried again after a growing wait. Only events the server has
 *   acknowledged are removed, and each has a client-made id, so a repeated send can never
 *   count an event twice (the server ignores an id it already has).
 *
 * The server adds the user from the signed-in session, so a client cannot claim to be
 * someone else, and the queue never needs to know who the learner is.
 */

export type Layout = LearningEvent["layout"];

/** An event as it is queued. The server adds the user. */
export type QueuedEvent = Omit<LearningEvent, "userId">;

/** What a caller supplies. The id and time are made here; the layout defaults to the one on screen. */
export type TrackInput = Omit<QueuedEvent, "id" | "occurredAt" | "layout"> & { layout?: Layout };

/** A failed send. `retryable` is false when the server refused the batch itself, so trying again would never help. */
export class SendError extends Error {
  constructor(
    message: string,
    public readonly retryable = true,
  ) {
    super(message);
    this.name = "SendError";
  }
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface EventQueueOptions {
  /** Sends one batch. Resolves when the server has the events; rejects (ideally with SendError) if not. */
  send: (events: QueuedEvent[]) => Promise<void>;
  storage?: KeyValueStore | null;
  storageKey?: string;
  flushIntervalMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** The most events kept waiting. The oldest are dropped beyond it, so a long offline spell cannot fill the device. */
  maxPending?: number;
  maxBatch?: number;
  now?: () => Date;
  isOnline?: () => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const EVENTS_STORAGE_KEY = "prism.events.v1";

export interface EventQueue {
  /** Adds an event. Returns it, with its id and time. */
  track(input: TrackInput): QueuedEvent;
  /** Events waiting to be sent, oldest first. */
  pending(): readonly QueuedEvent[];
  /** Sends what is waiting now. Resolves when the queue is empty or a send has failed. */
  flush(): Promise<void>;
  /** Sets the layout stamped on events that do not name one. */
  setLayout(layout: Layout): void;
  subscribe(listener: (event: QueuedEvent) => void): () => void;
  /** Starts the timer and the page listeners. Returns a function that stops them. */
  start(): () => void;
  /** Forgets everything waiting. For tests, and for signing out. */
  clear(): void;
}

function readStored(storage: KeyValueStore | null, key: string): QueuedEvent[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    // Keep only what looks like an event, so damaged storage cannot poison a batch.
    return parsed.filter(
      (e): e is QueuedEvent =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as QueuedEvent).id === "string" &&
        typeof (e as QueuedEvent).type === "string",
    );
  } catch {
    return [];
  }
}

export function createEventQueue(options: EventQueueOptions): EventQueue {
  const storage = options.storage ?? null;
  const storageKey = options.storageKey ?? EVENTS_STORAGE_KEY;
  const flushIntervalMs = options.flushIntervalMs ?? 5000;
  const backoffBaseMs = options.backoffBaseMs ?? 1000;
  const backoffMaxMs = options.backoffMaxMs ?? 60_000;
  const maxPending = options.maxPending ?? 5000;
  const maxBatch = Math.min(options.maxBatch ?? MAX_EVENTS_PER_BATCH, MAX_EVENTS_PER_BATCH);
  const now = options.now ?? (() => new Date());
  const isOnline =
    options.isOnline ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as number));

  let queue: QueuedEvent[] = readStored(storage, storageKey);
  let layout: Layout = "reader";
  let timer: unknown = null;
  let sending: Promise<void> | null = null;
  let failures = 0;
  // Timers run only once the app has started syncing, so a queue used on its own never sends by itself.
  let started = false;
  const listeners = new Set<(event: QueuedEvent) => void>();

  const save = () => {
    try {
      storage?.setItem(storageKey, JSON.stringify(queue));
    } catch {
      // Storage may be full or blocked; the queue still works in memory.
    }
  };

  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const schedule = (ms: number) => {
    cancelTimer();
    if (!started || queue.length === 0) return;
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, ms);
  };

  /** How long to wait after `failures` failures in a row: 1s, 2s, 4s, and so on up to the cap. */
  const backoff = () => Math.min(backoffBaseMs * 2 ** Math.max(failures - 1, 0), backoffMaxMs);

  async function sendAll(): Promise<void> {
    while (queue.length > 0) {
      if (!isOnline()) {
        // Wait for the connection to come back rather than burning attempts.
        return;
      }
      const batch = queue.slice(0, maxBatch);
      try {
        await options.send(batch);
      } catch (error) {
        if (error instanceof SendError && !error.retryable) {
          // The server refused these events outright. Drop them so they cannot block the rest.
          const refused = new Set(batch.map((e) => e.id));
          queue = queue.filter((e) => !refused.has(e.id));
          save();
          continue;
        }
        failures++;
        schedule(backoff());
        return;
      }
      failures = 0;
      const sent = new Set(batch.map((e) => e.id));
      // Events tracked while the batch was out are kept: only what was sent is removed.
      queue = queue.filter((e) => !sent.has(e.id));
      save();
    }
  }

  function flush(): Promise<void> {
    cancelTimer();
    if (sending) return sending;
    sending = sendAll().finally(() => {
      sending = null;
      // Something arrived while sending, and nothing else has scheduled a send.
      if (queue.length > 0 && timer === null && failures === 0 && isOnline()) {
        schedule(flushIntervalMs);
      }
    });
    return sending;
  }

  const queueApi: EventQueue = {
    track(input) {
      const event: QueuedEvent = {
        ...input,
        layout: input.layout ?? layout,
        id: ulid(),
        occurredAt: now().toISOString(),
      };
      queue.push(event);
      if (queue.length > maxPending) queue = queue.slice(queue.length - maxPending);
      save();
      for (const listener of listeners) listener(event);
      if (timer === null && !sending && failures === 0) schedule(flushIntervalMs);
      return event;
    },

    pending: () => queue,
    flush,

    setLayout(next) {
      layout = next;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    start() {
      if (typeof document === "undefined" || typeof window === "undefined") return () => {};
      started = true;
      const onHidden = () => {
        if (document.visibilityState === "hidden") void flush();
      };
      const onOnline = () => {
        failures = 0;
        void flush();
      };
      const onPageHide = () => void flush();
      document.addEventListener("visibilitychange", onHidden);
      window.addEventListener("pagehide", onPageHide);
      window.addEventListener("online", onOnline);
      // Events saved by an earlier visit are sent soon after this one opens.
      schedule(flushIntervalMs);
      return () => {
        document.removeEventListener("visibilitychange", onHidden);
        window.removeEventListener("pagehide", onPageHide);
        window.removeEventListener("online", onOnline);
        started = false;
        cancelTimer();
      };
    },

    clear() {
      queue = [];
      failures = 0;
      cancelTimer();
      save();
    },
  };
  return queueApi;
}

// ---- The app's queue ---------------------------------------------------------------------

/** Sends a batch to the server. A refused batch is not retried. */
export async function sendToServer(
  events: QueuedEvent[],
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchFn("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events }),
      // Lets the request finish if the page is closing.
      keepalive: true,
    });
  } catch {
    throw new SendError("offline");
  }
  if (response.ok) return;
  // 400 and 413 mean this batch is wrong; trying it again would never help. Everything else
  // (not signed in yet, rate limited, a server error) may pass.
  const retryable = !(
    response.status === 400 ||
    response.status === 413 ||
    response.status === 422
  );
  throw new SendError(`events were not accepted (${response.status})`, retryable);
}

function browserStorage(): KeyValueStore | null {
  try {
    if (typeof window === "undefined") return null;
    const probe = "__prism_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

let appQueue: EventQueue | null = null;

/** The one queue the app uses. Made on first use, so server rendering never touches the browser. */
export function getEventQueue(): EventQueue {
  appQueue ??= createEventQueue({ send: sendToServer, storage: browserStorage() });
  return appQueue;
}

/** For tests: replaces the app's queue. */
export function setEventQueue(queue: EventQueue | null): void {
  appQueue = queue;
}

export function track(input: TrackInput): QueuedEvent {
  return getEventQueue().track(input);
}

export function pendingEvents(): readonly QueuedEvent[] {
  return getEventQueue().pending();
}

export function subscribeToEvents(listener: (event: QueuedEvent) => void): () => void {
  return getEventQueue().subscribe(listener);
}

export function clearEvents(): void {
  getEventQueue().clear();
}
