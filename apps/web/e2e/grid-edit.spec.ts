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

/*
 * Заведение строки прямо в таблице (запрос владельца 16.08.2026: «если я хочу добавить долг то
 * меня перекидывает на окно обязательств. так быть не должно»).
 *
 * Раньше плюс был ссылкой на «Обязательства» — человек терял из виду ту самую таблицу, ради
 * которой пришёл. Проверяем оба свойства: экран не меняется, и строка действительно появляется.
 */
test('долг заводится из таблицы, не уводя с экрана', async ({ page }) => {
  const url = page.url();
  const debts = page.locator('.mgrid-row-head', { hasText: /ДОЛГИ|DEBTS/i }).first();
  await debts.getByRole('button', { name: /Добавить строку|Add a row/i }).click();

  const form = page.locator('.mgrid-addform');
  await expect(form).toBeVisible();
  expect(page.url()).toBe(url);

  await form.getByLabel(/^Название$|^Name$/).fill('Кредит на технику');
  await form.getByLabel(/^Осталось$|^Left to pay$/).fill('30000');
  await form.getByLabel(/^Платёж$|^Payment$/).fill('5000');
  await form.getByRole('button', { name: /^Добавить$|^Add$/ }).click();

  // Строка появляется в самой таблице, а не «где-то в разделе».
  await expect(page.locator('.mgrid-row-item', { hasText: 'Кредит на технику' })).toBeVisible({
    timeout: 15_000,
  });
  expect(page.url()).toBe(url);
});

/*
 * «Отмена» рядом с «Добавить» должна быть кнопкой того же роста, а не мелким ярлыком.
 *
 * Замер до правки: «Добавить» 52x34, «Отмена» 60x23 — разной высоты и разного вида, потому что
 * второстепенное действие набиралось классом ярлыка. Рядом друг с другом они читались как разные
 * породы элементов, хотя это две кнопки одной формы (замечание владельца 16.08.2026).
 */
test('отмена и добавить — кнопки одного роста', async ({ page }) => {
  await page
    .locator('.mgrid-row-head', { hasText: /ДОЛГИ|DEBTS/i })
    .first()
    .getByRole('button', { name: /Добавить строку|Add a row/i })
    .click();

  const form = page.locator('.mgrid-addform');
  const add = await form.getByRole('button', { name: /^Добавить$|^Add$/ }).boundingBox();
  const cancel = await form.getByRole('button', { name: /^Отмена$|^Cancel$/ }).boundingBox();

  expect(Math.abs(add!.height - cancel!.height)).toBeLessThanOrEqual(2);
});

/*
 * Горизонт таблицы переключается (вопрос владельца 16.08.2026: «почему показывает планирование
 * всего на 3 месяца?»). Было шесть периодов намертво — при выплатах дважды в месяц ровно три
 * месяца. Теперь по умолчанию двенадцать, и горизонт можно растянуть до двадцати четырёх.
 */
test('горизонт таблицы переключается и меняет число колонок', async ({ page }) => {
  const columns = () => page.locator('.mgrid-row-periods .mgrid-cell').count();
  await expect.poll(columns).toBe(12);

  await page.getByRole('button', { name: '24', exact: true }).click();
  await expect.poll(columns).toBe(24);

  await page.getByRole('button', { name: '6', exact: true }).click();
  await expect.poll(columns).toBe(6);
});

/*
 * Строки подвала таблицы стоят в своих колонках (регрессия 16.08.2026).
 *
 * Я добавил класс `.mgrid-foot` для подсказки с переключателем горизонта, не заметив, что такое
 * имя уже занято группой итогов таблицы. Мой `display: flex` в конце файла победил её сетку, и
 * «Свободный остаток» уехал в середину строки «К размену» — два ряда слиплись в один.
 *
 * Проверяем то, что глазами и видно: подпись итоговой строки стоит слева, у самого края таблицы,
 * а не посреди неё.
 */
test('строки подвала стоят друг под другом, а не в одну линию', async ({ page }) => {
  /*
   * Регрессия 16.08.2026: я объявил класс `.mgrid-foot` для строки подсказки, не заметив, что имя
   * занято группой итоговых строк. `display: flex` из моего правила победил, и строки подвала
   * встали в ряд — «Свободный остаток» уехал в середину строки «К размену».
   *
   * Первая версия проверки смотрела на координату подписи и поломку НЕ поймала: подпись первой
   * строки остаётся у левого края и в сломанной раскладке. Проверяем то, что видно глазами: каждая
   * следующая строка ниже предыдущей и начинается с того же левого края.
   */
  /*
   * Широкое окно обязательно: при узком строки не помещаются рядом и переносятся сами, поэтому
   * поломка не видна. Владелец увидел её именно на широком мониторе.
   */
  await page.setViewportSize({ width: 2000, height: 900 });
  /*
   * И горизонт 6: при двенадцати колонках строка шире половины окна и переносится сама, пряча
   * поломку. Владелец видел её именно на коротком горизонте — там две строки помещаются рядом.
   */
  await page.getByRole('button', { name: '6', exact: true }).click();
  const rows = page.locator('.mgrid-group.mgrid-foot .mgrid-row');
  // Ждём отрисовки: count() не ждёт сам, и на непрогруженной таблице проверка была бы пустой.
  await rows.first().waitFor();
  const count = await rows.count();
  expect(count).toBeGreaterThan(1);

  let prev = await rows.nth(0).boundingBox();
  for (let i = 1; i < count; i++) {
    const box = await rows.nth(i).boundingBox();
    expect(box!.y, `строка подвала #${i} не ниже предыдущей`).toBeGreaterThan(prev!.y);
    expect(Math.abs(box!.x - prev!.x), `строка подвала #${i} сдвинута вбок`).toBeLessThanOrEqual(1);
    prev = box;
  }
});
