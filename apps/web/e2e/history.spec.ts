import { expect, test } from '@playwright/test';
import { enterDemo, resetDemo } from './helpers.ts';

/**
 * История трат (issue #137, вопрос владельца «где история трат у нас в проекте вообще?»).
 *
 * Экран отвечает на три вопроса, и каждый проверяется здесь: «что я тратил в этом периоде»,
 * «сколько ушло на одну категорию», «где та покупка, я помню только слово в заметке».
 *
 * Проверка идёт через интерфейс, а не через API: сломать экран можно, не тронув ни один хендлер —
 * что и случалось (фильтр, который не долетает до запроса, читается в коде как рабочий).
 */

test.beforeEach(async ({ page }) => {
  await resetDemo(page);
  await enterDemo(page);
});

test('история открывается из навигации и показывает траты по дням', async ({ page }) => {
  await page.locator('.tab', { hasText: 'History' }).click();
  await expect(page).toHaveURL(/\/history$/);

  // Демо посеяно тратами, поэтому пустой список здесь означал бы, что запрос не долетел.
  const rows = page.locator('.prow');
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.panel-sum')).toContainText(/rows: \d+/);
});

test('фильтр по категории сужает список и итог', async ({ page }) => {
  await page.goto('/history');
  const spendRows = page.locator('.prow:not(.mgrid-row-sub)');
  await expect(spendRows.first()).toBeVisible({ timeout: 20_000 });

  /*
   * Категория берётся из самих данных, а не задаётся в тесте: демо пересеивается, и «Eating out» в
   * текущем периоде может не оказаться вовсе. Тест, привязанный к конкретному имени, падал бы на
   * содержимом сида, а не на поведении фильтра.
   */
  const first = await spendRows.first().locator('.prow-name > span').first().innerText();
  const countBefore = await spendRows.count();

  await page.locator('.sel-trigger').click();
  await page.locator('.sel-item', { hasText: first }).first().click();
  await expect(page.locator('.sel-trigger')).toContainText(first);

  /*
   * Утверждения только авто-ожидающие: смена фильтра проходит через три состояния — старые строки,
   * пустая загрузка, новые строки, — и любой снимок «сейчас» ловит одно из первых двух. Первая
   * версия теста собирала список через `allInnerTexts` и мигала на соседстве с медленными файлами,
   * обвиняя исправный фильтр. `toHaveCount(0)` ждёт, пока чужих строк не останется, и тем самым
   * ждёт именно конца перехода.
   */
  const alien = spendRows.filter({ hasNotText: first });
  await expect(alien).toHaveCount(0, { timeout: 20_000 });
  await expect(spendRows.first()).toBeVisible();
  expect(await spendRows.count()).toBeLessThanOrEqual(countBefore);
});

test('поиск по заметке находит покупку по слову', async ({ page }) => {
  await page.goto('/history');
  await expect(page.locator('.prow').first()).toBeVisible({ timeout: 20_000 });

  const noted = page.locator('.prow-name .sub').first();
  await expect(noted).toBeVisible({ timeout: 20_000 });
  const note = (await noted.innerText()).replace(/^·\s*/, '').split(' ')[0]!;

  await page.locator('input.grow').fill(note);
  const found = page.locator('.prow-name', { hasText: note });
  await expect(found.first()).toBeVisible();

  // Заведомо отсутствующее слово даёт объяснённую пустоту, а не молча пустой экран.
  await page.locator('input.grow').fill('zzzznosuchnote');
  await expect(page.locator('.prow-note')).toBeVisible();
  await expect(page.locator('.prow-name')).toHaveCount(0);
});

test('период листается назад и возвращается', async ({ page }) => {
  await page.goto('/history');
  await expect(page.locator('.prow').first()).toBeVisible({ timeout: 20_000 });
  const range = page.locator('.panel-tools .micro');
  // Ждём границы, а не первый кадр: до ответа плана в этом месте стоит «загружаем», и захваченное
  // «до» сравнивалось бы с самим состоянием загрузки, а не с периодом.
  await expect(range).toHaveText(/\d{2}\.\d{2} — \d{2}\.\d{2}/, { timeout: 20_000 });
  const current = await range.innerText();

  await page.locator('.panel-tools .act', { hasText: '←' }).click();
  await expect(range).not.toHaveText(current, { timeout: 20_000 });

  const forward = page.locator('.panel-tools .act', { hasText: '→' });
  await forward.click();
  await expect(range).toHaveText(current, { timeout: 20_000 });
  // Из текущего периода вперёд идти некуда — будущих трат не бывает.
  await expect(forward).toBeDisabled();
});
