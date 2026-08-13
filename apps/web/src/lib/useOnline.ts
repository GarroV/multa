import { useSyncExternalStore } from 'react';

/**
 * Есть ли сеть (Спринт 6, PWA).
 *
 * Приложение теперь открывается без сети — из кэшированной оболочки. Само по себе это опасно:
 * оболочка отрисуется, запросы упадут, и человек увидит пустой план, решив, что данные потерялись.
 * Поэтому состояние сети нужно показывать явно.
 *
 * `useSyncExternalStore` вместо `useState` + эффекта не из вкусовщины: это внешнее состояние
 * браузера, и только через него React гарантирует согласованность при конкурентном рендере.
 */
function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    // На сервере рендера нет, но значение по умолчанию обязано быть оптимистичным: полоса «нет
    // сети» на первом кадре у человека с интернетом — ложь дороже пользы.
    () => true,
  );
}
