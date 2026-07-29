import { describe, expect, it } from 'vitest';
import { isoDateInTimeZone } from './clock.ts';

describe('isoDateInTimeZone', () => {
  it('поздним вечером отдаёт местную дату, а не UTC-вчера', () => {
    // 23:30 в Белграде — для пользователя это ещё 29-е.
    expect(isoDateInTimeZone(new Date('2026-07-29T21:30:00Z'), 'Europe/Belgrade')).toBe('2026-07-29');
    // 00:30 уже 30-го: UTC всё ещё показывает 29-е — именно на этом трата уезжала в чужой день.
    expect(isoDateInTimeZone(new Date('2026-07-29T22:30:00Z'), 'Europe/Belgrade')).toBe('2026-07-30');
  });

  it('учитывает смещение зоны в обе стороны от UTC', () => {
    expect(isoDateInTimeZone(new Date('2026-07-29T20:00:00Z'), 'Asia/Tokyo')).toBe('2026-07-30'); // UTC+9
    expect(isoDateInTimeZone(new Date('2026-07-30T02:00:00Z'), 'America/New_York')).toBe('2026-07-29'); // UTC−4
  });

  it('в UTC совпадает с ISO-датой', () => {
    expect(isoDateInTimeZone(new Date('2026-07-29T22:30:00Z'), 'UTC')).toBe('2026-07-29');
  });

  it('на кривой зоне не падает, а честно откатывается к UTC', () => {
    // Дата запроса важнее, чем идеальная зона: 500 из-за опечатки в настройках недопустим.
    expect(isoDateInTimeZone(new Date('2026-07-29T22:30:00Z'), 'Mars/Olympus')).toBe('2026-07-29');
  });

  it('месяц и день всегда двузначные (формат для колонки date)', () => {
    expect(isoDateInTimeZone(new Date('2026-01-05T10:00:00Z'), 'Europe/Belgrade')).toBe('2026-01-05');
  });
});
