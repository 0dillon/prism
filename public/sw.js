// Offline support for the public demo (PRD P9-05). The demo's lesson and its simpler
// wordings are written into the page, so once the page and its scripts are saved the demo
// runs with no network at all. Only the "Tell Prism what you need" box and the tutor's free
// questions need a connection.
//
// What this does and does not do:
// - It saves the demo page, the scripts and styles it loads, and the fonts, as they are used.
// - It never saves anything under /api/, so no answer from the server is kept.
// - It leaves every page except /demo alone.

const CACHE = "prism-demo-v1";
const DEMO_PATH = "/demo";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(DEMO_PATH))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

function isStatic(url) {
  return url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/fonts/");
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // The demo page: the network first so it is current, the saved copy when offline.
  if (request.mode === "navigate" && url.pathname === DEMO_PATH) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(DEMO_PATH, copy));
          return response;
        })
        .catch(() => caches.match(DEMO_PATH).then((saved) => saved || Response.error())),
    );
    return;
  }

  // Scripts, styles and fonts never change under the same address, so the saved copy is used first.
  if (isStatic(url)) {
    event.respondWith(
      caches.match(request).then(
        (saved) =>
          saved ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});
