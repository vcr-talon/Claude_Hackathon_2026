// オフラインでも開けるよう、アプリ本体（HTML・JS・CSS・アイコン）だけを保存する。データファイルは保存しない
// 電波があるときは常に最新版を取りに行き（古い版が残らない）、圏外のときだけ保存した版を使う
const VERSION = '1.2.0'; // app.js の APP_VERSION と合わせる
const CACHE = `site-app-${VERSION}`;
const SHELL = ['./', './index.html', './app.js', './calc.js', './style.css', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('site-app-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(fetch(e.request)
    .then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit ?? caches.match('./index.html'))));
});
