import { GoogleGenAI, Modality, Type } from '@google/genai';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const retryWithBackoff = async (fn, retries = 4, delayMs = 1000) => {
  try {
    return await fn();
  } catch (error) {
    const message = String(error?.message || error || '');
    if (
      retries > 0 &&
      (message.includes('429') || message.includes('RESOURCE_EXHAUSTED') || message.includes('503') || message.includes('Overloaded'))
    ) {
      await delay(delayMs);
      return retryWithBackoff(fn, retries - 1, delayMs * 2);
    }
    throw error;
  }
};

const getClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Server missing GEMINI_API_KEY');
  }
  return new GoogleGenAI({ apiKey });
};

const extractImageDataUrl = (response) => {
  for (const part of response.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData) {
      return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
    }
  }
  return null;
};

const toFileDataFromDataUrl = (dataUrl) => {
  if (!dataUrl) {
    return null;
  }

  const match = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!match) {
    return null;
  }

  return {
    mimeType: match[1],
    data: match[2]
  };
};

const normalizeJsonArray = (text) => {
  let cleaned = text || '[]';
  const firstOpen = cleaned.indexOf('[');
  const lastClose = cleaned.lastIndexOf(']');
  if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
    cleaned = cleaned.substring(firstOpen, lastClose + 1);
  } else {
    cleaned = cleaned.replace(/```json/g, '').replace(/```/g, '').trim();
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed.filter((item) => typeof item === 'string').slice(0, 3);
    }
  } catch {
    // Fall through to default.
  }

  return ['Yes', 'No', 'Maybe'];
};

export const setupStoryPack = async (storyFile, styleImages) => {
  const ai = getClient();

  const setupStart = performance.now();
  const analyzeStart = performance.now();

  const analysisResponse = await retryWithBackoff(() =>
    ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: {
        parts: [
          { inlineData: { mimeType: storyFile.mimeType, data: storyFile.data } },
          {
            text: [
              'Analyze this children\'s story PDF and return JSON.',
              'Fields:',
              '1) summary: two short kid-friendly sentences.',
              '2) art_style: at most 5 words.',
              '3) story_brief: concise structured brief for turn-time Q&A and image prompts.',
              'Return valid JSON only.'
            ].join('\n')
          }
        ]
      },
      config: {
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 },
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            art_style: { type: Type.STRING },
            story_brief: { type: Type.STRING }
          },
          required: ['summary', 'art_style', 'story_brief']
        }
      }
    })
  );

  const analyzeMs = Math.round(performance.now() - analyzeStart);

  const parsed = JSON.parse(analysisResponse.text || '{}');
  const summary = parsed.summary || 'Story analyzed.';
  const artStyle = parsed.art_style || 'Children\'s book illustration';
  const storyBrief = parsed.story_brief || summary;

  const coverStart = performance.now();
  const coverParts = [];
  const styleInputs = styleImages.length > 0 ? styleImages : [storyFile];

  for (const img of styleInputs.slice(0, 4)) {
    coverParts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
  }

  coverParts.push({
    text: [
      'Generate a 3:4 children\'s cover illustration.',
      `Summary: ${summary}`,
      `Art style: ${artStyle}`,
      'Match style references closely and keep visual clarity high.'
    ].join('\n')
  });

  const coverResponse = await retryWithBackoff(() =>
    ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: { parts: coverParts },
      config: { imageConfig: { aspectRatio: '3:4' } }
    })
  );

  const coverMs = Math.round(performance.now() - coverStart);
  const totalMs = Math.round(performance.now() - setupStart);

  const coverImage = extractImageDataUrl(coverResponse);
  const coverPrimer = toFileDataFromDataUrl(coverImage);
  const stylePrimer = styleImages.length > 0 ? styleImages.slice(0, 4) : coverPrimer ? [coverPrimer] : [];

  return {
    storyPack: {
      summary,
      artStyle,
      storyBrief,
      coverImage,
      stylePrimer
    },
    timings: {
      analyzeMs,
      coverMs,
      totalMs
    }
  };
};

export const runTurnPipeline = async (
  audioBase64,
  mimeType,
  storyBrief,
  artStyle,
  stylePrimer,
  history
) => {
  const ai = getClient();
  const totalStart = performance.now();

  const transcribeStart = performance.now();
  const transcribeResponse = await retryWithBackoff(() =>
    ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: {
        parts: [
          { inlineData: { mimeType, data: audioBase64 } },
          {
            text: [
              'Transcribe only the parent question from this audio.',
              'Return only plain text transcription.',
              `Story context: ${storyBrief}`
            ].join('\n')
          }
        ]
      },
      config: {
        thinkingConfig: { thinkingBudget: 0 }
      }
    })
  );
  const question = transcribeResponse.text?.trim() || '';
  const transcribeMs = Math.round(performance.now() - transcribeStart);

  if (!question) {
    return {
      question: '',
      cards: [],
      timings: {
        transcribeMs,
        optionsMs: 0,
        imageMsById: {},
        fullCardsMs: transcribeMs,
        totalMs: transcribeMs
      }
    };
  }

  const optionsStart = performance.now();
  const historyText = history
    .map((turn) => `${turn.role === 'parent' ? 'Parent' : 'Child'}: ${turn.text}`)
    .join('\n');

  const optionsResponse = await retryWithBackoff(() =>
    ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: {
        parts: [
          {
            text: [
              'You are helping a non-verbal child answer about a story.',
              `Story brief: ${storyBrief}`,
              `Conversation:\n${historyText}`,
              `Parent asked: ${question}`,
              'Generate exactly 3 short answers (max 5 words each):',
              '1) correct, 2) incorrect, 3) related distractor.',
              'Return JSON array of strings only.'
            ].join('\n')
          }
        ]
      },
      config: {
        responseMimeType: 'application/json',
        responseSchema: { type: Type.ARRAY, items: { type: Type.STRING } },
        thinkingConfig: { thinkingBudget: 0 }
      }
    })
  );

  const optionTexts = normalizeJsonArray(optionsResponse.text);
  const optionsMs = Math.round(performance.now() - optionsStart);

  const cards = optionTexts.map((text, idx) => ({
    id: `opt-${idx}`,
    text,
    isLoadingImage: true
  }));

  const imageMsById = {};
  const imageStart = performance.now();

  await Promise.all(
    cards.map(async (card) => {
      const start = performance.now();
      const parts = [];

      for (const ref of stylePrimer.slice(0, 4)) {
        parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.data } });
      }

      parts.push({
        text: [
          `Generate a clear square illustration for: "${card.text}".`,
          `Story context: ${storyBrief}`,
          `Art style: ${artStyle}`,
          'Match the attached style references. Keep minimal and clear background.'
        ].join('\n')
      });

      const imageResponse = await retryWithBackoff(() =>
        ai.models.generateContent({
          model: 'gemini-2.5-flash-image',
          contents: { parts },
          config: { imageConfig: { aspectRatio: '1:1' } }
        })
      );

      card.imageUrl = extractImageDataUrl(imageResponse) || undefined;
      card.isLoadingImage = false;
      imageMsById[card.id] = Math.round(performance.now() - start);
    })
  );

  const fullCardsMs = Math.round(performance.now() - imageStart);
  const totalMs = Math.round(performance.now() - totalStart);

  return {
    question,
    cards,
    timings: {
      transcribeMs,
      optionsMs,
      imageMsById,
      fullCardsMs,
      totalMs
    }
  };
};

export const synthesizeSpeech = async (text) => {
  const ai = getClient();

  const response = await retryWithBackoff(() =>
    ai.models.generateContent({
      model: 'gemini-2.5-flash-preview-tts',
      contents: { parts: [{ text }] },
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
        }
      }
    })
  );

  const inlineData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!inlineData?.data) {
    return null;
  }

  return {
    audioBase64: inlineData.data,
    mimeType: inlineData.mimeType || 'audio/L16;rate=24000'
  };
};
