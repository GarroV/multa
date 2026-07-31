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
  user: { id: string; email: string; name: string } | null;
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
  note?: string;
}

function useExchangeMutation<TVars>(mutationFn: (vars: TVars) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['exchange-ops'] });
      void qc.invalidateQueries({ queryKey: ['plan'] });
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
