import { expect, test } from '@playwright/test';
import { enterDemo, resetDemo } from './helpers.ts';

/**
 * Демо и план — то, что видит смотрящий за первый клик (issues #56, #30). Если этот файл красный,
 * показывать продукт нельзя: либо вход не работает, либо главный экран пуст.
 */

test.beforeEach(async ({ page }) => {
  // Каждый тест начинает с одинакового наполнения: демо — общий воркспейс, его пачкают траты.
  await resetDemo(page);
});

test('вход в демо без регистрации открывает наполненный план', async ({ page }) => {
  await page.goto('/demo');
  await expect(page).toHaveURL(/\/plan$/, { timeout: 20_000 });

  // Цифра дня — главный ответ экрана; без неё план не собрался.
  const canSpend = page.locator('.kpi', { hasText: /YOU CAN SPEND|МОЖНО ТРАТИТЬ/ });
  await expect(canSpend).toBeVisible();
  await expect(canSpend.locator('.kpi-value')).toContainText(/\d/);

  /* Блок «всего денег» проверять больше нечего: счета скрыты из интерфейса решением владельца
     06.08.2026 (lib/sections.ts). Данные и ручка на месте, поэтому проверка удалена, а не
     переписана на «его нет»: вернётся раздел — вернётся и она. */

  /* Каскад: видимые группы раздачи. Пять их было, пока показывались цели и корзины; теперь эти
     разделы скрыты из интерфейса (lib/sections.ts), и легенда рисует три — долги, конверты,
     расходы. Логика раздачи не менялась, изменилось только что показываем. */
  const legend = page.locator('.legend');
  await expect(legend).toBeVisible();
  await expect(legend.locator('> div')).toHaveCount(3);

  // Панели обязательств и категорий на месте.
  // Флаг i обязателен: caps в панелях делает CSS, а в разметке лейблы — из словаря («Debts»).
  // «Расходы»/Spending — прежние «Категории»: раздел переименован 05.08.2026, чтобы было очевидно,
  // про что он. Домен остался категориями, поменялась только подпись раздела.
  for (const label of [/debts|долги/i, /spending|расходы/i, /income|доход/i]) {
    await expect(page.locator('.panel-name', { hasText: label }).first()).toBeVisible();
  }
});

test('демо открывается на английском, как требует правило показа', async ({ page }) => {
  await page.goto('/demo');
  await expect(page).toHaveURL(/\/plan$/, { timeout: 20_000 });
  await expect(page.locator('.tab').first()).toHaveText('Plan');
  // Ни одной кириллической буквы: демо всегда англоязычное, независимо от языка продукта.
  const text = await page.locator('.dense').innerText();
  expect(text).not.toMatch(/[А-Яа-я]/);
});

test('карта периода показывает события и не даёт подписям слипнуться', async ({ page }) => {
  await page.goto('/demo');
  await expect(page).toHaveURL(/\/plan$/, { timeout: 20_000 });

  const caps = page.locator('.pmap-cap');
  await expect(caps.first()).toBeVisible();
  const boxes = await caps.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right };
    }),
  );
  // Подписи схлопываются кластерами; проверяем, что соседние не перекрываются.
  const sorted = boxes.sort((a, b) => a.left - b.left);
  for (let i = 1; i < sorted.length; i += 1) {
    expect(sorted[i]!.left).toBeGreaterThanOrEqual(sorted[i - 1]!.right - 1);
  }
});

test('статистика считает метрики и историю разменов', async ({ page }) => {
  await page.goto('/demo');
  await expect(page).toHaveURL(/\/plan$/, { timeout: 20_000 });
  await page.locator('.tab', { hasText: 'Statistics' }).click();

  await expect(page).toHaveURL(/\/statistics$/);
  const spread = page.locator('.kpi', { hasText: 'AVERAGE SPREAD' }).locator('.kpi-value');
  // Средний спред обязан быть числом: «—» здесь означает, что размены не доехали.
  await expect(spread).toHaveText(/\d+\.\d%/);

  const history = page.locator('.panel', { hasText: 'HISTORY' });
  await expect(history.locator('.prow')).not.toHaveCount(0);
});

test('демо доводит размен до вывода: у кого дешевле и сколько дал бы переход', async ({ page }) => {
  /*
   * Вторая заявленная ценность продукта (issue #53) в её показательном виде. Проверяется именно
   * вывод, а не наличие панели: если сид скатится к одной сделке на обменник, сравнение перестанет
   * советовать переход, и демо будет показывать таблицу без главной строки.
   */
  await page.goto('/demo');
  await expect(page).toHaveURL(/\/plan$/, { timeout: 20_000 });
  await page.locator('.tab', { hasText: 'Statistics' }).click();

  const panel = page.locator('.panel', { hasText: 'WHERE YOU EXCHANGE' });
  await expect(panel.locator('.tag', { hasText: 'CHEAPEST' })).toHaveCount(1);
  await expect(panel.locator('.tag', { hasText: 'PRICIEST' })).toHaveCount(1);
  await expect(panel.locator('.panel-foot')).toContainText(/would have cost .* less/);
});

test('мастер-режим показывает полгода вперёд и не уезжает вбок', async ({ page }) => {
  /*
   * Таблица «строки × периоды» (issue #47) — то, ради чего человек уходит из Excel. Проверяем не
   * вёрстку, а два её обещания: закрывшийся долг перестаёт быть строкой (прочерк, а не ноль) и
   * широкая таблица скроллит себя, а не всю страницу.
   */
  await page.goto('/demo');
  await expect(page).toHaveURL(/\/plan$/, { timeout: 20_000 });
  await page.getByRole('button', { name: 'Table', exact: true }).click();

  const grid = page.locator('.mgrid');
  await expect(grid).toBeVisible();
  // Шесть колонок периодов + колонка названий.
  await expect(grid.locator('.mgrid-row-periods .mgrid-cell')).toHaveCount(6);
  // Закрывшийся долг: прочерк вместо суммы.
  await expect(grid.locator('.mgrid-cell-off').first()).toHaveText('—');

  // На телефоне шесть колонок заведомо не помещаются — и это должна разруливать сама таблица.
  await page.setViewportSize({ width: 375, height: 800 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const scrolls = await grid.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(scrolls).toBe(true);
});

test('регулярные платежи управляются из интерфейса и знают новые правила', async ({ page }) => {
  /*
   * До issue #55 регулярные платежи существовали только в API: в продукте их было не завести и не
   * удалить. Проверяем ровно это — панель есть, новые правила читаются словами, а вариант повтора
   * выводится из выбранной даты (29 сентября 2026 — пятый вторник, значит «последний»).
   */
  await page.goto('/demo');
  await expect(page).toHaveURL(/\/plan$/, { timeout: 20_000 });
  await page.locator('.tab', { hasText: 'Obligations' }).click();

  const panel = page.locator('.panel', { hasText: 'RECURRING PAYMENTS' });
  await expect(panel).toBeVisible();
  await expect(panel.locator('.tag', { hasText: 'SECOND TUESDAY OF THE MONTH' })).toHaveCount(1);
  await expect(panel.locator('.tag', { hasText: 'EVERY PAYDAY' })).toHaveCount(1);

  await panel.getByLabel('First time').fill('2026-09-29');
  const repeat = panel.getByLabel('Repeat');
  // «Пятого вторника» как правила не существует: пятая неделя предлагается как «последняя».
  await expect(repeat.locator('option')).toContainText([
    'day 29 of the month',
    'last Tuesday of the month',
  ]);
});

test('сигналы приходят сущностями и у каждого есть действие', async ({ page }) => {
  /*
   * Суть issue #50: раньше панель сигналов была разметкой без единой кнопки — она сообщала о
   * проблеме и оставляла человека с ней один на один. Проверяем именно это: у каждой строки есть
   * тон, метрика и хотя бы одно действие.
   */
  await page.goto('/demo');
  await expect(page).toHaveURL(/\/plan$/, { timeout: 20_000 });
  await page.locator('.tab', { hasText: 'Statistics' }).click();

  const panel = page.locator('.panel', { hasText: 'SIGNALS' });
  const rows = panel.locator('.prow');
  await expect(rows.first()).toBeVisible();

  const count = await rows.count();
  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    await expect(row.locator('.tag')).toHaveCount(1);
    await expect(row.locator('button.act').first()).toBeVisible();
  }
});
