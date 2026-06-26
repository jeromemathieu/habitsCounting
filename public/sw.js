// Service worker : cache le « shell » de l'app pour le hors-ligne.
// L'API et le flux iCal ne sont JAMAIS mis en cache (données sensibles/fraîches).
const CACHE = "habits-shell-v1";
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/vendor/chart.umd.min.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Jamais de cache pour l'API, l'auth, l'admin ou le flux iCal.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/calendar/") ||
    url.pathname.startsWith("/admin")
  ) {
    return; // laisse le réseau gérer
  }

  // Réseau d'abord (toujours frais en ligne), repli sur le cache hors-ligne.
  // Évite de servir un app.js/styles.css périmé après un déploiement.
  event.respondWith(
    fetch(request)
      .then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return resp;
      })
      .catch(() =>
        caches.match(request).then((cached) => cached || (request.mode === "navigate" ? caches.match("/index.html") : undefined))
      )
  );
});
