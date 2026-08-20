import { describe, expect, it } from 'vitest';
import { staleBundleVerdict } from './staleBundle.ts';

/**
 * Свежесть бандла перед E2E (issue #146).
 *
 * Прогон идёт по прод-сборке через `vite preview` с `reuseExistingServer`. Если порт уже слушают,
 * команда `pnpm build && vite preview` НЕ выполняется — и тесты проверяют бандл, собранный когда-то
 * раньше. Ошибается это в обе стороны: ложное падение (правки не видно) и ложный успех (сломал, а
 * зелено).
 */
describe('staleBundleVerdict', () => {
  it('свежий бандл пропускает', () => {
    expect(staleBundleVerdict({ distMs: 2000, srcMs: 1000, portBusy: true })).toBe('ok');
  });

  it('нет сборки — не мешаем: её соберёт сам прогон', () => {
    expect(staleBundleVerdict({ distMs: null, srcMs: 1000, portBusy: false })).toBe('ok');
    expect(staleBundleVerdict({ distMs: null, srcMs: 1000, portBusy: true })).toBe('ok');
  });

  it('устаревший бандл при свободном порте — не беда: сервер поднимется со сборкой', () => {
    expect(staleBundleVerdict({ distMs: 1000, srcMs: 2000, portBusy: false })).toBe('ok');
  });

  it('устаревший бандл и занятый порт — останов: именно так тест врёт', () => {
    expect(staleBundleVerdict({ distMs: 1000, srcMs: 2000, portBusy: true })).toBe('stale-served');
  });

  it('равные времена считаются свежими: сборка не может быть раньше себя', () => {
    // Секундная гранулярность mtime на некоторых файловых системах даёт равенство.
    expect(staleBundleVerdict({ distMs: 1000, srcMs: 1000, portBusy: true })).toBe('ok');
  });
});
