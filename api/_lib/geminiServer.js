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

const isWhereQuestion = (question) => /^\s*where\b/i.test(question || '');

const inferLocationFromStory = (storyBrief) => {
  const brief = (storyBrief || '').toLowerCase();
  if (/(ocean|sea|underwater|reef|shark|whale|fish)/.test(brief)) return 'In the ocean';
  if (/(beach|shore|coast)/.test(brief)) return 'On the beach';
  if (/(forest|jungle|woods|tree)/.test(brief)) return 'In the forest';
  if (/(home|house|bedroom|kitchen)/.test(brief)) return 'At home';
  if (/(school|classroom)/.test(brief)) return 'At school';
  if (/(farm|barn)/.test(brief)) return 'On a farm';
  if (/(city|town|street)/.test(brief)) return 'In the city';
  if (/(cave)/.test(brief)) return 'In a cave';
  return 'In the ocean';
};

const titleCaseFirst = (text) => {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const simplifyOptionText = (text, question) => {
  let value = String(text || '').trim().replace(/[.?!]+$/g, '').replace(/\s+/g, ' ');
  if (!value) return value;

  if (isWhereQuestion(question)) {
    value = value.replace(/^(a|an|the)\s+/i, '');
    if (!/^(in|on|at)\s+/i.test(value)) {
      value = `In ${value.toLowerCase()}`;
    }
  }

  const words = value.split(' ');
  if (words.length > 4) {
    value = words.slice(0, 4).join(' ');
  }

  return titleCaseFirst(value);
};

const buildFallbackOptions = (question, storyBrief) => {
  if (isWhereQuestion(question)) {
    return [
      { text: inferLocationFromStory(storyBrief), isCorrect: true },
      { text: 'In space', isCorrect: false },
      { text: 'In the desert', isCorrect: false }
    ];
  }

  return [
    { text: 'Not in this book', isCorrect: true },
    { text: 'Maybe', isCorrect: false },
    { text: 'No idea', isCorrect: false }
  ];
};

const normalizeOptionSet = (rawText, question, storyBrief) => {
  const fallback = buildFallbackOptions(question, storyBrief);

  try {
    const parsed = JSON.parse(rawText || '{}');
    const options = Array.isArray(parsed?.options) ? parsed.options : [];
    const mapped = options
      .map((opt) => ({
        text: simplifyOptionText(opt?.text, question),
        isCorrect: Boolean(opt?.is_correct)
      }))
      .filter((opt) => opt.text.length > 0)
      .slice(0, 3);

    if (mapped.length !== 3) {
      return fallback;
    }

    const correctCount = mapped.filter((opt) => opt.isCorrect).length;
    if (correctCount !== 1) {
      mapped[0].isCorrect = true;
      mapped[1].isCorrect = false;
      mapped[2].isCorrect = false;
    }

    // Shuffle to avoid always placing the correct answer first.
    for (let i = mapped.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [mapped[i], mapped[j]] = [mapped[j], mapped[i]];
    }

    return mapped;
  } catch {
    return fallback;
  }
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
              '3) story_brief: concise but detailed comprehension brief for turn-time Q&A.',
              'Include in story_brief: main characters, setting, sequence of key events, and concrete facts answerable from the book.',
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
              'This is a book comprehension activity for a non-verbal child who chooses among answers.',
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
              'You are helping a non-verbal child answer a reading-comprehension question.',
              'The parent is the reader. The child is the answerer.',
              'Every answer option MUST be grounded in the story context below.',
              'Use simple child language (age 3-7), no advanced vocabulary.',
              `Story brief: ${storyBrief}`,
              `Conversation:\n${historyText}`,
              `Parent asked: ${question}`,
              'Task: return exactly 3 short answer options (max 4 words each).',
              'Exactly ONE option must be correct for the parent question based on the story.',
              'The other TWO options must be clearly incorrect but still plausible choices.',
              'For "Where" questions, use location phrases like "In the ocean", "At home", or "At school".',
              'If the question cannot be answered from the story, mark "Not in this book" as the only correct option.',
              'Return strict JSON object: {"options":[{"text":"...","is_correct":true|false}, ...]}'
            ].join('\n')
          }
        ]
      },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            options: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  text: { type: Type.STRING },
                  is_correct: { type: Type.BOOLEAN }
                },
                required: ['text', 'is_correct']
              }
            }
          },
          required: ['options']
        },
        thinkingConfig: { thinkingBudget: 0 }
      }
    })
  );

  const optionChoices = normalizeOptionSet(optionsResponse.text, question, storyBrief);
  const optionsMs = Math.round(performance.now() - optionsStart);

  const cards = optionChoices.map((choice, idx) => ({
    id: `opt-${idx}`,
    text: choice.text,
    isLoadingImage: true,
    type: choice.isCorrect ? 'correct' : 'wrong'
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
