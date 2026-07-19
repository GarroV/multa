import { useQuery } from '@tanstack/react-query';
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
