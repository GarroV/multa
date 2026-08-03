import type { PlanDto } from './assemble.ts';
import type { ShareMode, SharingSettings } from '../validation.ts';
import type { WorkspaceRole } from '../middleware.ts';

/**
 * Матрица видимости на плане (issue #46).
 *
 * Правило продукта, из которого следует всё остальное: **скрыть можно содержимое, но не факт
 * траты**. Деньги, ушедшие из общего котла, обязаны остаться видимыми в итоге — иначе совместный
 * план врёт: у одного 187 000 дохода и 56 000 «на жизнь», у другого те же 187 000 и необъяснимая
 * дыра.
 *
 * Поэтому скрытые разделы не исчезают, а сворачиваются: `sum` отдаёт итог раздела, `hidden` —
 * одну строку «Личное» на все такие разделы сразу.
 */

/** Раздел, к которому относится строка плана. Регулярные платежи в каскаде не участвуют. */
const SECTION_OF: Record<string, keyof SharingSettings> = {
  debt: 'debts',
  bucket: 'buckets',
  envelope: 'envelopes',
  category: 'categories',
  goal: 'goals',
};

/**
 * Виден ли участнику раздел, к которому относится строка (issue #84).
 *
 * Общая для всех ручек, а не только для плана: сигналы, прогноз и мастер-сетка называют долги и
 * цели по имени, и без этой проверки закрытый раздел утекал бы через них. Владелец видит всё.
 */
export function sectionVisible(
  targetKind: string,
  sharing: SharingSettings,
  asMember: boolean,
): boolean {
  if (!asMember) return true;
  const section = SECTION_OF[targetKind];
  // Строка вне матрицы (например регулярный платёж) прячется вместе со своим разделом отдельно.
  return section === undefined ? true : sharing[section] === 'open';
}

export interface PlanSharingDto {
  /** Кто смотрит: владелец видит всё, участник — по матрице. */
  role: WorkspaceRole;
  /** Владелец смотрит глазами участника («view as»): предпросмотр, а не понижение прав. */
  previewAsMember: boolean;
  /** Итоги разделов в режиме «сумма». */
  sums: { section: string; minor: string }[];
  /** «Личное»: всё, что закрыто целиком, одной строкой — деньги не исчезают из каскада. */
  hiddenMinor: string;
  /** Разбивка по разделам не отдаётся: она вернула бы то, что владелец скрыл. */
  incomeVisible: boolean;
}

/**
 * Урезает план до того, что вправе видеть участник.
 *
 * Владельцу без `previewAsMember` план возвращается как есть: фильтровать собственный бюджет
 * незачем, а лишний проход — лишний источник расхождений.
 */
export function applySharing(
  plan: PlanDto,
  sharing: SharingSettings,
  role: WorkspaceRole,
  previewAsMember = false,
): PlanDto & { sharing: PlanSharingDto } {
  const asMember = role === 'member' || previewAsMember;
  if (!asMember) {
    return {
      ...plan,
      sharing: {
        role,
        previewAsMember: false,
        sums: [],
        hiddenMinor: '0',
        incomeVisible: true,
      },
    };
  }

  const modeOf = (targetKind: string): ShareMode => {
    const section = SECTION_OF[targetKind];
    return section ? sharing[section] : 'open';
  };

  const visible = plan.allocations.filter((a) => modeOf(a.targetKind) === 'open');

  const sums = new Map<string, bigint>();
  let hiddenMinor = 0n;
  for (const allocation of plan.allocations) {
    const mode = modeOf(allocation.targetKind);
    if (mode === 'open') continue;
    const minor = BigInt(allocation.allocatedMinor);
    if (mode === 'sum') {
      const section = SECTION_OF[allocation.targetKind]!;
      sums.set(section, (sums.get(section) ?? 0n) + minor);
    } else {
      hiddenMinor += minor;
    }
  }

  const incomeVisible = sharing.income === 'open';

  return {
    ...plan,
    allocations: visible,
    // Нерешённые строки тоже относятся к разделам: закрытый раздел не должен протекать через них.
    unresolved: plan.unresolved.filter((u) => modeOf(u.targetKind) === 'open'),
    income: incomeVisible ? plan.income : { events: [], unresolved: [] },
    sharing: {
      role,
      previewAsMember,
      sums: [...sums.entries()].map(([section, minor]) => ({ section, minor: minor.toString() })),
      hiddenMinor: hiddenMinor.toString(),
      incomeVisible,
    },
  };
}
