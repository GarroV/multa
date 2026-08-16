import { expect, test } from '@playwright/test';
import { enterDemo, resetDemo } from './helpers.ts';

/**
 * Правка в режиме таблицы (запрос владельца 13.08.2026: «в режиме таблицы должна быть возможность
 * редактировать поля, и чтобы оттуда шло распределение обратно»).
 *
 * Проверяется путь целиком: ячейка правится на месте, число сохраняется, и столбец пересчитывается —
 * итоги внизу меняются в том же ответе, без перезагрузки.
 */
test.beforeEach(async ({ page }) => {
  await resetDemo(page);
  await enterDemo(page);
  // Мастер-режим живёт в адресе, а не в состоянии экрана.
  await page.goto('/plan?view=table');
});

test('ячейка правится на месте и переживает перезагрузку', async ({ page }) => {
  const grid = page.locator('.mgrid');
  await expect(grid).toBeVisible();

  // Берём строку категории: у неё правка означает бюджет одного периода.
  const row = grid.locator('.mgrid-row', { hasText: 'Groceries' }).first();
  const cell = row.locator('.mgrid-cell-btn').nth(2);
  const before = (await cell.innerText()).trim();

  await cell.click();
  const input = row.locator('.mgrid-input');
  await input.fill('12345');
  await input.press('Enter');

  await expect(row.locator('.mgrid-cell').nth(2)).not.toHaveText(before, { timeout: 15_000 });
  const after = (await row.locator('.mgrid-cell').nth(2).innerText()).trim();

  await page.reload();
  const again = page
    .locator('.mgrid-row', { hasText: 'Groceries' })
    .first()
    .locator('.mgrid-cell')
    .nth(2);
  await expect(again).toHaveText(after, { timeout: 15_000 });
});

test('распределение идёт обратно: итог столбца пересчитывается сразу', async ({ page }) => {
  const grid = page.locator('.mgrid');
  const foot = grid.locator('.mgrid-foot');
  const freeBefore = await foot
    .locator('.mgrid-row')
    .last()
    .locator('.mgrid-cell')
    .nth(2)
    .innerText();

  const row = grid.locator('.mgrid-row', { hasText: 'Groceries' }).first();
  await row.locator('.mgrid-cell-btn').nth(2).click();
  const input = row.locator('.mgrid-input');
  await input.fill('99000');
  await input.press('Enter');

  // Без перезагрузки: сервер отдаёт пересобранную сетку, и она подменяет прежнюю в кэше.
  await expect(foot.locator('.mgrid-row').last().locator('.mgrid-cell').nth(2)).not.toHaveText(
    freeBefore,
    { timeout: 15_000 },
  );
});

test('Esc отменяет правку, ничего не записав', async ({ page }) => {
  const row = page.locator('.mgrid-row', { hasText: 'Groceries' }).first();
  const cell = row.locator('.mgrid-cell-btn').nth(2);
  const before = (await cell.innerText()).trim();

  await cell.click();
  const input = row.locator('.mgrid-input');
  await input.fill('777');
  await input.press('Escape');

  await expect(row.locator('.mgrid-cell').nth(2)).toHaveText(before);
});

/*
 * Ячейка не должна дёргаться в момент, когда в неё вошли (жалоба владельца 16.08.2026: «зачем
 * скачет поле?»).
 *
 * Замер до правки: колонка расширялась с 92 до 184px — ровно вдвое, потому что дорожка задана
 * `minmax(92px, max-content)`, а `max-content` пустого input'а это его собственная ширина по
 * умолчанию (двадцать символов). Поле выезжало на соседний столбец. Высота при этом падала с 36
 * до 22px: обёртка обнуляла отступы ячейки, а поле их не возвращало.
 *
 * Проверяем геометрию, а не пиксель-в-пиксель картинку: строка обязана сохранить и ширину, и
 * высоту, иначе таблица прыгает под курсором при каждом входе в ячейку.
 */
test('вход в ячейку не меняет её размеры', async ({ page }) => {
  const row = page.locator('.mgrid-row', { hasText: 'Groceries' }).first();
  const cell = row.locator('.mgrid-cell-btn').nth(2);
  const before = await cell.boundingBox();

  await cell.click();
  const input = row.locator('.mgrid-input');
  await expect(input).toBeVisible();
  const after = await input.boundingBox();

  // Допуск в 2px: рамка поля и антиалиасинг дают доли пикселя, а не скачок.
  expect(Math.abs(after!.width - before!.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(2);
});

/*
 * Значение тоже не должно меняться на глазах: показанный «0» превращался в «0.00», а «133 980» —
 * в «133980.00». Человек видит скачок цифр там, где ничего не произошло. Дробную часть показываем
 * только когда она есть.
 */
test('вход в ячейку не переписывает показанное число', async ({ page }) => {
  const row = page.locator('.mgrid-row', { hasText: 'Groceries' }).first();
  const cell = row.locator('.mgrid-cell-btn').nth(2);
  const shown = (await cell.innerText()).trim();

  await cell.click();
  const value = await row.locator('.mgrid-input').inputValue();

  // Разделители разрядов при вводе не нужны, но лишних нулей после точки быть не должно.
  expect(value).toBe(shown.replace(/[\s, ]/g, ''));
});
