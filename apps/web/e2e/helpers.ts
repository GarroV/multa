import { expect, type Page } from '@playwright/test';

/**
 * Общие шаги E2E. Здесь же живёт адрес api: он отличается от `baseURL` (там web), и запрос сброса,
 * отправленный на веб-порт, тихо возвращал index.html — демо не пересеивалось, а тесты об этом не
 * знали, потому что ошибка глушилась `catch`. Такой сброс обязан падать громко.
 */
export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3100';

/**
 * Возвращает демо к исходному наполнению: тесты пишут в общий воркспейс и пачкают его.
 *
 * Сначала вход, потом сброс: с тех пор как приложение доступно из интернета, сбросить демо может
 * только тот, кто в нём сидит (иначе один POST переписывал бы всю демо-базу по запросу кого угодно).
 */
export async function resetDemo(page: Page): Promise<void> {
  const entered = await page.request.post(`${API_URL}/v1/demo/enter`);
  expect(entered.ok(), `вход в демо не удался: ${entered.status()}`).toBe(true);
  const res = await page.request.post(`${API_URL}/v1/demo/reset`);
  expect(res.ok(), `сброс демо не удался: ${res.status()}`).toBe(true);
}

/** Вход в демо и ожидание собранного плана — точка старта почти каждого сценария. */
export async function enterDemo(page: Page): Promise<void> {
  await page.goto('/demo');
  await expect(page).toHaveURL(/\/plan$/, { timeout: 20_000 });
}
