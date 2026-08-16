import { expect, test } from '@playwright/test';
import { enterDemo, resetDemo } from './helpers.ts';

/**
 * Визуальные регрессии (issue #17).
 *
 * Набор собран не «на всякий случай», а по фактическим дефектам, которые за одну сессию нашёл глаз
 * владельца и не поймал ни один тест: две неразличимые пиктограммы вместо переключателя вида,
 * таблица впритык к раме окна, кнопка «обязательства» не на уровне соседей, подписи на карте
 * периода друг поверх друга, обрезанная до огрызка кнопка «завести». Каждый пункт ниже — один из
 * этих дефектов, превращённый в проверку.
 *
 * ПОЧЕМУ ЗДЕСЬ ПОЧТИ НЕТ ПИКСЕЛЬНЫХ ЭТАЛОНОВ. Демо живёт на датах: период, «сегодня», ближайшие
 * выплаты меняются каждый день, поэтому эталон целого экрана краснел бы назавтра и его перестали бы
 * читать. Эталоны берутся только с элементов, у которых нет ни дат, ни сумм — с пиктограмм; всё
 * остальное проверяется утверждениями о геометрии, которые от данных не зависят.
 */

/**
 * Гасим переходы и анимации перед замерами. В визуальных проверках это не оптимизация, а условие
 * корректности: с включёнными переходами замер попадает в промежуточный кадр и утверждение
 * проверяет цвет, которого на экране нет ни до, ни после.
 */
async function stopMotion(page: import('@playwright/test').Page): Promise<void> {
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });
}

const WIDTHS = [320, 390, 768, 1024, 1440] as const;
const SCREENS = ['/plan', '/plan?view=table', '/statistics', '/obligations', '/settings'] as const;

/*
 * Демо-сессия нужна только этой группе. Общий beforeEach на весь файл входил в демо и «пустому
 * аккаунту» ниже: тот открывал главную уже залогиненным, формы регистрации не видел и падал по
 * таймауту.
 */
test.describe('демо-данные', () => {
  test.beforeEach(async ({ page }) => {
    await resetDemo(page);
    await enterDemo(page);
  });

  test('страница никогда не прокручивается по горизонтали', async ({ page }) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of SCREENS) {
        await page.goto(path);
        await page.locator('.panel, .mgrid-row').first().waitFor();
        const over = await page.evaluate(() => {
          const de = document.documentElement;
          return { scroll: de.scrollWidth, client: de.clientWidth };
        });
        // Один пиксель прощаем округлению субпиксельной вёрстки, больше — уже уехавшая страница.
        expect(over.scroll - over.client, `${path} на ${width}px`).toBeLessThanOrEqual(1);
      }
    }
  });

  test('кнопки в шапках панелей стоят на одном уровне внутри колонки', async ({ page }) => {
    /*
     * Кнопка «обязательства» висела ниже «править» у соседних панелей: она стояла внутри строки
     * содержимого, а не в шапке. Проверяем не «где она в разметке», а видимое следствие — что каждая
     * кнопка действия принадлежит шапке своей панели по геометрии.
     */
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto('/plan');
    await page.locator('.panel').first().waitFor();

    const misplaced = await page.evaluate(() => {
      const bad: string[] = [];
      for (const panel of document.querySelectorAll('.panel')) {
        const head = panel.querySelector('.panel-head');
        if (!head) continue;
        const headBox = head.getBoundingClientRect();
        for (const act of panel.querySelectorAll('.panel-body .act, .panel-body a.act')) {
          const box = act.getBoundingClientRect();
          // Кнопка-действие уровня панели внутри тела и на своей строке — это и есть та рассинхронизация.
          if (box.width > 0 && box.top > headBox.bottom + 4 && act.closest('.prow')) {
            const label = (act.textContent ?? '').trim();
            const name = panel.getAttribute('aria-label') ?? '';
            // Строчные действия (например «ждём» у выплаты) законны: у них есть своя строка данных.
            const rowHasData = act.closest('.prow')?.querySelector('.prow-num');
            if (!rowHasData) bad.push(`${name}: ${label}`);
          }
        }
      }
      return bad;
    });
    expect(misplaced, 'действия панели должны жить в её шапке').toEqual([]);
  });

  test('ни одна кнопка не обрезана до огрызка', async ({ page }) => {
    /*
     * «ВАЛЮТНЫЕ КОРЗИ…» съедала кнопку «завести» до вертикальной полоски: подпись и кнопка делили
     * одну обрезаемую ячейку. Кнопка уже 24px — это не кнопка, а артефакт.
     */
    for (const width of [390, 1280] as const) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('/plan?view=table');
      await page.locator('.mgrid-row').first().waitFor();

      const stunted = await page.evaluate(() => {
        const bad: string[] = [];
        for (const el of document.querySelectorAll('button, a.act')) {
          const box = el.getBoundingClientRect();
          if (box.width === 0 && box.height === 0) continue;
          if (box.width < 24)
            bad.push(`${(el.textContent ?? '').trim() || el.className} ${box.width}`);
        }
        return bad;
      });
      expect(stunted, `ширина кнопок на ${width}px`).toEqual([]);
    }
  });

  test('подписи в строках таблицы не наезжают на кнопки', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto('/plan?view=table');
    await page.locator('.mgrid-row').first().waitFor();

    const overlaps = await page.evaluate(() => {
      const bad: string[] = [];
      for (const cell of document.querySelectorAll('.mgrid-name')) {
        const parts = [...cell.children].map((el) => ({
          text: (el.textContent ?? '').trim(),
          box: el.getBoundingClientRect(),
        }));
        for (let i = 0; i < parts.length; i += 1) {
          for (let j = i + 1; j < parts.length; j += 1) {
            const a = parts[i]!;
            const b = parts[j]!;
            const x = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
            const y = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
            if (x > 1 && y > 1) bad.push(`«${a.text}» и «${b.text}»`);
          }
        }
      }
      return bad;
    });
    expect(overlaps).toEqual([]);
  });

  test('главное действие читаемо в обеих темах', async ({ page }) => {
    /*
     * Заливка акцентом на подписи 10px: в светлой теме белым по светлому акценту выходило 4.06:1 —
     * ниже нормы AA, и это видно только замером, а не глазом.
     *
     * Тема переключается кнопкой, как это делает человек: подстановка data-theme из теста
     * затиралась хуком темы. И сам контраст не читается «сразу после клика» — смена темы проходит
     * через перерисовку, поэтому ждём устоявшегося значения, а не угадываем задержку.
     */
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/plan');
    await stopMotion(page);
    const primary = page.locator('.act-primary');
    await primary.waitFor();

    /*
     * Замер отдаёт тему И контраст одним куском, а `null` до применения темы: иначе `poll` берёт
     * первое подошедшее значение и, кликнув «светлую», радуется контрасту ещё тёмной.
     *
     * Переходы на экране выключены (см. `stopMotion`): у кнопки анимируются цвет и фон 120ms, и
     * замер сразу после клика попадал в середину анимации — выходили промежуточные 3.99 и 5.59
     * вместо настоящих 12.94 и 4.06. Проверка при этом зеленела на заведомо сломанной светлой
     * теме, то есть врала.
     */
    const contrastIn = (theme: string) => async () => {
      const r = await primary.evaluate((el) => {
        const cs = getComputedStyle(el);
        const rgb = (c: string) => (c.match(/\d+/g) ?? []).slice(0, 3).map(Number);
        const lum = (v: number[]) => {
          const [r1, g1, b1] = v.map((x) => {
            const s = x / 255;
            return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
          });
          return 0.2126 * r1! + 0.7152 * g1! + 0.0722 * b1!;
        };
        const a = lum(rgb(cs.color));
        const b = lum(rgb(cs.backgroundColor));
        return {
          theme: document.documentElement.getAttribute('data-theme'),
          ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        };
      });
      return r.theme === theme ? r.ratio : null;
    };

    const themeButtons = page.getByRole('group', { name: /theme|тема/i }).locator('button');
    for (const [index, theme] of (['dark', 'light'] as const).entries()) {
      await themeButtons.nth(index).click();
      await expect
        .poll(contrastIn(theme), { message: `контраст в теме ${theme}`, timeout: 5_000 })
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  test('колонки таблицы не растягиваются по ширине окна', async ({ page }) => {
    /*
     * `minmax(76px, 1fr)` растягивал шесть колонок на всю ширину монитора: на 2560px «57 420» и
     * «133 980» стояли в полуметре друг от друга, а таблица существует ровно для того, чтобы
     * сравнить их взглядом. Правка минимума не помогала — растягивал `1fr`.
     *
     * Проверяем оба требования сразу: колонки узкие и РАВНЫЕ между собой. Равенство важно не меньше:
     * ради него и держится минимум, иначе каждая колонка сжимается под своё содержимое и столбец
     * перестаёт читаться как столбец.
     */
    await page.setViewportSize({ width: 1900, height: 800 });
    await page.goto('/plan?view=table');
    await page.locator('.mgrid-row').first().waitFor();

    const tracks = await page
      .locator('.mgrid-row')
      .first()
      .evaluate((el) =>
        getComputedStyle(el)
          .gridTemplateColumns.split(' ')
          .map((v) => Math.round(parseFloat(v))),
      );

    // Первая дорожка — подписи, последняя — пустой добор до края; числа живут между ними.
    const numeric = tracks.slice(1, -1);
    expect(numeric.length, 'колонок периодов').toBeGreaterThan(3);
    for (const w of numeric) {
      expect(w, `ширина колонки при окне 1900px: ${numeric.join(', ')}`).toBeLessThanOrEqual(120);
    }
    expect(
      Math.max(...numeric) - Math.min(...numeric),
      'разброс ширин колонок',
    ).toBeLessThanOrEqual(2);
    // Добор обязан существовать: без него разделители обрывались бы там, где кончились числа.
    expect(tracks.at(-1)!, 'пустой добор справа').toBeGreaterThan(100);
  });

  test('весь текст проходит контраст AA в обеих темах', async ({ page }) => {
    /*
     * Проверка не одного элемента, а всего текста: сплошной обход нашёл 4 провала, которые
     * одиночная проверка `.act-primary` не видела, — чипы `.tag` (10px акцентом: cyan 3.82, lime
     * 4.24, amber 4.33 в светлой; vio 4.41 в тёмной), метку «сейчас» в мастер-сетке (4.06) и
     * предупреждение `.st-warn` (4.33). Исправлено текстовыми вариантами акцентов (`--*-ink`).
     *
     * Два свойства измерителя, без которых он врёт:
     *
     * 1. Полупрозрачные фоны смешиваются вниз по цепочке. Без этого `--accent-quiet`
     *    (`rgba(0,229,255,0.14)`) читается как ярко-голубой и даёт три фантомных провала по 1.37.
     * 2. Подписи карты периода исключены: в DOM они лежат внутри `.pmap-line`, у которой фон —
     *    цвет линии оси, а на экране рисуются НИЖЕ этой линии, на панели. Измерять их по
     *    DOM-предку — измерять не тот фон. Чтобы исключение не превратилось в слепое пятно, тест
     *    отдельно проверяет, что подписи и правда не накрывают линию.
     */
    await page.setViewportSize({ width: 1440, height: 900 });

    for (const path of SCREENS) {
      await page.goto(path);
      await page.locator('.panel, .mgrid-row').first().waitFor();
      await stopMotion(page);
      const themeButtons = page.getByRole('group', { name: /theme|тема/i }).locator('button');

      for (const [index, theme] of (['dark', 'light'] as const).entries()) {
        await themeButtons.nth(index).click();
        await expect
          .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
          .toBe(theme);

        const fails = await page.evaluate(() => {
          const parse = (c: string): number[] => {
            const v = (c.match(/[\d.]+/g) ?? []).map(Number);
            return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] === undefined ? 1 : v[3]];
          };
          const lum = (rgb: number[]) => {
            const f = rgb.slice(0, 3).map((x) => {
              const t = x / 255;
              return t <= 0.03928 ? t / 12.92 : Math.pow((t + 0.055) / 1.055, 2.4);
            });
            return 0.2126 * f[0]! + 0.7152 * f[1]! + 0.0722 * f[2]!;
          };
          const bgOf = (el: Element): number[] => {
            const layers: number[][] = [];
            let n: Element | null = el;
            while (n) {
              const c = parse(getComputedStyle(n).backgroundColor);
              if (c[3]! > 0) layers.push(c);
              if (c[3]! >= 1) break;
              n = n.parentElement;
            }
            let base = [255, 255, 255];
            for (const [r, g, b, a] of layers.reverse()) {
              base = [
                r! * a! + base[0]! * (1 - a!),
                g! * a! + base[1]! * (1 - a!),
                b! * a! + base[2]! * (1 - a!),
              ];
            }
            return base;
          };

          const out: string[] = [];
          for (const el of document.querySelectorAll('body *')) {
            if (el.closest('.pmap-line')) continue;
            const hasOwnText = [...el.childNodes].some(
              (n) => n.nodeType === 3 && (n.textContent ?? '').trim(),
            );
            if (!hasOwnText) continue;
            const box = el.getBoundingClientRect();
            if (box.width === 0 || box.height === 0) continue;
            const cs = getComputedStyle(el);
            if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
            const size = parseFloat(cs.fontSize);
            const bold = Number(cs.fontWeight) >= 700;
            const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
            const a = lum(parse(cs.color));
            const b = lum(bgOf(el));
            const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            if (ratio < need) {
              const cls = (el.className || el.tagName).toString().slice(0, 40);
              out.push(`${cls} = ${Math.round(ratio * 100) / 100} (нужно ${need})`);
            }
          }
          return [...new Set(out)];
        });

        expect(fails, `${path} · тема ${theme}`).toEqual([]);
      }
    }
  });

  test('подписи карты периода не накрывают линию оси', async ({ page }) => {
    /*
     * Страховка к исключению в проверке контраста выше: подписи выведены из измерения потому, что
     * визуально они лежат на панели, а не на линии. Если однажды они на линию наедут, контраст
     * измерялся бы не по тому фону — и никто бы не заметил. Здесь это утверждение проверяется.
     */
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/plan');
    await page.locator('.pmap-cap').first().waitFor();

    const overlaps = await page.evaluate(() => {
      const line = document.querySelector('.pmap-line')?.getBoundingClientRect();
      if (!line) return ['нет линии оси'];
      const bad: string[] = [];
      for (const cap of document.querySelectorAll('.pmap-cap')) {
        const r = cap.getBoundingClientRect();
        const overlapY = Math.min(r.bottom, line.bottom) - Math.max(r.top, line.top);
        if (overlapY > 1) bad.push((cap.textContent ?? '').trim().slice(0, 24));
      }
      return bad;
    });
    expect(overlaps).toEqual([]);
  });

  test('пиктограммы переключателя вида различимы', async ({ page }) => {
    /*
     * «▤» и «▦» в интерфейсном шрифте рисовались двумя почти одинаковыми квадратиками. Эталон здесь
     * уместен: у пиктограмм нет ни дат, ни сумм, поэтому он не протухает вместе с демо-данными.
     *
     * Файлы эталонов привязаны к платформе (`-chromium-darwin.png`). Когда появится CI (issue #14),
     * ему понадобятся свои эталоны под Linux — иначе первый же прогон покраснеет из-за разницы
     * растеризации, а не из-за пиктограмм.
     */
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/plan');
    await stopMotion(page);
    const icons = page.locator('.seg-icon');
    await icons.first().waitFor();
    await expect(icons).toHaveCount(2);

    // Пиктограмма обязана быть рисунком, а не символом шрифта: символ снова окажется неразличимым.
    for (const i of [0, 1]) {
      const el = icons.nth(i);
      await expect(el.locator('svg')).toHaveCount(1);
      expect((await el.innerText()).trim()).toBe('');
    }

    // Значки обязаны отличаться друг от друга: одинаковая геометрия — это и есть тот самый дефект.
    const [panels, table] = await Promise.all([
      icons.nth(0).locator('svg').innerHTML(),
      icons.nth(1).locator('svg').innerHTML(),
    ]);
    expect(panels).not.toBe(table);
    // И обе — непустые фигуры, а не пустой <svg> с нужным тегом.
    for (const markup of [panels, table]) {
      expect(markup).toMatch(/<(rect|path|circle|line|polyline)/);
    }
  });
});

/**
 * Пустой аккаунт — отдельный блок, и это не формальность: оба дефекта с кнопками («обязательства»
 * не на уровне соседей, «завести» обрезана до полоски) живут ТОЛЬКО здесь. На демо-данных те
 * кнопки вообще не рисуются, поэтому проверки выше их не увидели бы — они бы зеленели впустую.
 */
test.describe('пустой аккаунт', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    const email = `visual-e2e-${Date.now()}@multa.local`;
    await page.locator('form.card input').nth(0).fill('Visual E2E');
    await page.locator('form.card input').nth(1).fill(email);
    await page.locator('form.card input').nth(2).fill('SmokeTest123!');
    await page.locator('form.card button[type=submit]').click();
    await page.getByRole('button', { name: /^Next$|^Дальше$/ }).click();
    const amounts = page.getByLabel(/^Amount$|^Сумма$/);
    await amounts.first().fill('120000');
    await amounts.last().fill('120000');
    await page.getByRole('button', { name: /^Next$|^Дальше$/ }).click();
    await expect(page).toHaveURL(/\/plan$/, { timeout: 20_000 });
    // Обучение перекрыло бы клики и геометрию: закрываем сразу.
    const tip = page.locator('.tour-tip');
    if (await tip.isVisible().catch(() => false)) {
      await tip.getByRole('button', { name: /Skip|Пропустить/ }).click();
    }
  });

  test('«завести» у пустого раздела таблицы — кнопка, а не полоска', async ({ page }) => {
    /*
     * «ВАЛЮТНЫЕ КОРЗИ…» съедала кнопку до вертикальной полоски: подпись и кнопка делили одну
     * ячейку с overflow: hidden.
     *
     * Мерить сам прямоугольник кнопки бесполезно — `getBoundingClientRect` отдаёт полную ширину
     * даже у наполовину срезанного элемента, потому что обрезает его РОДИТЕЛЬ. Первая версия этой
     * проверки была именно такой и зеленела на сломанном коде. Считаем видимую часть: пересечение
     * кнопки с прямоугольником обрезающего предка.
     */
    for (const width of [390, 1280] as const) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('/plan?view=table');
      const add = page.locator('.mgrid-add');
      await add.first().waitFor();
      const count = await add.count();
      expect(count, 'у пустого аккаунта разделы обязаны предлагать завести строку').toBeGreaterThan(
        0,
      );

      const visible = await page.locator('.mgrid-add').evaluateAll((els) =>
        els.map((el) => {
          const own = el.getBoundingClientRect();
          let clip: DOMRect | null = null;
          for (let p = el.parentElement; p; p = p.parentElement) {
            const cs = getComputedStyle(p);
            if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
              clip = p.getBoundingClientRect();
              break;
            }
          }
          const shownWidth = clip
            ? Math.max(0, Math.min(own.right, clip.right) - Math.max(own.left, clip.left))
            : own.width;
          return { text: (el.textContent ?? '').trim(), own: own.width, shown: shownWidth };
        }),
      );

      for (const v of visible) {
        expect(v.shown, `«${v.text}» видно ${v.shown} из ${v.own} на ${width}px`).toBeGreaterThan(
          v.own * 0.9,
        );
        expect(v.shown, `ширина «${v.text}» на ${width}px`).toBeGreaterThanOrEqual(24);
      }
    }
  });

  test('кнопка «чистого листа» стоит в шапке панели, как «править» у соседей', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto('/plan');
    const panel = page.locator('.panel', { has: page.locator('.panel-tools') }).first();
    await panel.waitFor();

    /*
     * Проверка через poll, а не одним снимком (issue #95).
     *
     * Тест мигал: в полном прогоне падал, в одиночку — никогда. Обе версии из issue проверены и
     * НЕ подтвердились: воркер один (`workers: 1`, `fullyParallel: false`), гонки между ними быть
     * не может; транзиентного нарушения тоже нет — опрос состояния каждые 20мс в течение трёх
     * секунд после загрузки не поймал ни одного. Само падение за пять полных прогонов подряд не
     * воспроизвелось: код с 11.08 сильно изменился.
     *
     * Причина осталась ненайденной, поэтому чинить наугад нечего — но снимать единственное
     * мгновение на странице, которая ещё собирается, мы уже обжигались дважды (возврат фокуса,
     * 1c2f53f). Poll убирает этот класс целиком и ничего не прячет: нарушение, которое осталось
     * на экране, всё равно завалит тест по истечении ожидания.
     */
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const bad: string[] = [];
            for (const p of document.querySelectorAll('.panel')) {
              const head = p.querySelector('.panel-head');
              if (!head) continue;
              for (const act of p.querySelectorAll('.panel-body .prow > .act')) {
                // Действие уровня панели в строке без чисел — ровно тот рассинхрон.
                if (!act.closest('.prow')?.querySelector('.prow-num')) {
                  bad.push(
                    `${p.getAttribute('aria-label') ?? ''}: ${(act.textContent ?? '').trim()}`,
                  );
                }
              }
            }
            return bad;
          }),
        { message: 'действия уровня панели должны стоять в шапке, а не в теле' },
      )
      .toEqual([]);
  });
});
