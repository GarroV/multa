import { expect, test } from '@playwright/test';
import { enterDemo, resetDemo } from './helpers.ts';

/**
 * Клавиатура в модальных листах (находка сверки 05.08.2026).
 *
 * Листы ввода объявлены `role="dialog" aria-modal="true"` — то есть экранный читатель обещает
 * человеку модальное поведение. Выйти при этом можно было только мышью: обработчик Escape во всём
 * вебе существовал один, и только в обучающем туре.
 */

test.beforeEach(async ({ page }) => {
  await resetDemo(page);
  await enterDemo(page);
});

test('Escape закрывает лист ввода и возвращает фокус на кнопку', async ({ page }) => {
  /*
   * Возврат фокуса проверяется здесь же и не для галочки: без него после закрытия фокус остаётся на
   * body, и следующий Tab начинает обход страницы заново — человек, который вводил трату с
   * клавиатуры, теряет место.
   */
  await page.goto('/plan');
  const opener = page.locator('.act-primary');
  await opener.click();
  await expect(page.locator('.sheet')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('.sheet')).toHaveCount(0);

  const focused = await page.evaluate(() => document.activeElement?.className ?? '');
  expect(focused, 'фокус обязан вернуться на кнопку, которой лист открыли').toContain(
    'act-primary',
  );
});

test('лист ввода открывается и закрывается без мыши вовсе', async ({ page }) => {
  /*
   * Отдельный сценарий, потому что предыдущий открывает лист кликом. Здесь путь целиком
   * клавиатурный: так продуктом пользуются те, кто вводит траты серией и не отрывает руки.
   */
  await page.goto('/plan');
  const opener = page.locator('.act-primary');
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.sheet')).toBeVisible();

  // Фокус после открытия обязан быть внутри листа, иначе Tab уводит за его пределы.
  const inside = await page.evaluate(() => !!document.activeElement?.closest('.sheet'));
  expect(inside, 'фокус после открытия должен стоять внутри листа').toBe(true);

  await page.keyboard.press('Escape');
  await expect(page.locator('.sheet')).toHaveCount(0);
});
