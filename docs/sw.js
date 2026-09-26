const C = 'tazakoz-v2';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'mock-api.js', 'i18n.js', 'manifest.json', 'icon.svg'];
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(FILES))));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x))))));
self.addEventListener('fetch', e => { if (new URL(e.request.url).pathname.startsWith('/api/')) return; e.respondWith(fetch(e.request).catch(() => caches.match(e.request))); });
