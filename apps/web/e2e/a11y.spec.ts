import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { enterDemo, resetDemo } from './helpers.ts';

/**
 * Автоматическая проверка доступности (web/testing.md: «Run automated accessibility checks»).
 *
 * До этого доступность проверялась выборочно и руками: контрастная развёртка, клавиатурные
 * сценарии, роли у своей выпадашки. Так ловятся те нарушения, о которых вспомнили, — а нужны те, о
 * которых забыли.
 *
 * Ограничение честное: axe находит не всё и не заменяет живого человека с экранным читателем. Но
 * то, что находит, — это факт, а не вкус: поле без подписи, кнопка без имени, заголовки через
 * уровень.
 */
async function violations(page: import('@playwright/test').Page) {
  /*
   * Останавливаем переходы перед замером. У кнопок есть плавная смена цвета на наведении, и axe
   * успевает померить ПРОМЕЖУТОЧНЫЙ цвет: в трёх прогонах подряд одно и то же место давало 3.25,
   * 3.4 и 2.11 — числа плавали, потому что мерился разный кадр анимации.
   *
   * Тот же приём уже используется в визуальной развёртке по той же причине. Настоящий контраст —
   * это цвет покоя и цвет наведения, а не то, что между ними.
   */
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });
  const result = await new AxeBuilder({ page })
    // Уровень AA: тот же, что в наших правилах для контраста.
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return result.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.length,
    where: v.nodes[0]?.target.join(' '),
    // Причина словами axe: без неё «нарушение контраста» не говорит, какие именно цвета сошлись.
    why: v.nodes[0]?.any[0]?.message ?? v.nodes[0]?.failureSummary?.split('\n')[1] ?? '',
  }));
}

test('лендинг доступен', async ({ page }) => {
  await page.goto('/');
  expect(await violations(page)).toEqual([]);
});

test('вход доступен', async ({ page }) => {
  await page.goto('/login');
  expect(await violations(page)).toEqual([]);
});

test('план доступен', async ({ page }) => {
  await resetDemo(page);
  await enterDemo(page);
  expect(await violations(page)).toEqual([]);
});

test('статистика доступна', async ({ page }) => {
  await resetDemo(page);
  await enterDemo(page);
  await page.goto('/statistics');
  expect(await violations(page)).toEqual([]);
});

test('мастер-сетка доступна', async ({ page }) => {
  /*
   * Таблица — отдельный риск: у неё свои роли, и правимые ячейки стали кнопками. Кнопка без
   * различимого имени в таблице из шести колонок делает её нечитаемой на слух.
   */
  await resetDemo(page);
  await enterDemo(page);
  await page.goto('/plan?view=table');
  await expect(page.locator('.mgrid')).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test('лист чека доступен', async ({ page }) => {
  await resetDemo(page);
  await enterDemo(page);
  /*
   * Тема задаётся явно. Первая версия помечала тест «ожидаемо падающим» в Safari — и упала на CI
   * тем, что ПРОШЛА: на моей машине Safari стартовал в светлой теме, на линуксовом раннере в
   * тёмной. Определяет здесь тема, а не браузер, и привязка к браузеру была рассуждением по
   * совпадению.
   */
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: /^Receipt$|^Чек$/ }).click();
  await expect(page.locator('.sheet')).toBeVisible();

  /*
   * Исключения по контрасту здесь больше нет (#111). Оно заглушало правило ради нарушения, которое
   * в детерминированных условиях не воспроизводится: тема задана явно, переходы заморожены — ноль
   * находок. Замолчавшее правило охраняет призрака и не скажет ни слова, когда появится настоящее
   * нарушение; лучше падение с внятной диагностикой, чем тишина.
   */
  expect(await violations(page)).toEqual([]);
});

test('лист ввода траты доступен', async ({ page }) => {
  /*
   * Формы — самое опасное место: поле без подписи выглядит нормально и полностью непригодно для
   * экранного читателя. Лист открываем, потому что до открытия его в разметке нет.
   */
  await resetDemo(page);
  await enterDemo(page);
  await page.locator('.act-primary').click();
  await expect(page.locator('.sheet')).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test('обязательства доступны', async ({ page }) => {
  await resetDemo(page);
  await enterDemo(page);
  await page.goto('/obligations');
  expect(await violations(page)).toEqual([]);
});

test('настройки доступны', async ({ page }) => {
  await resetDemo(page);
  await enterDemo(page);
  await page.goto('/settings');
  expect(await violations(page)).toEqual([]);
});

/*
 * Флажок «закрыть к дате» без собственного имени (#112, пункт 5).
 *
 * Он работает через оборачивающий `label`, поэтому axe молчит — формально доступное имя есть. Но
 * ширина у него 13px: на узком экране и на сенсорном попасть по нему сложно, а увеличить область
 * нажатия одним лишь `label` нельзя, пока сам флажок не назван и не увеличен.
 *
 * Проверяем оба свойства: имя у элемента своё, и он не меньше 24px — минимума, ниже которого
 * промахиваются пальцем.
 */
test('переключатели формы названы и достаточно крупные, чтобы попасть', async ({ page }) => {
  await resetDemo(page);
  await enterDemo(page);
  await page.goto('/obligations');
  await page.locator('input[type=checkbox]').first().waitFor();
  const boxes = page.locator('input[type=checkbox]');
  const count = await boxes.count();
  expect(count).toBeGreaterThan(0);

  for (let i = 0; i < count; i++) {
    const box = boxes.nth(i);
    const name = await box.evaluate(
      (el) => el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '',
    );
    expect(name.length, `флажок #${i} без собственного имени`).toBeGreaterThan(0);

    const size = await box.boundingBox();
    expect(size!.width, `ширина флажка #${i}`).toBeGreaterThanOrEqual(24);
    expect(size!.height, `высота флажка #${i}`).toBeGreaterThanOrEqual(24);
  }
});
