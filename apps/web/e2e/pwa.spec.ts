import { expect, test } from '@playwright/test';
import { API_URL, enterDemo, resetDemo } from './helpers.ts';

/**
 * PWA (Спринт 6): приложение ставится на телефон и открывается без сети.
 *
 * Проверяется то, что было нечем проверить раньше, потому что этого не существовало: манифест,
 * иконка и честный признак отсутствия сети. Кэширование оболочки живёт в service worker, который в
 * деве намеренно не регистрируется — там он отдавал бы вчерашние ассеты и превращал отладку в охоту
 * за призраками, — поэтому здесь проверяется поведение приложения, а не самого worker'а.
 */
test('манифест и иконка отдаются и описывают устанавливаемое приложение', async ({ page }) => {
  const manifest = await page.request.get('/manifest.webmanifest');
  expect(manifest.status()).toBe(200);
  const parsed = (await manifest.json()) as {
    name: string;
    start_url: string;
    display: string;
    icons: { src: string; sizes: string }[];
  };
  expect(parsed.name).toBe('Multa');
  // Со «сегодня», а не с корня: корень редиректит, и установленное приложение мигало бы переходом.
  expect(parsed.start_url).toBe('/plan');
  expect(parsed.display).toBe('standalone');
  expect(parsed.icons.some((i) => i.sizes === '512x512')).toBe(true);

  const icon = await page.request.get(parsed.icons[0]!.src);
  expect(icon.status()).toBe(200);
  expect(icon.headers()['content-type']).toContain('image/png');

  // Страница объявляет манифест — без этого браузер не предложит установку.
  await page.goto('/');
  await expect(page.locator('link[rel=manifest]')).toHaveAttribute('href', '/manifest.webmanifest');
});

test('пропавшая сеть видна человеку, а не молчит', async ({ page, context }) => {
  /*
   * Полоса живёт выше гейта авторизации: без сети запрос `/v1/me` не проходит, гейт показывает
   * лендинг — и полоса, спрятанная в оболочке приложения, не появлялась именно тогда, когда нужна.
   * Поймано красным CI (локально сеть отваливалась уже после загрузки, на чистой машине — раньше),
   * поэтому проверяем оба состояния: до входа и внутри приложения.
   */
  await page.goto('/');
  await context.setOffline(true);
  await expect(page.locator('.offline-bar')).toBeVisible({ timeout: 10_000 });
  await context.setOffline(false);

  await resetDemo(page);
  await enterDemo(page);

  await context.setOffline(true);
  // Событие 'offline' браузер шлёт сам; ждём именно реакции интерфейса.
  await expect(page.locator('.offline-bar')).toBeVisible({ timeout: 10_000 });

  await context.setOffline(false);
  await expect(page.locator('.offline-bar')).toBeHidden({ timeout: 10_000 });
});

test('трата, записанная без сети, доезжает при её возвращении', async ({ page, context }) => {
  /*
   * Приложение открывается из кэша, значит трату записывают и в метро. Молча проглотить её хуже,
   * чем отказать: человек видел «записано» и больше к этой покупке не вернётся.
   *
   * Проверяется весь путь: без сети запись уходит в очередь, при возврате отправляется сама, и
   * появляется РОВНО одна трата — повтор не должен удваивать расход.
   */
  await resetDemo(page);
  await enterDemo(page);

  /*
   * Сумма нарочно необычная: узнаём свою запись по ней. Умное поле в тесте не трогаем — на blur оно
   * уходит в серверный разбор, которого без сети нет, и проверка превратилась бы в проверку разбора.
   */
  const amount = String(300 + (Date.now() % 700));
  await page.locator('.act-primary').click();
  const sheet = page.locator('.sheet');
  await expect(sheet).toBeVisible();

  await context.setOffline(true);
  await expect(page.locator('.offline-bar')).toBeVisible({ timeout: 10_000 });

  await sheet.locator('input[placeholder="0"]').fill(amount);
  await sheet.getByRole('button', { name: 'Log it' }).click();

  // Очередь непуста: запись жива, хотя сервера нет.
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('multa.outbox.v1') ?? '[]').length),
    )
    .toBeGreaterThan(0);

  await context.setOffline(false);

  // Очередь опустела сама, без нажатий.
  await expect
    .poll(
      () => page.evaluate(() => JSON.parse(localStorage.getItem('multa.outbox.v1') ?? '[]').length),
      { timeout: 20_000 },
    )
    .toBe(0);

  // И трата ровно одна: повтор не удвоил расход.
  const list = await page.request
    .get(`${API_URL}/v1/transactions?from=2020-01-01&to=2030-01-01`)
    .then((r) => r.json() as Promise<{ transactions: { amountMinor: string }[] }>);
  const minor = `${amount}00`;
  expect(list.transactions.filter((tx) => tx.amountMinor === minor)).toHaveLength(1);
});
