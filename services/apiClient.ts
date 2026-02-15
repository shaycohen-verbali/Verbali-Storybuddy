import { SetupStoryRequest, SetupStoryResponse, TurnRequest, TurnResponse } from '../types';
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

  const json = await response.json();
  if (!response.ok) {
    throw new Error(json?.error || `Request failed: ${path}`);
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
