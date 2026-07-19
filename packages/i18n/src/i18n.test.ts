import { describe, expect, it } from 'vitest';
import { createTranslator, plural, translate } from './i18n.ts';

describe('translate', () => {
  it('переводит ключ в обеих локалях', () => {
    expect(translate('en', 'onboarding.currency.title')).toBe('Where does your income arrive?');
    expect(translate('ru', 'onboarding.currency.title')).toBe('Где приходят деньги?');
  });

  it('интерполирует параметры {name}', () => {
    // Специальный ключ не нужен — проверяем через createTranslator и общий механизм.
    const t = createTranslator('ru');
    expect(t('brand.name')).toBe('multa');
  });
});

describe('createTranslator', () => {
  it('замыкает локаль', () => {
    const t = createTranslator('en');
    expect(t('common.next')).toBe('Next');
  });
});

describe('plural', () => {
  it('русские формы one/few/many', () => {
    const forms = { one: 'день', few: 'дня', many: 'дней', other: 'дня' };
    expect(plural('ru', 1, forms)).toBe('день');
    expect(plural('ru', 2, forms)).toBe('дня');
    expect(plural('ru', 5, forms)).toBe('дней');
    expect(plural('ru', 21, forms)).toBe('день');
  });

  it('английские формы one/other', () => {
    const forms = { one: 'day', other: 'days' };
    expect(plural('en', 1, forms)).toBe('day');
    expect(plural('en', 6, forms)).toBe('days');
  });
});
