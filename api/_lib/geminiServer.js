import { GoogleGenAI, Modality, Type } from '@google/genai';

const RENDER_MODE_BLEND = 'blend_with_story_world';
const RENDER_MODE_STANDALONE = 'standalone_option_world';
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'the', 'to', 'with'
]);

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

const parseJsonSafe = (rawText, fallback) => {
  try {
    return JSON.parse(rawText || '');
  } catch {
    return fallback;
  }
};

const isWhereQuestion = (question) => /^\s*where\b/i.test(question || '');

const titleCaseFirst = (text) => {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const normalizePhrase = (value) => String(value || '').trim().replace(/\s+/g, ' ');

const normalizeFactList = (items, limit = 10) => {
  if (!Array.isArray(items)) return [];

  const unique = [];
  const seen = new Set();

  for (const item of items) {
    const cleaned = normalizePhrase(item);
    if (!cleaned) continue;

    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    unique.push(cleaned);
    if (unique.length >= limit) break;
  }

  return unique;
};

const normalizeCharacterSource = (value) => {
  const source = String(value || '').toLowerCase();
  if (source === 'illustrated') return 'illustrated';
  if (source === 'both') return 'both';
  return 'mentioned';
};

const mergeCharacterSource = (currentSource, nextSource) => {
  if (currentSource === nextSource) return currentSource;
  if (!currentSource) return nextSource;
  if (!nextSource) return currentSource;
  return 'both';
};

const normalizeCharacterCatalog = (catalog, fallbackCharacters) => {
  const merged = new Map();

  for (const item of Array.isArray(catalog) ? catalog : []) {
    const name = normalizePhrase(item?.name || item);
    if (!name) continue;
    const key = name.toLowerCase();
    const source = normalizeCharacterSource(item?.source);
    const previous = merged.get(key);
    merged.set(key, {
      name,
      source: mergeCharacterSource(previous?.source, source)
    });
  }

  for (const character of normalizeFactList(fallbackCharacters, 20)) {
    const key = character.toLowerCase();
    const previous = merged.get(key);
    merged.set(key, {
      name: character,
      source: mergeCharacterSource(previous?.source, 'mentioned')
    });
  }

  return Array.from(merged.values()).slice(0, 20);
};

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
  return 'In the story setting';
};

const inferWorldTagsFromText = (text) => {
  const value = (text || '').toLowerCase();
  const tags = [];

  if (/(ocean|sea|reef|underwater|coral|shark|whale|fish)/.test(value)) tags.push('ocean');
  if (/(forest|woods|jungle|tree)/.test(value)) tags.push('forest');
  if (/(school|classroom|teacher)/.test(value)) tags.push('school');
  if (/(home|house|kitchen|bedroom)/.test(value)) tags.push('home');
  if (/(playground|park|slide|swing)/.test(value)) tags.push('playground');
  if (/(beach|shore|coast|sand)/.test(value)) tags.push('beach');
  if (/(city|town|street)/.test(value)) tags.push('city');

  return [...new Set(tags)];
};

const normalizeStoryFacts = (facts, storyBrief) => {
  const characterCatalog = normalizeCharacterCatalog(
    facts?.characterCatalog || facts?.character_catalog,
    facts?.characters
  );

  const normalized = {
    characters: characterCatalog.map((entry) => entry.name),
    characterCatalog,
    places: normalizeFactList(facts?.places, 12),
    objects: normalizeFactList(facts?.objects, 12),
    events: normalizeFactList(facts?.events, 14),
    setting: normalizePhrase(facts?.setting || storyBrief || inferLocationFromStory(storyBrief)),
    worldTags: normalizeFactList(facts?.worldTags || facts?.world_tags || [], 8).map((item) => item.toLowerCase())
  };

  if (!normalized.setting) {
    normalized.setting = inferLocationFromStory(storyBrief);
  }

  if (normalized.places.length === 0) {
    normalized.places.push(inferLocationFromStory(storyBrief).replace(/^(In|On|At)\s+/i, ''));
  }

  if (normalized.worldTags.length === 0) {
    const derived = inferWorldTagsFromText(
      [normalized.setting, ...normalized.places, ...normalized.events].join(' | ')
    );
    normalized.worldTags = derived;
  }

  return normalized;
};

const tokenize = (value) => {
  const text = String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  return text
    .split(/\s+/)
    .filter((token) => token && token.length > 1 && !STOP_WORDS.has(token));
};

const canonicalOption = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/^(in|on|at)\s+/i, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const shuffle = (array) => {
  const output = [...array];
  for (let i = output.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [output[i], output[j]] = [output[j], output[i]];
  }
  return output;
};

const simplifyOptionText = (text, question) => {
  let value = normalizePhrase(text).replace(/[.?!]+$/g, '');
  if (!value) return value;
  if (/^not in this book$/i.test(value)) {
    return 'Not in this book';
  }

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

const getAllFactPhrases = (storyFacts) => [
  ...(storyFacts?.characters || []),
  ...(storyFacts?.places || []),
  ...(storyFacts?.objects || []),
  ...(storyFacts?.events || []),
  storyFacts?.setting || ''
].filter(Boolean);

const computeSupportLevel = (candidateText, evidenceText, storyFacts, question, storyBrief) => {
  const text = `${candidateText || ''} ${evidenceText || ''}`.trim();
  if (!text) return 0;

  const candidateCanonical = canonicalOption(candidateText);
  if (!candidateCanonical) return 0;
  const candidateTokens = tokenize(text);
  const storyTokens = tokenize(storyBrief || '');
  const factPhrases = getAllFactPhrases(storyFacts);
  const factTokens = tokenize(factPhrases.join(' '));

  const candidateSet = new Set(candidateTokens);
  const factSet = new Set(factTokens);
  const storySet = new Set(storyTokens);

  let score = 0;

  const phraseMatches = factPhrases.filter((phrase) => {
    const normalizedPhrase = canonicalOption(phrase);
    return normalizedPhrase && (normalizedPhrase.includes(candidateCanonical) || candidateCanonical.includes(normalizedPhrase));
  });

  if (phraseMatches.length > 0) {
    score += 35;
  }

  let overlap = 0;
  for (const token of candidateSet) {
    if (factSet.has(token)) overlap += 1;
  }
  score += Math.min(overlap * 8, 32);

  let briefOverlap = 0;
  for (const token of candidateSet) {
    if (storySet.has(token)) briefOverlap += 1;
  }
  score += Math.min(briefOverlap * 4, 16);

  if (isWhereQuestion(question)) {
    const placeMatches = (storyFacts?.places || []).some((place) =>
      canonicalOption(place).includes(candidateCanonical) || candidateCanonical.includes(canonicalOption(place))
    );

    if (placeMatches) {
      score += 20;
    }

    if (/^(in|on|at)\s+/i.test(String(candidateText || ''))) {
      score += 6;
    }
  }

  if (/not in this book/i.test(String(candidateText || ''))) {
    score = Math.max(score, 12);
  }

  return Math.max(0, Math.min(100, score));
};

const buildFallbackOptions = (question, storyBrief, storyFacts) => {
  if (isWhereQuestion(question)) {
    const bestPlace = storyFacts?.places?.[0]
      ? simplifyOptionText(`In ${storyFacts.places[0]}`, question)
      : inferLocationFromStory(storyBrief);

    return [
      {
        text: bestPlace,
        isCorrect: true,
        supportLevel: 80,
        evidence: 'Fallback location inferred from story facts.'
      },
      {
        text: 'In space',
        isCorrect: false,
        supportLevel: 8,
        evidence: ''
      },
      {
        text: 'In the desert',
        isCorrect: false,
        supportLevel: 10,
        evidence: ''
      }
    ];
  }

  return [
    {
      text: 'Not in this book',
      isCorrect: true,
      supportLevel: 15,
      evidence: 'Question appears unsupported by the book facts.'
    },
    {
      text: 'Maybe',
      isCorrect: false,
      supportLevel: 5,
      evidence: ''
    },
    {
      text: 'No idea',
      isCorrect: false,
      supportLevel: 5,
      evidence: ''
    }
  ];
};

const generateCandidates = async (ai, question, historyText, storyBrief, storyFacts) => {
  const response = await retryWithBackoff(() =>
    ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: {
        parts: [
          {
            text: [
              'You are generating answer candidates for a non-verbal child comprehension activity.',
              'Parent asks the question. Child selects one of 3 options.',
              'Use simple language suitable for ages 3-7.',
              `Story brief: ${storyBrief}`,
              `Story facts: ${JSON.stringify(storyFacts)}`,
              `Conversation:\n${historyText}`,
              `Parent asked: ${question}`,
              'Return JSON with:',
              '- candidate_correct: 3 answer candidates with text and short evidence from the story.',
              '- distractor_candidates: 6 short wrong options (still plausible choices).',
              '- not_answerable: true only when the question is not supported by book facts.',
              'Rules:',
              '1) Candidate correct options should be directly grounded in story facts.',
              '2) Distractors should stay short and child-friendly.',
              '3) For "Where" questions, format options like "In the ocean" or "At school".',
              '4) Output strict JSON only.'
            ].join('\n')
          }
        ]
      },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            candidate_correct: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  text: { type: Type.STRING },
                  evidence: { type: Type.STRING }
                },
                required: ['text', 'evidence']
              }
            },
            distractor_candidates: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            },
            not_answerable: { type: Type.BOOLEAN }
          },
          required: ['candidate_correct', 'distractor_candidates', 'not_answerable']
        },
        thinkingConfig: { thinkingBudget: 0 }
      }
    })
  );

  return parseJsonSafe(response.text, {
    candidate_correct: [],
    distractor_candidates: [],
    not_answerable: false
  });
};

const scoreCorrectCandidates = (candidates, question, storyBrief, storyFacts) => {
  const unique = [];
  const seen = new Set();

  for (const candidate of candidates || []) {
    const simplified = simplifyOptionText(candidate?.text, question);
    const canonical = canonicalOption(simplified);
    if (!simplified || !canonical || seen.has(canonical)) continue;

    seen.add(canonical);
    const supportLevel = computeSupportLevel(simplified, candidate?.evidence || '', storyFacts, question, storyBrief);

    unique.push({
      text: simplified,
      evidence: normalizePhrase(candidate?.evidence || ''),
      supportLevel
    });
  }

  unique.sort((a, b) => b.supportLevel - a.supportLevel);
  return unique;
};

const selectDistractors = ({
  candidates,
  question,
  storyBrief,
  storyFacts,
  correctCanonical,
  correctSupport
}) => {
  const selected = [];
  const seen = new Set([correctCanonical]);

  for (const rawCandidate of candidates || []) {
    const text = simplifyOptionText(rawCandidate, question);
    const canonical = canonicalOption(text);
    if (!text || !canonical || seen.has(canonical)) continue;

    const supportLevel = computeSupportLevel(text, '', storyFacts, question, storyBrief);
    const tooSupported = supportLevel >= Math.max(60, correctSupport - 8);

    if (tooSupported) {
      continue;
    }

    selected.push({
      text,
      isCorrect: false,
      supportLevel,
      evidence: ''
    });
    seen.add(canonical);

    if (selected.length === 2) {
      break;
    }
  }

  return selected;
};

const regenerateDistractors = async (ai, question, storyBrief, storyFacts, correctOption) => {
  const response = await retryWithBackoff(() =>
    ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: {
        parts: [
          {
            text: [
              'Generate 6 short wrong answer options for a non-verbal child.',
              'Keep language very simple.',
              `Question: ${question}`,
              `Correct answer: ${correctOption}`,
              `Story brief: ${storyBrief}`,
              `Story facts: ${JSON.stringify(storyFacts)}`,
              'Rules:',
              '1) Every option must be WRONG for this question.',
              '2) Do not repeat the correct answer.',
              '3) For "Where" questions, use short location phrases.',
              'Return strict JSON array of strings.'
            ].join('\n')
          }
        ]
      },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: { type: Type.STRING }
        },
        thinkingConfig: { thinkingBudget: 0 }
      }
    })
  );

  try {
    const parsed = JSON.parse(response.text || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const buildFinalOptions = async ({ ai, question, storyBrief, storyFacts, candidatePayload }) => {
  const fallback = buildFallbackOptions(question, storyBrief, storyFacts);

  if (candidatePayload?.not_answerable) {
    return {
      options: [
        {
          text: 'Not in this book',
          isCorrect: true,
          supportLevel: 20,
          evidence: 'Model marked this question as unsupported by the book.'
        },
        ...fallback.filter((item) => !item.isCorrect).slice(0, 2)
      ],
      regenerationCount: 0
    };
  }

  const scoredCandidates = scoreCorrectCandidates(
    candidatePayload?.candidate_correct,
    question,
    storyBrief,
    storyFacts
  );

  const selectedCorrect = scoredCandidates[0];

  if (!selectedCorrect) {
    return {
      options: fallback,
      regenerationCount: 0
    };
  }

  const correctCanonical = canonicalOption(selectedCorrect.text);
  let distractors = selectDistractors({
    candidates: candidatePayload?.distractor_candidates,
    question,
    storyBrief,
    storyFacts,
    correctCanonical,
    correctSupport: selectedCorrect.supportLevel
  });

  let regenerationCount = 0;

  if (distractors.length < 2) {
    regenerationCount = 1;
    const regenerated = await regenerateDistractors(ai, question, storyBrief, storyFacts, selectedCorrect.text);

    const fromRegeneration = selectDistractors({
      candidates: regenerated,
      question,
      storyBrief,
      storyFacts,
      correctCanonical,
      correctSupport: selectedCorrect.supportLevel
    });

    const combined = [...distractors, ...fromRegeneration];
    const deduped = [];
    const seen = new Set();

    for (const option of combined) {
      const key = canonicalOption(option.text);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(option);
      if (deduped.length === 2) break;
    }

    distractors = deduped;
  }

  if (distractors.length < 2) {
    const fallbackDistractors = fallback.filter((item) => !item.isCorrect);
    const existing = new Set(distractors.map((item) => canonicalOption(item.text)));

    for (const extra of fallbackDistractors) {
      const key = canonicalOption(extra.text);
      if (key === correctCanonical || existing.has(key)) continue;
      distractors.push(extra);
      existing.add(key);
      if (distractors.length === 2) break;
    }
  }

  const options = [
    {
      text: selectedCorrect.text,
      isCorrect: true,
      supportLevel: selectedCorrect.supportLevel,
      evidence: selectedCorrect.evidence
    },
    ...distractors.slice(0, 2)
  ];

  while (options.length < 3) {
    const fallbackOption = fallback[options.length];
    options.push(fallbackOption);
  }

  return {
    options,
    regenerationCount
  };
};

const isOptionInStoryFacts = (optionText, storyFacts, storyBrief) => {
  const canonical = canonicalOption(optionText);
  if (!canonical) return false;

  const factPhrases = getAllFactPhrases(storyFacts).map((phrase) => canonicalOption(phrase));
  const phraseMatch = factPhrases.some(
    (phrase) => phrase && (phrase.includes(canonical) || canonical.includes(phrase))
  );

  if (phraseMatch) {
    return true;
  }

  const optionTokens = tokenize(optionText);
  const factTokens = new Set(tokenize(factPhrases.join(' ')));
  const briefTokens = new Set(tokenize(storyBrief || ''));

  let overlap = 0;
  for (const token of optionTokens) {
    if (factTokens.has(token) || briefTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap >= 2;
};

const determineRenderMode = (optionText, isCorrect, supportLevel, storyFacts, storyBrief) => {
  if (isCorrect) {
    return RENDER_MODE_BLEND;
  }

  const text = String(optionText || '').toLowerCase();
  const inStory = isOptionInStoryFacts(optionText, storyFacts, storyBrief) || supportLevel >= 55;

  if (inStory) {
    return RENDER_MODE_BLEND;
  }

  const hasOceanWorld = (storyFacts?.worldTags || []).includes('ocean') || /ocean|underwater|reef|sea/.test(storyBrief || '');
  const optionIsForest = /forest|woods|jungle|tree/.test(text);

  if (hasOceanWorld && optionIsForest) {
    return RENDER_MODE_STANDALONE;
  }

  return RENDER_MODE_STANDALONE;
};

const buildImagePrompt = ({ optionText, renderMode, storyBrief, artStyle, storyFacts }) => {
  const allowedCharacters = (storyFacts?.characterCatalog || [])
    .map((entry) => normalizePhrase(entry?.name))
    .filter(Boolean)
    .slice(0, 12);
  const normalizedOption = canonicalOption(optionText);
  const optionUsesKnownCharacter = allowedCharacters.some((name) => {
    const normalizedName = canonicalOption(name);
    return normalizedName && normalizedOption.includes(normalizedName);
  });

  const characterRules = allowedCharacters.length > 0
    ? [
        `- Allowed characters from this book only: ${allowedCharacters.join(', ')}.`,
        '- Never invent new people, animals, or creatures that are not in the allowed list.',
        optionUsesKnownCharacter
          ? '- If a character is shown, prioritize the matching allowed character.'
          : '- If the option is about a place/object, avoid adding extra characters.'
      ]
    : [
        '- Do not invent any named characters.',
        '- Prefer object/location-only scenes when possible.'
      ];

  const styleLayer = [
    'STYLE LAYER:',
    `- Match the attached style references exactly.`,
    `- Art style description: ${artStyle || 'Children\'s book illustration'}.`,
    '- Keep clean linework, soft kid-friendly colors, and one clear focal subject.',
    '- Composition must be easy for a non-verbal child to recognize quickly.',
    ...characterRules
  ];

  const semanticLayer =
    renderMode === RENDER_MODE_BLEND
      ? [
          'SEMANTIC LAYER:',
          `- Main subject to depict: "${optionText}".`,
          '- Blend the subject naturally into the story world when plausible.',
          `- Story world context: ${storyFacts?.setting || storyBrief}.`,
          '- Keep the scene simple with minimal clutter.'
        ]
      : [
          'SEMANTIC LAYER:',
          `- Main subject to depict: "${optionText}".`,
          '- Render this option in its normal real-world context.',
          `- Keep style consistent with the story art, but DO NOT force story-world mashups.`,
          '- Explicitly avoid adding underwater/ocean setting unless the option itself requires it.',
          '- Keep the scene simple with minimal clutter.'
        ];

  return [...styleLayer, ...semanticLayer].join('\n');
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
              'Analyze this children\'s story PDF and return strict JSON.',
              'Fields:',
              '1) summary: two short kid-friendly sentences.',
              '2) art_style: at most 5 words.',
              '3) story_brief: concise but detailed brief for comprehension Q&A.',
              '4) story_facts object with:',
              '   - characters: short names/roles (all characters in book)',
              '   - character_catalog: list of all characters that are mentioned or illustrated',
              '     each item: {name, source} where source is mentioned, illustrated, or both',
              '   - places: concrete locations mentioned',
              '   - objects: key objects',
              '   - events: key events in sequence fragments',
              '   - setting: one short sentence for overall world',
              '   - world_tags: short tags like ocean, school, forest',
              'Keep facts compact and evidence-based. Return valid JSON only.'
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
            story_brief: { type: Type.STRING },
            story_facts: {
              type: Type.OBJECT,
              properties: {
                characters: { type: Type.ARRAY, items: { type: Type.STRING } },
                character_catalog: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      name: { type: Type.STRING },
                      source: { type: Type.STRING }
                    },
                    required: ['name', 'source']
                  }
                },
                places: { type: Type.ARRAY, items: { type: Type.STRING } },
                objects: { type: Type.ARRAY, items: { type: Type.STRING } },
                events: { type: Type.ARRAY, items: { type: Type.STRING } },
                setting: { type: Type.STRING },
                world_tags: { type: Type.ARRAY, items: { type: Type.STRING } }
              },
              required: ['characters', 'character_catalog', 'places', 'objects', 'events', 'setting', 'world_tags']
            }
          },
          required: ['summary', 'art_style', 'story_brief', 'story_facts']
        }
      }
    })
  );

  const analyzeMs = Math.round(performance.now() - analyzeStart);

  const parsed = parseJsonSafe(analysisResponse.text, {});
  const summary = parsed.summary || 'Story analyzed.';
  const artStyle = parsed.art_style || 'Children\'s book illustration';
  const storyBrief = parsed.story_brief || summary;

  let extractedCharacterCatalog = [];
  try {
    const characterResponse = await retryWithBackoff(() =>
      ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: {
          parts: [
            { inlineData: { mimeType: storyFile.mimeType, data: storyFile.data } },
            {
              text: [
                'Extract all story characters from this children\'s book PDF.',
                'Include characters that are explicitly mentioned in text and characters that are visually illustrated.',
                'Return strict JSON with character_catalog only.',
                'Each item must be: {name, source} and source must be one of mentioned, illustrated, both.'
              ].join('\n')
            }
          ]
        },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              character_catalog: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    source: { type: Type.STRING }
                  },
                  required: ['name', 'source']
                }
              }
            },
            required: ['character_catalog']
          },
          thinkingConfig: { thinkingBudget: 0 }
        }
      })
    );

    const characterPayload = parseJsonSafe(characterResponse.text, { character_catalog: [] });
    extractedCharacterCatalog = Array.isArray(characterPayload.character_catalog)
      ? characterPayload.character_catalog
      : [];
  } catch {
    extractedCharacterCatalog = [];
  }

  const storyFacts = normalizeStoryFacts(
    {
      ...(parsed.story_facts || {}),
      character_catalog: [
        ...((parsed.story_facts && parsed.story_facts.character_catalog) || []),
        ...extractedCharacterCatalog
      ]
    },
    storyBrief
  );

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
      storyFacts,
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
  storyFacts,
  artStyle,
  stylePrimer,
  history
) => {
  const ai = getClient();
  const totalStart = performance.now();
  const normalizedFacts = normalizeStoryFacts(storyFacts, storyBrief);

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
              'This is a reading comprehension activity for a non-verbal child.',
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

  let candidatePayload;
  try {
    candidatePayload = await generateCandidates(ai, question, historyText, storyBrief, normalizedFacts);
  } catch {
    candidatePayload = null;
  }

  const { options: resolvedOptions, regenerationCount } = await buildFinalOptions({
    ai,
    question,
    storyBrief,
    storyFacts: normalizedFacts,
    candidatePayload
  });

  const shuffled = shuffle(resolvedOptions);
  const optionsMs = Math.round(performance.now() - optionsStart);

  const cards = shuffled.map((choice, idx) => {
    const renderMode = determineRenderMode(
      choice.text,
      choice.isCorrect,
      choice.supportLevel || 0,
      normalizedFacts,
      storyBrief
    );

    return {
      id: `opt-${idx}`,
      text: choice.text,
      isLoadingImage: true,
      type: choice.isCorrect ? 'correct' : 'wrong',
      isCorrect: choice.isCorrect,
      renderMode,
      supportLevel: choice.supportLevel || 0
    };
  });

  const wrongCards = cards.filter((card) => !card.isCorrect);
  const accidentalTruthCount = wrongCards.filter((card) => (card.supportLevel || 0) >= 60).length;
  const renderModeSplit = cards.reduce(
    (acc, card) => {
      if (card.renderMode === RENDER_MODE_BLEND) acc.blend += 1;
      else acc.standalone += 1;
      return acc;
    },
    { blend: 0, standalone: 0 }
  );

  console.info(
    `[qa] turn options wrong_truth_rate=${(accidentalTruthCount / Math.max(wrongCards.length, 1)).toFixed(2)} ` +
      `render_split=${renderModeSplit.blend}/${renderModeSplit.standalone} regenerations=${regenerationCount}`
  );

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
        text: buildImagePrompt({
          optionText: card.text,
          renderMode: card.renderMode,
          storyBrief,
          artStyle,
          storyFacts: normalizedFacts
        })
      });

      try {
        const imageResponse = await retryWithBackoff(() =>
          ai.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: { parts },
            config: { imageConfig: { aspectRatio: '1:1' } }
          })
        );

        card.imageUrl = extractImageDataUrl(imageResponse) || undefined;
      } catch (error) {
        console.warn('[image] generation failed', card.id, error?.message || error);
        card.imageUrl = undefined;
      }

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
