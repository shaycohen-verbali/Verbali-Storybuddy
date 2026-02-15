import { PipelineTimings, SetupTimings } from '../types';

export const PERF_BUDGETS = {
  fullCardsP50Ms: 8000,
  fullCardsP95Ms: 14000,
  maxTurnPayloadBytes: 300 * 1024
} as const;

export const getPayloadBytes = (payload: unknown): number => {
  return new Blob([JSON.stringify(payload || {})]).size;
};

export const logPayloadSize = (label: string, payloadBytes: number): void => {
  const target = PERF_BUDGETS.maxTurnPayloadBytes;
  const status = payloadBytes <= target ? 'within budget' : 'over budget';
  console.info(`[perf] ${label} payload=${payloadBytes}B (${status}, target=${target}B)`);
};

export const logSetupTimings = (label: string, timings: SetupTimings): void => {
  console.info(
    `[perf] ${label} analyze=${timings.analyzeMs}ms cover=${timings.coverMs}ms total=${timings.totalMs}ms`
  );
};

export const logTurnTimings = (label: string, timings: PipelineTimings): void => {
  console.info(
    `[perf] ${label} transcribe=${timings.transcribeMs}ms options=${timings.optionsMs}ms fullCards=${timings.fullCardsMs}ms total=${timings.totalMs}ms`
  );
};
