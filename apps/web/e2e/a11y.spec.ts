import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { enterDemo, resetDemo } from './helpers.ts';

/**
 * Автоматическая проверка доступности (web/testing.md: «Run automated accessibility checks»).
 *
 * До этого доступность проверялась выборочно и руками: контрастная развёртка, клавиатурные
 * сценарии, роли у своей выпадашки. Так ловятся те нарушения, о которых вспомнили, — а нужны те, о
 * которых забыли.
 *
 * Ограничение честное: axe находит не всё и не заменяет живого человека с экранным читателем. Но
 * то, что находит, — это факт, а не вкус: поле без подписи, кнопка без имени, заголовки через
 * уровень.
 */
async function violations(page: import('@playwright/test').Page) {
  const result = await new AxeBuilder({ page })
    // Уровень AA: тот же, что в наших правилах для контраста.
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return result.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.length,
    where: v.nodes[0]?.target.join(' '),
  }));
}

test('лендинг доступен', async ({ page }) => {
  await page.goto('/');
  expect(await violations(page)).toEqual([]);
});

test('вход доступен', async ({ page }) => {
  await page.goto('/login');
  expect(await violations(page)).toEqual([]);
});

test('план доступен', async ({ page }) => {
  await resetDemo(page);
  await enterDemo(page);
  expect(await violations(page)).toEqual([]);
});

test('лист ввода траты доступен', async ({ page }) => {
  /*
   * Формы — самое опасное место: поле без подписи выглядит нормально и полностью непригодно для
   * экранного читателя. Лист открываем, потому что до открытия его в разметке нет.
   */
  await resetDemo(page);
  await enterDemo(page);
  await page.locator('.act-primary').click();
  await expect(page.locator('.sheet')).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test('обязательства доступны', async ({ page }) => {
  await resetDemo(page);
  await enterDemo(page);
  await page.goto('/obligations');
  expect(await violations(page)).toEqual([]);
});

test('настройки доступны', async ({ page }) => {
  await resetDemo(page);
  await enterDemo(page);
  await page.goto('/settings');
  expect(await violations(page)).toEqual([]);
});
