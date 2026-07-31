import { expect, type Page } from '@playwright/test';

/**
 * Общие шаги E2E. Здесь же живёт адрес api: он отличается от `baseURL` (там web), и запрос сброса,
 * отправленный на веб-порт, тихо возвращал index.html — демо не пересеивалось, а тесты об этом не
 * знали, потому что ошибка глушилась `catch`. Такой сброс обязан падать громко.
 */
export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3100';

/** Возвращает демо к исходному наполнению: тесты пишут в общий воркспейс и пачкают его. */
export async function resetDemo(page: Page): Promise<void> {
  const res = await page.request.post(`${API_URL}/v1/demo/reset`);
  expect(res.ok(), `сброс демо не удался: ${res.status()}`).toBe(true);
}

/** Вход в демо и ожидание собранного плана — точка старта почти каждого сценария. */
export async function enterDemo(page: Page): Promise<void> {
  await page.goto('/demo');
  await expect(page).toHaveURL(/\/plan$/, { timeout: 20_000 });
}
