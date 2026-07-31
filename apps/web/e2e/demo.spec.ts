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

  // «Сколько всего денег» — первый блок прототипа (issue #45): три валюты и общий итог.
  const onHand = page.locator('.kpi', { hasText: /MONEY ON HAND|ВСЕГО ДЕНЕГ/ });
  await expect(onHand).toBeVisible();
  await expect(onHand.locator('.kpi-value')).toContainText(/\d/);
  await expect(onHand.locator('.kpi-rows > div')).toHaveCount(3);

  // Каскад: все пять групп раздачи, иначе показ демонстрирует пустой продукт.
  const legend = page.locator('.legend');
  await expect(legend).toBeVisible();
  await expect(legend.locator('> div')).toHaveCount(5);

  // Панели обязательств и категорий на месте.
  // Флаг i обязателен: caps в панелях делает CSS, а в разметке лейблы — из словаря («Debts»).
  for (const label of [/debts|долги/i, /categories|категории/i, /income|доход/i]) {
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
