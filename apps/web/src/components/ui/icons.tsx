/**
 * Пиктограммы интерфейса — один дом на всё приложение.
 *
 * Иконки нарисованы, а не набраны глифами. Юникодные «▤» и «▦» в интерфейсном шрифте выходят двумя
 * почти одинаковыми серыми квадратиками 15px: отличить панели от таблицы нельзя, а угадывать
 * приходится каждому (найдено владельцем 05.08.2026). Контур наследует цвет кнопки, поэтому
 * нажатое и наведённое состояния подсвечиваются сами, без второго набора иконок.
 *
 * Подпись у иконки не исчезает, а переезжает в `aria-label` и `title` на кнопке: пиктограмма
 * экономит место, но не смысл.
 */

/** Панели: две широкие полосы одна под другой. */
export function IconPanels() {
  return (
    <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden focusable="false">
      <rect x="1" y="2" width="12" height="4" rx="1" fill="none" stroke="currentColor" />
      <rect x="1" y="8" width="12" height="4" rx="1" fill="none" stroke="currentColor" />
    </svg>
  );
}

/** Таблица: рамка с сеткой — строки статей против колонок периодов. */
export function IconTable() {
  return (
    <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden focusable="false">
      <rect x="1" y="2" width="12" height="10" rx="1" fill="none" stroke="currentColor" />
      <path d="M5.5 2v10M9.5 2v10M1 5.5h12M1 8.5h12" stroke="currentColor" />
    </svg>
  );
}

/** Предпросмотр «глазами участника»: глаз открыт — смотрим чужими глазами, закрыт — своими. */
export function IconEye({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 14" width="16" height="14" aria-hidden focusable="false">
      <path
        d="M1 7c2-3.2 4.3-4.8 7-4.8S13 3.8 15 7c-2 3.2-4.3 4.8-7 4.8S3 10.2 1 7z"
        fill="none"
        stroke="currentColor"
      />
      {open ? (
        <circle cx="8" cy="7" r="2.1" fill="currentColor" />
      ) : (
        <path d="M3 3l10 8" stroke="currentColor" />
      )}
    </svg>
  );
}

/**
 * Плюс — «добавить строку». Заменил слово «завести» в шапке пустого раздела таблицы: слово стояло
 * вплотную к подписи раздела, отнимало у неё место («ВАЛЮТН…») и в плотной таблице читалось как
 * часть названия, а не как действие.
 */
export function IconPlus() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden focusable="false">
      <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" />
    </svg>
  );
}
