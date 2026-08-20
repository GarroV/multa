/**
 * Ширина первой колонки мастер-таблицы (issue #133, жалоба владельца «столбец слева не раздвинуть»).
 *
 * До этого ширина была зашита числом: сначала 168px, потом 232px — подобранное под текущий набор
 * данных. У имени долга или регулярного платежа длина непредсказуема («Ипотека Сбербанк
 * рефинансирование» длиннее любого заголовка раздела), поэтому любое фиксированное число рано или
 * поздно снова обрезает текст.
 *
 * Дельта считается от НАЧАЛА жеста (`startWidth` + `startX`), а не от предыдущего кадра: так делает
 * и TanStack Table, и по той же причине — покадровая дельта копит ошибку округления, и колонка
 * уползает от курсора за длинный жест.
 */

/** Меньше — заголовки разделов с шевроном и плюсом перестают читаться. */
export const MIN_NAME_WIDTH = 140;
/** Больше — колонка сумм выдавливается за экран, а таблица существует ради сравнения чисел. */
export const MAX_NAME_WIDTH = 560;
/** Столько нужно самому длинному заголовку раздела — с него и начинаем. */
export const DEFAULT_NAME_WIDTH = 232;

const STORAGE_KEY = 'multa.mgrid.nameWidth';

/** Приводит любое число к читаемым границам. Мусор превращается в ширину по умолчанию. */
export function clampNameWidth(px: number): number {
  if (Number.isNaN(px)) return DEFAULT_NAME_WIDTH;
  return Math.round(Math.min(MAX_NAME_WIDTH, Math.max(MIN_NAME_WIDTH, px)));
}

export interface DragInput {
  /** Ширина на момент нажатия — точка отсчёта на весь жест. */
  readonly startWidth: number;
  /** Где курсор был при нажатии. */
  readonly startX: number;
  /** Где курсор сейчас. */
  readonly clientX: number;
}

/** Ширина колонки для текущего положения курсора. */
export function nameWidthFrom({ startWidth, startX, clientX }: DragInput): number {
  return clampNameWidth(startWidth + (clientX - startX));
}

/**
 * Выбранная ширина переживает перезагрузку: подгонять колонку каждый визит — это не настройка, а
 * работа. Хранилище может быть недоступно (приватный режим, отключённые куки), и тогда таблица
 * просто открывается с шириной по умолчанию — падать тут нечему.
 */
export function readNameWidth(store: Storage): number {
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_NAME_WIDTH;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? clampNameWidth(parsed) : DEFAULT_NAME_WIDTH;
  } catch {
    return DEFAULT_NAME_WIDTH;
  }
}

/** Пишем уже приведённое значение: испорченное хранилище не должно уметь сломать раскладку. */
export function writeNameWidth(store: Storage, px: number): void {
  try {
    store.setItem(STORAGE_KEY, String(clampNameWidth(px)));
  } catch {
    // Некуда сохранить — не повод мешать работе.
  }
}
