import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { workspaces } from '../db/schema/domain.ts';
import type { Workspace } from '../middleware.ts';
import {
  workspaceSettingsPatchSchema,
  workspaceSettingsSchema,
  type WorkspaceSettings,
} from '../validation.ts';
import type { z } from 'zod';

/**
 * Настройки воркспейса (issue #49).
 *
 * Чтение всегда прогоняет сохранённый jsonb через схему: старая запись без новых полей возвращается
 * полной, с дефолтами. Поэтому добавление настройки не требует миграции данных, а код, который её
 * читает, никогда не встречает `undefined`.
 */

/** Настройки воркспейса с подставленными дефолтами. Никогда не бросает: мусор в БД → дефолты. */
export function settingsOf(ws: Pick<Workspace, 'settings'>): WorkspaceSettings {
  const parsed = workspaceSettingsSchema.safeParse(ws.settings ?? {});
  // Сломанная запись не должна ронять план: настройки — предпочтения, а не источник правды о деньгах.
  return parsed.success ? parsed.data : workspaceSettingsSchema.parse({});
}

export type SettingsPatch = z.infer<typeof workspaceSettingsPatchSchema>;

/**
 * Частичная правка: тронутые поля накладываются на сохранённые. Правка одной группы не сбрасывает
 * остальные — иначе «поменял буфер» молча вернуло бы порядок сжатия к дефолтному.
 */
export async function patchSettings(
  ws: Workspace,
  patch: SettingsPatch,
): Promise<WorkspaceSettings> {
  const current = settingsOf(ws);
  const next: WorkspaceSettings = {
    periods: { ...current.periods, ...(patch.periods ?? {}) },
    currency: { ...current.currency, ...(patch.currency ?? {}) },
    cascade: { ...current.cascade, ...(patch.cascade ?? {}) },
    signals: { ...current.signals, ...(patch.signals ?? {}) },
  };
  // Прогоняем результат через схему целиком: слияние не должно уметь собрать невалидный объект.
  const validated = workspaceSettingsSchema.parse(next);
  await db.update(workspaces).set({ settings: validated }).where(eq(workspaces.id, ws.id));
  return validated;
}
