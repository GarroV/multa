import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { enterDemo, resetDemo, stopMotion } from './helpers.ts';

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

test('наведение не роняет контраст в светлой теме (#142)', async ({ page }) => {
  /*
   * Наведение проверяется ЯВНО, а не как побочный эффект клика в соседних сценариях. Раньше hover
   * попадал в замер случайно — курсор оставался над кнопкой после клика, — и падение мигало: три
   * прогона файла давали 11 passed, 2 failed, 1 failed. Мигающий тест хуже падающего: он приучает
   * считать настоящее нарушение шумом.
   *
   * Проверяются все места, где наведение меняет цвет текста на акцентный, а не только то, на
   * котором нарушение заметили: мелкая кнопка, главная кнопка (у неё своя тёмная заливка) и
   * подсказка. Порог у них строгий — кегль 10–11px.
   */
  await resetDemo(page);
  await enterDemo(page);
  await page.locator('.seg-btn', { hasText: /^light$/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  const spots: readonly string[] = ['.act:not(.act-primary)', '.act-primary', '.hint'];
  for (const spot of spots) {
    const target = page.locator(spot).first();
    // Подсказка есть не на каждом экране — отсутствие места не повод падать.
    if ((await target.count()) === 0) continue;
    await target.hover();
    expect(await violations(page), `наведение на ${spot}`).toEqual([]);
  }
});

/**
 * Контраст символьной кнопки замеряем САМИ, а не через axe (issue #145).
 *
 * axe про такие элементы судить отказывается: «Element content contains only non-text characters», —
 * и уводит их в `incomplete`, куда хелпер `violations()` не смотрит. Проверено: тест через axe
 * оставался зелёным, даже когда символ был намеренно выкрашен в `#a8d8e6`. Зелёный тест, который не
 * может упасть, хуже отсутствующего — он выдаёт себя за проверку.
 *
 * Фон собираем вверх по дереву до первого непрозрачного: подложка нажатой кнопки — `rgba(accent,
 * .16)`, и замер «по своему background» считал бы её самим акцентом, завышая контраст.
 */
async function symbolContrast(target: import('@playwright/test').Locator) {
  return target.evaluate((el) => {
    const parse = (c: string) => {
      const n = (c.match(/[\d.]+/g) ?? []).map(Number);
      return { r: n[0] ?? 0, g: n[1] ?? 0, b: n[2] ?? 0, a: n.length > 3 ? (n[3] ?? 1) : 1 };
    };
    type Rgba = ReturnType<typeof parse>;
    const over = (fg: Rgba, bg: Rgba): Rgba => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });
    const lum = (c: Rgba) => {
      const f = (x: number) => {
        const s = x / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };

    const layers: Rgba[] = [];
    for (let node: Element | null = el; node; node = node.parentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c.a > 0) layers.push(c);
      if (c.a === 1) break;
    }
    let bg: Rgba = { r: 255, g: 255, b: 255, a: 1 };
    for (const c of layers.reverse()) bg = over(c, bg);

    const a = lum(parse(getComputedStyle(el).color));
    const b = lum(bg);
    return {
      ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      fontSize: Number.parseFloat(getComputedStyle(el).fontSize),
    };
  });
}

test('включённое состояние символьной кнопки читается в светлой теме', async ({ page }) => {
  /*
   * Нажатое — третье состояние после покоя и наведения, и у него свои цвета: акцентный текст на
   * акцентной подложке. Ровно эта пара уже давала 3.25 при наведении (#142), поэтому включённое
   * проверяется отдельно — иначе «починили hover» означало бы «починили один случай из трёх».
   *
   * Пример на экране — значок настроек формы долга (#126): он помечается нажатым, когда внутри
   * что-то включено, и по замыслу обязан бросаться в глаза.
   */
  await resetDemo(page);
  await enterDemo(page);
  await page.locator('.seg-btn', { hasText: /^light$/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.goto('/obligations');
  await stopMotion(page);

  const gear = page.locator('.act-icon[aria-label]').first();
  await expect(gear).toBeVisible({ timeout: 20_000 });
  await gear.click();
  await page.locator('.obl-settings .seg-btn', { hasText: /^By date$|^Срок$/ }).click();
  await gear.click();
  await expect(gear).toHaveAttribute('aria-pressed', 'true');
  /*
   * Уводим курсор перед замером. После клика мышь остаётся на кнопке, и правило наведения перебивает
   * нажатое состояние — первая версия теста мерила hover и радовалась 5.73, хотя нажатое состояние
   * давало 3.14. Тест мерил не то состояние, которое назван мерить.
   */
  await page.mouse.move(0, 0);

  /*
   * Меряем ИМЕННО этот значок, а не первый попавшийся `.act-icon[aria-pressed="true"]`: на экране
   * есть тумблеры регулярных платежей с тем же атрибутом, и селектор по атрибуту брал их — тест
   * зеленел, проверив не то, что назван проверять.
   */
  const { ratio, fontSize } = await symbolContrast(gear);
  // 10px — мелкий текст, порог AA для него 4.5, а не 3.0.
  expect(fontSize).toBeLessThan(18);
  expect(ratio, `контраст значка ${Math.round(ratio * 100) / 100}`).toBeGreaterThanOrEqual(4.5);
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
  /*
   * Проверка пережила смену механики. Раньше «Закрыть к дате» был системным флажком 13px — его и
   * сторожила: без имени и по нему промахивались пальцем. Теперь это переключатель одной породы с
   * соседями (замечание владельца о разнобое, 16.08.2026), и требование то же самое: имя есть,
   * попасть можно. Сторожим ОБА вида, чтобы правка не увела проверку в пустоту.
   */
  await resetDemo(page);
  await enterDemo(page);
  await page.goto('/obligations');

  /*
   * Переключатели уехали под значок настроек (#126) — сначала раскрываем панель. Проверка от этого не
   * теряет смысл: требование «имя есть, попасть можно» относится к ним в любом месте формы.
   */
  await page
    .getByRole('button', { name: /Настройки долга|Debt settings/ })
    .first()
    .click();
  const controls = page.locator('input[type=checkbox], .toggle');
  await controls.first().waitFor();
  const count = await controls.count();
  expect(count).toBeGreaterThan(0);

  for (let i = 0; i < count; i++) {
    const control = controls.nth(i);
    const name = await control.evaluate(
      (el) => el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.textContent ?? '',
    );
    expect(name.trim().length, `переключатель #${i} без имени`).toBeGreaterThan(0);

    const size = await control.boundingBox();
    expect(size!.height, `высота переключателя #${i}`).toBeGreaterThanOrEqual(24);
  }
});

/*
 * Ни один орган управления не должен быть мельче, чем в него можно попасть.
 *
 * Перепись органов по всем экранам (16.08.2026) показала выпадающих: крестик удаления валюты в
 * настройках — 13px высотой, кнопка разворота раздела в таблице — 17px. По ним промахиваются даже
 * мышью, а пальцем — тем более. Остальные держатся двух семей: 28px (поля, кнопки, переключатели)
 * и 22px (компактные действия и сегменты).
 *
 * Проверка идёт по экранам, а не по одному: выпадающие как раз и заводятся там, куда давно не
 * смотрели.
 */
test('органы управления не мельче минимума для попадания', async ({ page }) => {
  await resetDemo(page);
  await enterDemo(page);

  for (const path of ['/plan', '/plan?view=table', '/obligations', '/settings']) {
    await page.goto(path);
    await page.locator('.panel, .mgrid-row').first().waitFor();

    const tiny = await page.evaluate(() =>
      [...document.querySelectorAll('button, input[type=checkbox]')]
        .map((el) => ({
          box: el.getBoundingClientRect(),
          name: (el.textContent ?? '').trim() || (el as HTMLElement).className,
        }))
        .filter((x) => x.box.height > 0 && x.box.height < 20)
        .map((x) => `${x.name.slice(0, 24)} — ${Math.round(x.box.height)}px`),
    );
    expect(tiny, `мелкие органы на ${path}`).toEqual([]);
  }
});
