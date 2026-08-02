import { expect, test } from '@playwright/test';

/**
 * Онбординг и обучение (issue #28).
 *
 * Живёт отдельным файлом, потому что ему нужен чистый браузер: остальные сценарии стартуют с уже
 * открытой демо-сессии, а здесь проверяется путь человека, который пришёл впервые.
 *
 * Суть issue: раньше визард спрашивал про долги и валютные корзины ДО того, как человек увидел
 * продукт, и ответы давались наугад. Теперь обязательный минимум — валюта и доход, а объясняет
 * экран сам, подсветкой блоков.
 */

test('новый человек попадает в план за два шага и видит обучение', async ({ page }) => {
  /*
   * Суть issue #28: раньше визард спрашивал про долги и валютные корзины ДО того, как человек
   * увидел продукт, и ответы давались наугад. Теперь обязательный минимум — валюта и доход, а
   * объясняет экран сам, подсветкой блоков.
   */
  await page.goto('/');
  const email = `tour-e2e-${Date.now()}@multa.local`;
  await page.locator('form.card input').nth(0).fill('Tour E2E');
  await page.locator('form.card input').nth(1).fill(email);
  await page.locator('form.card input').nth(2).fill('SmokeTest123!');
  await page.locator('form.card button[type=submit]').click();

  // Шаг 1: валюта. Шагов в полосе ровно два — долгов и корзин здесь больше нет.
  await expect(page.getByRole('button', { name: /^Next$|^Дальше$/ })).toBeVisible();
  await page.getByRole('button', { name: /^Next$|^Дальше$/ }).click();

  // Шаг 2: доход. Сумма — единственное, что обязательно ввести руками.
  const amounts = page.getByLabel(/^Amount$|^Сумма$/);
  await amounts.first().fill('120000');
  await amounts.last().fill('120000');
  await page.getByRole('button', { name: /^Next$|^Дальше$/ }).click();

  await expect(page).toHaveURL(/\/plan$/, { timeout: 20_000 });

  // Обучение открылось само и показывает первый шаг.
  const tip = page.locator('.tour-tip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('1 / 6');
  // Подсветка не накрывает сам блок: он остаётся видимым внутри рамки.
  await expect(page.locator('.tour-ring')).toBeVisible();
  await expect(page.locator('.kpi-hero')).toBeVisible();

  // Пропуск закрывает тур и больше не возвращает его после перезагрузки.
  await tip.getByRole('button', { name: /Skip|Пропустить/ }).click();
  await expect(page.locator('.tour')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.kpi-hero')).toBeVisible();
  await expect(page.locator('.tour')).toHaveCount(0);
});
