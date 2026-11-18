// Service Worker：アプリ本体をキャッシュしてオフライン動作させる。
// データ（IndexedDB）には触れない。外部通信は行わない。
// PRECACHE と VERSION は tools/build_sw.py が自動生成する（ファイル追加・変更後に実行）。

// BEGIN GENERATED
const VERSION = 'b73325fdfadd';
const PRECACHE = [
  './',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512-maskable.png',
  './icons/icon-512.png',
  './index.html',
  './manifest.webmanifest',
  './src/core/csv.js',
  './src/core/ledger.js',
  './src/core/money.js',
  './src/core/text.js',
  './src/core/util.js',
  './src/core/zip.js',
  './src/data/backup.js',
  './src/data/csvio.js',
  './src/data/db.js',
  './src/data/sample.js',
  './src/data/store.js',
  './src/scan/ean.js',
  './src/ui/dom.js',
  './src/ui/history.js',
  './src/ui/inventory.js',
  './src/ui/item.js',
  './src/ui/main.js',
  './src/ui/ops.js',
  './src/ui/photo.js',
  './src/ui/places.js',
  './src/ui/scan.js',
  './src/ui/settings.js',
  './src/ui/styles.css',
  './src/ui/views.js'
];
// END GENERATED

const CACHE = `zaiko-app-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('zaiko-app-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部リソースは扱わない
  if (url.pathname.includes('/tests/')) return; // テストページは常にネットワーク
  // ナビゲーションはアプリシェルを返す（オフライン対応）
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html', { ignoreSearch: true }).then((cached) => cached || fetch(req))
    );
    return;
  }
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
