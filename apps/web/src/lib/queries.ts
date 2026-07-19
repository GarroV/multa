import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api.ts';

export interface WorkspaceDto {
  id: string;
  baseCurrency: string;
  timezone: string;
  locale: 'ru' | 'en';
  periodAnchors: unknown | null;
  expectedIncomeMinor: string | null;
}

export interface MeDto {
  user: { id: string; email: string; name: string } | null;
  workspace: WorkspaceDto | null;
}

export interface PlanDto {
  period: { startsOn: string; endsOn: string };
  daysInPeriod: number;
  daysLeft: number;
  baseCurrency: string;
  expectedIncomeMinor: string | null;
  canSpendPerDayMinor: string;
  allocations: unknown[];
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
          return { user: null, workspace: null };
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

export type EntityName = 'debts' | 'envelopes' | 'goals' | 'buckets';

export function useEntities<T>(name: EntityName) {
  return useQuery({ queryKey: [name], retry: false, queryFn: () => api<T[]>(`/v1/${name}`) });
}

export function useCreateEntity(name: EntityName) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) => api(`/v1/${name}`, { method: 'POST', body: JSON.stringify(body) }),
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
