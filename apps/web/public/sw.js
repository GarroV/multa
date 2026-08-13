/*
 * Service worker (Спринт 6).
 *
 * Задача узкая и намеренно скромная: приложение должно открываться без сети и честно говорить, что
 * данные показаны из кэша. Ни синхронизации, ни очереди мутаций здесь нет — очередь живёт в
 * приложении, где видно состояние записи; в worker'е она превратилась бы в невидимую машинерию,
 * которая молча теряет трату.
 *
 * Стратегии ровно две, потому что больше и не нужно:
 *   - собранные ассеты (/assets/*, хэш в имени) неизменяемы → cache-first, сразу и навсегда;
 *   - навигация → network-first с падением на кэшированную оболочку: свежая версия важнее скорости,
 *     но лучше старая оболочка, чем «нет интернета» от браузера.
 *
 * Запросы к API не кэшируются НИКОГДА. Показать вчерашнюю «цифру дня» как сегодняшнюю — худшее, что
 * может сделать продукт про деньги: человек примет решение по числу, которого больше нет.
 */

const CACHE = 'multa-shell-v1';
const SHELL = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([SHELL, '/manifest.webmanifest', '/icon-512.png'])),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Старые версии оболочки убираем сразу: две оболочки в кэше — это две разные версии приложения.
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Чужой origin и API — мимо кэша. Про API см. комментарий к файлу.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/v1/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(SHELL, copy));
          return response;
        })
        .catch(() => caches.match(SHELL).then((hit) => hit ?? Response.error())),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
            return response;
          }),
      ),
    );
  }
});
