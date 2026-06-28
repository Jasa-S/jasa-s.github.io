const CACHE = 'site-v11';
const SHELL = [
    '/blue-admin.html',
    '/blue-admin.webmanifest',
    '/theme.js',
    '/shared.css',
];

const SHARE_DB     = 'blue-share';
const SHARE_STORE  = 'inbox';
const SHARE_KEY    = 'pending';
const SHARE_TARGET = '/blue-admin.html';

function openShareDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(SHARE_DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(SHARE_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}
async function stashShare(files, text) {
    const db = await openShareDb();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(SHARE_STORE, 'readwrite');
        tx.objectStore(SHARE_STORE).put({ files, text, at: Date.now() }, SHARE_KEY);
        tx.oncomplete = resolve;
        tx.onerror    = () => reject(tx.error);
    });
    db.close();
}

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
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    if (req.method === 'POST' && url.pathname === SHARE_TARGET) {
        event.respondWith((async () => {
            try {
                const form  = await req.formData();
                const files = form.getAll('photos').filter((f) => f && f.size > 0);
                const text  = [form.get('title'), form.get('text'), form.get('url')]
                    .filter(Boolean).join(' ').trim();
                await stashShare(files, text);
            } catch (e) {  }
            return Response.redirect(SHARE_TARGET + '?share=1', 303);
        })());
        return;
    }

    if (req.method !== 'GET') return;

    event.respondWith((async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(req);
        const networkPromise = fetch(req).then((res) => {
            if (res && res.status === 200 && res.type === 'basic') {
                cache.put(req, res.clone()).catch(() => {});
            }
            return res;
        }).catch(() => null);

        const networkFirst = req.mode === 'navigate'
            || /\.(?:html|js|css|webmanifest)$/.test(url.pathname);
        if (networkFirst) {
            const fresh = await networkPromise;
            return fresh || cached || new Response('', { status: 504 });
        }
        return cached || networkPromise || new Response('', { status: 504 });
    })());
});
