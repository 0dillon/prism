"use client";

import { useEffect, useState } from "react";
import { LAYOUTS, rendererLoaders } from "@/renderers/registry";

/**
 * Makes the demo usable with the network off (PRD P9-05). In production it registers the
 * service worker that saves the page, and it loads all four layouts now, so every layout is
 * saved too and not only the one on screen. It reports when that is done, so the presenter
 * can see the demo is safe before the network goes away.
 */

export type OfflineState = "unsupported" | "preparing" | "ready";

/** The cache the service worker uses (public/sw.js). */
export const OFFLINE_CACHE = "prism-demo-v1";

export async function warmEverything(): Promise<void> {
  await Promise.all(LAYOUTS.map((layout) => rendererLoaders[layout]()));
  await saveLoadedAssets();
}

/**
 * Saves every script, style and font the page has loaded so far. The worker only sees
 * requests made after it took control, so what loaded before that is added here, from the
 * browser's own copy. Nothing from /api/ is ever saved.
 */
export async function saveLoadedAssets(): Promise<void> {
  if (typeof caches === "undefined") return;
  const urls = new Set<string>();
  for (const entry of performance.getEntriesByType("resource")) {
    const path = new URL(entry.name).pathname;
    if (path.startsWith("/_next/static/") || path.startsWith("/fonts/")) urls.add(entry.name);
  }
  const cache = await caches.open(OFFLINE_CACHE);
  await Promise.all([...urls].map((url) => cache.add(url).catch(() => undefined)));
}

export function useOfflineReady(
  options: { register?: boolean; warm?: () => Promise<void> } = {},
): OfflineState {
  const register = options.register ?? process.env.NODE_ENV === "production";
  const warm = options.warm ?? warmEverything;
  const supported = typeof navigator !== "undefined" && "serviceWorker" in navigator;
  const [state, setState] = useState<OfflineState>("preparing");

  useEffect(() => {
    if (!register || !supported) return;
    let cancelled = false;
    (async () => {
      try {
        await navigator.serviceWorker.register("/sw.js");
        await navigator.serviceWorker.ready;
        await warm();
        if (!cancelled) setState("ready");
      } catch {
        // Offline support is an extra. If it cannot start, the demo still works while online.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [register, supported, warm]);

  return register && supported ? state : "unsupported";
}
