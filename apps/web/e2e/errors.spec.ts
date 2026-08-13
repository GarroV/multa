import { expect, test } from '@playwright/test';
import { enterDemo, resetDemo } from './helpers.ts';

/**
 * Граница ошибок (Спринт 6). До неё любая ошибка рендера давала белый экран: человек видел пустоту
 * и не мог понять, что делать, а мы не узнавали о поломке никогда — она умирала в его консоли.
 *
 * Ошибка подстраивается искусственно: ломаем ответ ручки плана так, чтобы экран упал на рендере.
 * Проверяем ровно две вещи, ради которых граница и нужна: человек видит объяснение и кнопку, а мы
 * получаем отчёт.
 */
test('падение экрана показывает объяснение и присылает отчёт', async ({ page }) => {
  await resetDemo(page);

  const reports: string[] = [];
  await page.route('**/v1/client-errors', async (route) => {
    reports.push(route.request().postData() ?? '');
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  /*
   * Тело проходит разбор JSON, но валит рендер: экран обходит `allocations` списком, а получает
   * null. Это ровно тот класс поломок, ради которого граница и ставится, — не сбой сети, который
   * приложение умеет показать, а неожиданная форма данных внутри отрисовки.
   */
  await page.route('**/v1/plan/current*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ allocations: null, income: null, periodId: 'x' }),
    }),
  );

  await enterDemo(page).catch(() => undefined);

  await expect(page.getByText(/Что-то сломалось/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: /Перезагрузить/ })).toBeVisible();
  await expect.poll(() => reports.length, { timeout: 10_000 }).toBeGreaterThan(0);
});
