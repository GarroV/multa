/**
 * «Сегодня» для пользователя, а не для сервера.
 *
 * Периоды выплат и даты трат живут в локальном дне workspace: в UTC поздний вечер уже
 * относится к предыдущему дню, из-за чего трата (а на границе периодов — и весь план)
 * уезжала в чужой день. Поэтому дату считаем в таймзоне workspace.
 */

/** Дата момента в указанной таймзоне, YYYY-MM-DD. Неизвестная зона → откат к UTC. */
export function isoDateInTimeZone(at: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(at);
    const get = (type: 'year' | 'month' | 'day') => parts.find((p) => p.type === type)?.value;
    const [year, month, day] = [get('year'), get('month'), get('day')];
    if (!year || !month || !day) return at.toISOString().slice(0, 10);
    return `${year}-${month}-${day}`;
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** Сегодняшняя дата в таймзоне workspace (без аргумента — UTC, для контекстов без workspace). */
export const today = (timeZone = 'UTC'): string => isoDateInTimeZone(new Date(), timeZone);
