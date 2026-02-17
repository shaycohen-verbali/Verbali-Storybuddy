import { GoogleGenAI, Modality, Type } from '@google/genai';

const RENDER_MODE_BLEND = 'blend_with_story_world';
const RENDER_MODE_STANDALONE = 'standalone_option_world';
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'the', 'to', 'with'
]);
const MAX_OPTION_WORDS = 10;
const MAX_TTS_WORDS = 10;
const MAX_STORY_BRIEF_PROMPT_CHARS = 700;
const MAX_HISTORY_TURNS_FOR_PROMPT = 4;
const MAX_HISTORY_TEXT_CHARS = 90;
const MAX_FACT_PROMPT_ITEMS = 8;
const IMAGE_MODEL = (process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image').trim();
const STYLE_REF_MAX_TOTAL = 14;
const STYLE_REF_SCENE_QUOTA = 6;
const STYLE_REF_CHARACTER_QUOTA = 4;
const STYLE_REF_OBJECT_QUOTA = 4;
const MAX_CHARACTER_REFS_PER_CHARACTER = 3;

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
const truncate = (value, maxChars) => {
  const normalized = normalizePhrase(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
};
const limitWords = (value, maxWords) => {
  const normalized = normalizePhrase(value);
  if (!normalized) return '';
  const words = normalized.split(' ');
  if (words.length <= maxWords) {
    return normalized;
  }
  return words.slice(0, maxWords).join(' ');
};

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

const normalizeCharacterImageMap = (imageMap, characterCatalog, maxRefCount) => {
  const allowed = new Map(
    (Array.isArray(characterCatalog) ? characterCatalog : [])
      .map((entry) => [String(entry?.name || '').toLowerCase(), String(entry?.name || '').trim()])
      .filter((entry) => entry[0] && entry[1])
  );
  const normalized = new Map();

  for (const item of Array.isArray(imageMap) ? imageMap : []) {
    const key = String(item?.characterName || item?.character_name || '').trim().toLowerCase();
    const canonicalName = allowed.get(key);
    if (!canonicalName) continue;

    const sourceIndexes = Array.isArray(item?.styleRefIndexes)
      ? item.styleRefIndexes
      : Array.isArray(item?.style_ref_indexes)
        ? item.style_ref_indexes
        : [];

    const validIndexes = sourceIndexes
      .map((index) => Number(index))
      .filter((index) => Number.isInteger(index) && index >= 0 && index < maxRefCount);

    if (validIndexes.length === 0) continue;

    const existing = normalized.get(canonicalName) || [];
    const merged = [...existing, ...validIndexes];
    const deduped = [...new Set(merged)].slice(0, 6);

    normalized.set(canonicalName, deduped);
  }

  return Array.from(normalized.entries()).map(([characterName, styleRefIndexes]) => ({
    characterName,
    styleRefIndexes
  }));
};

const normalizeObjectImageMap = (imageMap, objects, maxRefCount) => {
  const allowed = new Map(
    normalizeFactList(objects, 40)
      .map((name) => [name.toLowerCase(), name])
      .filter((entry) => entry[0] && entry[1])
  );
  const normalized = new Map();

  for (const item of Array.isArray(imageMap) ? imageMap : []) {
    const key = String(item?.objectName || item?.object_name || '').trim().toLowerCase();
    const canonicalName = allowed.get(key);
    if (!canonicalName) continue;

    const sourceIndexes = Array.isArray(item?.styleRefIndexes)
      ? item.styleRefIndexes
      : Array.isArray(item?.style_ref_indexes)
        ? item.style_ref_indexes
        : [];

    const validIndexes = sourceIndexes
      .map((index) => Number(index))
      .filter((index) => Number.isInteger(index) && index >= 0 && index < maxRefCount);

    if (validIndexes.length === 0) continue;

    const existing = normalized.get(canonicalName) || [];
    const merged = [...existing, ...validIndexes];
    const deduped = [...new Set(merged)].slice(0, 6);

    normalized.set(canonicalName, deduped);
  }

  return Array.from(normalized.entries()).map(([objectName, styleRefIndexes]) => ({
    objectName,
    styleRefIndexes
  }));
};

const normalizeStyleReferenceKind = (value, fallback = 'scene') => {
  const kind = String(value || '').toLowerCase();
  if (kind === 'character') return 'character';
  if (kind === 'object') return 'object';
  if (kind === 'scene') return 'scene';
  return fallback;
};

const normalizeStyleReferenceSource = (value, fallback = 'upload') => {
  const source = String(value || '').toLowerCase();
  if (source === 'pdf_page') return 'pdf_page';
  if (source === 'upload') return 'upload';
  if (source === 'crop') return 'crop';
  if (source === 'generated') return 'generated';
  return fallback;
};

const normalizeConfidence = (value, fallback = 0.5) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
};

const styleRefFingerprint = (item) => {
  if (!item?.data || !item?.mimeType) return '';
  const middleStart = Math.max(0, Math.floor(item.data.length / 2) - 24);
  return [
    item.mimeType,
    item.data.length,
    item.data.slice(0, 40),
    item.data.slice(middleStart, middleStart + 48),
    item.data.slice(-40)
  ].join(':');
};

const normalizeStyleReferenceAssets = (styleRefs, fallbackSource = 'upload', dedupe = true) => {
  const normalized = [];
  const seen = new Set();

  for (const ref of Array.isArray(styleRefs) ? styleRefs : []) {
    if (!ref?.data || !ref?.mimeType) continue;

    const fingerprint = styleRefFingerprint(ref);
    if (!fingerprint) continue;
    if (dedupe && seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    normalized.push({
      mimeType: ref.mimeType,
      data: ref.data,
      kind: normalizeStyleReferenceKind(ref.kind, 'scene'),
      source: normalizeStyleReferenceSource(ref.source, fallbackSource),
      characterName: normalizePhrase(ref.characterName || ''),
      objectName: normalizePhrase(ref.objectName || ''),
      pageIndex: Number.isInteger(ref.pageIndex) ? Number(ref.pageIndex) : undefined,
      confidence: normalizeConfidence(ref.confidence, 0.5),
      detectedCharacters: Array.isArray(ref.detectedCharacters)
        ? ref.detectedCharacters
            .map((entry) => ({
              name: normalizePhrase(entry?.name || ''),
              confidence: normalizeConfidence(entry?.confidence, 0.5)
            }))
            .filter((entry) => entry.name)
            .slice(0, 4)
        : [],
      detectedObjects: Array.isArray(ref.detectedObjects)
        ? ref.detectedObjects
            .map((entry) => ({
              name: normalizePhrase(entry?.name || ''),
              confidence: normalizeConfidence(entry?.confidence, 0.5)
            }))
            .filter((entry) => entry.name)
            .slice(0, 4)
        : []
    });
  }

  return normalized;
};

const buildAllowedCharacterMap = (storyFacts) =>
  new Map(
    (storyFacts?.characterCatalog || [])
      .map((entry) => [String(entry?.name || '').trim().toLowerCase(), String(entry?.name || '').trim()])
      .filter((entry) => entry[0] && entry[1])
  );

const buildAllowedObjectMap = (storyFacts) =>
  new Map(
    (storyFacts?.objects || [])
      .map((entry) => [String(entry || '').trim().toLowerCase(), String(entry || '').trim()])
      .filter((entry) => entry[0] && entry[1])
  );

const normalizeToAllowedName = (value, allowedMap) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  return allowedMap.get(normalized) || '';
};

const classifyStyleReferences = async (ai, styleRefs, storyFacts) => {
  const references = normalizeStyleReferenceAssets(styleRefs).slice(0, STYLE_REF_MAX_TOTAL);
  if (references.length === 0) {
    return [];
  }

  const allowedCharacters = (storyFacts?.characterCatalog || []).map((entry) => entry.name).filter(Boolean);
  const allowedObjects = (storyFacts?.objects || []).slice(0, 20);

  const parts = [
    {
      text: [
        'Classify each style reference image.',
        `Character names allowed: ${allowedCharacters.join(', ') || 'none'}.`,
        `Object names allowed: ${allowedObjects.join(', ') || 'none'}.`,
        `You will receive ${references.length} images in order.`,
        'Return strict JSON with classifications array.',
        'Each item must contain:',
        '- image_index (number)',
        '- kind (scene | character | object)',
        '- confidence (0..1)',
        '- characters (array of exact allowed names)',
        '- objects (array of exact allowed object names)',
        'Rules:',
        '- If image is a character crop, use kind=character.',
        '- If image highlights a key object, use kind=object.',
        '- Use kind=scene for page-wide or environmental references.'
      ].join('\n')
    }
  ];

  references.forEach((reference, index) => {
    parts.push({ text: `Reference image index ${index}` });
    parts.push({ inlineData: { mimeType: reference.mimeType, data: reference.data } });
  });

  try {
    const response = await retryWithBackoff(() =>
      ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: { parts },
        config: {
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 0 },
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              classifications: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    image_index: { type: Type.NUMBER },
                    kind: { type: Type.STRING },
                    confidence: { type: Type.NUMBER },
                    characters: { type: Type.ARRAY, items: { type: Type.STRING } },
                    objects: { type: Type.ARRAY, items: { type: Type.STRING } }
                  },
                  required: ['image_index', 'kind', 'confidence', 'characters', 'objects']
                }
              }
            },
            required: ['classifications']
          }
        }
      })
    );

    return parseJsonSafe(response.text, { classifications: [] }).classifications || [];
  } catch (error) {
    console.warn('[setup] style reference classification failed', error?.message || error);
    return [];
  }
};

const mergeStyleReferenceClassification = (styleRefs, classifications, storyFacts) => {
  const references = normalizeStyleReferenceAssets(styleRefs).slice(0, STYLE_REF_MAX_TOTAL);
  const classificationMap = new Map();
  for (const item of Array.isArray(classifications) ? classifications : []) {
    const idx = Number(item?.image_index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= references.length) continue;
    classificationMap.set(idx, item);
  }

  const allowedCharacters = buildAllowedCharacterMap(storyFacts);
  const allowedObjects = buildAllowedObjectMap(storyFacts);

  return references.map((reference, index) => {
    const classification = classificationMap.get(index);
    const characters = (Array.isArray(classification?.characters) ? classification.characters : [])
      .map((name) => normalizeToAllowedName(name, allowedCharacters))
      .filter(Boolean);
    const objects = (Array.isArray(classification?.objects) ? classification.objects : [])
      .map((name) => normalizeToAllowedName(name, allowedObjects))
      .filter(Boolean);

    const characterName = characters[0] || normalizeToAllowedName(reference.characterName, allowedCharacters);
    const objectName = objects[0] || normalizeToAllowedName(reference.objectName, allowedObjects);

    let kind = normalizeStyleReferenceKind(classification?.kind, reference.kind || 'scene');
    if (characterName) kind = 'character';
    else if (objectName && kind !== 'character') kind = 'object';

    return {
      ...reference,
      kind,
      characterName: characterName || undefined,
      objectName: objectName || undefined,
      confidence: normalizeConfidence(classification?.confidence, reference.confidence ?? 0.5),
      detectedCharacters: characters.map((name) => ({ name, confidence: normalizeConfidence(classification?.confidence, 0.6) })),
      detectedObjects: objects.map((name) => ({ name, confidence: normalizeConfidence(classification?.confidence, 0.6) }))
    };
  });
};

const sortStyleRefs = (refs) =>
  [...refs].sort((a, b) => {
    const confidenceDelta = (b.confidence || 0) - (a.confidence || 0);
    if (confidenceDelta !== 0) return confidenceDelta;
    return (a.pageIndex ?? Number.MAX_SAFE_INTEGER) - (b.pageIndex ?? Number.MAX_SAFE_INTEGER);
  });

const buildCanonicalStyleReferencePack = (styleRefs) => {
  const references = normalizeStyleReferenceAssets(styleRefs).slice(0, STYLE_REF_MAX_TOTAL);
  const selected = [];
  const used = new Set();

  const pickKind = (kind, limit) => {
    for (const ref of sortStyleRefs(references).filter((item) => item.kind === kind)) {
      const key = styleRefFingerprint(ref);
      if (!key || used.has(key)) continue;
      selected.push(ref);
      used.add(key);
      if (selected.length >= STYLE_REF_MAX_TOTAL) return;
      const pickedOfKind = selected.filter((item) => item.kind === kind).length;
      if (pickedOfKind >= limit) return;
    }
  };

  pickKind('scene', STYLE_REF_SCENE_QUOTA);
  pickKind('character', STYLE_REF_CHARACTER_QUOTA);
  pickKind('object', STYLE_REF_OBJECT_QUOTA);

  for (const ref of sortStyleRefs(references)) {
    if (selected.length >= STYLE_REF_MAX_TOTAL) break;
    const key = styleRefFingerprint(ref);
    if (!key || used.has(key)) continue;
    selected.push(ref);
    used.add(key);
  }

  return selected.slice(0, STYLE_REF_MAX_TOTAL);
};

const buildEntityImageMapsFromStyleRefs = (styleRefs, storyFacts) => {
  const characterBuckets = new Map();
  const objectBuckets = new Map();
  const allowedCharacters = buildAllowedCharacterMap(storyFacts);
  const allowedObjects = buildAllowedObjectMap(storyFacts);

  (Array.isArray(styleRefs) ? styleRefs : []).forEach((reference, index) => {
    const characterName = normalizeToAllowedName(reference?.characterName, allowedCharacters);
    if (characterName) {
      const list = characterBuckets.get(characterName) || [];
      if (list.length < MAX_CHARACTER_REFS_PER_CHARACTER) {
        list.push(index);
        characterBuckets.set(characterName, list);
      }
    }

    const objectName = normalizeToAllowedName(reference?.objectName, allowedObjects);
    if (objectName) {
      const list = objectBuckets.get(objectName) || [];
      if (list.length < 4) {
        list.push(index);
        objectBuckets.set(objectName, list);
      }
    }
  });

  return {
    characterImageMap: normalizeCharacterImageMap(
      Array.from(characterBuckets.entries()).map(([characterName, styleRefIndexes]) => ({
        characterName,
        styleRefIndexes
      })),
      storyFacts?.characterCatalog || [],
      styleRefs.length
    ),
    objectImageMap: normalizeObjectImageMap(
      Array.from(objectBuckets.entries()).map(([objectName, styleRefIndexes]) => ({
        objectName,
        styleRefIndexes
      })),
      storyFacts?.objects || [],
      styleRefs.length
    )
  };
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
    characterImageMap: normalizeCharacterImageMap(
      facts?.characterImageMap || facts?.character_image_map,
      characterCatalog,
      STYLE_REF_MAX_TOTAL
    ),
    objectImageMap: normalizeObjectImageMap(
      facts?.objectImageMap || facts?.object_image_map,
      facts?.objects,
      STYLE_REF_MAX_TOTAL
    ),
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

const compactStoryBriefForPrompt = (storyBrief) =>
  truncate(storyBrief || '', MAX_STORY_BRIEF_PROMPT_CHARS);

const compactFactsForPrompt = (storyFacts) => {
  const normalized = normalizeStoryFacts(storyFacts, '');
  return {
    setting: truncate(normalized.setting || '', 140),
    worldTags: normalized.worldTags.slice(0, 6),
    characters: normalized.characterCatalog.slice(0, MAX_FACT_PROMPT_ITEMS).map((entry) => ({
      name: truncate(entry.name, 36),
      source: entry.source
    })),
    characterImageMap: (normalized.characterImageMap || []).slice(0, MAX_FACT_PROMPT_ITEMS).map((entry) => ({
      characterName: entry.characterName,
      styleRefIndexes: entry.styleRefIndexes.slice(0, 3)
    })),
    objectImageMap: (normalized.objectImageMap || []).slice(0, MAX_FACT_PROMPT_ITEMS).map((entry) => ({
      objectName: entry.objectName,
      styleRefIndexes: entry.styleRefIndexes.slice(0, 3)
    })),
    places: normalized.places.slice(0, MAX_FACT_PROMPT_ITEMS).map((value) => truncate(value, 44)),
    objects: normalized.objects.slice(0, MAX_FACT_PROMPT_ITEMS).map((value) => truncate(value, 44)),
    events: normalized.events.slice(0, MAX_FACT_PROMPT_ITEMS).map((value) => truncate(value, 56))
  };
};

const compactHistoryForPrompt = (history) =>
  (Array.isArray(history) ? history : [])
    .slice(-MAX_HISTORY_TURNS_FOR_PROMPT)
    .map((turn) => `${turn.role === 'parent' ? 'Parent' : 'Child'}: ${truncate(turn.text || '', MAX_HISTORY_TEXT_CHARS)}`)
    .join('\n');

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

  value = limitWords(value, MAX_OPTION_WORDS);

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

const generateCandidates = async (ai, question, history, storyBrief, storyFacts) => {
  const compactStoryBrief = compactStoryBriefForPrompt(storyBrief);
  const compactStoryFacts = compactFactsForPrompt(storyFacts);
  const compactHistory = compactHistoryForPrompt(history);

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
              `Story brief: ${compactStoryBrief}`,
              `Story facts: ${JSON.stringify(compactStoryFacts)}`,
              `Conversation:\n${compactHistory || 'None yet.'}`,
              `Parent asked: ${question}`,
              'Return JSON with:',
              '- candidate_correct: 3 answer candidates with text and short evidence from the story.',
              '- distractor_candidates: 6 short wrong options (still plausible choices).',
              '- not_answerable: true only when the question is not supported by book facts.',
              'Rules:',
              '1) Candidate correct options should be directly grounded in story facts.',
              '2) Distractors should stay short and child-friendly (max 10 words).',
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

const buildFinalOptions = ({ question, storyBrief, storyFacts, candidatePayload }) => {
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

  const regenerationCount = distractors.length < 2 ? 1 : 0;

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

const buildImagePrompt = ({ optionText, renderMode, storyBrief, artStyle, storyFacts, optionCharacters }) => {
  const allowedCharacterEntries = (storyFacts?.characterCatalog || [])
    .map((entry) => ({
      name: normalizePhrase(entry?.name),
      source: normalizeCharacterSource(entry?.source)
    }))
    .filter((entry) => entry.name);
  const allowedCharacters = allowedCharacterEntries
    .map((entry) => entry.name)
    .filter(Boolean)
    .slice(0, 12);
  const primaryCharacter = allowedCharacters[0] || '';
  const normalizedOption = canonicalOption(optionText);
  const optionUsesKnownCharacter = allowedCharacters.some((name) => {
    const normalizedName = canonicalOption(name);
    return normalizedName && normalizedOption.includes(normalizedName);
  });

  const characterRules = allowedCharacters.length > 0
    ? [
        `- Allowed characters from this book only: ${allowedCharacterEntries.map((entry) => `${entry.name} (${entry.source})`).join(', ')}.`,
        '- Never invent new people, animals, fish, or creatures not in the allowed list.',
        '- If a character is needed, use only one of the allowed characters.',
        optionUsesKnownCharacter
          ? '- The matching allowed character must be visually recognizable.'
          : '- For place/object options, draw zero characters unless absolutely required.',
        !optionUsesKnownCharacter && primaryCharacter
          ? `- If the scene needs a character, use "${primaryCharacter}" only.`
          : '- If the scene needs a character, use only one allowed character.'
      ]
    : [
        '- Do not invent any characters.',
        '- Prefer object/location-only scenes.'
      ];

  const styleLayer = [
    'STYLE LAYER:',
    `- Match the attached style references exactly.`,
    `- Art style description: ${artStyle || 'Children\'s book illustration'}.`,
    optionCharacters?.length
      ? `- Character visual anchors from references: ${optionCharacters.join(', ')}.`
      : '- Use reference style consistency for all visible characters.',
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

const inferOptionCharacters = (optionText, storyFacts) => {
  const normalizedOption = canonicalOption(optionText);
  if (!normalizedOption) {
    return [];
  }

  const matches = [];
  for (const entry of storyFacts?.characterCatalog || []) {
    const normalizedName = canonicalOption(entry?.name || '');
    if (!normalizedName) continue;
    if (normalizedOption.includes(normalizedName) || normalizedName.includes(normalizedOption)) {
      matches.push(entry.name);
    }
  }

  return matches.slice(0, 2);
};

const inferOptionObjects = (optionText, storyFacts) => {
  const normalizedOption = canonicalOption(optionText);
  if (!normalizedOption) {
    return [];
  }

  const matches = [];
  for (const value of storyFacts?.objects || []) {
    const normalizedValue = canonicalOption(value);
    if (!normalizedValue) continue;
    if (normalizedOption.includes(normalizedValue) || normalizedValue.includes(normalizedOption)) {
      matches.push(value);
    }
  }

  return matches.slice(0, 2);
};

const pickStyleRefByIndexList = (selectedIndexes, indexList, limit, refs, selectedRefs) => {
  for (const index of indexList || []) {
    if (selectedRefs.length >= limit) return;
    if (!Number.isInteger(index)) continue;
    if (index < 0 || index >= refs.length) continue;
    if (selectedIndexes.has(index)) continue;
    selectedIndexes.add(index);
    selectedRefs.push(refs[index]);
  }
};

const selectStyleRefsForOption = (stylePrimer, styleReferences, storyFacts, optionText) => {
  const refsSource = Array.isArray(styleReferences) && styleReferences.length > 0
    ? styleReferences
    : (Array.isArray(stylePrimer) ? stylePrimer.map((item) => ({ ...item, kind: 'scene', source: 'upload' })) : []);
  const refsWithMeta = normalizeStyleReferenceAssets(
    refsSource,
    'upload',
    false
  ).slice(0, STYLE_REF_MAX_TOTAL);
  const selectedRefs = [];
  const selectedIndexes = new Set();

  const sceneIndexes = refsWithMeta
    .map((ref, index) => ({ ref, index }))
    .filter((entry) => entry.ref.kind === 'scene')
    .sort((a, b) => (b.ref.confidence || 0) - (a.ref.confidence || 0))
    .slice(0, STYLE_REF_SCENE_QUOTA)
    .map((entry) => entry.index);
  pickStyleRefByIndexList(selectedIndexes, sceneIndexes, STYLE_REF_MAX_TOTAL, refsWithMeta, selectedRefs);

  const optionCharacters = inferOptionCharacters(optionText, storyFacts);
  const optionObjects = inferOptionObjects(optionText, storyFacts);

  const charMap = storyFacts?.characterImageMap || [];
  for (const character of optionCharacters) {
    const mapping = charMap.find((entry) => String(entry.characterName || '').toLowerCase() === character.toLowerCase());
    pickStyleRefByIndexList(selectedIndexes, mapping?.styleRefIndexes || [], STYLE_REF_MAX_TOTAL, refsWithMeta, selectedRefs);
    if (selectedRefs.length >= STYLE_REF_SCENE_QUOTA + STYLE_REF_CHARACTER_QUOTA) break;
  }

  if (selectedRefs.length < STYLE_REF_SCENE_QUOTA + STYLE_REF_CHARACTER_QUOTA) {
    const fallbackCharacterIndexes = refsWithMeta
      .map((ref, index) => ({ ref, index }))
      .filter((entry) => entry.ref.kind === 'character')
      .sort((a, b) => (b.ref.confidence || 0) - (a.ref.confidence || 0))
      .map((entry) => entry.index);
    pickStyleRefByIndexList(
      selectedIndexes,
      fallbackCharacterIndexes,
      STYLE_REF_SCENE_QUOTA + STYLE_REF_CHARACTER_QUOTA,
      refsWithMeta,
      selectedRefs
    );
  }

  const objectMap = storyFacts?.objectImageMap || [];
  for (const objectName of optionObjects) {
    const mapping = objectMap.find((entry) => String(entry.objectName || '').toLowerCase() === objectName.toLowerCase());
    pickStyleRefByIndexList(selectedIndexes, mapping?.styleRefIndexes || [], STYLE_REF_MAX_TOTAL, refsWithMeta, selectedRefs);
    if (selectedRefs.length >= STYLE_REF_MAX_TOTAL) break;
  }

  if (selectedRefs.length < STYLE_REF_MAX_TOTAL) {
    const fallbackObjectIndexes = refsWithMeta
      .map((ref, index) => ({ ref, index }))
      .filter((entry) => entry.ref.kind === 'object')
      .sort((a, b) => (b.ref.confidence || 0) - (a.ref.confidence || 0))
      .map((entry) => entry.index);
    pickStyleRefByIndexList(selectedIndexes, fallbackObjectIndexes, STYLE_REF_MAX_TOTAL, refsWithMeta, selectedRefs);
  }

  if (selectedRefs.length < STYLE_REF_MAX_TOTAL) {
    const remaining = refsWithMeta
      .map((ref, index) => ({ ref, index }))
      .filter((entry) => !selectedIndexes.has(entry.index))
      .sort((a, b) => (b.ref.confidence || 0) - (a.ref.confidence || 0))
      .map((entry) => entry.index);
    pickStyleRefByIndexList(selectedIndexes, remaining, STYLE_REF_MAX_TOTAL, refsWithMeta, selectedRefs);
  }

  return {
    refs: selectedRefs.slice(0, STYLE_REF_MAX_TOTAL),
    optionCharacters,
    optionObjects
  };
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

  const incomingStyleRefs = normalizeStyleReferenceAssets(
    (Array.isArray(styleImages) ? styleImages : []).slice(0, STYLE_REF_MAX_TOTAL).map((item) => ({
      ...item,
      kind: item.kind || 'scene',
      source: item.source || 'upload'
    })),
    'upload'
  );
  const classification = await classifyStyleReferences(ai, incomingStyleRefs, storyFacts);
  const classifiedStyleRefs = mergeStyleReferenceClassification(incomingStyleRefs, classification, storyFacts);
  const canonicalStyleRefs = buildCanonicalStyleReferencePack(classifiedStyleRefs);

  const coverStart = performance.now();
  const coverParts = [];
  const coverStyleInputs = canonicalStyleRefs.length > 0
    ? canonicalStyleRefs
    : incomingStyleRefs.length > 0
      ? incomingStyleRefs
      : [{ ...storyFile, kind: 'scene', source: 'pdf_page', confidence: 0.5 }];

  for (const img of coverStyleInputs.slice(0, 6)) {
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
      model: IMAGE_MODEL,
      contents: { parts: coverParts },
      config: { imageConfig: { aspectRatio: '3:4' } }
    })
  );

  const coverMs = Math.round(performance.now() - coverStart);
  const totalMs = Math.round(performance.now() - setupStart);

  const coverImage = extractImageDataUrl(coverResponse);
  const coverPrimer = toFileDataFromDataUrl(coverImage);
  let finalStyleReferences = canonicalStyleRefs;
  if (finalStyleReferences.length === 0 && coverPrimer) {
    finalStyleReferences = [
      {
        ...coverPrimer,
        kind: 'scene',
        source: 'generated',
        confidence: 0.7
      }
    ];
  }
  const stylePrimer = finalStyleReferences.map((reference) => ({
    mimeType: reference.mimeType,
    data: reference.data
  }));
  const { characterImageMap, objectImageMap } = buildEntityImageMapsFromStyleRefs(finalStyleReferences, storyFacts);
  const storyFactsWithImageMap = normalizeStoryFacts(
    {
      ...storyFacts,
      characterImageMap,
      objectImageMap
    },
    storyBrief
  );

  return {
    storyPack: {
      summary,
      artStyle,
      storyBrief,
      storyFacts: storyFactsWithImageMap,
      coverImage,
      stylePrimer,
      styleReferences: finalStyleReferences
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
  styleReferences,
  history
) => {
  const ai = getClient();
  const totalStart = performance.now();
  const normalizedFacts = normalizeStoryFacts(storyFacts, storyBrief);
  const effectiveStyleReferences = normalizeStyleReferenceAssets(
    Array.isArray(styleReferences) && styleReferences.length > 0
      ? styleReferences
      : (Array.isArray(stylePrimer)
          ? stylePrimer.map((ref) => ({ ...ref, kind: 'scene', source: 'upload', confidence: 0.45 }))
          : []),
    'upload',
    false
  ).slice(0, STYLE_REF_MAX_TOTAL);
  const effectiveStylePrimer = effectiveStyleReferences.map((ref) => ({
    mimeType: ref.mimeType,
    data: ref.data
  }));

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
              'Return only plain text transcription.'
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

  let candidatePayload;
  try {
    candidatePayload = await generateCandidates(ai, question, history, storyBrief, normalizedFacts);
  } catch {
    candidatePayload = null;
  }

  const { options: resolvedOptions, regenerationCount } = buildFinalOptions({
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
      const { refs: refsForOption, optionCharacters } = selectStyleRefsForOption(
        effectiveStylePrimer,
        effectiveStyleReferences,
        normalizedFacts,
        card.text
      );

      for (const ref of refsForOption) {
        parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.data } });
      }

      parts.push({
        text: buildImagePrompt({
          optionText: card.text,
          renderMode: card.renderMode,
          storyBrief,
          artStyle,
          storyFacts: normalizedFacts,
          optionCharacters
        })
      });

      try {
        const imageResponse = await retryWithBackoff(
          () =>
            ai.models.generateContent({
              model: IMAGE_MODEL,
              contents: { parts },
              config: { imageConfig: { aspectRatio: '1:1' } }
            }),
          1,
          350
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
  const normalizedText = limitWords(text, MAX_TTS_WORDS) || 'Okay';

  const response = await retryWithBackoff(
    () =>
      ai.models.generateContent({
        model: 'gemini-2.5-flash-preview-tts',
        contents: { parts: [{ text: normalizedText }] },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
          }
        }
      }),
    1,
    150
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
