import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NAME_WIDTH,
  MAX_NAME_WIDTH,
  MIN_NAME_WIDTH,
  clampNameWidth,
  nameWidthFrom,
  readNameWidth,
  writeNameWidth,
} from './gridColumnWidth.ts';

/** Хранилище-обманка: тесты не должны зависеть от того, есть ли localStorage у окружения. */
function fakeStore(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe('clampNameWidth', () => {
  it('держит ширину в границах читаемости', () => {
    expect(clampNameWidth(300)).toBe(300);
    expect(clampNameWidth(MIN_NAME_WIDTH - 50)).toBe(MIN_NAME_WIDTH);
    expect(clampNameWidth(MAX_NAME_WIDTH + 500)).toBe(MAX_NAME_WIDTH);
  });

  it('мусор превращает в ширину по умолчанию, а не в NaN-колонку', () => {
    expect(clampNameWidth(Number.NaN)).toBe(DEFAULT_NAME_WIDTH);
    expect(clampNameWidth(Number.POSITIVE_INFINITY)).toBe(MAX_NAME_WIDTH);
  });

  it('дробные пиксели округляет: полупиксельная колонка мылит текст', () => {
    expect(clampNameWidth(280.6)).toBe(281);
  });
});

describe('nameWidthFrom', () => {
  it('считает ширину от НАЧАЛА перетаскивания, а не от предыдущего кадра', () => {
    // Дрейф: если считать от кадра к кадру, ошибка округления копится за жест.
    expect(nameWidthFrom({ startWidth: 232, startX: 500, clientX: 600 })).toBe(332);
    expect(nameWidthFrom({ startWidth: 232, startX: 500, clientX: 450 })).toBe(232 - 50);
  });

  it('за границы не выпускает даже при рывке курсора за окно', () => {
    expect(nameWidthFrom({ startWidth: 232, startX: 500, clientX: -5000 })).toBe(MIN_NAME_WIDTH);
    expect(nameWidthFrom({ startWidth: 232, startX: 500, clientX: 99_999 })).toBe(MAX_NAME_WIDTH);
  });
});

describe('readNameWidth / writeNameWidth', () => {
  it('возвращает сохранённое значение', () => {
    const store = fakeStore({ 'multa.mgrid.nameWidth': '300' });
    expect(readNameWidth(store)).toBe(300);
  });

  it('без сохранённого значения даёт ширину по умолчанию', () => {
    expect(readNameWidth(fakeStore())).toBe(DEFAULT_NAME_WIDTH);
  });

  it('испорченное значение не роняет таблицу', () => {
    expect(readNameWidth(fakeStore({ 'multa.mgrid.nameWidth': 'сто' }))).toBe(DEFAULT_NAME_WIDTH);
    expect(readNameWidth(fakeStore({ 'multa.mgrid.nameWidth': '-40' }))).toBe(MIN_NAME_WIDTH);
  });

  it('записывает уже приведённое к границам значение, а не сырое', () => {
    const store = fakeStore();
    writeNameWidth(store, MAX_NAME_WIDTH + 1000);
    expect(store.getItem('multa.mgrid.nameWidth')).toBe(String(MAX_NAME_WIDTH));
  });

  it('недоступное хранилище не считается ошибкой', () => {
    const broken: Storage = {
      ...fakeStore(),
      getItem: () => {
        throw new Error('приватный режим');
      },
      setItem: () => {
        throw new Error('приватный режим');
      },
    };
    expect(readNameWidth(broken)).toBe(DEFAULT_NAME_WIDTH);
    expect(() => writeNameWidth(broken, 300)).not.toThrow();
  });
});
