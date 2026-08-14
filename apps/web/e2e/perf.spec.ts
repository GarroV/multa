import { expect, test } from '@playwright/test';
import { enterDemo, resetDemo } from './helpers.ts';

/**
 * Бюджет сдвига макета (замер 14.08.2026).
 *
 * До этого экран плана показывал «загружается» по центру, а потом сверху вставлялась полоса KPI и
 * толкала всё вниз — ровно в тот момент, когда человек начинал читать цифру дня. CLS был 0,044.
 *
 * Проверяем не «красиво ли», а измеримое: содержимое не прыгает под руками. Порог взят с запасом
 * от целевого 0,1 из наших же правил — иначе тест начнёт ловить шум вместо регрессий.
 */
async function cls(page: import('@playwright/test').Page): Promise<number> {
  return await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let value = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
            if (!shift.hadRecentInput) value += shift.value;
          }
        }).observe({ type: 'layout-shift', buffered: true });
        setTimeout(() => resolve(Number(value.toFixed(4))), 2000);
      }),
  );
}

test('план не прыгает при загрузке', async ({ page }) => {
  await resetDemo(page);
  await enterDemo(page);
  expect(await cls(page)).toBeLessThan(0.02);
});

test('лендинг не прыгает', async ({ page }) => {
  await page.goto('/');
  expect(await cls(page)).toBeLessThan(0.02);
});
