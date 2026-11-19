// @ts-check
/// <reference lib="webworker" />
/**
 * KT1: formun kendi dosyalari onbellege alinir, sonra internetsiz de acilir. Yalniz ayni
 * adresteki dosyalar istenir; kontrol verisi hicbir yere gitmez.
 * Dosya degisince CACHE_VERSION artirilir: eski onbellek silinir.
 */
const CACHE_VERSION = "parti-kontrol-3";
/** Takilan agda (cevap gelmiyor) kayitli surume gecmeden once beklenen sure */
const NETWORK_WAIT_MS = 3000;
/** Ag bir kez takilinca bu ana kadar diger dosyalar beklemeden kayitli surumden acilir */
let slowNetworkUntil = 0;
const FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./message.js",
  "./manifest.webmanifest",
];

const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));

sw.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(FILES))
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)),
        ),
      )
      .then(() => sw.clients.claim()),
  );
});

/** @param {Request} request */
async function fromCache(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached !== undefined) return cached;
  return request.mode === "navigate" ? caches.match("./index.html") : undefined;
}

/**
 * Once agdan (guncel surum), ag yoksa onbellekten. Ag NETWORK_WAIT_MS icinde cevap vermezse
 * (takilan mobil veri) kayitli surum acilir; kayitli surum yoksa ag beklenir.
 * @param {Request} request
 * @returns {Promise<Response>}
 */
function networkFirst(request) {
  return new Promise((resolve) => {
    let answered = false;
    /** @param {Response} response */
    const answer = (response) => {
      if (answered) return;
      answered = true;
      resolve(response);
    };
    fetch(request)
      .then(async (response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          return response;
        }
        // Barindirma hata verirse (404 / 503) elde olan surum acilsin
        return (await fromCache(request)) ?? response;
      })
      .catch(async () => (await fromCache(request)) ?? Response.error())
      .then(answer);
    const wait = Date.now() < slowNetworkUntil ? 0 : NETWORK_WAIT_MS;
    setTimeout(() => {
      void fromCache(request).then((cached) => {
        if (cached === undefined || answered) return;
        slowNetworkUntil = Date.now() + 10_000;
        answer(cached);
      });
    }, wait);
  });
}

// "#..." parcasi istege girmez.
sw.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== sw.location.origin) {
    return;
  }
  event.respondWith(networkFirst(request));
});
