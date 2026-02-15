import { useCallback, useState } from 'react';
import { SetupStoryResponse, FileData } from '../types';
import { setupStoryWithBackend, USE_BACKEND_PIPELINE } from '../services/apiClient';
import { logPayloadSize, logSetupTimings } from '../services/performanceService';
import * as GeminiService from '../services/geminiService';

export const useStorySetup = () => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prepareStory = useCallback(async (storyFile: FileData, styleImages: FileData[]): Promise<SetupStoryResponse> => {
    setIsProcessing(true);
    setError(null);

    try {
      if (USE_BACKEND_PIPELINE) {
        const response = await setupStoryWithBackend({ storyFile, styleImages });
        return response;
      }

      const start = performance.now();
      const analyzeStart = performance.now();
      const analysis = await GeminiService.analyzeStoryStructure(storyFile);
      const analyzeMs = Math.round(performance.now() - analyzeStart);

      const coverStart = performance.now();
      const coverImage = await GeminiService.generateCoverIllustration(
        analysis.summary,
        analysis.artStyle,
        storyFile
      );
      const coverMs = Math.round(performance.now() - coverStart);
      const totalMs = Math.round(performance.now() - start);

      const payloadBytes = new Blob([JSON.stringify({ storyFile, styleImages })]).size;
      logPayloadSize('legacy/setup-story', payloadBytes);

      const response: SetupStoryResponse = {
        storyPack: {
          summary: analysis.summary,
          artStyle: analysis.artStyle,
          storyBrief: analysis.summary,
          coverImage,
          stylePrimer: styleImages.length > 0 ? styleImages : coverImage ? [{
            mimeType: coverImage.split(';')[0].replace('data:', ''),
            data: coverImage.split(',')[1] || ''
          }] : []
        },
        timings: { analyzeMs, coverMs, totalMs },
        payloadBytes
      };

      logSetupTimings('legacy/setup-story', response.timings);
      return response;
    } catch (err: any) {
      const message = err?.message || 'Failed to prepare story';
      setError(message);
      throw err;
    } finally {
      setIsProcessing(false);
    }
  }, []);

  return {
    isProcessing,
    error,
    prepareStory
  };
};
