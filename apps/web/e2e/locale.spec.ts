import { expect, test } from '@playwright/test';
import { API_URL } from './helpers.ts';

/**
 * Язык интерфейса должен доезжать до сервера при создании воркспейса (#104).
 *
 * Форма отправляла только валюту, поэтому стартовые категории всегда сеялись на русском: человек с
 * английским браузером проходил онбординг по-английски и попадал на главный экран, где его же
 * категории написаны кириллицей. Это не косметика перевода, а обрыв на самом узком месте воронки —
 * первом экране после регистрации.
 *
 * Локаль браузера задаётся контекстом, а не кликом по переключателю: переключатель живёт внутри
 * приложения, то есть уже ПОСЛЕ создания воркспейса, и через него баг не воспроизводится.
 */
test.use({ locale: 'en-US' });

test('английский браузер получает английские категории (#104)', async ({ page }) => {
  await page.goto('/login');
  const email = `locale-e2e-${Date.now()}@multa.local`;
  await page.locator('form.card input').nth(0).fill('Locale E2E');
  await page.locator('form.card input').nth(1).fill(email);
  await page.locator('form.card input').nth(2).fill('SmokeTest123!');
  await page.locator('form.card button[type=submit]').click();

  await page.getByRole('button', { name: 'Next' }).click();
  /*
   * Второй шаг обязан остаться английским. Баг был шире, чем «русские категории»: воркспейс
   * создавался с локалью по умолчанию, App подхватывал её как стартовую (App.tsx, эффект
   * wsLocale) — и интерфейс перекидывало на русский прямо посреди онбординга.
   */
  await expect(page.getByRole('heading').first()).toContainText('When does the money come?');
  const amounts = page.getByLabel('Amount');
  await amounts.first().fill('120000');
  await amounts.last().fill('120000');
  // На этом шаге «Next» две: шаг и добавление выплаты. Нужна последняя — кнопка шага.
  await page.getByRole('button', { name: 'Next' }).last().click();
  await expect(page).toHaveURL(/\/plan$/, { timeout: 20_000 });

  // Через API_URL, а не относительным путём: относительный уходит на веб-порт и молча отдаёт HTML.
  const categories = await page.request
    .get(`${API_URL}/v1/categories`)
    .then((r) => r.json() as Promise<{ name: string }[]>);
  const names = categories.map((c) => c.name);
  expect(names).toContain('Groceries');
  expect(names).not.toContain('Продукты');
});
