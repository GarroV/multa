import type { TranslationKey } from '@multa/i18n';

export const todayISO = (): string => new Date().toISOString().slice(0, 10);

export interface PaydayPreset {
  key: TranslationKey;
  anchors: () => unknown;
}

export const PAYDAY_PRESETS: PaydayPreset[] = [
  { key: 'onboarding.payday.preset.twiceMonthly', anchors: () => ({ kind: 'monthly-days', days: [10, 25] }) },
  { key: 'onboarding.payday.preset.monthly', anchors: () => ({ kind: 'monthly-days', days: [1] }) },
  { key: 'onboarding.payday.preset.biweekly', anchors: () => ({ kind: 'every-weeks', weeks: 2, startsOn: todayISO() }) },
];
