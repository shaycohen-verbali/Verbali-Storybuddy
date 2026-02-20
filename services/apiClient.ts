import {
  RuntimeLoadBookRequest,
  RuntimeLoadBookResponse,
  RuntimePlanResponse,
  RuntimeQuizResponse,
  RuntimeRenderResponse,
  SetupStoryRequest,
  SetupStoryResponse,
  TurnRequest,
  TurnResponse
} from '../types';
import { getPayloadBytes, logPayloadSize, logSetupTimings, logTurnTimings } from './performanceService';

export const USE_BACKEND_PIPELINE = import.meta.env.VITE_USE_BACKEND_PIPELINE !== 'false';

const postJson = async <TResponse>(path: string, payload: unknown): Promise<TResponse> => {
  const payloadBytes = getPayloadBytes(payload);
  logPayloadSize(path, payloadBytes);

  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const raw = await response.text();
  let json: any = null;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    json = null;
  }

  if (!response.ok) {
    const textError = raw?.trim();
    throw new Error(json?.error || textError || `Request failed: ${path}`);
  }

  if (!json) {
    throw new Error(`Invalid JSON response from ${path}`);
  }

  return json as TResponse;
};

export const setupStoryWithBackend = async (payload: SetupStoryRequest): Promise<SetupStoryResponse> => {
  const response = await postJson<SetupStoryResponse>('/api/setup-story', payload);
  logSetupTimings('setup-story', response.timings);
  return response;
};

export const runTurnWithBackend = async (payload: TurnRequest): Promise<TurnResponse> => {
  const nonAudioPayload = { ...payload, audioBase64: '<omitted>' };
  logPayloadSize('/api/turn(non-audio)', getPayloadBytes(nonAudioPayload));
  const response = await postJson<TurnResponse>('/api/turn', payload);
  logTurnTimings('turn', response.timings);
  return response;
};

export const requestTtsFromBackend = async (text: string): Promise<{ audioBase64: string; mimeType: string } | null> => {
  const response = await postJson<{ audio: { audioBase64: string; mimeType: string } | null }>('/api/tts', { text });
  return response.audio;
};

export const loadRuntimeBook = async (payload: RuntimeLoadBookRequest): Promise<RuntimeLoadBookResponse> =>
  postJson<RuntimeLoadBookResponse>('/api/runtime-load-book', payload);

export const createRuntimePlan = async (payload: {
  book_id: string;
  question_text: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  qa_ready_package?: unknown;
  style_references?: unknown[];
  force_reload?: boolean;
}): Promise<RuntimePlanResponse> =>
  postJson<RuntimePlanResponse>('/api/runtime-plan', payload);

export const renderRuntimePlanImages = async (qa_plan_id: string): Promise<RuntimeRenderResponse> =>
  postJson<RuntimeRenderResponse>('/api/runtime-render', { qa_plan_id });

export const runRuntimeQuiz = async (payload: {
  book_id: string;
  question_text: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  qa_ready_package?: unknown;
  style_references?: unknown[];
  force_reload?: boolean;
}): Promise<RuntimeQuizResponse> =>
  postJson<RuntimeQuizResponse>('/api/runtime-quiz', payload);

export const getRuntimeEvents = async (params?: { book_id?: string; qa_plan_id?: string; limit?: number }) =>
  postJson<{ count: number; events: unknown[] }>('/api/runtime-events', params || {});
