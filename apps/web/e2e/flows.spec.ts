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

test('подписи на карте периода не встают вплотную на телефоне (#87)', async ({ page }) => {
  /*
   * Зазор между подписями считался в процентах оси, и на телефоне те же 9% давали 31px вместо
   * 130px: соседние подписи вставали в один-три пикселя друг от друга, а при другой раскладке дат
   * прямо налезали одна на другую.
   *
   * Проверяется зазор, а не пересечение: пересечение зависит от того, какие события попали в
   * период сегодня, и тест на него зелёный через день после того, как баг вернулся. Требование
   * «между подписями видно пустое место» от данных не зависит.
   */
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/plan');
  await page.locator('.pmap-cap').first().waitFor();

  const boxes = await page.locator('.pmap-cap').evaluateAll((els) =>
    els
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, text: el.textContent ?? '' };
      })
      .sort((a, b) => a.left - b.left),
  );

  const MIN_GAP_PX = 8;
  for (let i = 1; i < boxes.length; i += 1) {
    const prev = boxes[i - 1]!;
    const cur = boxes[i]!;
    expect(
      cur.left - prev.right,
      `«${prev.text}» и «${cur.text}» стоят вплотную`,
    ).toBeGreaterThanOrEqual(MIN_GAP_PX);
  }
});

test('обязательство можно исправить, а не только завести и удалить (#91)', async ({ page }) => {
  /*
   * У долгов, конвертов, целей и корзин была только пара «создать/удалить»: опечатку в названии или
   * неверную сумму чинили удалением строки, а вместе с долгом уходила история платежей и прогноз
   * закрытия. Проверяем весь путь, а не ручку: правка из интерфейса и то, что она пережила
   * перезагрузку, — иначе легко получить «сохранено» только на экране.
   */
  await page.goto('/obligations');
  const row = page.locator('.prow', { hasText: 'Bank credit' }).first();
  await row.getByRole('button', { name: /edit|править/i }).click();

  const editor = page
    .locator('.fx-form', { has: page.getByRole('button', { name: /^Save$|^Сохранить$/ }) })
    .first();
  await editor.getByLabel(/^Name$|^Название$/).fill('Bank credit 2');
  await editor.getByRole('button', { name: /^Save$|^Сохранить$/ }).click();

  await expect(page.locator('.prow', { hasText: 'Bank credit 2' }).first()).toBeVisible({
    timeout: 10_000,
  });
  await page.reload();
  await expect(page.locator('.prow', { hasText: 'Bank credit 2' }).first()).toBeVisible();
});

test('срок и смена суммы задаются из меню строки и переживают перезагрузку', async ({ page }) => {
  /*
   * Живой случай владельца: «интернет 2 500 до октября, потом 4 000». Срок «с — по» и ступени
   * суммы нужны редко, поэтому спрятаны за «…» — строка остаётся из названия, повтора и суммы.
   *
   * Проверяется именно сохранение: раньше такое выражалось двумя строками, и человек видел в
   * списке два интернета вместо одного.
   */
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/obligations');
  const rows = page.locator('.panel', { hasText: /RECURRING|РЕГУЛЯРНЫЕ/i }).locator('.prow');
  const row = rows.first();
  await row.getByRole('button', { name: /Dates and amount|Срок и смена/i }).click();

  const panel = page
    .locator('.fx-form', { has: page.getByRole('button', { name: /^Save$|^Сохранить$/ }) })
    .first();
  await expect(panel).toBeVisible();

  await panel.getByRole('button', { name: /From a date|С даты/i }).click();
  // Третье поле даты — дата ступени: первые два это срок «с» и «по».
  await panel.locator('input[type=date]').nth(2).fill('2026-10-01');
  await panel
    .getByLabel(/^Amount$|^Сумма$/)
    .last()
    .fill('4000');
  await panel.getByRole('button', { name: /^Save$|^Сохранить$/ }).click();
  await expect(panel).toHaveCount(0, { timeout: 10_000 });

  await page.reload();
  await row.getByRole('button', { name: /Dates and amount|Срок и смена/i }).click();
  await expect(page.locator('input[type=date]').nth(2)).toHaveValue('2026-10-01');
});

test('регулярный платёж виден в мастер-таблице и помечен как не входящий в итоги (#80)', async ({
  page,
}) => {
  /*
   * Человек заводит счёт за интернет и открывает таблицу «что впереди». Раньше строки там не было
   * вовсе, и отсутствие читалось как «платежа не будет».
   *
   * Складывать их в подытоги нельзя — большинство таких трат уже сидит внутри бюджета категории, и
   * «свободный остаток» посчитал бы одни деньги дважды. Поэтому проверяем обе половины: строка
   * есть И рядом стоит честная пометка.
   */
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/plan?view=table');
  await page.locator('.mgrid-row').first().waitFor();

  const head = page.locator('.mgrid-row-head', {
    hasText: /Recurring payments|Регулярные платежи/i,
  });
  await expect(head).toBeVisible();
  await expect(head).toContainText(/not counted in totals|не входит в итоги/i);
});

test('платёж по долгу меняется с даты, и правка переживает перезагрузку', async ({ page }) => {
  /*
   * «Платёж / период» задавался один раз на всю жизнь долга, а он меняется: банк пересчитал,
   * ставка сменилась, договорились иначе. Ступени умел API, но задать их из интерфейса было
   * нельзя — то есть для человека этой возможности не существовало.
   */
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/obligations');
  const row = page.locator('.prow', { hasText: 'Bank credit' }).first();
  await row.getByRole('button', { name: /edit|править/i }).click();

  const editor = page
    .locator('.fx-form', { has: page.getByRole('button', { name: /^Save$|^Сохранить$/ }) })
    .first();
  await editor.getByRole('button', { name: /From a date|С даты/i }).click();
  await editor.locator('input[type=date]').first().fill('2026-11-01');
  await editor
    .getByLabel(/^Amount$|^Сумма$/)
    .last()
    .fill('15000');
  await editor.getByRole('button', { name: /^Save$|^Сохранить$/ }).click();
  await expect(editor).toHaveCount(0, { timeout: 10_000 });

  await page.reload();
  await row.getByRole('button', { name: /edit|править/i }).click();
  await expect(page.locator('input[type=date]').first()).toHaveValue('2026-11-01');
});

test('долг можно завести по сроку — взнос посчитает продукт', async ({ page }) => {
  /*
   * Запрос владельца: «остаток 300 000, хочу закрыть к маю — посчитай платёж». Раньше форма
   * спрашивала только взнос, и человек делил в уме.
   *
   * Округление вверх намеренно: посчитанный вниз взнос оставляет хвост, и долг закрывается периодом
   * позже обещанного — то есть продукт соврал бы ровно в том, ради чего его спросили.
   */
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto('/obligations');

  const panel = page.locator('.panel', { hasText: /DEBTS|ДОЛГИ/i }).first();
  await panel.getByRole('checkbox').first().check();
  await panel.getByPlaceholder(/^Name$|^Название$/).fill('Кредитка');
  await panel.getByPlaceholder(/^Amount$|^Сумма$/).fill('300000');
  await panel.locator('input[type=date]').first().fill('2027-05-10');

  // Считаем вслух: взнос виден до нажатия «добавить», а не после.
  await expect(panel.locator('.sub.dim').last()).toContainText(/per period|за период/i);
});
