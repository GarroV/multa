import { describe, expect, it } from 'vitest';
import {
  formatPayday,
  payoutsToSources,
  percentSum,
  previewDates,
  rhythmToConfig,
  rhythmToPayload,
  withRhythmKind,
  draftToSource,
  onboardingIncome,
  type RhythmForm,
  seedPayouts,
  sourceToDraft,
  draftToPatch,
} from './income.ts';

const twiceMonthly: RhythmForm = {
  kind: 'twiceMonthly',
  days: [10, 25],
  weeks: 2,
  anchorDate: '2026-08-07',
  weekendRule: 'as-is',
};

describe('rhythmToConfig', () => {
  it('два раза в месяц → monthly-days с обоими числами', () => {
    expect(rhythmToConfig(twiceMonthly)).toEqual({
      kind: 'monthly-days',
      days: [10, 25],
      weekendRule: 'as-is',
    });
  });

  it('раз в месяц → monthly-days с одним числом', () => {
    expect(rhythmToConfig({ ...twiceMonthly, kind: 'monthly', days: [5] })).toEqual({
      kind: 'monthly-days',
      days: [5],
      weekendRule: 'as-is',
    });
  });

  it('цикл недель → every-weeks от указанной даты, а не от сегодня', () => {
    expect(rhythmToConfig({ ...twiceMonthly, kind: 'everyWeeks' })).toEqual({
      kind: 'every-weeks',
      weeks: 2,
      startsOn: '2026-08-07',
      weekendRule: 'as-is',
    });
  });
});

describe('withRhythmKind', () => {
  it('возврат к «два раза в месяц» после правки одного числа даёт снова два числа', () => {
    const monthlyDay5 = withRhythmKind({ ...twiceMonthly, days: [5] }, 'monthly');
    expect(monthlyDay5.days).toEqual([5]);
    // Регресс: раньше ритм молча оставался однодневным, а второе поле пустым.
    expect(withRhythmKind(monthlyDay5, 'twiceMonthly').days).toEqual([5, 25]);
  });

  it('«раз в месяц» оставляет первое число', () => {
    expect(withRhythmKind(twiceMonthly, 'monthly').days).toEqual([10]);
  });

  it('не даёт двух одинаковых чисел — откатывает к дефолту', () => {
    const monthly = withRhythmKind({ ...twiceMonthly, days: [25] }, 'monthly');
    expect(withRhythmKind({ ...monthly, days: [25, 25] }, 'twiceMonthly').days).toEqual([10, 25]);
  });

  it('цикл недель числа не трогает', () => {
    expect(withRhythmKind(twiceMonthly, 'everyWeeks')).toEqual({
      ...twiceMonthly,
      kind: 'everyWeeks',
    });
  });
});

describe('formatPayday', () => {
  it('даёт человеческую дату без сдвига таймзоны', () => {
    expect(formatPayday('2026-08-10', 'ru')).toBe('10 авг.');
    expect(formatPayday('2026-08-10', 'en')).toBe('Aug 10');
  });
});

describe('rhythmToPayload', () => {
  it('не отдаёт weekendRule — сервер склеивает его сам', () => {
    expect(rhythmToPayload(twiceMonthly)).toEqual({ kind: 'monthly-days', days: [10, 25] });
  });
});

describe('previewDates', () => {
  it('показывает ближайшие даты выплат для «два раза в месяц»', () => {
    expect(previewDates(twiceMonthly, '2026-08-01', 3)).toEqual([
      '2026-08-10',
      '2026-08-25',
      '2026-09-10',
    ]);
  });

  it('для цикла в две недели даты плывут по календарю', () => {
    expect(previewDates({ ...twiceMonthly, kind: 'everyWeeks' }, '2026-08-01', 3)).toEqual([
      '2026-08-07',
      '2026-08-21',
      '2026-09-04',
    ]);
  });

  it('учитывает правило выходных', () => {
    // 25 июля 2026 — суббота.
    expect(
      previewDates(
        { ...twiceMonthly, kind: 'monthly', days: [25], weekendRule: 'before' },
        '2026-07-01',
        1,
      ),
    ).toEqual(['2026-07-24']);
  });
});

describe('payoutsToSources', () => {
  const payouts = [
    { label: 'Аванс', day: 10, amount: '80000', percent: '40' },
    { label: 'Зарплата', day: 25, amount: '120000', percent: '60' },
  ];

  it('абсолютные суммы → источники с monthly-days и minor units', () => {
    const sources = payoutsToSources(payouts, { currency: 'RUB', usePercent: false, gross: '' });
    expect(sources).toEqual([
      {
        label: 'Аванс',
        currency: 'RUB',
        schedule: { kind: 'monthly-days', days: [10] },
        amount: { kind: 'absolute', amountMinor: '8000000' },
        stability: 'fixed',
        active: true,
        sort: 0,
      },
      {
        label: 'Зарплата',
        currency: 'RUB',
        schedule: { kind: 'monthly-days', days: [25] },
        amount: { kind: 'absolute', amountMinor: '12000000' },
        stability: 'fixed',
        active: true,
        sort: 1,
      },
    ]);
  });

  it('проценты → amount percent с окладом в minor units', () => {
    const sources = payoutsToSources(payouts, {
      currency: 'RUB',
      usePercent: true,
      gross: '200000',
    });
    expect(sources[0]!.amount).toEqual({ kind: 'percent', percent: '40', ofMinor: '20000000' });
  });

  it('пропускает выплаты без валидной суммы', () => {
    const sources = payoutsToSources([{ label: 'Аванс', day: 10, amount: '', percent: '' }], {
      currency: 'RUB',
      usePercent: false,
      gross: '',
    });
    expect(sources).toEqual([]);
  });

  it('пропускает проценты без оклада', () => {
    const sources = payoutsToSources(payouts, { currency: 'RUB', usePercent: true, gross: '' });
    expect(sources).toEqual([]);
  });
});

describe('percentSum', () => {
  it('складывает проценты выплат', () => {
    expect(
      percentSum([
        { label: 'a', day: 10, amount: '', percent: '40' },
        { label: 'b', day: 25, amount: '', percent: '60' },
      ]),
    ).toBe(100);
  });

  it('пустой процент считает нулём', () => {
    expect(percentSum([{ label: 'a', day: 10, amount: '', percent: '' }])).toBe(0);
  });
});

/**
 * Несистемный доход (2026-08-03). Первый живой тестировщик бросил онбординг: доход у неё
 * ежедневный, а форма умела только «число месяца». «Когда как» её случай не описывает — доход
 * предсказуем частотой, и он обязан попадать в план.
 */
describe('draftToSource', () => {
  const opts = { currency: 'RUB' } as const;

  it('ежедневный доход → расписание daily и сумма за раз', () => {
    const out = draftToSource(
      { label: 'Смены', kind: 'daily', day: 25, weekday: 5, amount: '2500' },
      opts,
    );
    expect(out).toEqual({
      label: 'Смены',
      currency: 'RUB',
      schedule: { kind: 'daily' },
      amount: { kind: 'absolute', amountMinor: '250000' },
      // Ежедневный доход по своей природе плавает: помечаем его так, а не выдаём за оклад.
      stability: 'variable',
      active: true,
      sort: 0,
    });
  });

  it('недельный доход → расписание weekly с днём недели', () => {
    const out = draftToSource(
      { label: 'Пятницы', kind: 'weekly', day: 25, weekday: 5, amount: '8000' },
      opts,
    );
    expect(out?.schedule).toEqual({ kind: 'weekly', weekday: 5 });
    expect(out?.stability).toBe('variable');
  });

  it('число месяца → прежнее monthly-days и «оклад»', () => {
    const out = draftToSource(
      { label: 'Аванс', kind: 'monthly', day: 10, weekday: 5, amount: '30000' },
      opts,
    );
    expect(out?.schedule).toEqual({ kind: 'monthly-days', days: [10] });
    expect(out?.stability).toBe('fixed');
  });

  it('пустая метка или нечисловая сумма → null, а не источник с нулём', () => {
    expect(
      draftToSource({ label: '', kind: 'daily', day: 1, weekday: 1, amount: '10' }, opts),
    ).toBe(null);
    expect(
      draftToSource({ label: 'Смены', kind: 'daily', day: 1, weekday: 1, amount: '—' }, opts),
    ).toBe(null);
  });
});

/**
 * Несистемный доход в ОНБОРДИНГЕ (2026-08-05). Редактор источников его уже понимал, а первый экран
 * продукта — нет: он спрашивал «по каким числам тебе платят», и человек с ежедневным доходом
 * упирался в вопрос не про себя. Именно на этом шаге живой тестер и остановился.
 */
describe('onboardingIncome', () => {
  it('ежедневный доход: один источник daily и период двухнедельными отрезками', () => {
    const out = onboardingIncome(
      { mode: 'daily', label: 'Смены', amount: '2500', weekday: 5 },
      { currency: 'RUB', today: '2026-08-05' },
    );
    expect(out?.sources).toHaveLength(1);
    expect(out?.sources[0]?.schedule).toEqual({ kind: 'daily' });
    expect(out?.sources[0]?.amount).toEqual({ kind: 'absolute', amountMinor: '250000' });
    /*
     * Границы периода из дат выплат вывести нельзя — выплата каждый день. Берём двухнедельные
     * отрезки от сегодня: это решение по умолчанию, которое человек меняет в настройках, а не
     * догадка о его зарплате.
     */
    expect(out?.rhythm).toEqual({ kind: 'every-weeks', weeks: 2, startsOn: '2026-08-05' });
    // Ежедневному доходу перенос с выходных не нужен: деньги приходят и в субботу.
    expect(out?.weekendRule).toBe('as-is');
  });

  it('недельный доход: расписание с днём недели, период тот же', () => {
    const out = onboardingIncome(
      { mode: 'weekly', label: 'Подработка', amount: '8000', weekday: 5 },
      { currency: 'RUB', today: '2026-08-05' },
    );
    expect(out?.sources[0]?.schedule).toEqual({ kind: 'weekly', weekday: 5 });
    expect(out?.rhythm.kind).toBe('every-weeks');
  });

  it('без суммы или метки шаг не собирается — план на нуле не строим', () => {
    const opts = { currency: 'RUB', today: '2026-08-05' } as const;
    expect(onboardingIncome({ mode: 'daily', label: '', amount: '2500', weekday: 5 }, opts)).toBe(
      null,
    );
    expect(onboardingIncome({ mode: 'daily', label: 'Смены', amount: '', weekday: 5 }, opts)).toBe(
      null,
    );
  });
});

describe('seedPayouts', () => {
  /*
   * Порядок «аванс → зарплата» на числах 10 и 25 владелец увидел на своём экране (11.08.2026) и
   * назвал бредом — справедливо. Аванс платят за первую половину текущего месяца, ближе к её концу;
   * окончательный расчёт за прошлый месяц приходит в начале следующего (ТК РФ ст. 136 — не позднее
   * 15 числа). То есть 10 — зарплата, 25 — аванс, а не наоборот.
   *
   * Это метка-сид, её можно переписать, но неверный дефолт человек читает как утверждение продукта
   * о том, как устроены его деньги, — и перестаёт доверять остальным цифрам.
   */
  it('на 10 число встаёт зарплата, на 25 — аванс', () => {
    expect(seedPayouts('ru').map((p) => [p.day, p.label])).toEqual([
      [10, 'Зарплата'],
      [25, 'Аванс'],
    ]);
  });

  it('английские метки в том же порядке', () => {
    expect(seedPayouts('en').map((p) => [p.day, p.label])).toEqual([
      [10, 'Salary'],
      [25, 'Advance'],
    ]);
  });

  it('суммы пустые: подставлять человеку чужие цифры нельзя', () => {
    expect(seedPayouts('ru').every((p) => p.amount === '' && p.percent === '')).toBe(true);
  });
});

describe('sourceToDraft', () => {
  /*
   * Правка источника дохода (владелец, 11.08.2026: «а править ты не собираешься?»).
   *
   * До этого источник можно было только завести и удалить. Опечатка в названии чинилась удалением
   * строки — а вместе с источником уходили подтверждённые поступления, которые на него ссылаются.
   * Ручка PATCH в API была с самого начала, не было формы.
   *
   * Черновик — тот же, что у формы добавления: одна форма для «завести» и «поправить» не даёт им
   * разъехаться. Но выразить она может не всякий источник, и там, где не может, обязана честно
   * сказать «нет» — молча переписать процент в абсолютную сумму значит подменить человеку доход.
   */
  const absolute = { kind: 'absolute', amountMinor: '13398000' };

  it('месячный источник: число месяца и сумма в major', () => {
    const draft = sourceToDraft(
      { label: 'Зарплата', schedule: { kind: 'monthly-days', days: [10] }, amount: absolute },
      'RUB',
    );
    expect(draft).toEqual({
      label: 'Зарплата',
      kind: 'monthly',
      day: 10,
      weekday: 5,
      amount: '133980.00',
    });
  });

  it('ежедневный источник: числа месяца у него нет', () => {
    const draft = sourceToDraft(
      { label: 'Смены', schedule: { kind: 'daily' }, amount: absolute },
      'RUB',
    );
    expect(draft?.kind).toBe('daily');
  });

  it('недельный источник сохраняет день недели', () => {
    const draft = sourceToDraft(
      { label: 'Такси', schedule: { kind: 'weekly', weekday: 3 }, amount: absolute },
      'RUB',
    );
    expect(draft?.kind).toBe('weekly');
    expect(draft?.weekday).toBe(3);
  });

  it('процент от суммы форма не выражает — отказ, а не пересчёт в рубли', () => {
    const draft = sourceToDraft(
      {
        label: 'Аванс',
        schedule: { kind: 'monthly-days', days: [25] },
        amount: { kind: 'percent', percent: '40', ofMinor: '20000000' },
      },
      'RUB',
    );
    expect(draft).toBe(null);
  });

  it('две выплаты в одном источнике: одно поле «число» их не выразит', () => {
    const draft = sourceToDraft(
      { label: 'Оклад', schedule: { kind: 'monthly-days', days: [10, 25] }, amount: absolute },
      'RUB',
    );
    expect(draft).toBe(null);
  });

  it('ритм «раз в N недель» формой не правится', () => {
    const draft = sourceToDraft(
      { label: 'Гонорар', schedule: { kind: 'every-weeks', weeks: 2 }, amount: absolute },
      'RUB',
    );
    expect(draft).toBe(null);
  });

  it('черновик едет обратно в источник без потерь', () => {
    const source = {
      label: 'Зарплата',
      schedule: { kind: 'monthly-days', days: [10] },
      amount: absolute,
    };
    const draft = sourceToDraft(source, 'RUB');
    const back = draftToSource(draft!, { currency: 'RUB' });
    expect(back?.schedule).toEqual(source.schedule);
    expect(back?.amount).toEqual(absolute);
  });
});

describe('draftToPatch', () => {
  /*
   * Правка меняет ровно то, что показывает: название, ритм, сумму. `stability`, `active` и `sort`
   * в форме не выведены, и трогать их она не имеет права — иначе смена ритма молча снимала бы с
   * дохода пометку «плавает», которую человек поставил сам.
   */
  it('отдаёт только показанные поля', () => {
    const patch = draftToPatch(
      { label: 'Зарплата', kind: 'monthly', day: 10, weekday: 5, amount: '133980' },
      'RUB',
    );
    expect(Object.keys(patch!).sort()).toEqual(['amount', 'label', 'schedule']);
  });

  it('пустая сумма — не патч: молча обнулять доход нельзя', () => {
    expect(
      draftToPatch({ label: 'Зарплата', kind: 'monthly', day: 10, weekday: 5, amount: '' }, 'RUB'),
    ).toBe(null);
  });
});
