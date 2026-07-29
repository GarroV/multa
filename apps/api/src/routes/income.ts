import { Hono } from 'hono';
import {
  deleteSourceById,
  insertSource,
  listSourceRows,
  patchSourceById,
  replaceOnboardingIncome,
  serializeSource,
} from '../income/store.ts';
import { requireWorkspace, type AppVariables } from '../middleware.ts';
import {
  incomeSourcePatchSchema,
  incomeSourceSchema,
  onboardingIncomeSchema,
} from '../validation.ts';

/** Источники дохода: CRUD + атомарный шаг онбординга. Скоуп — только из токена (правило 7). */
export const incomeRoute = new Hono<{ Variables: AppVariables }>();
incomeRoute.use('*', requireWorkspace);

incomeRoute.get('/income-sources', async (c) => {
  const ws = c.get('workspace')!;
  return c.json((await listSourceRows(ws.id)).map(serializeSource));
});

incomeRoute.post('/income-sources', async (c) => {
  const ws = c.get('workspace')!;
  const body = incomeSourceSchema.parse(await c.req.json());
  return c.json(serializeSource(await insertSource(ws.id, body)), 201);
});

incomeRoute.patch('/income-sources/:id', async (c) => {
  const ws = c.get('workspace')!;
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'not_found' }, 404);
  const patch = incomeSourcePatchSchema.parse(await c.req.json());
  const row = await patchSourceById(ws.id, id, patch);
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(serializeSource(row));
});

incomeRoute.delete('/income-sources/:id', async (c) => {
  const ws = c.get('workspace')!;
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'not_found' }, 404);
  if (!(await deleteSourceById(ws.id, id))) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});

/** Шаг онбординга «когда приходят деньги»: ритм и источники за один атомарный запрос. */
incomeRoute.post('/onboarding/income', async (c) => {
  const ws = c.get('workspace')!;
  const body = onboardingIncomeSchema.parse(await c.req.json());
  const rows = await replaceOnboardingIncome(ws.id, body);
  return c.json({ sources: rows.map(serializeSource) }, 201);
});
