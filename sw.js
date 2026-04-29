/* Site-wide service worker. Stale-while-revalidate so updates roll out on
   the next reload instead of being pinned forever to the first cached
   version. Shared by Slow Walking and CUSP. */
const CACHE = 'site-v4';
const SHELL = [
    '/slow-walking.html',
    '/slow-walking.js',
    '/cusp.html',
    '/cusp.js',
    '/cusp.webmanifest',
    '/theme.js',
    '/shared.css',
    '/favicon.svg',
    '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(
            keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
        )).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return; // never intercept YouTube/CDN

    event.respondWith((async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(req);
        const networkPromise = fetch(req).then((res) => {
            if (res && res.status === 200 && res.type === 'basic') {
                cache.put(req, res.clone()).catch(() => {});
            }
            return res;
        }).catch(() => null);

        // Network-first for the shell so HTML/JS/CSS updates land immediately;
        // fall back to cache when offline. Other paths use stale-while-revalidate.
        const isShell = SHELL.some((p) => url.pathname === p || url.pathname === p.replace(/^\//, ''));
        if (isShell) {
            const fresh = await networkPromise;
            return fresh || cached || new Response('', { status: 504 });
        }
        return cached || networkPromise || new Response('', { status: 504 });
    })());
});
