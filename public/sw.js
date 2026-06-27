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

// Réception d'une notification push.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  const title = data.title || "Suivi des habitudes";
  const opts = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: data.url || "/" },
  };
  if (data.alarm) {
    opts.requireInteraction = true;
    opts.vibrate = [500, 200, 500, 200, 500];
    opts.tag = "calendar-alarm";
    opts.renotify = true;
  }
  event.waitUntil(self.registration.showNotification(title, opts));
});

// Clic sur une notification : ouvre / focalise l'app.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ("focus" in c) { c.navigate(target); return c.focus(); }
      }
      return self.clients.openWindow(target);
    })
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
