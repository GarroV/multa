import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api.ts';
import { enqueue, flush } from './outbox.ts';

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
  /** Роль в воркспейсе (issue #46): участник смотрит и не правит. null — воркспейса нет. */
  role: 'owner' | 'member' | null;
  /** «Сегодня» в таймзоне воркспейса: браузерный UTC для этого не годится (#109). */
  today: string;
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
  /** Во что менять: базовая сумма и сколько валюты за неё дадут (issue #152). */
  toExchangeByCurrency: { currency: string; minor: string; amountMinor: string }[];
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
  /** Матрица видимости в действии (issue #46): что свернуто и во что. */
  sharing?: {
    role: 'owner' | 'member';
    previewAsMember: boolean;
    sums: { section: string; minor: string }[];
    hiddenMinor: string;
    incomeVisible: boolean;
  };
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
            // Гостю дату считаем в UTC: воркспейса с таймзоной у него ещё нет.
            today: new Date().toISOString().slice(0, 10),
            role: null,
          };
        }
        throw err;
      }
    },
  });
}

/**
 * План текущего периода. `asMember` — предпросмотр владельца «глазами участника» (issue #46):
 * параметр только сужает видимое, поэтому его можно передавать с клиента.
 */
/**
 * Ключ кэша плана владельца.
 *
 * Вынесен в константу после бага «оплатить ничего не делает» (16.08.2026): пять мутаций клали
 * свежий план в `['plan']`, а экран читал `['plan','own']`. Промах молчаливый — сервер отвечал 200,
 * данные приходили и уходили в ячейку кэша, которую никто не читает. Виден он только глазами: на
 * экране ничего не менялось.
 */
export const PLAN_KEY = ['plan', 'own'] as const;

export function usePlan(enabled: boolean, asMember = false) {
  return useQuery({
    queryKey: asMember ? ['plan', 'as-member'] : PLAN_KEY,
    enabled,
    retry: false,
    queryFn: () => api<PlanDto>(`/v1/plan/current${asMember ? '?as=member' : ''}`),
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
  /** Ступени суммы платежа: «с такой-то даты столько-то» (issue про меняющийся платёж). */
  amountSteps: { from: string; amountMinor: string }[] | null;
  counterparty: string | null;
  /**
   * Разбивка платежа по выплатам (issue #117): сколько уходит с аванса, сколько с зарплаты.
   * Пусто или null — одна сумма на все выплаты, как было до разбивки.
   */
  paymentsBySource: { sourceId: string; amountMinor: string }[] | null;
  /** Кто кому должен: `owed_to_me` — заём, деньги ждут возврата и в раздачу не идут (#94). */
  direction: 'owed_by_me' | 'owed_to_me';
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

/**
 * Возврат по займу (#94). Приход денег, а не правка карточки: сервер уменьшает остаток и пишет
 * транзакцию, поэтому обновляем и списки, и план — месячный итог меняется вместе с остатком.
 */
export function useRepayLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, amountMinor }: { id: string; amountMinor: string }) =>
      api(`/v1/debts/${id}/repaid`, { method: 'POST', body: JSON.stringify({ amountMinor }) }),
    onSuccess: () => {
      // Ключ списка — само имя сущности (см. useEntities), а не пара ['entities', name].
      void qc.invalidateQueries({ queryKey: ['debts'] });
      void qc.invalidateQueries({ queryKey: ['plan'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
    },
  });
}

export function useCreateEntity(name: EntityName) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) =>
      api(`/v1/${name}`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [name] });
      /*
       * План и мастер-таблица тоже поменялись: новый долг или накопление участвуют в каскаде с
       * первого же периода. Раньше сбрасывался только список сущностей — этого хватало, пока
       * заводили из разделов и возвращались на план заново. Заведение прямо в таблице вскрыло
       * дыру: строка создавалась, а таблица показывала прежние итоги до перезагрузки.
       */
      void qc.invalidateQueries({ queryKey: ['plan'] });
    },
  });
}

/**
 * Правка строки обязательства (issue #91). План пересобирается вслед за правкой: сумма долга или
 * цель влияют на каскад, и оставить на экране прежнюю цифру дня значило бы показать неправду.
 */
export function usePatchEntity(name: EntityName) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) =>
      api(`/v1/${name}/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [name] });
      await qc.invalidateQueries({ queryKey: ['plan'] });
    },
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
    onSuccess: (plan) => qc.setQueryData(PLAN_KEY, plan),
  });
}

export function useClearCategoryBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<PlanDto>(`/v1/plan/current/categories/${id}`, { method: 'DELETE' }),
    onSuccess: (plan) => qc.setQueryData(PLAN_KEY, plan),
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

export type ShareMode = 'open' | 'sum' | 'hidden';
export type ShareSection = 'income' | 'debts' | 'buckets' | 'envelopes' | 'categories' | 'goals';

export interface WorkspaceSettingsDto {
  periods: { suggestRaises: boolean };
  currency: {
    /** Валюты воркспейса: что показывать в выпадашках (решение владельца 06.08.2026). */
    list: string[];
    rateSource: 'cbr' | 'ecb' | 'manual';
    defaultSpreadBp: number;
    defaultProvider: string | null;
    /** Шаг округления суммы к размену в major units; 0 — не округлять (#49). */
    exchangeRoundingMajor: number;
  };
  cascade: { bufferPct: number; compressOrder: ('goal' | 'envelope' | 'category')[] };
  signals: {
    burnThresholdDays: number;
    medianPeriods: number;
    runwayWarnDays: number;
    lockedWarnPct: number;
    maxSignals: number;
  };
  /** Матрица видимости для участников (issue #46). */
  sharing: Record<ShareSection, ShareMode>;
  /** Пройденное обучение (issue #28): флаг на сервере, а не в localStorage. */
  tour: { planDone: boolean };
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

// --- Совместный доступ (issue #46) ---

export interface MembersDto {
  role: 'owner' | 'member';
  members: { id: string; userId: string; role: 'owner' | 'member'; name: string; email: string }[];
  sharing: Record<ShareSection, ShareMode>;
}

export function useMembers(enabled = true) {
  return useQuery({
    queryKey: ['members'],
    retry: false,
    enabled,
    queryFn: () => api<MembersDto>('/v1/workspace/members'),
  });
}

export function useCreateInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ code: string }>('/v1/workspace/invites', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['members'] }),
  });
}

export function useRemoveMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/v1/workspace/members/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['members'] }),
  });
}

/** Принятие приглашения: меняет всё сразу — воркспейс, план, роль. Чистим кэш целиком. */
export function useAcceptInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) =>
      api<{ ok: true; workspaceId: string }>(
        `/v1/workspace/invites/${encodeURIComponent(code)}/accept`,
        { method: 'POST' },
      ),
    onSuccess: () => qc.invalidateQueries(),
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
  | { kind: 'rebalance'; targetId: string; needMinor: string }
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
  /** Ступени суммы: «с такой-то даты столько-то» (запрос владельца 06.08.2026). */
  amountSteps: { from: string; amountMinor: string }[] | null;
  /** Откладывать на него из дохода отдельной строкой каскада. */
  reserve: boolean;
}

export interface RecurringInput {
  name: string;
  amountMinor: string;
  currency: string;
  schedule: unknown;
  /* null снимает ограничение срока; отличать от «поле не прислали» обязательно — иначе правка
     одной даты молча стёрла бы вторую. */
  startsOn?: string | null;
  endsOn?: string | null;
  showOnMap?: boolean;
  /** Ступени суммы: «с такой-то даты столько-то». Пустой список снимает все. */
  amountSteps?: { from: string; amountMinor: string }[];
  reserve?: boolean;
}

export function useRecurringItems(enabled = true) {
  return useQuery({
    queryKey: ['recurring-items'],
    retry: false,
    enabled,
    queryFn: () => api<RecurringItemDto[]>('/v1/recurring-items'),
  });
}

/**
 * После правки платежа перечитываем и прогноз: «что впереди» и карта периода считаются из него.
 *
 * План и мастер-сетка — тоже (issue #154): регулярный платёж стоит в них строкой и участвует в
 * «К размену», а с 22.08.2026 его правят прямо из таблицы. Без этой инвалидации лист закрывался, а
 * в таблице оставалось прежнее число — ровно та же жалоба «поменял, а не изменилось», от которой
 * лист и заводили (поймано браузерным тестом).
 */
function useRecurringMutation<TVars>(fn: (vars: TVars) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['recurring-items'] });
      void qc.invalidateQueries({ queryKey: ['forecast'] });
      void qc.invalidateQueries({ queryKey: ['plan'] });
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
  /** Группа вне итогов: показывается, но в подвал не входит (issue #80). */
  informational?: true;
  kind: PlanTargetKind | 'income' | 'recurring';
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
    toExchangeByCurrency: { currency: string; cells: string[]; amountCells: string[] }[];
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

/**
 * Правка ячейки мастер-сетки (запрос владельца 13.08.2026).
 *
 * Ответ сервера — пересобранная сетка, и мы кладём её в кэш вместо инвалидации: правка одной ячейки
 * меняет весь столбец каскадом, а у долга и все столбцы правее. Инвалидация оставила бы кадр со
 * старыми числами рядом с новым — ровно то, из-за чего таблице перестают верить.
 */
export function useEditGridCell(periods: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cell: {
      targetKind: string;
      targetId: string;
      startsOn: string;
      plannedMinor: string;
    }) =>
      api<PlanGridDto>(`/v1/plan/grid/cell?periods=${periods}`, {
        method: 'PUT',
        body: JSON.stringify(cell),
      }),
    onSuccess: (grid) => {
      qc.setQueryData(['plan', 'grid', periods], grid);
      /*
       * План периода тоже поменялся: бюджет категории на текущий период — это он же. Инвалидируем
       * по префиксу, но ПОСЛЕ setQueryData — иначе сетка перезапросилась бы и на миг показала
       * старые числа, хотя ответ с новыми уже пришёл.
       */
      void qc.invalidateQueries({ queryKey: ['plan'], predicate: (q) => q.queryKey[1] !== 'grid' });
    },
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

/** `enabled` нужен для участника совместного доступа: ручка ему закрыта (issue #46). */
export function useRevisions(enabled = true) {
  return useQuery({
    queryKey: ['revisions'],
    enabled,
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

/** `enabled` нужен для участника совместного доступа: ручка ему закрыта (issue #46). */
export function useBalances(enabled = true) {
  return useQuery({
    queryKey: ['balances'],
    enabled,
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

export interface HistoryFilter {
  /** Границы включительно-исключительно, как у периода: [from, to). */
  readonly from?: string;
  readonly to?: string;
  readonly categoryId?: string;
}

/**
 * История трат за произвольный отрезок (issue #137).
 *
 * Отдельно от `useTransactions`: тот отвечает на «что я записал в этом периоде» и живёт в листе
 * ввода, а этот — на «где я потратил 12 000 в марте». Разные вопросы, разные ключи кэша: общий ключ
 * заставлял бы список ввода перезагружаться от смены фильтра на экране истории.
 */
export function useHistory(filter: HistoryFilter) {
  const params = new URLSearchParams();
  if (filter.from) params.set('from', filter.from);
  if (filter.to) params.set('to', filter.to);
  if (filter.categoryId) params.set('categoryId', filter.categoryId);
  const qs = params.toString();
  return useQuery({
    queryKey: [
      'transactions',
      'history',
      filter.from ?? '',
      filter.to ?? '',
      filter.categoryId ?? '',
    ],
    retry: false,
    queryFn: () => api<TransactionsDto>(`/v1/transactions${qs ? `?${qs}` : ''}`),
    /*
     * Пока границы периода неизвестны, запрос не уходит. Иначе экран истории делал два запроса
     * подряд: первый без границ (сервер сам подставлял текущий период), а после ответа плана — тот
     * же самый уже с границами. Второй ответ подменял список, и он на кадр опустошался — мигание,
     * которое поймал E2E, приняв исправный фильтр за сломанный.
     */
    enabled: filter.from != null && filter.to != null,
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
function useTransactionMutation<TVars>(
  mutationFn: (vars: TVars) => Promise<unknown>,
  /**
   * `always` отключает встроенную паузу TanStack Query в офлайне (Спринт 6).
   *
   * По умолчанию Query держит мутацию в памяти до появления сети — и теряет её при перезагрузке
   * страницы, то есть ровно тогда, когда человек в метро закроет вкладку. Нам нужна пауза, которая
   * переживает закрытие приложения, поэтому запрос всё-таки уходит, падает, и запись ловит наша
   * очередь в localStorage.
   */
  networkMode?: 'always',
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    ...(networkMode ? { networkMode } : {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['plan'] });
    },
  });
}

/**
 * Правка источника дохода. Ручка PATCH была в API с самого начала, формы не было: опечатка в
 * названии чинилась удалением строки, а вместе с источником уходили подтверждённые поступления,
 * которые на него ссылаются.
 */
export function usePatchIncomeSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) =>
      api<IncomeSourceDto>(`/v1/income-sources/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['income-sources'] });
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

/**
 * Запись траты с очередью на случай отсутствия сети (Спринт 6).
 *
 * Приложение открывается из кэша, значит трату записывают и в метро. Молча проглотить её хуже, чем
 * отказать: человек видел «записано» и больше к этой покупке не вернётся. Поэтому сетевая ошибка
 * (именно сетевая — не отказ сервера) кладёт запись в очередь и считается успехом для интерфейса.
 *
 * У каждой попытки свой `clientKey`: повтор не может знать, дошла ли первая отправка, и без ключа
 * создал бы вторую такую же трату. Уникальность ключа держит БД (миграция 0019).
 */
export function useCreateSpend() {
  return useTransactionMutation<SpendInput>(async (body) => {
    const clientKey = crypto.randomUUID();
    const payload: Record<string, unknown> = { ...body, clientKey };
    try {
      return await api<Transaction>('/v1/transactions', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // Отказ сервера в очередь не идёт: он не станет успехом от повторов, о нём надо сказать сразу.
      if (err instanceof ApiError) throw err;
      enqueue({ clientKey, body: payload, queuedAt: new Date().toISOString() });
      return null;
    }
  }, 'always');
}

/**
 * Отправляет отложенные траты. Зовётся при появлении сети и при запуске приложения.
 *
 * Отказ сервера (`ApiError`) снимает запись с очереди: невалидная строка не станет валидной от
 * повторов и иначе навсегда заблокировала бы хвост. Сетевая ошибка оставляет очередь как есть.
 */
export function useFlushOutbox() {
  const qc = useQueryClient();
  return useMutation({
    // См. комментарий к useTransactionMutation: пауза Query здесь только мешает.
    networkMode: 'always',
    mutationFn: () =>
      flush(async (item) => {
        try {
          await api<Transaction>('/v1/transactions', {
            method: 'POST',
            body: JSON.stringify(item.body),
          });
          return 'sent';
        } catch (err) {
          return err instanceof ApiError ? 'rejected' : 'offline';
        }
      }),
    onSuccess: (sent) => {
      if (sent === 0) return;
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['plan'] });
    },
  });
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
      qc.setQueryData(PLAN_KEY, plan);
      void qc.invalidateQueries({ queryKey: ['transactions'] });
    },
  });
}

/**
 * Снять отметку исполнения (#119, жалоба владельца: «внесено при нажатии никак не реагирует»).
 *
 * Кнопка показывает нажатое состояние — значит должна и отжиматься. Отдельная мутация, а не
 * «подтвердить на ноль»: на сервере это разные утверждения.
 */
export function useUnconfirmExecution() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ targetKind, targetId }: { targetKind: string; targetId: string }) =>
      api<PlanDto>(`/v1/plan/current/items/${targetKind}/${targetId}/unconfirm`, {
        method: 'POST',
      }),
    onSuccess: (plan) => {
      qc.setQueryData(PLAN_KEY, plan);
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
      qc.setQueryData(PLAN_KEY, plan);
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
      qc.setQueryData(PLAN_KEY, plan);
      void qc.invalidateQueries({ queryKey: ['rebalance'] });
    },
  });
}

// --- Прогноз-таймлайн (Спринт 4) ---

export interface ForecastEvent {
  kind: 'debt_closed' | 'freed_money' | 'goal_reached' | 'goal_at_risk' | 'recurring_due';
  targetId: string;
  name: string;
  /** Валюта суммы события: долг или цель могут быть не в базовой (#99). */
  currency: string;
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

/** `enabled` нужен для участника совместного доступа: ручка ему закрыта (issue #46). */
export function useForecast(enabled = true) {
  return useQuery({
    queryKey: ['forecast'],
    enabled,
    retry: false,
    queryFn: () =>
      api<{
        horizonPeriods: number;
        /** Границы периодов на горизонте: карта рисует по ним насечки. */
        periods: { startsOn: string; endsOn: string }[];
        /** Выплаты вперёд — карта живёт не одним периодом, а тремя месяцами. */
        payouts: {
          sourceId: string;
          label: string;
          on: string;
          amountMinor: string;
          currency: string;
        }[];
        dueSoon: RecurringDue[];
        events: ForecastEvent[];
      }>('/v1/forecast'),
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

/**
 * Разбор надиктованной фразы (#107). Ручка `/transactions/voice` жила с самого начала и была
 * покрыта тестами, но кнопки к ней не было — то есть ручка оплачивалась и не приносила пользы.
 *
 * Аудио уезжает data-URL: файл диктовки — секунды, отдельное хранилище ради него разводить незачем,
 * а лимит в схеме сервера (14 МБ) заведомо выше любой такой записи.
 */
export function useParseVoice() {
  return useMutation({
    mutationFn: (audioUrl: string) =>
      api<ParsedEntryDto & { transcript: string }>('/v1/transactions/voice', {
        method: 'POST',
        body: JSON.stringify({ audioUrl }),
      }),
  });
}

/**
 * Удаление аккаунта (Спринт 6). После успеха перезагружаем страницу целиком, а не чистим кэш:
 * сессия на сервере уже мертва, и любой следующий запрос из живого приложения упрётся в 401 —
 * честнее сразу вернуть человека на вход.
 */
export function useDeleteAccount() {
  return useMutation({
    mutationFn: (confirm: string) =>
      api(`/v1/me?confirm=${encodeURIComponent(confirm)}`, { method: 'DELETE' }),
    onSuccess: () => {
      window.location.href = '/';
    },
  });
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

/**
 * Предложения правок (issue #83).
 *
 * Участник не пишет в план: он предлагает, владелец решает. Поэтому у участника та же ячейка, что
 * у владельца, но её отправка идёт другой ручкой — а лента предложений живёт у владельца.
 */
export type ProposalDto = {
  id: string;
  targetKind: string;
  targetId: string;
  startsOn: string;
  plannedMinor: string;
  status: string;
  createdAt: string;
};

export function useProposals() {
  return useQuery({
    queryKey: ['proposals'],
    retry: false,
    queryFn: () => api<{ proposals: ProposalDto[] }>('/v1/proposals'),
  });
}

export function useCreateProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cell: {
      targetKind: string;
      targetId: string;
      startsOn: string;
      plannedMinor: string;
    }) => api<ProposalDto>('/v1/proposals', { method: 'POST', body: JSON.stringify(cell) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['proposals'] }),
  });
}

export function useResolveProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, verdict }: { id: string; verdict: 'accept' | 'reject' }) =>
      api(`/v1/proposals/${id}/${verdict}`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['proposals'] });
      /*
       * Принятое предложение переставляет деньги — план и таблица обязаны это показать сразу.
       * Иначе владелец нажимает «принять», видит прежние числа и не понимает, случилось ли что-то.
       */
      void qc.invalidateQueries({ queryKey: ['plan'] });
    },
  });
}
