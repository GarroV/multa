import { expect, test } from '@playwright/test';
import { enterDemo, resetDemo } from './helpers.ts';

/**
 * Рабочие флоу поверх демо: запись траты, тема и язык, защита форм от невалидного ввода
 * (регрессия issue #20) и раскладка на узких экранах.
 */

test.beforeEach(async ({ page }) => {
  await resetDemo(page);
  await enterDemo(page);
});

test('трата записывается и попадает в факт категории', async ({ page }) => {
  const groceries = page.locator('.prow', { hasText: 'Groceries' }).first();
  const before = await groceries.locator('.prow-num b').innerText();

  // Главное действие топбара: одна кнопка на трату и приход, поэтому и подпись без «траты».
  await page.locator('.act-primary').click();
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

test('язык запоминается между визитами и попадает в <html lang> (находка аудита)', async ({
  page,
}) => {
  await page.locator('.seg-btn', { hasText: 'RU' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');

  await page.reload();
  // Раньше язык сбрасывался на русский по умолчанию при каждом визите, хотя тема персистилась.
  await expect(page.locator('.tab').first()).toHaveText('План');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');

  await page.locator('.seg-btn', { hasText: 'EN' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('сбой загрузки в статистике не выдаётся за пустоту (находка аудита)', async ({ page }) => {
  await page.route('**/v1/exchange-ops', (route) => route.fulfill({ status: 500, body: '{}' }));
  await page.locator('.tab', { hasText: 'Statistics' }).click();
  await expect(page).toHaveURL(/\/statistics$/);

  const history = page.locator('.panel', { hasText: 'HISTORY' });
  await expect(history.getByText(/Could not load/i)).toBeVisible();
  await expect(history.getByText(/No exchanges yet|Разменов пока нет/)).toHaveCount(0);
});

test('выбранный вариант в группе виден глазом, а не только скринридеру (находка аудита)', async ({
  page,
}) => {
  await page.locator('.tab', { hasText: 'Settings' }).click();
  const pressed = page.locator('.act[aria-pressed="true"]').first();
  await expect(pressed).toBeVisible();
  // Фон выбранной кнопки отличается от невыбранной — раньше состояние было только в aria.
  const [selectedBg, plainBg] = await Promise.all([
    pressed.evaluate((el) => getComputedStyle(el).backgroundColor),
    page
      .locator('.act[aria-pressed="false"]')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ]);
  expect(selectedBg).not.toBe(plainBg);
});

test('на телефоне сначала цифра дня и диаграмма, а не ведомости', async ({ page }) => {
  /*
   * Решение владельца 2026-08-01: мобильная раскладка должна отдавать смысл быстро, поэтому
   * картинки идут раньше списков. Порядок задан только в CSS (`order`), а такие вещи молча
   * возвращаются при первом же рефакторе разметки — тест держит их на месте.
   */
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/plan');

  const topOf = async (selector: string) => (await page.locator(selector).first().boundingBox())!.y;

  const hero = await topOf('.kpi-hero');
  const donut = await topOf('.kpi-cascade');
  const map = await topOf('.pmap');
  const secondary = await topOf('.kpi-money');
  const panels = await topOf('.panels .panel');

  expect(hero).toBeLessThan(donut);
  expect(donut).toBeLessThan(map);
  // Второстепенные суммы и ведомости — после обоих графиков.
  expect(map).toBeLessThan(secondary);
  expect(secondary).toBeLessThan(panels);
  // Оба графика помещаются в два экрана: ради этого перекладка и делалась.
  expect(map).toBeLessThan(812 * 2);
});

test('на телефоне статистика открывается графиками, а не списком сигналов', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/statistics');

  const structure = (await page.locator('.panel-structure').boundingBox())!.y;
  const periods = (await page.locator('.panel-periods').boundingBox())!.y;
  const signals = (await page.locator('.panel-signals').boundingBox())!.y;

  expect(structure).toBeLessThan(periods);
  expect(periods).toBeLessThan(signals);
});

test('на широком экране порядок прежний: полоса метрик, потом панели', async ({ page }) => {
  // Перекладка касается только телефона; ломать привычный десктоп ради неё нельзя.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/plan');

  const money = (await page.locator('.kpi-money').boundingBox())!;
  const hero = (await page.locator('.kpi-hero').boundingBox())!;
  // Клетки стоят в одну строку: разница по вертикали нулевая, порядок — слева направо.
  expect(Math.abs(money.y - hero.y)).toBeLessThan(2);
  expect(money.x).toBeLessThan(hero.x);
});
