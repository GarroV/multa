import { expect, test } from '@playwright/test';
import { API_URL, enterDemo, resetDemo } from './helpers.ts';

/**
 * Займы (issue #94): деньги, которые должны вернуть мне.
 *
 * Проверяется главное свойство, ради которого заём вынесен отдельно: он НЕ забирает деньги из
 * плана. Долг откладывается каждый период, заём наоборот ждёт прихода — оставь его в раздаче, и
 * цифра дня уменьшится вместо роста, причём числа сойдутся и ошибку никто не заметит.
 */
test.beforeEach(async ({ page }) => {
  await resetDemo(page);
  await enterDemo(page);
});

test('заём заводится, не трогает цифру дня и возвращается частями', async ({ page }) => {
  /*
   * Цифру дня читаем из плана, а не с экрана: первым KPI идёт «всего денег», и проверка по позиции
   * сравнивала бы не то. Заодно это устойчиво к вёрстке — меряем смысл, а не разметку.
   */
  const perDayOf = async (): Promise<string> =>
    page.request
      .get(`${API_URL}/v1/plan/current`)
      .then((r) => r.json() as Promise<{ perDayMinor: string }>)
      .then((p) => p.perDayMinor);
  const before = await perDayOf();

  await page.goto('/obligations');
  const panel = page.locator('.panel', { hasText: /Owed to me|Должны мне/ }).first();
  await expect(panel).toBeVisible();

  await panel.locator('input[placeholder*="owes"], input[placeholder*="должен"]').fill('Petya');
  await panel.locator('input.num').first().fill('5000');
  await panel.getByRole('button', { name: /^Add$|^Добавить$/ }).click();

  const row = panel.locator('.prow', { hasText: 'Petya' }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });

  // Цифра дня не изменилась: заём ничего не откладывает.
  expect(await perDayOf()).toBe(before);

  // Возврат частью: остаток уменьшается.
  await page.goto('/obligations');
  const again = page
    .locator('.panel', { hasText: /Owed to me|Должны мне/ })
    .first()
    .locator('.prow', { hasText: 'Petya' })
    .first();
  await again.getByRole('button', { name: /paid back|вернули/ }).click();
  const input = page
    .locator('.panel', { hasText: /Owed to me|Должны мне/ })
    .locator('input.num')
    .first();
  await input.fill('2000');
  await input.press('Enter');

  await expect(
    page
      .locator('.panel', { hasText: /Owed to me|Должны мне/ })
      .locator('.prow', { hasText: 'Petya' })
      .first(),
  ).toContainText('3', { timeout: 15_000 });
});
