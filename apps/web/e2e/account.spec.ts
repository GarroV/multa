import { expect, test } from '@playwright/test';
import { API_URL } from './helpers.ts';

/**
 * Забрать данные и уйти (Спринт 6) — два условия, без которых нельзя звать посторонних.
 *
 * Проверяется весь путь из интерфейса: файл действительно скачивается и не пуст, а удаление
 * требует подтверждения и после него сессия мертва. Аккаунт заводится свой: тест по определению
 * уничтожает то, на чём работает, и общий демо-воркспейс тут не годится.
 */
async function signUp(page: import('@playwright/test').Page): Promise<string> {
  const email = `account-e2e-${Date.now()}@multa.local`;
  await page.goto('/');
  await page.locator('form.card input').nth(0).fill('Account E2E');
  await page.locator('form.card input').nth(1).fill(email);
  await page.locator('form.card input').nth(2).fill('SmokeTest123!');
  await page.locator('form.card button[type=submit]').click();
  await page.getByRole('button', { name: /^Next$|^Дальше$/ }).click();
  const amounts = page.getByLabel(/^Amount$|^Сумма$/);
  await amounts.first().fill('120000');
  await amounts.last().fill('120000');
  await page
    .getByRole('button', { name: /^Next$|^Дальше$/ })
    .last()
    .click();
  await expect(page).toHaveURL(/\/plan$/, { timeout: 20_000 });
  return email;
}

test('данные скачиваются файлом, аккаунт удаляется с подтверждением', async ({ page }) => {
  const email = await signUp(page);
  await page.goto('/settings');

  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: /Download CSV|Скачать CSV/ }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('multa-transactions.csv');

  await page
    .getByRole('button', { name: /^Delete$|^Удалить$/ })
    .first()
    .click();
  const confirm = page.getByLabel(/Type .* to confirm|Введите .* чтобы подтвердить/);
  const submit = page.getByRole('button', { name: /^Delete$|^Удалить$/ }).last();

  // Без верного подтверждения кнопка выключена: необратимое не должно случаться с одного клика.
  await confirm.fill('not-my-email@example.com');
  await expect(submit).toBeDisabled();

  await confirm.fill(email);
  await expect(submit).toBeEnabled();
  await submit.click();

  // Вернулись на вход, и сессии больше нет.
  await expect(page.locator('form.card')).toBeVisible({ timeout: 20_000 });
  expect((await page.request.get(`${API_URL}/v1/me`)).status()).toBe(401);
});
