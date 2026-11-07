/*
 * Local Music service worker — app-shell precache only.
 * Audio files are never cached here (they live in IndexedDB handles/blobs or
 * are read straight from disk). The precache manifest is injected at build
 * time by scripts/build-sw.mjs; in dev this file is not registered.
 */

const APP_SHELL_CACHE = "local-music-shell-v__BUILD_HASH__";
const PRECACHE_URLS = []; // @precache-inject@

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(APP_SHELL_CACHE);
      await cache.addAll(["/", ...PRECACHE_URLS]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith("local-music-shell-") && key !== APP_SHELL_CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never touch other origins
  if (url.protocol === "blob:") return; // audio object URLs — never cached

  // Navigations: network first (picks up new builds), cache fallback offline.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(APP_SHELL_CACHE);
          cache.put("/", fresh.clone());
          return fresh;
        } catch {
          const cached = await caches.match("/");
          return (
            cached ??
            new Response("<h1>Offline</h1><p>The app shell has not been cached yet. Reconnect once, then retry.</p>", {
              headers: { "Content-Type": "text/html" },
              status: 200,
            })
          );
        }
      })(),
    );
    return;
  }

  // Same-origin assets: cache first (hashed filenames make this safe).
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      try {
        const fresh = await fetch(request);
        if (fresh.ok && (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/") || url.pathname.endsWith(".webmanifest"))) {
          const cache = await caches.open(APP_SHELL_CACHE);
          cache.put(request, fresh.clone());
        }
        return fresh;
      } catch {
        return new Response("", { status: 504, statusText: "Offline and not cached" });
      }
    })(),
  );
});
