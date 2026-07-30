/**
 * Пересборка плана — «каскад наоборот» (01-domain-model §Исполнение, 04-web-ux §Пересборка).
 *
 * Когда в категории кончились деньги, вопрос не «кто виноват», а «откуда добавим». Модуль
 * отвечает на второй: перечисляет строки плана, из которых можно взять, в порядке уступки —
 * **цели → конверты → незащищённые категории**. Это зеркало приоритета раздачи.
 *
 * Чего модуль не делает никогда:
 * - не предлагает долги и валютные корзины: автоматика их не трогает (железное правило 3);
 * - не предлагает защищённые категории: их режут только явным выбором пользователя;
 * - не предлагает уже истраченное: у категории доступен лишь неизрасходованный остаток.
 */

import type { TargetKind } from './cascade.ts';

export interface RebalanceRow {
  readonly targetKind: TargetKind;
  readonly targetId: string;
  readonly name: string;
  readonly allocatedMinor: bigint;
  /** Факт по строке: у категорий — траты, у обязательств — исполненное. */
  readonly spentMinor: bigint;
  readonly protected?: boolean;
}

export interface RebalanceOption {
  readonly targetKind: TargetKind;
  readonly targetId: string;
  readonly name: string;
  /** Сколько в этой строке ещё не израсходовано. */
  readonly availableMinor: bigint;
  /** Сколько предлагаем взять под запрошенную сумму (не больше доступного). */
  readonly takeMinor: bigint;
}

/** Порядок уступки — обратный порядку раздачи каскада. */
const GIVE_ORDER: readonly TargetKind[] = ['goal', 'envelope', 'category'];

export interface RebalanceInput {
  readonly rows: readonly RebalanceRow[];
  /** Сколько денег нужно найти. */
  readonly needMinor: bigint;
  /** Строка, которой добавляем — сама себе источником быть не может. */
  readonly targetId: string;
}

export function rebalanceOptions(input: RebalanceInput): RebalanceOption[] {
  const candidates = input.rows.filter(
    (r) => GIVE_ORDER.includes(r.targetKind) && r.targetId !== input.targetId && r.protected !== true,
  );

  const options: RebalanceOption[] = [];
  for (const kind of GIVE_ORDER) {
    for (const row of candidates.filter((r) => r.targetKind === kind)) {
      const availableRaw = row.allocatedMinor - row.spentMinor;
      const availableMinor = availableRaw > 0n ? availableRaw : 0n;
      if (availableMinor <= 0n) continue;
      options.push({
        targetKind: row.targetKind,
        targetId: row.targetId,
        name: row.name,
        availableMinor,
        takeMinor: availableMinor < input.needMinor ? availableMinor : input.needMinor,
      });
    }
  }
  return options;
}
