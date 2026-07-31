import type { TargetKind } from '@multa/core';
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { ZodError } from 'zod';
import {
  categoryBudgetSchema,
  createWorkspaceSchema,
  patchWorkspaceSchema,
  executionSchema,
  rateQuerySchema,
  rebalanceApplySchema,
  rebalanceQuerySchema,
} from './validation.ts';
import { auth } from './auth.ts';
import { db } from './db/client.ts';
import { workspaces } from './db/schema/domain.ts';
import { env } from './env.ts';
import { fxFreshnessHours, getRate } from './fx/service.ts';
import { hasActiveIncome } from './income/store.ts';
import { logger } from './logger.ts';
import {
  requireAuth,
  requireWorkspace,
  sessionMiddleware,
  type AppVariables,
  type Workspace,
} from './middleware.ts';
import {
  applyRebalance,
  getCurrentPlan,
  FreezeAlreadySet,
  FreezeNotApplicable,
  listRevisions,
  rebalanceSuggestions,
  RevisionAlreadyUndone,
  RevisionNotFound,
  setGoalFreeze,
  undoRevision,
  UndoWouldGoNegative,
  setCategoryBudget,
  setExecution,
} from './plan/assemble.ts';
import { categoriesRoute, seedPresetCategories } from './routes/categories.ts';
import { accountsRoute } from './routes/accounts.ts';
import { analyticsRoute } from './routes/analytics.ts';
import { demoRoute } from './routes/demo.ts';
import { incomeRoute } from './routes/income.ts';
import { obligations } from './routes/obligations.ts';
import { exchangeRoute } from './routes/exchange.ts';
import { forecastRoute } from './routes/forecast.ts';
import { receiptsRoute } from './routes/receipts.ts';
import { recurringRoute } from './routes/recurring.ts';
import { transactionsRoute } from './routes/transactions.ts';
import { today } from './clock.ts';

/** Воркспейс для клиента. Доход периода здесь не живёт — он считается по источникам. */
function serializeWorkspace(ws: Workspace) {
  return {
    id: ws.id,
    baseCurrency: ws.baseCurrency,
    timezone: ws.timezone,
    locale: ws.locale,
    // Ритм планирования (PeriodConfig) — задаёт границы периодов, не суммы.
    rhythm: ws.periodAnchors,
    weekendRule: ws.paydayWeekendRule,
  };
}

const corsOptions = {
  origin: env.WEB_ORIGIN,
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
};

export const app = new Hono<{ Variables: AppVariables }>();

// Access-лог не нужен в тестах: он топит вывод vitest и прячет причину падения.
if (process.env.NODE_ENV !== 'test') app.use('*', honoLogger());
app.use('/v1/*', cors(corsOptions));

// better-auth (email+password + TOTP) — на /v1/auth/*
app.on(['POST', 'GET'], '/v1/auth/*', (c) => auth.handler(c.req.raw));

app.use('*', sessionMiddleware);

app.get('/v1/health', async (c) =>
  c.json({ ok: true, fxFreshnessHours: await fxFreshnessHours() }),
);

app.get('/v1/me', requireAuth, async (c) => {
  const user = c.get('user')!;
  const rows = await db.select().from(workspaces).where(eq(workspaces.ownerId, user.id)).limit(1);
  const ws = rows[0];
  // Онбординг завершён, когда есть ритм И хотя бы один активный источник дохода:
  // без ритма нет границ периода, без источника план собрался бы на нуле.
  const onboardingComplete = ws
    ? ws.periodAnchors != null && (await hasActiveIncome(ws.id))
    : false;
  return c.json({
    user: { id: user.id, email: user.email, name: user.name },
    workspace: ws ? serializeWorkspace(ws) : null,
    onboardingComplete,
    // Пропустил обучение — пускаем в приложение, план останется пустым до ввода дохода.
    onboardingSkipped: ws?.onboardingSkipped ?? false,
  });
});

// --- Онбординг ---

app.post('/v1/workspace', requireAuth, async (c) => {
  const user = c.get('user')!;
  const body = createWorkspaceSchema.parse(await c.req.json());
  const existing = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.ownerId, user.id))
    .limit(1);
  if (existing[0]) return c.json({ error: 'workspace_exists' }, 409);
  const inserted = await db
    .insert(workspaces)
    .values({
      ownerId: user.id,
      baseCurrency: body.baseCurrency.toUpperCase(),
      timezone: body.timezone ?? 'Europe/Belgrade',
      locale: body.locale ?? 'ru',
    })
    .returning();
  const ws = inserted[0]!;
  // Пресет-категории для первого плана (04-web-ux); бюджеты пользователь задаст на «Плане».
  await seedPresetCategories(ws.id, ws.locale);
  return c.json({ workspace: serializeWorkspace(ws) }, 201);
});

app.patch('/v1/workspace', requireWorkspace, async (c) => {
  const ws = c.get('workspace')!;
  const body = patchWorkspaceSchema.parse(await c.req.json());
  const updated = await db
    .update(workspaces)
    .set({
      ...(body.baseCurrency ? { baseCurrency: body.baseCurrency.toUpperCase() } : {}),
      ...(body.timezone ? { timezone: body.timezone } : {}),
      ...(body.locale ? { locale: body.locale } : {}),
      ...(body.weekendRule ? { paydayWeekendRule: body.weekendRule } : {}),
      // Правило выходных живёт и внутри ритма (его читает generatePeriods), и в колонке.
      ...(body.rhythm
        ? {
            periodAnchors: {
              ...body.rhythm,
              weekendRule: body.weekendRule ?? ws.paydayWeekendRule,
            },
          }
        : {}),
    })
    .where(eq(workspaces.id, ws.id))
    .returning();
  return c.json({ workspace: serializeWorkspace(updated[0]!) });
});

// --- План текущего периода: автосборка каскадом (Спринт 2) ---

app.get('/v1/plan/current', requireWorkspace, async (c) => {
  const ws = c.get('workspace')!;
  try {
    const plan = await getCurrentPlan(ws, today(ws.timezone));
    return c.json(plan);
  } catch (err) {
    if (err instanceof Error && err.message === 'onboarding_incomplete') {
      return c.json({ error: 'onboarding_incomplete' }, 409);
    }
    throw err;
  }
});

// Бюджет категории на текущий период. PUT ставит, DELETE снимает; оба возвращают пересобранный план.
async function handleCategoryBudget(c: Context<{ Variables: AppVariables }>, plannedMinor: bigint) {
  const ws = c.get('workspace')!;
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'not_found' }, 404);
  try {
    const plan = await setCategoryBudget(ws, today(ws.timezone), id, plannedMinor);
    return c.json(plan);
  } catch (err) {
    if (err instanceof Error && err.message === 'category_not_found')
      return c.json({ error: 'not_found' }, 404);
    if (err instanceof Error && err.message === 'onboarding_incomplete')
      return c.json({ error: 'onboarding_incomplete' }, 409);
    throw err;
  }
}

app.put('/v1/plan/current/categories/:id', requireWorkspace, async (c) => {
  const body = categoryBudgetSchema.parse(await c.req.json());
  return handleCategoryBudget(c, body.plannedMinor);
});

app.delete('/v1/plan/current/categories/:id', requireWorkspace, (c) => handleCategoryBudget(c, 0n));

// Раскладка дня выплаты: «сделал» / «пропустил» по плановой строке (01-domain-model §Исполнение).
async function handleExecution(c: Context<{ Variables: AppVariables }>, mode: 'confirm' | 'skip') {
  const ws = c.get('workspace')!;
  const targetKind = c.req.param('kind') as TargetKind;
  const targetId = c.req.param('id');
  if (!targetId) return c.json({ error: 'not_found' }, 404);
  const body =
    mode === 'confirm' ? executionSchema.parse(await c.req.json().catch(() => ({}))) : {};
  try {
    const plan = await setExecution(
      ws,
      today(ws.timezone),
      targetKind,
      targetId,
      mode,
      body.executedMinor,
    );
    return c.json(plan);
  } catch (err) {
    if (err instanceof Error && err.message === 'execution_not_applicable') {
      return c.json({ error: 'execution_not_applicable' }, 400);
    }
    if (err instanceof Error && err.message === 'planned_item_not_found')
      return c.json({ error: 'not_found' }, 404);
    if (err instanceof Error && err.message === 'onboarding_incomplete')
      return c.json({ error: 'onboarding_incomplete' }, 409);
    throw err;
  }
}

/** Перевод доменных ошибок заморозки в коды ответа: общая часть у freeze и unfreeze. */
function freezeError(err: unknown): { error: string; status: 400 | 404 | 409 } | null {
  if (err instanceof FreezeNotApplicable) return { error: 'freeze_not_applicable', status: 400 };
  if (err instanceof FreezeAlreadySet) return { error: 'freeze_already_set', status: 409 };
  if (err instanceof Error && err.message === 'goal_not_found')
    return { error: 'not_found', status: 404 };
  if (err instanceof Error && err.message === 'onboarding_incomplete')
    return { error: 'onboarding_incomplete', status: 409 };
  return null;
}

const UUID_PATH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Заморозка взноса в цель на период (issue #54): пропуск — осознанное решение, поэтому у него своя
 * ручка и своя запись в истории, а не молчаливое обнуление строки.
 */
for (const [suffix, frozen] of [
  ['freeze', true],
  ['unfreeze', false],
] as const) {
  app.post(`/v1/plan/current/items/:kind/:id/${suffix}`, requireWorkspace, async (c) => {
    const ws = c.get('workspace')!;
    const kind = c.req.param('kind') as TargetKind;
    const id = c.req.param('id');
    if (!id || !UUID_PATH_RE.test(id)) return c.json({ error: 'not_found' }, 404);
    try {
      return c.json(await setGoalFreeze(ws, today(ws.timezone), kind, id, frozen));
    } catch (err) {
      const mapped = freezeError(err);
      if (mapped) return c.json({ error: mapped.error }, mapped.status);
      throw err;
    }
  });
}

/**
 * История ревизий периода и откат (issue #52). Откат — тоже ревизия: история дописывается, а не
 * переписывается, потому что по ней считается «как обычно» в подсказках пересборки.
 */
app.get('/v1/plan/current/revisions', requireWorkspace, async (c) => {
  const ws = c.get('workspace')!;
  return c.json(await listRevisions(ws, today(ws.timezone)));
});

app.post('/v1/plan/current/revisions/:id/undo', requireWorkspace, async (c) => {
  const ws = c.get('workspace')!;
  const id = c.req.param('id');
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return c.json({ error: 'not_found' }, 404);
  }
  try {
    return c.json(await undoRevision(ws, today(ws.timezone), id));
  } catch (err) {
    if (err instanceof RevisionNotFound) return c.json({ error: 'not_found' }, 404);
    if (err instanceof RevisionAlreadyUndone) return c.json({ error: 'already_undone' }, 409);
    if (err instanceof UndoWouldGoNegative) return c.json({ error: 'undo_would_go_negative' }, 422);
    throw err;
  }
});

// Пересборка плана: варианты «откуда добавим» и применение выбранного (Спринт 4).
app.get('/v1/plan/current/rebalance', requireWorkspace, async (c) => {
  const ws = c.get('workspace')!;
  const q = rebalanceQuerySchema.parse(c.req.query());
  try {
    return c.json(await rebalanceSuggestions(ws, today(ws.timezone), q.targetId, q.needMinor));
  } catch (err) {
    if (err instanceof Error && err.message === 'onboarding_incomplete')
      return c.json({ error: 'onboarding_incomplete' }, 409);
    throw err;
  }
});

app.post('/v1/plan/current/rebalance', requireWorkspace, async (c) => {
  const ws = c.get('workspace')!;
  const body = rebalanceApplySchema.parse(await c.req.json());
  try {
    const plan = await applyRebalance(ws, today(ws.timezone), {
      fromKind: body.fromKind,
      fromId: body.fromId,
      toId: body.toId,
      amountMinor: body.amountMinor,
    });
    return c.json(plan);
  } catch (err) {
    const known: Record<string, number> = {
      invalid_amount: 400,
      source_protected: 400,
      target_not_adjustable: 400,
      same_target: 400,
      insufficient_source: 409,
      planned_item_not_found: 404,
      onboarding_incomplete: 409,
    };
    if (err instanceof Error && known[err.message]) {
      return c.json({ error: err.message }, known[err.message] as 400);
    }
    throw err;
  }
});

app.post('/v1/plan/current/items/:kind/:id/confirm', requireWorkspace, (c) =>
  handleExecution(c, 'confirm'),
);
app.post('/v1/plan/current/items/:kind/:id/skip', requireWorkspace, (c) =>
  handleExecution(c, 'skip'),
);

// --- FX ---

app.get('/v1/fx/rate', requireAuth, async (c) => {
  const q = rateQuerySchema.parse(c.req.query());
  const snap = await getRate(q.from, q.to, q.on ?? today());
  if (!snap) return c.json({ error: 'rate_unavailable' }, 404);
  return c.json(snap);
});

// Демо без регистрации (#56): /v1/demo/enter, /v1/demo/reset — единственные роуты вне сессии,
// они её и выдают. Монтируются ДО остальных суброутеров: те объявляют `use('*', requireWorkspace)`,
// а в Hono такой middleware из подключённого роутера действует на все пути /v1/*, смонтированные
// после него, — публичный роут ниже получал бы 401 ещё до своего хендлера.
app.route('/v1', demoRoute);
// Счета и мультивалютные остатки (#45): «сколько всего денег есть».
app.route('/v1', accountsRoute);
// Категорийная аналитика (#51): план против медианы факта, спарклайн, вердикт.
app.route('/v1', analyticsRoute);

// CRUD обязательств (Спринт 2): /v1/debts, /v1/envelopes, /v1/goals, /v1/buckets
app.route('/v1', obligations);

// CRUD категорий (Спринт 2): /v1/categories
app.route('/v1', categoriesRoute);

// Источники дохода + шаг онбординга «когда приходят деньги»: /v1/income-sources, /v1/onboarding/income
app.route('/v1', incomeRoute);

// Факт трат (Спринт 3): /v1/transactions
app.route('/v1', transactionsRoute);

// Размен валюты со спредом (Спринт 3): /v1/exchange-ops
app.route('/v1', exchangeRoute);

// Прогноз-таймлайн (Спринт 4): /v1/forecast
app.route('/v1', forecastRoute);

// Чеки: QR-путь и подтверждение раскладки (Спринт 5): /v1/receipts
app.route('/v1', receiptsRoute);

// Регулярные платежи вне обязательств (#21): /v1/recurring-items
app.route('/v1', recurringRoute);

app.onError((err, c) => {
  if (err instanceof ZodError) return c.json({ error: 'validation', issues: err.issues }, 400);
  logger.error('unhandled error', err);
  return c.json({ error: 'internal' }, 500);
});
