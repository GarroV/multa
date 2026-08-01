import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api.ts';

export interface WorkspaceDto {
  id: string;
  baseCurrency: string;
  timezone: string;
  locale: 'ru' | 'en';
  /** Ритм планирования (PeriodConfig). Задаёт границы периодов, не суммы. */
  rhythm: unknown | null;
  weekendRule: 'as-is' | 'before' | 'after';
}

export interface MeDto {
  user: { id: string; email: string; name: string; twoFactorEnabled: boolean } | null;
  workspace: WorkspaceDto | null;
  /** Есть ритм и хотя бы один активный источник дохода. */
  onboardingComplete: boolean;
  /** Обучение пропущено осознанно — пускаем в приложение с пустым планом. */
  onboardingSkipped: boolean;
}

/** Онбординг не пройден: план собрать нельзя, но это не ошибка — нужен пустой экран с CTA. */
export function isOnboardingIncomplete(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'onboarding_incomplete';
}

export interface IncomeSourceDto {
  id: string;
  label: string;
  currency: string;
  schedule: unknown;
  amount: unknown;
  stability: 'fixed' | 'variable';
  active: boolean;
  startsOn: string | null;
  endsOn: string | null;
  sort: number;
}

export interface IncomeEventDto {
  sourceId: string;
  label: string;
  date: string;
  amountMinor: string;
  currency: string;
  /** `received` — поступление подтверждено фактом (issue #48), `expected` — ещё ждём. */
  status: 'expected' | 'received';
  receiptId?: string;
  baseAmountMinor?: string;
}

export type PlanTargetKind = 'debt' | 'bucket' | 'envelope' | 'category' | 'goal';

export interface PlanAllocation {
  targetKind: PlanTargetKind;
  targetId: string;
  name: string;
  sourceCurrency: string;
  sourceMinor: string;
  toCurrency?: string;
  plannedMinor: string; // желаемое (до сжатия), base
  allocatedMinor: string; // после сжатия, base
  shortfallMinor: string;
  spentMinor: string; // факт периода, base
  remainingMinor: string; // allocated − spent, может быть отрицательным
  overspentMinor: string;
  advice?: { kind: 'raise' | 'lower'; suggestedMinor: string; periods: number };
  protectedCategory?: boolean;
  /** Цель с осознанно пропущенным взносом в этом периоде (issue #54). */
  frozen?: boolean;
  executionStatus: 'pending' | 'confirmed' | 'partial' | 'skipped' | 'n_a';
  executedMinor: string;
  remainderMinor: string;
}

export interface PlanUnresolved {
  targetKind: PlanTargetKind;
  targetId: string;
  name: string;
  sourceCurrency: string;
  sourceMinor: string;
  reason: 'rate_unavailable';
}

export interface PlanDto {
  period: { startsOn: string; endsOn: string };
  daysInPeriod: number;
  daysLeft: number;
  baseCurrency: string;
  incomeMinor: string;
  totalPlannedMinor: string;
  totalAllocatedMinor: string;
  compressedMinor: string;
  freeMinor: string;
  toExchangeMinor: string;
  /** Отложено буфером и не вошло в дневной темп (issue #49). */
  bufferMinor: string;
  canSpendPerDayMinor: string;
  extraIncomeMinor: string;
  livingMinor: string;
  spentLivingMinor: string;
  remainingLivingMinor: string;
  overspentMinor: string;
  allocations: PlanAllocation[];
  unresolved: PlanUnresolved[];
  burn: { perDayMinor: string; willLast: boolean; runsOutOn: string | null };
  /** Разбивка дохода периода по источникам. */
  income: {
    events: IncomeEventDto[];
    unresolved: (IncomeEventDto & { reason: 'rate_unavailable' })[];
  };
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    retry: false,
    queryFn: async (): Promise<MeDto> => {
      try {
        return await api<MeDto>('/v1/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          return {
            user: null,
            workspace: null,
            onboardingComplete: false,
            onboardingSkipped: false,
          };
        }
        throw err;
      }
    },
  });
}

export function usePlan(enabled: boolean) {
  return useQuery({
    queryKey: ['plan'],
    enabled,
    retry: false,
    queryFn: () => api<PlanDto>('/v1/plan/current'),
  });
}

// --- Обязательства (Спринт 2) ---

export interface Debt {
  id: string;
  name: string;
  currency: string;
  principalMinor: string;
  remainingMinor: string;
  paymentMinor: string;
  dueDate: string | null;
  counterparty: string | null;
}
export interface Envelope {
  id: string;
  name: string;
  currency: string;
  ruleKind: 'fixed' | 'percent';
  ruleValue: string;
  balanceMinor: string;
}
export interface Goal {
  id: string;
  name: string;
  currency: string;
  targetMinor: string;
  savedMinor: string;
  plannedPerPeriodMinor: string;
}
export interface Bucket {
  id: string;
  name: string;
  fromCurrency: string;
  toCurrency: string;
  amountMinor: string;
  active: boolean;
}

export interface Category {
  id: string;
  name: string;
  icon: string | null;
  isSystem: boolean;
  protected: boolean;
  sort: number;
}

export type EntityName = 'debts' | 'envelopes' | 'goals' | 'buckets';

export function useEntities<T>(name: EntityName) {
  return useQuery({ queryKey: [name], retry: false, queryFn: () => api<T[]>(`/v1/${name}`) });
}

export function useCreateEntity(name: EntityName) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) =>
      api(`/v1/${name}`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [name] }),
  });
}

export function useDeleteEntity(name: EntityName) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/v1/${name}/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [name] }),
  });
}

// --- Категории (Спринт 2) ---

export function useCategories() {
  return useQuery({
    queryKey: ['categories'],
    retry: false,
    queryFn: () => api<Category[]>('/v1/categories'),
  });
}

export function useCreateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; protected?: boolean }) =>
      api<Category>('/v1/categories', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['categories'] });
      void qc.invalidateQueries({ queryKey: ['plan'] });
    },
  });
}

export function usePatchCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      name?: string;
      protected?: boolean;
      sort?: number;
    }) => api<Category>(`/v1/categories/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['categories'] });
      void qc.invalidateQueries({ queryKey: ['plan'] });
    },
  });
}

export function useDeleteCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/v1/categories/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['categories'] });
      void qc.invalidateQueries({ queryKey: ['plan'] });
    },
  });
}

/** Бюджет категории на текущий период. Ответ — свежий план, кладём в кэш сразу. */
export function useSetCategoryBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, plannedMinor }: { id: string; plannedMinor: string }) =>
      api<PlanDto>(`/v1/plan/current/categories/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ plannedMinor }),
      }),
    onSuccess: (plan) => qc.setQueryData(['plan'], plan),
  });
}

export function useClearCategoryBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<PlanDto>(`/v1/plan/current/categories/${id}`, { method: 'DELETE' }),
    onSuccess: (plan) => qc.setQueryData(['plan'], plan),
  });
}

// --- Источники дохода ---

export function useIncomeSources(enabled = true) {
  return useQuery({
    queryKey: ['income-sources'],
    enabled,
    retry: false,
    queryFn: () => api<IncomeSourceDto[]>('/v1/income-sources'),
  });
}

/** Шаг онбординга: ритм + источники одним запросом. 'me' инвалидирует вызывающий. */
export function useSaveOnboardingIncome() {
  return useMutation({
    mutationFn: (body: unknown) =>
      api('/v1/onboarding/income', { method: 'POST', body: JSON.stringify(body) }),
  });
}

/** Валюта по умолчанию, если обучение пропустили до шага выбора валюты. Меняется в настройках. */
const DEFAULT_BASE_CURRENCY = 'RUB';

/** Пропустить обучение: в приложение с пустым планом, доход можно задать позже в настройках. */
export function useSkipOnboarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      // Скип возможен с первого экрана, где воркспейса ещё нет — создаём его с дефолтной валютой.
      const me = qc.getQueryData<MeDto>(['me']);
      if (!me?.workspace) {
        await api('/v1/workspace', {
          method: 'POST',
          body: JSON.stringify({ baseCurrency: DEFAULT_BASE_CURRENCY }),
        });
      }
      await api('/v1/onboarding/skip', { method: 'POST' });
    },
    onSuccess: async () => {
      // Явный fetch, а не invalidate: гейт App должен детерминированно открыть приложение.
      const me = await api<MeDto>('/v1/me');
      qc.setQueryData(['me'], me);
    },
  });
}

export function useCreateIncomeSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) =>
      api<IncomeSourceDto>('/v1/income-sources', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['income-sources'] });
      void qc.invalidateQueries({ queryKey: ['plan'] });
    },
  });
}

/**
 * Подтверждение поступления (issue #48). Курс — необязательный: если человек знает курс дня
 * выплаты, он фиксируется и по нему считается весь период, включая «к размену».
 */
export function useConfirmIncome() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      sourceId: string;
      amountMinor: string;
      currency?: string;
      occurredOn: string;
      rate?: string;
    }) => {
      const { sourceId, ...body } = input;
      return api(`/v1/income-sources/${sourceId}/received`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['plan'] });
      void qc.invalidateQueries({ queryKey: ['forecast'] });
    },
  });
}

/** Отмена подтверждения: план возвращается к плановой сумме источника. */
export function useCancelIncomeReceipt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (receiptId: string) =>
      api(`/v1/income-receipts/${receiptId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['plan'] });
      void qc.invalidateQueries({ queryKey: ['forecast'] });
    },
  });
}

// --- Импорт из Excel (issue #76) ---

export interface ImportPreviewDto {
  sheets: { name: string; rows: number }[];
  /** null — спрашивали только состав книги (лист ещё не выбран). */
  journal: null | {
    rowsTotal: number;
    rowsReady: number;
    rowsSkipped: { sourceRow: number; reason: string }[];
    firstDate: string | null;
    lastDate: string | null;
    totalMinor: string;
    categories: { name: string; rows: number; existingId: string | null }[];
  };
}

export interface ImportCommitDto {
  batchId: string;
  rowsImported: number;
  rowsDuplicated: number;
  rowsSkipped: number;
  categoriesCreated: string[];
}

export interface ImportBatchDto {
  id: string;
  filename: string;
  sheet: string;
  rowsTotal: number;
  rowsImported: number;
  rowsDuplicated: number;
  status: 'committed' | 'rolled_back';
  createdAt: string;
}

export function useImportPreview() {
  return useMutation({
    mutationFn: (input: { fileBase64: string; sheet?: string }) =>
      api<ImportPreviewDto>('/v1/import/preview', { method: 'POST', body: JSON.stringify(input) }),
  });
}

export function useImportCommit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      fileBase64: string;
      sheet: string;
      dictionarySheet?: string;
      filename?: string;
    }) =>
      api<ImportCommitDto>('/v1/import/commit', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => {
      // Перенос меняет всё сразу: факт, категории, аналитику и советы по медиане.
      void qc.invalidateQueries();
    },
  });
}

export function useImportBatches() {
  return useQuery({
    queryKey: ['import-batches'],
    retry: false,
    queryFn: () => api<ImportBatchDto[]>('/v1/import/batches'),
  });
}

export function useRollbackImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (batchId: string) =>
      api<{ ok: boolean; rowsRemoved: number }>(`/v1/import/batches/${batchId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void qc.invalidateQueries();
    },
  });
}

// --- Настройки воркспейса (issue #49) ---

export interface WorkspaceSettingsDto {
  periods: { suggestRaises: boolean };
  currency: {
    rateSource: 'cbr' | 'ecb' | 'manual';
    defaultSpreadBp: number;
    defaultProvider: string | null;
  };
  cascade: { bufferPct: number; compressOrder: ('goal' | 'envelope' | 'category')[] };
  signals: { burnThresholdDays: number; medianPeriods: number };
}

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    retry: false,
    queryFn: () => api<WorkspaceSettingsDto>('/v1/workspace/settings'),
  });
}

/** Правка частичная: сервер сливает тронутое с сохранённым, остальное не сбрасывается. */
export function usePatchSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: DeepPartial<WorkspaceSettingsDto>) =>
      api<WorkspaceSettingsDto>('/v1/workspace/settings', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      // Настройки меняют поведение плана и аналитики — их надо перечитать, а не оставить старыми.
      void qc.invalidateQueries({ queryKey: ['plan'] });
      void qc.invalidateQueries({ queryKey: ['analytics'] });
    },
  });
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

// --- Категорийная аналитика (issue #51) ---

export interface CategoryAnalyticsRow {
  categoryId: string;
  name: string;
  plannedMinor: string;
  medianMinor: string;
  deltaPct: number | null;
  verdict: 'unknown' | 'stable' | 'raise' | 'lower' | 'volatile' | 'unplanned';
  series: { startsOn: string; spentMinor: string }[];
  periods: number;
}

/**
 * Аналитика категорий. Без аргумента горизонт берёт сервер из настроек воркспейса (issue #49) —
 * так вердикт на экране совпадает с советами в плане, которые считаются по тому же горизонту.
 * Явное число передаётся только когда экран сознательно просит другой отрезок.
 */
export function useCategoryAnalytics(periods?: number) {
  return useQuery({
    queryKey: ['analytics', 'categories', periods ?? 'settings'],
    retry: false,
    queryFn: () =>
      api<CategoryAnalyticsRow[]>(
        periods ? `/v1/analytics/categories?periods=${periods}` : '/v1/analytics/categories',
      ),
  });
}

// --- Сигналы как сущность (issue #50) ---

export type SignalSeverity = 'risk' | 'attention' | 'opportunity';

export type SignalMetricDto =
  | { kind: 'money'; minor: string; currency: string }
  | { kind: 'percent'; bp: number }
  | { kind: 'days'; days: number }
  | { kind: 'date'; on: string };

export type SignalActionDto =
  | { kind: 'rebalance'; targetId: string }
  | { kind: 'set_budget'; targetId: string; amountMinor: string }
  | { kind: 'freeze_goal'; targetId: string }
  | { kind: 'open'; screen: 'plan' | 'statistics' | 'obligations' };

export interface SignalDto {
  id: string;
  rule: string;
  severity: SignalSeverity;
  metric: SignalMetricDto;
  /** Значения для подстановки в строку словаря: текст сервер не собирает (правило 5). */
  params: Record<string, string | number>;
  targetId: string | null;
  targetName: string | null;
  actions: SignalActionDto[];
}

/**
 * Сигналы текущего периода. Ключ включает `plan`: любое действие по сигналу меняет план, и список
 * обязан пересчитаться — иначе кнопка «поднять бюджет» остаётся на экране после нажатия.
 */
export function useSignals(enabled = true) {
  return useQuery({
    queryKey: ['plan', 'signals'],
    retry: false,
    enabled,
    queryFn: () => api<{ baseCurrency: string; signals: SignalDto[] }>('/v1/signals'),
  });
}

// --- Регулярные платежи (issues #21, #55) ---

export interface RecurringItemDto {
  id: string;
  kind: 'expense' | 'envelope' | 'goal' | 'debt';
  name: string;
  amountMinor: string;
  currency: string;
  /** Правило повтора; форма зависит от `kind` (см. RepeatRule в ядре). */
  schedule: { kind: string; [key: string]: unknown };
  active: boolean;
  targetId: string | null;
  startsOn: string | null;
  endsOn: string | null;
  /** Тумблер прячет метку на карте периода, но не само событие. */
  showOnMap: boolean;
}

export interface RecurringInput {
  name: string;
  amountMinor: string;
  currency: string;
  schedule: unknown;
  startsOn?: string;
  showOnMap?: boolean;
}

export function useRecurringItems(enabled = true) {
  return useQuery({
    queryKey: ['recurring-items'],
    retry: false,
    enabled,
    queryFn: () => api<RecurringItemDto[]>('/v1/recurring-items'),
  });
}

/** После правки платежа перечитываем и прогноз: «что впереди» и карта периода считаются из него. */
function useRecurringMutation<TVars>(fn: (vars: TVars) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['recurring-items'] });
      void qc.invalidateQueries({ queryKey: ['forecast'] });
    },
  });
}

export function useCreateRecurring() {
  return useRecurringMutation<RecurringInput>((body) =>
    api<RecurringItemDto>('/v1/recurring-items', { method: 'POST', body: JSON.stringify(body) }),
  );
}

export function usePatchRecurring() {
  return useRecurringMutation<{ id: string } & Partial<RecurringInput> & { active?: boolean }>(
    ({ id, ...body }) =>
      api<RecurringItemDto>(`/v1/recurring-items/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
  );
}

export function useDeleteRecurring() {
  return useRecurringMutation<string>((id) =>
    api(`/v1/recurring-items/${id}`, { method: 'DELETE' }),
  );
}

// --- Мастер-сетка: строки × периоды (issue #47) ---

export interface GridCellDto {
  minor: string;
  /** `planned` — сумма периода, `none` — строки в нём нет, `ended` — строка кончилась. */
  state: 'planned' | 'none' | 'ended';
}

export interface GridRowDto {
  targetKind: PlanTargetKind;
  targetId: string;
  name: string;
  sourceCurrency: string;
  cells: GridCellDto[];
  totalMinor: string;
  endsAfterIndex: number | null;
}

export interface GridGroupDto {
  kind: PlanTargetKind | 'income';
  rows: GridRowDto[];
  totals: string[];
  totalMinor: string;
}

export interface PlanGridDto {
  baseCurrency: string;
  periods: { startsOn: string; endsOn: string; daysInPeriod: number; materialized: boolean }[];
  groups: GridGroupDto[];
  footer: {
    freeMinor: string[];
    perDayMinor: string[];
    toExchangeMinor: string[];
    toExchangeByCurrency: { currency: string; cells: string[] }[];
  };
  unresolved: {
    targetKind: PlanTargetKind;
    targetId: string;
    name: string;
    sourceCurrency: string;
  }[];
}

/**
 * Матрица «строки × периоды». Ключ включает `plan`, чтобы правка бюджета или обязательства
 * обновляла и её: иначе мастер-режим показывал бы состояние до правки.
 */
export function usePlanGrid(periods: number, enabled = true) {
  return useQuery({
    queryKey: ['plan', 'grid', periods],
    retry: false,
    enabled,
    queryFn: () => api<PlanGridDto>(`/v1/plan/grid?periods=${periods}`),
  });
}

// --- Сравнение провайдеров размена (issue #53) ---

export interface ProviderStatsDto {
  /** null — метка не проставлена: такие сделки видны, но «перейти на без метки» нельзя. */
  provider: string | null;
  deals: number;
  avgSpreadPct: number;
  /** Отданные объёмы по валютам отдачи. */
  volumeMinor: Record<string, string>;
  /** Потери по валютам получения. */
  lostMinor: Record<string, string>;
}

export interface SpreadDto {
  months: number;
  providers: ProviderStatsDto[];
  best: ProviderStatsDto | null;
  worst: ProviderStatsDto | null;
  /** Есть ли у лучшего повторяемость: без неё показываем разницу, но не советуем переходить. */
  confident: boolean;
  savingMinor: string;
  savingCurrency: string | null;
}

export function useSpread(months?: number) {
  return useQuery({
    queryKey: ['analytics', 'spread', months ?? 'default'],
    retry: false,
    queryFn: () =>
      api<SpreadDto>(months ? `/v1/analytics/spread?months=${months}` : '/v1/analytics/spread'),
  });
}

// --- История ревизий (issue #52) ---

export interface RevisionMoveDto {
  fromKind: string;
  fromId: string;
  fromName: string | null;
  toKind: string;
  toId: string;
  toName: string | null;
  amountMinor: string;
}

export interface RevisionDto {
  id: string;
  reason: string;
  createdAt: string;
  undone: boolean;
  /** `move` — перенос, `freeze`/`unfreeze` — пропуск взноса в цель (issue #54). */
  kind: 'move' | 'freeze' | 'unfreeze';
  moves: RevisionMoveDto[];
}

export function useRevisions() {
  return useQuery({
    queryKey: ['revisions'],
    retry: false,
    queryFn: () => api<RevisionDto[]>('/v1/plan/current/revisions'),
  });
}

/**
 * Заморозка взноса в цель на период (issue #54): деньги уходят на другое, накопленное остаётся,
 * срок сдвигается. Обратный жест — снятие заморозки, а не «откатить правку».
 */
export function useGoalFreeze() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ goalId, frozen }: { goalId: string; frozen: boolean }) =>
      api(`/v1/plan/current/items/goal/${goalId}/${frozen ? 'freeze' : 'unfreeze'}`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['plan'] });
      void qc.invalidateQueries({ queryKey: ['revisions'] });
      void qc.invalidateQueries({ queryKey: ['forecast'] });
    },
  });
}

/** Откат правки. История при этом дописывается, а не переписывается — так решено в бэкенде. */
export function useUndoRevision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/v1/plan/current/revisions/${id}/undo`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['plan'] });
      void qc.invalidateQueries({ queryKey: ['revisions'] });
    },
  });
}

// --- Счета и остатки (issue #45) ---

export interface AccountDto {
  id: string;
  name: string;
  currency: string;
  kind: 'cash' | 'card' | 'savings' | 'other';
  balanceMinor: string;
  archived: boolean;
}

export interface BalancesDto {
  baseCurrency: string;
  /** null — по какой-то валюте нет курса: сумму без части денег показывать нельзя. */
  totalMinor: string | null;
  byCurrency: { currency: string; minor: string; baseMinor: string | null }[];
  unresolved: string[];
}

export function useAccounts(includeArchived = false) {
  return useQuery({
    queryKey: ['accounts', includeArchived],
    queryFn: () => api<AccountDto[]>(`/v1/accounts${includeArchived ? '?includeArchived=1' : ''}`),
  });
}

export function useBalances() {
  return useQuery({
    queryKey: ['balances'],
    queryFn: () => api<BalancesDto>('/v1/accounts/balances'),
  });
}

export function useSaveAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id?: string } & Partial<AccountDto>) => {
      const { id, ...body } = input;
      return id
        ? api<AccountDto>(`/v1/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
        : api<AccountDto>('/v1/accounts', { method: 'POST', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['balances'] });
    },
  });
}

// --- Факт трат (Спринт 3) ---

export interface Transaction {
  id: string;
  kind: string;
  categoryId: string | null;
  amountMinor: string;
  currency: string;
  baseAmountMinor: string;
  rate: string;
  rateSource: string;
  rateDate: string;
  occurredOn: string;
  source: string;
  note: string | null;
}

export interface TransactionsDto {
  period: { from: string; to: string };
  transactions: Transaction[];
}

/** Траты текущего периода (границы считает сервер по якорям выплат). */
export function useTransactions() {
  return useQuery({
    queryKey: ['transactions'],
    retry: false,
    queryFn: () => api<TransactionsDto>('/v1/transactions'),
  });
}

export interface SpendInput {
  /** 'expense' — трата, 'income' — внеплановый приход (side hustle). */
  kind?: 'expense' | 'income';
  amountMinor: string;
  currency: string;
  categoryId?: string;
  occurredOn?: string;
  note?: string;
}

/** Факт меняет и список трат, и план (остаток, цифра дня) — инвалидируем оба. */
function useTransactionMutation<TVars>(mutationFn: (vars: TVars) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['plan'] });
    },
  });
}

export function useDeleteIncomeSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/v1/income-sources/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['income-sources'] });
      void qc.invalidateQueries({ queryKey: ['plan'] });
    },
  });
}

export function useCreateSpend() {
  return useTransactionMutation<SpendInput>((body) =>
    api<Transaction>('/v1/transactions', { method: 'POST', body: JSON.stringify(body) }),
  );
}

/** «Сделал» по плановой строке: без суммы — целиком, с суммой — частично. Ответ — свежий план. */
export function useConfirmExecution() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      targetKind,
      targetId,
      executedMinor,
    }: {
      targetKind: string;
      targetId: string;
      executedMinor?: string;
    }) =>
      api<PlanDto>(`/v1/plan/current/items/${targetKind}/${targetId}/confirm`, {
        method: 'POST',
        body: JSON.stringify(executedMinor ? { executedMinor } : {}),
      }),
    onSuccess: (plan) => {
      qc.setQueryData(['plan'], plan);
      void qc.invalidateQueries({ queryKey: ['transactions'] });
    },
  });
}

export function useSkipExecution() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ targetKind, targetId }: { targetKind: string; targetId: string }) =>
      api<PlanDto>(`/v1/plan/current/items/${targetKind}/${targetId}/skip`, { method: 'POST' }),
    onSuccess: (plan) => {
      qc.setQueryData(['plan'], plan);
      void qc.invalidateQueries({ queryKey: ['transactions'] });
    },
  });
}

export function useDeleteSpend() {
  return useTransactionMutation<string>((id) =>
    api(`/v1/transactions/${id}`, { method: 'DELETE' }),
  );
}

// --- Размен валюты (Спринт 3) ---

export interface ExchangeOp {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  fromMinor: string;
  toMinor: string;
  actualRate: string;
  officialRate: string | null;
  officialSource: string | null;
  spreadPct: string | null;
  spreadMinor: string | null;
  occurredOn: string;
  /** Где меняли (issue #53): по этому полю считается сравнение провайдеров. */
  provider: string | null;
  note: string | null;
}

export interface ExchangeDto {
  ops: ExchangeOp[];
  /** Накопленные потери на спреде по валютам получения. */
  totalLost: { currency: string; minor: string }[];
}

export function useExchangeOps() {
  return useQuery({
    queryKey: ['exchange-ops'],
    retry: false,
    queryFn: () => api<ExchangeDto>('/v1/exchange-ops'),
  });
}

export interface ExchangeInput {
  fromCurrency: string;
  toCurrency: string;
  fromMinor: string;
  toMinor: string;
  occurredOn?: string;
  /** Пусто — сервер подставит привычного провайдера из настроек. */
  provider?: string;
  note?: string;
}

function useExchangeMutation<TVars>(mutationFn: (vars: TVars) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['exchange-ops'] });
      void qc.invalidateQueries({ queryKey: ['plan'] });
      // Сравнение провайдеров считается по этим же сделкам: иначе новая строка есть, а вывод старый.
      void qc.invalidateQueries({ queryKey: ['analytics', 'spread'] });
    },
  });
}

export function useCreateExchange() {
  return useExchangeMutation<ExchangeInput>((body) =>
    api<ExchangeOp>('/v1/exchange-ops', { method: 'POST', body: JSON.stringify(body) }),
  );
}

export function useDeleteExchange() {
  return useExchangeMutation<string>((id) => api(`/v1/exchange-ops/${id}`, { method: 'DELETE' }));
}

// --- Пересборка плана (Спринт 4) ---

export interface RebalanceOption {
  targetKind: string;
  targetId: string;
  name: string;
  availableMinor: string;
  takeMinor: string;
  /** Из этого источника пользователь уже брал раньше. */
  usual: boolean;
}

export function useRebalanceOptions(targetId: string | null, needMinor: string) {
  return useQuery({
    queryKey: ['rebalance', targetId, needMinor],
    enabled: !!targetId && BigInt(needMinor || '0') > 0n,
    retry: false,
    queryFn: () =>
      api<RebalanceOption[]>(
        `/v1/plan/current/rebalance?targetId=${targetId}&needMinor=${needMinor}`,
      ),
  });
}

export function useApplyRebalance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { fromKind: string; fromId: string; toId: string; amountMinor: string }) =>
      api<PlanDto>('/v1/plan/current/rebalance', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (plan) => {
      qc.setQueryData(['plan'], plan);
      void qc.invalidateQueries({ queryKey: ['rebalance'] });
    },
  });
}

// --- Прогноз-таймлайн (Спринт 4) ---

export interface ForecastEvent {
  kind: 'debt_closed' | 'freed_money' | 'goal_reached' | 'goal_at_risk';
  targetId: string;
  name: string;
  on: string;
  periodsAway: number;
  amountMinor: string | null;
}

export interface RecurringDue {
  id: string;
  name: string;
  amountMinor: string;
  currency: string;
  on: string;
  /** Тумблер платежа: прячет метку на карте периода, но не сам платёж (issue #55). */
  showOnMap: boolean;
}

export function useForecast() {
  return useQuery({
    queryKey: ['forecast'],
    retry: false,
    queryFn: () =>
      api<{ horizonPeriods: number; dueSoon: RecurringDue[]; events: ForecastEvent[] }>(
        '/v1/forecast',
      ),
  });
}

// --- Чеки (Спринт 5) ---

export interface ReceiptSplitRow {
  categoryId: string;
  amountMinor: string;
}

export interface ReceiptParsed {
  receipt: { id: string; status: string; method: string | null };
  merchant?: string | null;
  currency: string;
  totalMinor: string;
  confidence: 'high' | 'low';
  items?: { name: string; amountMinor: string }[];
  split: ReceiptSplitRow[];
}

/** QR — бесплатный путь, пробуем первым. */
export function useParseReceiptQr() {
  return useMutation({
    mutationFn: (payload: string) =>
      api<ReceiptParsed>('/v1/receipts/qr', { method: 'POST', body: JSON.stringify({ payload }) }),
  });
}

/** Фото — платный путь, только если QR не дал результата. */
export function useParseReceiptPhoto() {
  return useMutation({
    mutationFn: (imageUrl: string) =>
      api<ReceiptParsed>('/v1/receipts/photo', {
        method: 'POST',
        body: JSON.stringify({ imageUrl }),
      }),
  });
}

export function useConfirmReceipt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, split }: { id: string; split: ReceiptSplitRow[] }) =>
      api<{ ok: boolean; transactions: number }>(`/v1/receipts/${id}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ split }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['plan'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
    },
  });
}

/** Разбор фразы на сервере: сначала regex, затем LLM — решает api. */
export interface ParsedEntryDto {
  source: 'regex' | 'llm';
  kind: 'expense' | 'income';
  amountMinor: string;
  currency: string;
  occurredOn: string;
  categoryId: string | null;
  categoryName: string | null;
  note: string | null;
}

export function useParseEntry() {
  return useMutation({
    mutationFn: (text: string) =>
      api<ParsedEntryDto>('/v1/transactions/parse', {
        method: 'POST',
        body: JSON.stringify({ text }),
      }),
  });
}
