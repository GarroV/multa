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
} from './validation.ts';
import { auth } from './auth.ts';
import { db } from './db/client.ts';
import { workspaces } from './db/schema/domain.ts';
import { env } from './env.ts';
import { fxFreshnessHours, getRate } from './fx/service.ts';
import { hasActiveIncome } from './income/store.ts';
import { logger } from './logger.ts';
import { requireAuth, requireWorkspace, sessionMiddleware, type AppVariables, type Workspace } from './middleware.ts';
import { getCurrentPlan, setCategoryBudget, setExecution } from './plan/assemble.ts';
import { categoriesRoute, seedPresetCategories } from './routes/categories.ts';
import { incomeRoute } from './routes/income.ts';
import { obligations } from './routes/obligations.ts';
import { exchangeRoute } from './routes/exchange.ts';
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

app.use('*', honoLogger());
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
  const onboardingComplete = ws ? ws.periodAnchors != null && (await hasActiveIncome(ws.id)) : false;
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
  const existing = await db.select().from(workspaces).where(eq(workspaces.ownerId, user.id)).limit(1);
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
        ? { periodAnchors: { ...body.rhythm, weekendRule: body.weekendRule ?? ws.paydayWeekendRule } }
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
    if (err instanceof Error && err.message === 'category_not_found') return c.json({ error: 'not_found' }, 404);
    if (err instanceof Error && err.message === 'onboarding_incomplete') return c.json({ error: 'onboarding_incomplete' }, 409);
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
  const body = mode === 'confirm' ? executionSchema.parse(await c.req.json().catch(() => ({}))) : {};
  try {
    const plan = await setExecution(ws, today(ws.timezone), targetKind, targetId, mode, body.executedMinor);
    return c.json(plan);
  } catch (err) {
    if (err instanceof Error && err.message === 'execution_not_applicable') {
      return c.json({ error: 'execution_not_applicable' }, 400);
    }
    if (err instanceof Error && err.message === 'planned_item_not_found') return c.json({ error: 'not_found' }, 404);
    if (err instanceof Error && err.message === 'onboarding_incomplete') return c.json({ error: 'onboarding_incomplete' }, 409);
    throw err;
  }
}

app.post('/v1/plan/current/items/:kind/:id/confirm', requireWorkspace, (c) => handleExecution(c, 'confirm'));
app.post('/v1/plan/current/items/:kind/:id/skip', requireWorkspace, (c) => handleExecution(c, 'skip'));

// --- FX ---

app.get('/v1/fx/rate', requireAuth, async (c) => {
  const q = rateQuerySchema.parse(c.req.query());
  const snap = await getRate(q.from, q.to, q.on ?? today());
  if (!snap) return c.json({ error: 'rate_unavailable' }, 404);
  return c.json(snap);
});

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

app.onError((err, c) => {
  if (err instanceof ZodError) return c.json({ error: 'validation', issues: err.issues }, 400);
  logger.error('unhandled error', err);
  return c.json({ error: 'internal' }, 500);
});
