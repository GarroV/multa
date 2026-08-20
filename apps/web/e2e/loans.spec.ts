import { expect, test } from '@playwright/test';
import { API_URL, enterDemo, resetDemo } from './helpers.ts';

/**
 * Займы (issue #94): деньги, которые должны вернуть мне.
 *
 * Проверяется главное свойство, ради которого заём вынесен отдельно: он НЕ забирает деньги из
 * плана. Долг откладывается каждый период, заём наоборот ждёт прихода — оставь его в раздаче, и
 * цифра дня уменьшится вместо роста, причём числа сойдутся и ошибку никто не заметит.
 */
test.beforeEach(async ({ page }) => {
  await resetDemo(page);
  await enterDemo(page);
});

test('заём заводится, не трогает цифру дня и возвращается частями', async ({ page }) => {
  /*
   * Цифру дня читаем из плана, а не с экрана: первым KPI идёт «всего денег», и проверка по позиции
   * сравнивала бы не то. Заодно это устойчиво к вёрстке — меряем смысл, а не разметку.
   */
  const perDayOf = async (): Promise<string> =>
    page.request
      .get(`${API_URL}/v1/plan/current`)
      .then((r) => r.json() as Promise<{ perDayMinor: string }>)
      .then((p) => p.perDayMinor);
  const before = await perDayOf();

  await page.goto('/obligations');
  const panel = page.locator('.panel', { hasText: /Owed to me|Должны мне/ }).first();
  await expect(panel).toBeVisible();

  await panel.locator('input[placeholder*="owes"], input[placeholder*="должен"]').fill('Petya');
  await panel.locator('input.num').first().fill('5000');
  await panel.getByRole('button', { name: /^Add$|^Добавить$/ }).click();

  const row = panel.locator('.prow', { hasText: 'Petya' }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });

  // Цифра дня не изменилась: заём ничего не откладывает.
  expect(await perDayOf()).toBe(before);

  // Возврат частью: остаток уменьшается.
  await page.goto('/obligations');
  const again = page
    .locator('.panel', { hasText: /Owed to me|Должны мне/ })
    .first()
    .locator('.prow', { hasText: 'Petya' })
    .first();
  await again.getByRole('button', { name: /paid back|вернули/ }).click();
  const input = page
    .locator('.panel', { hasText: /Owed to me|Должны мне/ })
    .locator('input.num')
    .first();
  await input.fill('2000');
  await input.press('Enter');

  await expect(
    page
      .locator('.panel', { hasText: /Owed to me|Должны мне/ })
      .locator('.prow', { hasText: 'Petya' })
      .first(),
  ).toContainText('3', { timeout: 15_000 });
});

/*
 * Разбивка платежа задаётся сразу при заведении долга (замечание владельца 16.08.2026: «какой долг
 * на правку? как сразу задать-то?»).
 *
 * До этого разбивка жила только в правке: чтобы разбить платёж, надо было завести долг с одной
 * суммой, найти его в списке и открыть редактор — ради того, что человек знал с самого начала.
 */
test('долг можно завести сразу с разными суммами по выплатам', async ({ page }) => {
  await page.goto('/obligations');
  const panel = page
    .locator('.panel[aria-label*="ДОЛГИ" i], .panel[aria-label*="DEBTS" i]')
    .first();
  await panel.waitFor();

  await panel.getByPlaceholder(/^Название$|^Name$/).fill('Сбер');
  // Остаток обязателен: долг без суммы к выплате — не долг.
  await panel.getByPlaceholder(/^Осталось$|^Left to pay$/).fill('80000');
  /* Разбивка уехала под значок настроек (#126) — сначала открываем панель. */
  await panel.getByRole('button', { name: /Настройки долга|Debt settings/ }).click();
  await panel.getByRole('button', { name: /Разбить по выплатам|Split across payouts/ }).click();

  // По полю на каждый источник дохода воркспейса — их в демо больше одного.
  const fields = panel.locator('.obl-split input');
  await expect.poll(() => fields.count()).toBeGreaterThan(1);
  await fields.nth(0).fill('5000');
  await fields.nth(1).fill('15000');

  await panel.getByRole('button', { name: /^Добавить$|^Add$/ }).click();
  await expect(panel.getByText('Сбер')).toBeVisible({ timeout: 15_000 });
});

/*
 * Заведённая разбивка должна дойти до плана, а не остаться в форме: именно это и было целью.
 * Отдельная проверка, потому что первая версия теста ловила лишь появление строки в списке — а
 * строка появилась бы и с потерянной разбивкой.
 */
test('разбивка, заданная при заведении, доезжает до долга', async ({ page }) => {
  await page.goto('/obligations');
  const panel = page
    .locator('.panel[aria-label*="ДОЛГИ" i], .panel[aria-label*="DEBTS" i]')
    .first();
  await panel.waitFor();

  await panel.getByPlaceholder(/^Название$|^Name$/).fill('Тинькофф');
  await panel.getByPlaceholder(/^Осталось$|^Left to pay$/).fill('60000');
  /* Разбивка уехала под значок настроек (#126) — сначала открываем панель. */
  await panel.getByRole('button', { name: /Настройки долга|Debt settings/ }).click();
  await panel.getByRole('button', { name: /Разбить по выплатам|Split across payouts/ }).click();
  await panel.locator('.obl-split input').first().fill('7000');
  await panel.getByRole('button', { name: /^Добавить$|^Add$/ }).click();

  await expect(panel.getByText('Тинькофф')).toBeVisible({ timeout: 15_000 });
  // Спрашиваем сам API: показанная строка появилась бы и с потерянной разбивкой.
  const debts = await page.evaluate(async (api: string) => {
    const res = await fetch(`${api}/v1/debts`, { credentials: 'include' });
    return (await res.json()) as { name: string; paymentsBySource: unknown }[];
  }, API_URL);
  const created = debts.find((d) => d.name === 'Тинькофф');
  expect(created?.paymentsBySource).toEqual([
    { sourceId: expect.any(String), amountMinor: '700000' },
  ]);
});

/*
 * Окно платежей задаётся в форме (issue #117, вопрос владельца: «как выбрать период, допустим, что
 * долг у меня в плане с ноября по февраль?»). Раньше это делалось правкой трёх ячеек таблицы.
 */
test('долг можно завести с окном «платим с… по…»', async ({ page }) => {
  await page.goto('/obligations');
  const panel = page
    .locator('.panel[aria-label*="ДОЛГИ" i], .panel[aria-label*="DEBTS" i]')
    .first();
  await panel.waitFor();

  await panel.getByPlaceholder(/^Название$|^Name$/).fill('Рассрочка');
  await panel.getByPlaceholder(/^Осталось$|^Left to pay$/).fill('40000');
  await panel.getByPlaceholder(/^Платёж$|^Payment$/).fill('10000');
  /* Окно платежей уехало под значок настроек (#126). */
  await panel.getByRole('button', { name: /Настройки долга|Debt settings/ }).click();
  await panel.getByRole('button', { name: /Платим с… по…|Pay from… to…/ }).click();
  await panel.getByLabel(/^Платим с$|^Pay from$/).fill('2026-11-01');
  await panel.getByLabel(/^Платим по$|^Pay until$/).fill('2027-02-28');
  await panel.getByRole('button', { name: /^Добавить$|^Add$/ }).click();

  await expect(panel.getByText('Рассрочка')).toBeVisible({ timeout: 15_000 });

  // Окно должно доехать до долга, а не остаться в форме.
  const debts = await page.evaluate(async (api: string) => {
    const res = await fetch(`${api}/v1/debts`, { credentials: 'include' });
    return (await res.json()) as { name: string; paysFrom: string; paysUntil: string }[];
  }, API_URL);
  const created = debts.find((d) => d.name === 'Рассрочка');
  expect([created?.paysFrom, created?.paysUntil]).toEqual(['2026-11-01', '2027-02-28']);
});

/*
 * Новый долг начинает платиться со следующей выплаты (issue #121, замечание владельца: «я внёс
 * новый долг, и он должен привязаться к следующему периоду, не к текущему»).
 *
 * Текущий период уже прожит наполовину: деньги распределены, часть потрачена. Обязательство,
 * заведённое сегодня, откусывало от остатка задним числом — цифра дня падала не потому, что человек
 * потратил, а потому, что он что-то записал.
 *
 * Умолчание ВИДИМОЕ, а не тихое правило сервера: форма говорит, с какой даты начнёт платить, и дату
 * можно изменить. Обратный случай реален — платёж может уходить уже в этом периоде, — и молча
 * занижать обязательства нельзя.
 */
test('новый долг по умолчанию платится со следующего периода, и это видно', async ({ page }) => {
  await page.goto('/obligations');
  const panel = page
    .locator('.panel[aria-label*="ДОЛГИ" i], .panel[aria-label*="DEBTS" i]')
    .first();
  await panel.waitFor();

  // Форма сообщает дату начала до нажатия «добавить», а не после.
  await expect(panel.locator('.obl-from-note')).toBeVisible();

  await panel.getByPlaceholder(/^Название$|^Name$/).fill('Автокредит');
  await panel.getByPlaceholder(/^Осталось$|^Left to pay$/).fill('50000');
  await panel.getByPlaceholder(/^Платёж$|^Payment$/).fill('10000');
  await panel.getByRole('button', { name: /^Добавить$|^Add$/ }).click();
  await expect(panel.getByText('Автокредит')).toBeVisible({ timeout: 15_000 });

  const debts = await page.evaluate(async (api: string) => {
    const res = await fetch(`${api}/v1/debts`, { credentials: 'include' });
    return (await res.json()) as { name: string; paysFrom: string | null }[];
  }, API_URL);
  const created = debts.find((d) => d.name === 'Автокредит');

  // Дата начала — начало следующего периода, а не «сегодня» и не пусто.
  const plan = await page.evaluate(async (api: string) => {
    const res = await fetch(`${api}/v1/plan/current`, { credentials: 'include' });
    return (await res.json()) as { period: { endsOn: string } };
  }, API_URL);
  expect(created?.paysFrom).toBe(plan.period.endsOn);
});

/*
 * «Платёж» и «Срок» — один выбор из двух, а не флажок (issue #117, замечание владельца: «там же
 * чекбокс "до даты" или "сумма", где система сама должна перераспределить выплаты по месяцам»).
 *
 * Способ задать долг ровно один из двух: либо человек называет платёж, либо срок — и продукт
 * считает второе сам. Это взаимоисключающий выбор, и сегмент говорит об этом сам, как в референсе
 * владельца (Mixpanel: 7D / 30D / 3M).
 *
 * Сегмент — ростом с поля этого ряда, а не как в шапке: иначе вернулся бы тот самый разнобой
 * высот, из-за которого ряд и переделывали.
 */
test('способ задать долг выбирается сегментом, и он одного роста с полями', async ({ page }) => {
  await page.goto('/obligations');
  const panel = page
    .locator('.panel[aria-label*="ДОЛГИ" i], .panel[aria-label*="DEBTS" i]')
    .first();
  await panel.waitFor();

  /* Сегмент уехал под значок настроек (#126): в ряду он был четвёртым элементом из семи. */
  await panel.getByRole('button', { name: /Настройки долга|Debt settings/ }).click();
  const seg = panel.locator('.panel-foot .seg').first();
  await expect(seg).toBeVisible();

  // По умолчанию задаём платёж: поле суммы на месте, поля даты нет.
  await expect(panel.getByPlaceholder(/^Платёж$|^Payment$/)).toBeVisible();

  await seg.getByRole('button', { name: /^Срок$|^By date$/ }).click();
  await expect(panel.locator('input[type=date]').first()).toBeVisible();
  await expect(panel.getByPlaceholder(/^Платёж$|^Payment$/)).toHaveCount(0);

  // Рост сегмента совпадает с полями ряда: разброс больше 2px — снова разные породы.
  const heights = await panel.evaluate((p) => {
    const rows = p.querySelectorAll('.panel-foot .form-row');
    const last = rows[rows.length - 1] as HTMLElement;
    return [...last.querySelectorAll('button, input')]
      .map((el) => Math.round(el.getBoundingClientRect().height))
      .filter((h) => h > 0);
  });
  expect(
    Math.max(...heights) - Math.min(...heights),
    `высоты: ${heights.join(', ')}`,
  ).toBeLessThanOrEqual(2);
});

/**
 * Форма долга собрана в один ряд, настройки — по требованию (issue #126, реакция владельца на
 * скрин: «сейчас очень путает»).
 *
 * В ряду стояло семь элементов сразу: два поля, сегмент «Платёж/Срок», знак вопроса, две
 * кнопки-переключателя и «Добавить». Форма уже упрощалась один раз (#117) — значит дело не в
 * стилях, а в том, что ВСЁ показано сразу. Поэтому редкое уезжает под значок, а частое остаётся.
 */
test('форма долга: настройки спрятаны, но не потеряны', async ({ page }) => {
  await page.goto('/obligations');
  const panel = page
    .locator('.panel[aria-label*="ДОЛГИ" i], .panel[aria-label*="DEBTS" i]')
    .first();
  await panel.waitFor();

  // Обычный путь — имя, остаток, платёж, «добавить». Редкое в глаза не бросается.
  const settings = panel.getByRole('button', { name: /Настройки долга|Debt settings/ });
  await expect(settings).toBeVisible();
  await expect(
    panel.getByRole('button', { name: /Разбить по выплатам|Split across payouts/ }),
  ).toBeHidden();
  await expect(
    panel.getByRole('group', { name: /Как задаём долг|How to define the debt/ }),
  ).toBeHidden();

  await settings.click();
  await expect(
    panel.getByRole('button', { name: /Разбить по выплатам|Split across payouts/ }),
  ).toBeVisible();

  /*
   * Скрытая, но включённая настройка обязана быть заметна снаружи: иначе человек закрывает панель и
   * не понимает, почему поле «Платёж» превратилось в дату. Значок помечается нажатым.
   */
  await panel.getByRole('button', { name: /^Срок$|^By date$/ }).click();
  await settings.click();
  await expect(settings).toHaveAttribute('aria-pressed', 'true');
  // Режим виден и по самому полю: вместо суммы платежа — дата закрытия.
  await expect(panel.locator('input[type="date"]').first()).toBeVisible();
});
