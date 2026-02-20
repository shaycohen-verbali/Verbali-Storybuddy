import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { ChatTurn, ImageModelPreference, Option, StoryAssets } from '../types';
import { initialTurnSessionState, turnSessionReducer } from '../features/session/sessionReducer';
import { requestTtsFromBackend, runTurnWithBackend, USE_BACKEND_PIPELINE } from '../services/apiClient';
import { decodePcm16AudioBase64, playAudioBuffer, playPcm16AudioBase64 } from '../services/audioService';
import * as GeminiService from '../services/geminiService';

const MAX_HISTORY_TURNS_FOR_BACKEND = 6;
const MAX_HISTORY_TEXT_CHARS = 120;
const MAX_TURN_STYLE_REFS = 14;
const MAX_TURN_STYLE_PRIMER = 14;
const TURN_REQUEST_SOFT_LIMIT_BYTES = 4 * 1024 * 1024;

type TtsResponse = { audioBase64: string; mimeType: string; audioBuffer?: AudioBuffer } | null;

const readBlobAsBase64 = async (blob: Blob): Promise<string> => {
  const reader = new FileReader();
  return new Promise((resolve, reject) => {
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.split(',')[1] || '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

const truncateText = (value: string, maxChars: number): string => {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
};

const compactHistoryForBackend = (history: ChatTurn[]): ChatTurn[] =>
  history.slice(-MAX_HISTORY_TURNS_FOR_BACKEND).map((turn) => ({
    role: turn.role,
    text: truncateText(turn.text, MAX_HISTORY_TEXT_CHARS)
  }));

const ttsCacheKey = (text: string): string =>
  String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');

const estimatePayloadBytes = (payload: unknown): number => new Blob([JSON.stringify(payload || {})]).size;

const toUserFacingTurnError = (error: unknown): string => {
  const raw = String((error as any)?.message || error || '').trim();
  const lowered = raw.toLowerCase();

  if (
    lowered.includes('function_payload_too_large') ||
    lowered.includes('request entity too large') ||
    lowered.includes('payload too large') ||
    lowered.includes('body exceeded')
  ) {
    return 'This book is too large for cloud turn processing. Re-open setup with a smaller PDF or fewer style images.';
  }

  if (raw) {
    return raw;
  }

  return 'Something went wrong processing your request.';
};

export const useTurnPipeline = (
  activeAssets: StoryAssets | null,
  imageModelPreference: ImageModelPreference = 'nano-banana-pro'
) => {
  const [state, dispatch] = useReducer(turnSessionReducer, initialTurnSessionState);
  const stateRef = useRef(state);
  const ttsCacheRef = useRef<Map<string, Promise<TtsResponse>>>(new Map());

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const getTtsPromise = useCallback((text: string): Promise<TtsResponse> => {
    const key = ttsCacheKey(text);
    const cached = ttsCacheRef.current.get(key);
    if (cached) {
      return cached;
    }

    const pending = requestTtsFromBackend(text)
      .then((audio) => {
        if (!audio?.audioBase64) {
          return audio;
        }
        try {
          return {
            ...audio,
            audioBuffer: decodePcm16AudioBase64(audio.audioBase64)
          };
        } catch {
          return audio;
        }
      })
      .catch((error) => {
        console.warn('TTS prefetch failed', error);
        ttsCacheRef.current.delete(key);
        return null;
      });

    ttsCacheRef.current.set(key, pending);
    return pending;
  }, []);

  const warmTtsCache = useCallback((options: Option[]) => {
    if (!USE_BACKEND_PIPELINE) {
      return;
    }

    for (const option of options.slice(0, 3)) {
      void getTtsPromise(option.text);
    }
  }, [getTtsPromise]);

  const processRecording = useCallback(async (audioBlob: Blob) => {
    if (!activeAssets) {
      dispatch({ type: 'SET_ERROR', error: 'Please select a story first!' });
      return;
    }

    ttsCacheRef.current.clear();
    dispatch({ type: 'START', audioBlob });

    try {
      const audioBase64 = await readBlobAsBase64(audioBlob);

      if (USE_BACKEND_PIPELINE) {
        const storyText = String(activeAssets.metadata.storyText || activeAssets.storyBrief || '').trim();
        if (!storyText) {
          dispatch({
            type: 'SET_ERROR',
            error: 'This story is missing extracted book text. Open setup and save again.'
          });
          return;
        }

        const baseTurnPayload = {
          audioBase64,
          mimeType: audioBlob.type,
          storyText,
          imageModelPreference,
          storyBrief: activeAssets.storyBrief,
          storyFacts: activeAssets.metadata.storyFacts,
          artStyle: activeAssets.metadata.artStyle || 'Children\'s book illustration',
          stylePrimer: activeAssets.stylePrimer.slice(0, MAX_TURN_STYLE_PRIMER),
          // Avoid sending the full style reference pool each turn; this commonly exceeds Vercel payload limits.
          styleReferences: (activeAssets.styleReferences || []).slice(0, MAX_TURN_STYLE_REFS),
          history: compactHistoryForBackend(stateRef.current.conversationHistory)
        };

        let turnPayload = baseTurnPayload;
        let payloadBytes = estimatePayloadBytes(turnPayload);

        if (payloadBytes > TURN_REQUEST_SOFT_LIMIT_BYTES) {
          turnPayload = {
            ...baseTurnPayload,
            styleReferences: [],
            stylePrimer: activeAssets.stylePrimer.slice(0, 8)
          };
          payloadBytes = estimatePayloadBytes(turnPayload);
        }

        if (payloadBytes > TURN_REQUEST_SOFT_LIMIT_BYTES) {
          turnPayload = {
            ...turnPayload,
            stylePrimer: activeAssets.stylePrimer.slice(0, 4)
          };
          payloadBytes = estimatePayloadBytes(turnPayload);
        }

        if (payloadBytes > TURN_REQUEST_SOFT_LIMIT_BYTES) {
          dispatch({
            type: 'SET_ERROR',
            error: 'This story is too large for cloud turn processing. Open setup and save a smaller PDF.'
          });
          return;
        }

        const turnResponse = await runTurnWithBackend(turnPayload);

        if (!turnResponse.question) {
          dispatch({ type: 'SET_ERROR', error: "I couldn't hear the question. Please try again." });
          return;
        }

        dispatch({ type: 'SET_QUESTION', question: turnResponse.question });
        dispatch({ type: 'SET_STAGE', stage: 'generating_options' });
        dispatch({ type: 'SET_STAGE', stage: 'generating_images' });
        dispatch({
          type: 'SET_OPTIONS',
          options: turnResponse.cards.map((card) => ({ ...card, isLoadingImage: false }))
        });
        warmTtsCache(turnResponse.cards);
        dispatch({ type: 'SET_TIMINGS', timings: turnResponse.timings });
        dispatch({ type: 'SET_STAGE', stage: 'completed' });
        return;
      }

      const questionStart = performance.now();
      const questionText = await GeminiService.transcribeParentQuestion(
        audioBase64,
        audioBlob.type,
        activeAssets.metadata
      );
      const transcribeMs = Math.round(performance.now() - questionStart);

      if (!questionText) {
        dispatch({ type: 'SET_ERROR', error: "I couldn't hear the question. Please try again." });
        return;
      }

      dispatch({ type: 'SET_QUESTION', question: questionText });
      dispatch({ type: 'SET_STAGE', stage: 'generating_options' });

      const optionsStart = performance.now();
      const tempHistory = [...stateRef.current.conversationHistory, { role: 'parent' as const, text: questionText }];
      const textOptions = await GeminiService.generateAnswerOptions(
        questionText,
        activeAssets.pdfData || null,
        tempHistory,
        activeAssets.metadata
      );
      const optionsMs = Math.round(performance.now() - optionsStart);

      const cards: Option[] = textOptions.map((text, index) => ({
        id: `opt-${index}`,
        text,
        isLoadingImage: true
      }));
      dispatch({ type: 'SET_OPTIONS', options: cards });
      dispatch({ type: 'SET_STAGE', stage: 'generating_images' });

      const imageMsById: Record<string, number> = {};
      const imageBatchStart = performance.now();

      const generated = await Promise.all(
        cards.map(async (card) => {
          const imageStart = performance.now();
          const imageUrl = await GeminiService.generateIllustration(
            card.text,
            activeAssets.pdfData || null,
            activeAssets.stylePrimer,
            activeAssets.metadata,
            cards.filter((c) => c.id !== card.id).map((c) => c.text),
            tempHistory
          );
          imageMsById[card.id] = Math.round(performance.now() - imageStart);
          return { ...card, imageUrl: imageUrl || undefined, isLoadingImage: false };
        })
      );

      const fullCardsMs = Math.round(performance.now() - imageBatchStart);
      dispatch({ type: 'SET_OPTIONS', options: generated });
      dispatch({
        type: 'SET_TIMINGS',
        timings: {
          transcribeMs,
          optionsMs,
          imageMsById,
          fullCardsMs,
          totalMs: transcribeMs + optionsMs + fullCardsMs
        }
      });
      dispatch({ type: 'SET_STAGE', stage: 'completed' });
    } catch (error) {
      console.error('Turn pipeline failed', error);
      dispatch({ type: 'SET_ERROR', error: toUserFacingTurnError(error) });
    }
  }, [activeAssets, imageModelPreference, warmTtsCache]);

  const retry = useCallback(() => {
    if (stateRef.current.lastAudioBlob) {
      processRecording(stateRef.current.lastAudioBlob);
    }
  }, [processRecording]);

  const selectOption = useCallback(async (option: Option) => {
    dispatch({ type: 'SELECT_OPTION', optionId: option.id, optionText: option.text });

    try {
      if (USE_BACKEND_PIPELINE) {
        const audio = await getTtsPromise(option.text);
        if (audio?.audioBuffer) {
          await playAudioBuffer(audio.audioBuffer);
        } else if (audio?.audioBase64) {
          await playPcm16AudioBase64(audio.audioBase64);
        }
        return;
      }

      await GeminiService.speakText(option.text);
    } catch (error) {
      console.error('TTS failed', error);
    }
  }, [getTtsPromise]);

  const resetConversation = useCallback(() => {
    ttsCacheRef.current.clear();
    dispatch({ type: 'RESET' });
  }, []);

  const isBusy = useMemo(() => {
    return (
      state.processingStage === 'transcribing' ||
      state.processingStage === 'generating_options' ||
      state.processingStage === 'generating_images'
    );
  }, [state.processingStage]);

  return {
    ...state,
    isBusy,
    processRecording,
    retry,
    selectOption,
    resetConversation
  };
};
