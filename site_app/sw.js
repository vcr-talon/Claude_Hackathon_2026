// オフラインでも開けるよう、アプリ本体（HTML・JS・CSS・アイコン）だけを保存する。データファイルはここには保存しない（datastore.js が端末の IndexedDB に残す）
// 電波があるときは常に最新版を取りに行き（古い版が残らない）、圏外のときだけ保存した版を使う。
// 取りに行くときは毎回サーバーに新しいかを確かめる（GitHub Pages は10分キャッシュしてよいと返すため、
// そのままだと更新の直後に新しい app.js と古い calc.js が混ざり、アプリが動き出せないことがある）
const VERSION = '1.6.1'; // app.js の APP_VERSION と合わせる
const CACHE = `site-app-${VERSION}`;
const SHELL = ['./', './index.html', './app.js', './calc.js', './record.js', './datastore.js', './style.css', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('site-app-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
    .then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit ?? caches.match('./index.html'))));
});
