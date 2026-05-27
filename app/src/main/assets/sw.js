const STATIC_CACHE = "radiovidimost-static-v19";
const TILE_CACHE = "radiovidimost-tiles-v1";
const DATA_CACHE = "radiovidimost-data-v2";
const STATIC_ASSETS = ["./index.html", "./styles.css", "./app.js?v=20260527-cache14", "./sw.js?v=20260527-cache14"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith("radiovidimost-") && ![STATIC_CACHE, TILE_CACHE, DATA_CACHE].includes(key))
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET") return;

  if (url.hostname.includes("arcgisonline.com")) {
    event.respondWith(cacheFirst(request, TILE_CACHE));
    return;
  }

  if (url.hostname === "api.open-meteo.com" || url.hostname.includes("overpass") || url.hostname === "query.wikidata.org") {
    event.respondWith(cacheFirst(request, DATA_CACHE));
    return;
  }

  if (url.hostname === location.hostname && url.pathname.startsWith("/assets/")) {
    event.respondWith(networkFirst(request, STATIC_CACHE));
  }
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok || response.type === "opaque") {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok || response.type === "opaque") {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}
