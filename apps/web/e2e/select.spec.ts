import { expect, test } from '@playwright/test';
import { enterDemo, resetDemo } from './helpers.ts';

/**
 * Выпадающий список (жалоба владельца 13.08.2026: «при переключении положение контекстного окна
 * прыгает», «выглядит как стандартная справка от системы»).
 *
 * Проверяются ровно две причины, а не внешний вид: нативный `<select>` заменён своим (его список
 * рисовала операционная система, и подчинить её нельзя), а строка формы больше не перестраивается
 * при переключении — раньше поле «число» появлялось и исчезало, и соседи уезжали в новое место.
 */
test.beforeEach(async ({ page }) => {
  await resetDemo(page);
  await enterDemo(page);
});

async function openIncomeEditor(page: import('@playwright/test').Page) {
  const panel = page.locator('.panel', { hasText: /INCOME|ДОХОД/ }).first();
  await panel.getByRole('button', { name: /^edit$|^править$/i }).click();
  return panel;
}

test('список свой, а не системный, и подпись видна целиком', async ({ page }) => {
  const panel = await openIncomeEditor(page);
  // Нативных select не осталось нигде на экране: их попап рисует ОС, и подчинить его нельзя.
  expect(await page.locator('select').count()).toBe(0);

  const trigger = panel.locator('.sel-trigger').first();
  await trigger.click();
  const list = page.locator('.sel-list');
  await expect(list).toBeVisible();
  await expect(list.locator('[role=option]')).toHaveCount(3);

  // Подпись не обрезана: видимая ширина текста укладывается в кнопку.
  const clipped = await trigger
    .locator('.sel-value')
    .evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(clipped).toBe(false);
});

test('переключение вида ритма не сдвигает строку', async ({ page }) => {
  const panel = await openIncomeEditor(page);
  const trigger = panel.locator('.sel-trigger').first();
  const before = await trigger.boundingBox();

  await trigger.click();
  await page.locator('.sel-item', { hasText: /Every day|Каждый день/ }).click();

  const after = await trigger.boundingBox();
  // Раньше исчезавшее поле «число» перестраивало ряд, и открытая выпадашка оказывалась в новом месте.
  expect(Math.abs((after?.x ?? 0) - (before?.x ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);
});

test('список работает с клавиатуры и возвращает фокус', async ({ page }) => {
  const panel = await openIncomeEditor(page);
  const trigger = panel.locator('.sel-trigger').first();
  await trigger.click();

  // Нативный select давал клавиатуру бесплатно — заменяя его, мы обязаны её вернуть.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('.sel-list')).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText(/Weekly|Раз в неделю/);

  // Esc закрывает без выбора и тоже возвращает фокус.
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.sel-list')).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText(/Weekly|Раз в неделю/);
});

test('список не режется краем панели', async ({ page }) => {
  const panel = await openIncomeEditor(page);
  await panel.locator('.sel-trigger').first().click();

  /*
   * Панель обрезает содержимое (`overflow: hidden`), поэтому список обязан жить ВНЕ неё. Проверяем
   * именно это, а не «вылез ли он за край»: у высокой панели он может уместиться внутри случайно, и
   * такая проверка зеленела бы на сломанной вёрстке.
   */
  const inPanel = await page.locator('.sel-list').evaluate((el) => el.closest('.panel') !== null);
  expect(inPanel).toBe(false);
  await expect(page.locator('body > .sel-list')).toHaveCount(1);
});
