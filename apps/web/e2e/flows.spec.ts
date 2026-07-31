import { expect, test } from '@playwright/test';

/**
 * Рабочие флоу поверх демо: запись траты, тема и язык, защита форм от невалидного ввода
 * (регрессия issue #20) и раскладка на узких экранах.
 */

test.beforeEach(async ({ page }) => {
  await page.request.post('/v1/demo/reset').catch(() => undefined);
  await page.goto('/demo');
  await expect(page).toHaveURL(/\/plan$/, { timeout: 20_000 });
});

test('трата записывается и попадает в факт категории', async ({ page }) => {
  const groceries = page.locator('.prow', { hasText: 'Groceries' }).first();
  const before = await groceries.locator('.prow-num b').innerText();

  await page.locator('.act', { hasText: 'Log a spend' }).click();
  const sheet = page.locator('.sheet');
  await expect(sheet).toBeVisible();

  // Сумма и категория напрямую: «умный ввод» применяется на blur, и в тесте это давало бы гонку
  // между разбором фразы и отправкой.
  await sheet.locator('input[placeholder="0"]').fill('750');
  await sheet.locator('.chip', { hasText: 'Groceries' }).click();
  await sheet.getByRole('button', { name: 'Log it' }).click();

  // Панель остаётся открытой намеренно: траты вводят серией. Проверяем, что запись появилась в
  // списке периода внутри панели, а после закрытия факт категории на плане вырос.
  await expect(sheet.getByText(/Groceries/).last()).toBeVisible({ timeout: 15_000 });
  await sheet.getByRole('button', { name: '✕' }).first().click();
  await expect(sheet).toBeHidden();
  await expect(groceries.locator('.prow-num b')).not.toHaveText(before, { timeout: 15_000 });
});

test('тема переключается и запоминается между визитами', async ({ page }) => {
  const root = page.locator('html');
  await page.locator('.seg-btn', { hasText: 'light' }).click();
  await expect(root).toHaveAttribute('data-theme', 'light');

  await page.reload();
  // Выбор темы обязан выжить перезагрузку: иначе человек выбирает её каждый визит.
  await expect(root).toHaveAttribute('data-theme', 'light');

  await page.locator('.seg-btn', { hasText: 'dark' }).click();
  await expect(root).toHaveAttribute('data-theme', 'dark');
});

test('язык переключается на всём интерфейсе', async ({ page }) => {
  await expect(page.locator('.tab').first()).toHaveText('Plan');
  await page.locator('.seg-btn', { hasText: 'RU' }).click();
  await expect(page.locator('.tab').first()).toHaveText('План');
  await page.locator('.seg-btn', { hasText: 'EN' }).click();
  await expect(page.locator('.tab').first()).toHaveText('Plan');
});

test('невалидная сумма не создаёт обязательство на ноль (регрессия #20)', async ({ page }) => {
  await page.locator('.tab', { hasText: 'Obligations' }).click();
  await expect(page).toHaveURL(/\/obligations$/);

  const debts = page.locator('.panel', { hasText: 'DEBTS' });
  // Ждём загрузку, прежде чем считать строки: без этого count() ловил панель на полпути.
  await expect(debts.locator('.prow', { hasText: 'Ozon installment' })).toBeVisible();
  const rowsBefore = await debts.locator('.prow').count();

  await debts.locator('input[placeholder="Name"]').fill('Bad debt');
  await debts.locator('input[placeholder="Amount"]').fill('1 000');
  await debts.getByRole('button', { name: 'Add' }).click();

  // Форма говорит, что не так, и ничего не создаёт — раньше молча появлялся долг на 0.
  await expect(debts.locator('.danger')).toBeVisible();
  await expect(debts.locator('.prow')).toHaveCount(rowsBefore);
});

test('ошибка загрузки не притворяется пустотой (регрессия #20)', async ({ page }) => {
  await page.route('**/v1/debts', (route) => route.fulfill({ status: 500, body: '{}' }));
  await page.locator('.tab', { hasText: 'Obligations' }).click();

  const debts = page.locator('.panel', { hasText: 'DEBTS' });
  await expect(debts.getByText(/Could not load/i)).toBeVisible();
  await expect(debts.getByText(/^Empty|Пока пусто$/)).toHaveCount(0);
});

for (const width of [375, 768, 1024, 1440]) {
  test(`нет горизонтального скролла на ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ['/plan', '/statistics', '/obligations', '/settings']) {
      await page.goto(path);
      await expect(page.locator('.dense, .panels').first()).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} на ${width}px`).toBeLessThanOrEqual(1);
    }
  });
}
