import { expect, test } from '@playwright/test';

/**
 * Онбординг и обучение (issue #28).
 *
 * Живёт отдельным файлом, потому что ему нужен чистый браузер: остальные сценарии стартуют с уже
 * открытой демо-сессии, а здесь проверяется путь человека, который пришёл впервые.
 *
 * Суть issue: раньше визард спрашивал про долги и валютные корзины ДО того, как человек увидел
 * продукт, и ответы давались наугад. Теперь обязательный минимум — валюта и доход, а объясняет
 * экран сам, подсветкой блоков.
 */

test('новый человек попадает в план за два шага и видит обучение', async ({ page }) => {
  /*
   * Суть issue #28: раньше визард спрашивал про долги и валютные корзины ДО того, как человек
   * увидел продукт, и ответы давались наугад. Теперь обязательный минимум — валюта и доход, а
   * объясняет экран сам, подсветкой блоков.
   */
  await page.goto('/');
  const email = `tour-e2e-${Date.now()}@multa.local`;
  await page.locator('form.card input').nth(0).fill('Tour E2E');
  await page.locator('form.card input').nth(1).fill(email);
  await page.locator('form.card input').nth(2).fill('SmokeTest123!');
  await page.locator('form.card button[type=submit]').click();

  // Шаг 1: валюта. Шагов в полосе ровно два — долгов и корзин здесь больше нет.
  await expect(page.getByRole('button', { name: /^Next$|^Дальше$/ })).toBeVisible();
  await page.getByRole('button', { name: /^Next$|^Дальше$/ }).click();

  // Шаг 2: доход. Сумма — единственное, что обязательно ввести руками.
  const amounts = page.getByLabel(/^Amount$|^Сумма$/);
  await amounts.first().fill('120000');
  await amounts.last().fill('120000');
  await page.getByRole('button', { name: /^Next$|^Дальше$/ }).click();

  await expect(page).toHaveURL(/\/plan$/, { timeout: 20_000 });

  // Обучение открылось само и показывает первый шаг.
  const tip = page.locator('.tour-tip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('1 / 6');
  // Подсветка не накрывает сам блок: он остаётся видимым внутри рамки.
  await expect(page.locator('.tour-ring')).toBeVisible();
  await expect(page.locator('.kpi-hero')).toBeVisible();

  // Пропуск закрывает тур и больше не возвращает его после перезагрузки.
  await tip.getByRole('button', { name: /Skip|Пропустить/ }).click();
  await expect(page.locator('.tour')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.kpi-hero')).toBeVisible();
  await expect(page.locator('.tour')).toHaveCount(0);
});

test('человек с ежедневным доходом проходит онбординг и получает цифру дня', async ({ page }) => {
  /*
   * Живой тестер (05.08.2026) бросил продукт на шаге дохода: он спрашивал «по каким числам тебе
   * платят», а доход у неё ежедневный — вопрос не про неё. Проверяем весь путь до цифры дня, а не
   * только наличие кнопки: важно, что план на таком доходе действительно собирается.
   */
  await page.goto('/');
  const email = `daily-e2e-${Date.now()}@multa.local`;
  await page.locator('form.card input').nth(0).fill('Daily E2E');
  await page.locator('form.card input').nth(1).fill(email);
  await page.locator('form.card input').nth(2).fill('SmokeTest123!');
  await page.locator('form.card button[type=submit]').click();

  // Шаг 1: валюта по умолчанию.
  await page.getByRole('button', { name: /^Next$|^Дальше$/ }).click();

  // Шаг 2: «каждый день» вместо чисел месяца.
  await page.getByRole('button', { name: /^Every day$|^Каждый день$/ }).click();
  // Полей по числам месяца в этом режиме быть не должно: они спрашивают о том, чего у неё нет.
  await expect(page.getByLabel(/^Day$|^Число$/)).toHaveCount(0);

  await page.getByLabel(/^Label$|^Метка$/).fill('Shifts');
  await page.getByLabel(/per arrival|за раз/i).fill('2500');
  await page.getByRole('button', { name: /^Next$|^Дальше$/ }).click();

  await expect(page).toHaveURL(/\/plan$/, { timeout: 20_000 });

  // Главное: план собрался и цифра дня положительна, а не «0» и не прочерк.
  const hero = page.locator('.kpi-hero .kpi-value').first();
  await expect(hero).toBeVisible({ timeout: 20_000 });
  const perDay = Number((await hero.innerText()).replace(/[^\d]/g, ''));
  expect(perDay).toBeGreaterThan(0);
});

test('занятая почта объясняется по-человечески и предлагает вход', async ({ page }) => {
  /*
   * Жалоба живого пользователя 10.08.2026: «не могу зарегистрироваться». Регистрация работала, а
   * вот отказ приходил текстом better-auth по-английски — «User already exists. Use another
   * email.» — и человек с уже созданным аккаунтом читал это как «нельзя».
   *
   * Проверяем оба свойства: сообщение на языке интерфейса и выход из тупика — кнопку входа с той же
   * почтой. Отказ без пути дальше и есть то, на что жалуются.
   */
  const email = `taken-${Date.now()}@multa.local`;

  await page.goto('/');
  await page.locator('form.card input').nth(0).fill('Первый');
  await page.locator('form.card input').nth(1).fill(email);
  await page.locator('form.card input').nth(2).fill('SmokeTest123!');
  await page.locator('form.card button[type=submit]').click();
  await expect(page.getByRole('button', { name: /^Next$|^Дальше$/ })).toBeVisible({
    timeout: 20_000,
  });

  // Второй заход тем же адресом — из чистого контекста, как это делает другой человек.
  await page.context().clearCookies();
  await page.goto('/');
  await page.locator('form.card input').nth(0).fill('Второй');
  await page.locator('form.card input').nth(1).fill(email);
  await page.locator('form.card input').nth(2).fill('SmokeTest123!');
  await page.locator('form.card button[type=submit]').click();

  const err = page.locator('.danger');
  await expect(err).toBeVisible({ timeout: 20_000 });
  // Ни слова из английского текста библиотеки: сообщение обязано быть нашим.
  await expect(err).not.toContainText('User already exists');
  await expect(
    page.getByRole('button', { name: /Sign in with this email|Войти с этой почтой/ }),
  ).toBeVisible();
});
