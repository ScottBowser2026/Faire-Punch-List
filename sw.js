const CACHE_NAME = "faire-punch-list-shell-v1";
const SHELL_FILES = [
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./firebase-app-compat.js",
  "./firebase-auth-compat.js",
  "./firebase-database-compat.js",
  "./firebase-storage-compat.js",
  "./emailjs.min.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Firebase, EmailJS, and the app shell are all cached (self-hosted, same
// origin) so the app can cold-start with zero connection. Live data itself
// (Firebase reads/writes) always goes to the network — only these static
// library/shell files are ever served from cache.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isShellFile = SHELL_FILES.some((f) => url.pathname.endsWith(f.replace("./", "")));

  if (isShellFile) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const networkFetch = fetch(event.request)
          .then((response) => {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
            return response;
          })
          .catch(() => cached);
        return cached || networkFetch;
      })
    );
  }
  // else: let the browser handle it normally (network)
});
