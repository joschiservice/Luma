import type {
  Control,
  CreateRun,
  InjectIncident,
  RunDetail,
  RunScenario,
} from '@luma/simulator-contract';
import {
  keepPreviousData,
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { createContext, useContext } from 'react';

import {
  ApiError,
  type JournalQuery,
  type RecordQuery,
  type SimulatorApi,
} from './api';

/** Run lists and the selected run's clock refresh this often. */
const runInterval = 2_000;
/** Journal, metrics, incidents and the scorecard refresh this often. */
const detailInterval = 5_000;

/** The API client and token for the current tab. */
export interface ApiConnection {
  api: SimulatorApi;
  token: string;
  /** Stores a new token and discards data read with the previous one. */
  changeToken: (token: string) => void;
}

export const ApiContext = createContext<ApiConnection | null>(null);

/** Returns the simulator connection; must be rendered inside `ApiContext`. */
export function useConnection() {
  const connection = useContext(ApiContext);
  if (!connection) throw new Error('Simulator API context is missing.');

  return connection;
}

const useApi = () => useConnection().api;

/**
 * Creates the query cache. Client errors are final; an unreachable simulator gets one retry.
 * Polling pauses while the tab is hidden, which is TanStack Query's default.
 */
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failures, error) =>
          !(error instanceof ApiError && error.status >= 400) && failures < 1,
        refetchOnWindowFocus: true,
      },
    },
  });
}

/** Query keys, grouped by run so a deleted run's data can be dropped at once. */
const keys = {
  profiles: ['profiles'] as const,
  runs: ['runs'] as const,
  run: (id: string) => ['run', id] as const,
  journal: (id: string, filters: JournalQuery) =>
    ['run', id, 'journal', filters] as const,
  metrics: (id: string, windowMs: number) =>
    ['run', id, 'metrics', windowMs] as const,
  incidents: (id: string) => ['run', id, 'incidents'] as const,
  scorecard: (id: string) => ['run', id, 'scorecard'] as const,
  operations: (id: string) => ['run', id, 'operations'] as const,
  recordKinds: (id: string, instance: string) =>
    ['run', id, 'record-kinds', instance] as const,
  records: (id: string, instance: string, filters: RecordQuery) =>
    ['run', id, 'records', instance, filters] as const,
  skus: (id: string, prefix: string) => ['run', id, 'skus', prefix] as const,
  sku: (id: string, sku: string) => ['run', id, 'sku', sku] as const,
};

/** Merchant profiles, chaos presets and incident kinds offered by the host. */
export function useProfiles() {
  const api = useApi();

  return useQuery({
    queryKey: keys.profiles,
    queryFn: api.profiles,
    staleTime: Infinity,
  });
}

/** All runs with their lifecycle state and clock. */
export function useRuns() {
  const api = useApi();

  return useQuery({
    queryKey: keys.runs,
    queryFn: api.runs,
    refetchInterval: runInterval,
  });
}

/** One run's configuration, clock, faults and chaos profile. */
export function useRun(id: string | null) {
  const api = useApi();

  return useQuery({
    queryKey: keys.run(id ?? ''),
    queryFn: () => api.run(id ?? ''),
    enabled: id !== null,
    refetchInterval: runInterval,
  });
}

/** The newest journal entries matching the filters, refreshed while `live`. */
export function useJournalHead(
  id: string,
  filters: JournalQuery,
  live: boolean,
) {
  const api = useApi();

  return useQuery({
    queryKey: keys.journal(id, filters),
    queryFn: () => api.journal(id, filters),
    refetchInterval: live ? detailInterval : false,
    placeholderData: keepPreviousData,
  });
}

/** Aggregated run metrics over a simulation-time window ending now. */
export function useMetrics(id: string, windowMs: number) {
  const api = useApi();

  return useQuery({
    queryKey: keys.metrics(id, windowMs),
    queryFn: () => api.metrics(id, windowMs),
    refetchInterval: detailInterval,
    placeholderData: keepPreviousData,
  });
}

/** Ground-truth incidents with Luma's detection state. */
export function useIncidents(id: string) {
  const api = useApi();

  return useQuery({
    queryKey: keys.incidents(id),
    queryFn: () => api.incidents(id),
    refetchInterval: detailInterval,
  });
}

/** Detection totals compared with Luma's cases. */
export function useScorecard(id: string) {
  const api = useApi();

  return useQuery({
    queryKey: keys.scorecard(id),
    queryFn: () => api.scorecard(id),
    refetchInterval: detailInterval,
  });
}

/** Luma's inventory check status for the run, when the platform bridge is attached. */
export function useOperations(id: string) {
  const api = useApi();

  return useQuery({
    queryKey: keys.operations(id),
    queryFn: () => api.operations(id),
    refetchInterval: detailInterval,
    retry: false,
  });
}

/** Record kinds and counts stored by one provider instance. */
export function useRecordKinds(id: string, instance: string | null) {
  const api = useApi();

  return useQuery({
    queryKey: keys.recordKinds(id, instance ?? ''),
    queryFn: () => api.recordKinds(id, instance ?? ''),
    enabled: instance !== null,
    refetchInterval: detailInterval * 2,
  });
}

/** One page of provider records of a kind. */
export function useRecords(
  id: string,
  instance: string,
  filters: RecordQuery | null,
) {
  const api = useApi();

  return useQuery({
    queryKey: keys.records(id, instance, filters ?? { kind: '' }),
    queryFn: () => api.records(id, instance, filters ?? { kind: '' }),
    enabled: filters !== null,
    refetchInterval: detailInterval,
    placeholderData: keepPreviousData,
  });
}

/** SKUs starting with a prefix, up to 20. */
export function useSkuSearch(id: string, prefix: string) {
  const api = useApi();

  return useQuery({
    queryKey: keys.skus(id, prefix),
    queryFn: () => api.skus(id, prefix),
    enabled: prefix.length > 0,
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  });
}

/** ERP and shop stock for one SKU. */
export function useSku(id: string, sku: string | null) {
  const api = useApi();

  return useQuery({
    queryKey: keys.sku(id, sku ?? ''),
    queryFn: () => api.sku(id, sku ?? ''),
    enabled: sku !== null,
    refetchInterval: detailInterval,
  });
}

/** Sends a run control and stores the returned run, so the header updates at once. */
export function useControl(id: string) {
  const api = useApi();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (control: Control) => api.control(id, control),
    onSuccess: (run: RunDetail) => {
      client.setQueryData(keys.run(id), run);
      void client.invalidateQueries({ queryKey: keys.runs });
    },
  });
}

/** Creates a run and refreshes the run list. */
export function useCreateRun() {
  const api = useApi();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (body: Partial<CreateRun> & { id: string }) =>
      api.createRun(body),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.runs }),
  });
}

/** Deletes a run and drops its cached data. */
export function useDeleteRun() {
  const api = useApi();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.deleteRun(id),
    onSuccess: (_, id) => {
      client.removeQueries({ queryKey: keys.run(id) });
      void client.invalidateQueries({ queryKey: keys.runs });
    },
  });
}

/** Injects an incident; the caller keeps the ID stable across retries of one request. */
export function useInjectIncident(id: string) {
  const api = useApi();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (body: InjectIncident) => api.injectIncident(id, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.incidents(id) });
      void client.invalidateQueries({ queryKey: keys.scorecard(id) });
    },
  });
}

/** Starts a workflow scenario; the same request ID never starts it twice. */
export function useRunScenario(id: string) {
  const api = useApi();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (body: RunScenario) => api.runScenario(id, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.incidents(id) });
      void client.invalidateQueries({ queryKey: keys.scorecard(id) });
      void client.invalidateQueries({ queryKey: keys.run(id) });
    },
  });
}

/** Removes an injected incident's cause in the provider systems. */
export function useRecoverIncident(id: string) {
  const api = useApi();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (incident: string) => api.recoverIncident(id, incident),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.incidents(id) });
      void client.invalidateQueries({ queryKey: keys.scorecard(id) });
    },
  });
}

/** Asks Luma to check inventory now and stores the resulting status. */
export function useCheckOperations(id: string) {
  const api = useApi();
  const client = useQueryClient();

  return useMutation({
    mutationFn: () => api.checkOperations(id),
    onSuccess: (status) => client.setQueryData(keys.operations(id), status),
  });
}
