import { expect, test } from '@playwright/test';

/**
 * Лендинг (Спринт 6). До него у холодного посетителя не было точки входа: корень редиректил в
 * приложение, а незалогиненный видел форму регистрации — продукт просил представиться прежде, чем
 * объяснял, зачем он нужен.
 */
test('холодный посетитель видит объяснение и путь в демо, а не форму регистрации', async ({
  page,
}) => {
  await page.goto('/');
  // Форма регистрации на первом экране быть не должна.
  await expect(page.locator('form.card')).toHaveCount(0);
  await expect(page.locator('.landing-title')).toBeVisible();

  // Демо — главное действие: «посмотреть без регистрации» это обещание продукта.
  const demo = page.getByRole('link', { name: /See the demo|Посмотреть демо/ });
  await expect(demo).toBeVisible();
  await demo.click();
  await expect(page).toHaveURL(/\/plan$/, { timeout: 20_000 });
});

test('вход остаётся доступен отдельной ссылкой', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /^sign in$|^войти$/ }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator('form.card')).toBeVisible();
});

test('лендинг не разъезжается на узком экране', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
