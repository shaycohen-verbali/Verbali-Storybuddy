import { GoogleGenAI, Modality, Type } from '@google/genai';

const RENDER_MODE_BLEND = 'blend_with_story_world';
const RENDER_MODE_STANDALONE = 'standalone_option_world';
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'the', 'to', 'with'
]);
const MAX_OPTION_WORDS = 10;
const MAX_TTS_WORDS = 10;
const MAX_STORY_BRIEF_PROMPT_CHARS = 700;
const MAX_STORY_TEXT_PROMPT_CHARS = 32000;
const MAX_PAGES_TEXT_ITEMS = 160;
const MAX_HISTORY_TURNS_FOR_PROMPT = 4;
const MAX_HISTORY_TEXT_CHARS = 90;
const MAX_FACT_PROMPT_ITEMS = 8;
const ANSWER_AGENT_MODEL = 'gemini-3-flash-preview';
const ILLUSTRATION_AGENT_MODEL = 'gemini-3-flash-preview';
const REPLICATE_IMAGE_MODEL = (
  process.env.REPLICATE_IMAGE_MODEL ||
  'google/nano-banana-pro:d71e2df08d6ef4c4fb6d3773e9e557de6312e04444940dbb81fd73366ed83941'
).trim();
const IMAGE_MODEL = REPLICATE_IMAGE_MODEL;
const REPLICATE_PREDICTIONS_URL = 'https://api.replicate.com/v1/predictions';
const STYLE_REF_MAX_TOTAL = 14;
const MIN_STYLE_REF_GROUNDING = 4;
const STYLE_REF_INDEX_LIMIT = 240;
const STYLE_REF_POOL_LIMIT = 120;
const STYLE_REF_CLASSIFY_BATCH_SIZE = 12;
const STYLE_REF_SCENE_QUOTA = 6;
const STYLE_REF_CHARACTER_QUOTA = 4;
const STYLE_REF_OBJECT_QUOTA = 4;
const MAX_CHARACTER_REFS_PER_CHARACTER = 3;
const MAX_OBJECT_REFS_PER_OBJECT = 4;
const MAX_SCENE_REFS_PER_SCENE = 4;
const MIN_DETECTION_CONFIDENCE = 0.45;
const LOW_CONFIDENCE_WARNING_THRESHOLD = 0.7;
const MAX_ENTITY_CROP_COVERAGE = 0.6;
const MAX_SCENE_ALIASES = 5;
const MAX_SCENE_FACTS = 16;
const QA_PACKAGE_VERSION = '1.0.0';
const MIN_STYLE_BIBLE_REFS = 5;
const MAX_STYLE_BIBLE_REFS = 20;

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

const getReplicateToken = () => {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    throw new Error('Image generation is configured for Replicate nano-banana-pro only. Missing REPLICATE_API_TOKEN.');
  }
  return token;
};

const partsToReplicateInput = (parts, aspectRatio) => {
  const safeParts = Array.isArray(parts) ? parts : [];
  const prompt = safeParts
    .map((part) => String(part?.text || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();

  const imageInput = safeParts
    .filter((part) => part?.inlineData?.mimeType && part?.inlineData?.data)
    .map((part) => `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`)
    .slice(0, STYLE_REF_MAX_TOTAL);

  const input = {
    prompt: prompt || 'Children illustration in storybook style',
    aspect_ratio: aspectRatio,
    output_format: 'jpg'
  };

  if (imageInput.length > 0) {
    input.image_input = imageInput;
  }

  return input;
};

const extractReplicateOutputUrl = (prediction) => {
  const output = prediction?.output;
  if (!output) return null;

  if (typeof output === 'string') {
    return output;
  }

  if (Array.isArray(output)) {
    for (const item of output) {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && typeof item.url === 'string') return item.url;
    }
    return null;
  }

  if (output && typeof output === 'object') {
    if (typeof output.url === 'string') return output.url;
    if (typeof output.image === 'string') return output.image;
  }

  return null;
};

const fetchRemoteImageAsDataUrl = async (url) => {
  if (!url) return null;
  if (url.startsWith('data:')) return url;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Replicate image download failed: ${response.status}`);
  }

  const mimeType = response.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await response.arrayBuffer());
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
};

const waitForReplicatePrediction = async (predictionUrl, token) => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(1200);

    const pollResponse = await fetch(predictionUrl, {
      method: 'GET',
      headers: {
        Authorization: `Token ${token}`
      }
    });

    const payload = await pollResponse.json().catch(() => ({}));
    if (!pollResponse.ok) {
      throw new Error(payload?.detail || payload?.error || `Replicate polling failed (${pollResponse.status})`);
    }

    if (payload?.status === 'succeeded') {
      return payload;
    }

    if (payload?.status === 'failed' || payload?.status === 'canceled') {
      throw new Error(payload?.error || payload?.detail || 'Replicate prediction failed');
    }
  }

  throw new Error('Replicate prediction timed out');
};

const generateImageWithReplicate = async (parts, aspectRatio) => {
  const token = getReplicateToken();
  const input = partsToReplicateInput(parts, aspectRatio);

  const response = await fetch(REPLICATE_PREDICTIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Token ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'wait=60'
    },
    body: JSON.stringify({
      version: REPLICATE_IMAGE_MODEL,
      input
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.detail || payload?.error || `Replicate request failed (${response.status})`);
  }

  let completedPayload = payload;
  if (payload?.status !== 'succeeded') {
    if (payload?.status === 'failed' || payload?.status === 'canceled') {
      throw new Error(payload?.error || payload?.detail || 'Replicate prediction failed');
    }
    if (payload?.urls?.get) {
      completedPayload = await waitForReplicatePrediction(payload.urls.get, token);
    }
  }

  const outputUrl = extractReplicateOutputUrl(completedPayload);
  if (!outputUrl) {
    return null;
  }

  return fetchRemoteImageAsDataUrl(outputUrl);
};

const generateImageDataUrl = async (ai, parts, aspectRatio) => {
  if (!REPLICATE_IMAGE_MODEL) {
    throw new Error('Image generation is configured for Replicate nano-banana-pro only. Missing REPLICATE_IMAGE_MODEL.');
  }

  return generateImageWithReplicate(parts, aspectRatio);
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
const toSceneId = (value, fallback = 'scene') => {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || fallback;
};

const truncate = (value, maxChars) => {
  const normalized = normalizePhrase(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
};

const slugify = (value, fallback = 'item') => {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || fallback;
};

const makeEntityId = (type, name) => `ent_${slugify(type, 'entity')}_${slugify(name, 'unknown')}`;

const hashStringFast = (value) => {
  const input = String(value || '');
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }
  return `h${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

const estimateBase64Bytes = (base64Data) => {
  const rawLength = String(base64Data || '').length;
  if (!rawLength) return 0;
  const padding = String(base64Data || '').endsWith('==') ? 2 : String(base64Data || '').endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((rawLength * 3) / 4) - padding);
};

const toImageIdFromStyleRefIndex = (index) => `img_${String(index + 1).padStart(4, '0')}`;

const normalizePagesTextEntries = (pages) => {
  const normalized = [];
  const seen = new Set();

  for (const entry of Array.isArray(pages) ? pages : []) {
    const pageNum = Number(entry?.page_num ?? entry?.pageNum);
    if (!Number.isInteger(pageNum) || pageNum <= 0) continue;
    if (seen.has(pageNum)) continue;

    const rawText = String(entry?.raw_text ?? entry?.rawText ?? '').trim();
    const cleanText = normalizePhrase(entry?.clean_text ?? entry?.cleanText ?? rawText);
    seen.add(pageNum);
    normalized.push({
      pageNum,
      rawText,
      cleanText,
      charCount: cleanText.length
    });
  }

  return normalized.sort((a, b) => a.pageNum - b.pageNum).slice(0, MAX_PAGES_TEXT_ITEMS);
};

const evaluateTextQuality = (pagesText) => {
  const pages = Array.isArray(pagesText) ? pagesText : [];
  if (pages.length === 0) {
    return {
      textQuality: 'poor',
      nearEmptyPercent: 1,
      avgCharsPerPage: 0
    };
  }

  const totalChars = pages.reduce((sum, page) => sum + Number(page?.charCount || 0), 0);
  const nearEmptyPages = pages.filter((page) => Number(page?.charCount || 0) < 24).length;
  const nearEmptyPercent = nearEmptyPages / Math.max(1, pages.length);
  const avgCharsPerPage = totalChars / Math.max(1, pages.length);

  let textQuality = 'poor';
  if (avgCharsPerPage >= 120 && nearEmptyPercent <= 0.25) {
    textQuality = 'good';
  } else if (avgCharsPerPage >= 40 && nearEmptyPercent <= 0.65) {
    textQuality = 'mixed';
  }

  return {
    textQuality,
    nearEmptyPercent,
    avgCharsPerPage
  };
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

const normalizeEvidenceList = (evidence, limit = 8) => {
  const output = [];
  const seen = new Set();

  for (const item of Array.isArray(evidence) ? evidence : []) {
    const pageIndex = Number(item?.pageIndex);
    const snippet = normalizePhrase(item?.snippet || '');
    const confidence = normalizeConfidence(item?.confidence, 0.6);
    if (!Number.isInteger(pageIndex) || pageIndex < 0) continue;

    const key = `${pageIndex}:${snippet.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    output.push({
      pageIndex,
      snippet: snippet || undefined,
      confidence
    });
    if (output.length >= limit) break;
  }

  return output;
};

const normalizeSceneCatalog = (sceneCatalog, storyFacts) => {
  const merged = new Map();
  const fallbackScenes = normalizeFactList(
    [...(storyFacts?.scenes || []), ...(storyFacts?.places || [])],
    MAX_SCENE_FACTS
  );

  for (const scene of Array.isArray(sceneCatalog) ? sceneCatalog : []) {
    const title = normalizePhrase(scene?.title || scene?.name || scene);
    if (!title) continue;
    const id = toSceneId(scene?.id || title, `scene-${merged.size + 1}`);
    const aliases = normalizeFactList(scene?.aliases, MAX_SCENE_ALIASES);
    const describedEvidence = normalizeEvidenceList(scene?.describedEvidence || scene?.described_evidence, 8);
    const illustratedEvidence = normalizeEvidenceList(scene?.illustratedEvidence || scene?.illustrated_evidence, 8);

    const existing = merged.get(id);
    merged.set(id, {
      id,
      title,
      aliases: [...new Set([...(existing?.aliases || []), ...aliases])].slice(0, MAX_SCENE_ALIASES),
      describedEvidence: [...(existing?.describedEvidence || []), ...describedEvidence].slice(0, 8),
      illustratedEvidence: [...(existing?.illustratedEvidence || []), ...illustratedEvidence].slice(0, 8)
    });
  }

  for (const place of fallbackScenes) {
    const id = toSceneId(place, `scene-${merged.size + 1}`);
    if (merged.has(id)) continue;
    merged.set(id, {
      id,
      title: place,
      aliases: [],
      describedEvidence: [],
      illustratedEvidence: []
    });
  }

  return Array.from(merged.values()).slice(0, MAX_SCENE_FACTS);
};

const normalizeSceneImageMap = (sceneImageMap, sceneCatalog, maxRefCount) => {
  const allowed = new Map(
    (Array.isArray(sceneCatalog) ? sceneCatalog : [])
      .map((scene) => [String(scene?.id || '').toLowerCase(), String(scene?.id || '').trim()])
      .filter((entry) => entry[0] && entry[1])
  );
  const normalized = new Map();

  for (const item of Array.isArray(sceneImageMap) ? sceneImageMap : []) {
    const key = String(item?.sceneId || item?.scene_id || '').trim().toLowerCase();
    const canonicalSceneId = allowed.get(key);
    if (!canonicalSceneId) continue;

    const sourceIndexes = Array.isArray(item?.styleRefIndexes)
      ? item.styleRefIndexes
      : Array.isArray(item?.style_ref_indexes)
        ? item.style_ref_indexes
        : [];

    const validIndexes = sourceIndexes
      .map((index) => Number(index))
      .filter((index) => Number.isInteger(index) && index >= 0 && index < maxRefCount);

    if (validIndexes.length === 0) continue;

    const existing = normalized.get(canonicalSceneId) || [];
    const mergedIndexes = [...new Set([...existing, ...validIndexes])].slice(0, MAX_SCENE_REFS_PER_SCENE);
    normalized.set(canonicalSceneId, {
      sceneId: canonicalSceneId,
      styleRefIndexes: mergedIndexes,
      confidence: normalizeConfidence(item?.confidence, 0.65)
    });
  }

  return Array.from(normalized.values());
};

const normalizeCharacterEvidenceMap = (input, characterCatalog) => {
  const allowed = new Map(
    (Array.isArray(characterCatalog) ? characterCatalog : [])
      .map((entry) => [String(entry?.name || '').toLowerCase(), String(entry?.name || '').trim()])
      .filter((entry) => entry[0] && entry[1])
  );
  const output = [];
  for (const item of Array.isArray(input) ? input : []) {
    const key = String(item?.characterName || item?.character_name || '').toLowerCase().trim();
    const characterName = allowed.get(key);
    if (!characterName) continue;
    output.push({
      characterName,
      evidence: normalizeEvidenceList(item?.evidence || [], 10)
    });
  }
  return output;
};

const normalizeObjectEvidenceMap = (input, objects) => {
  const allowed = new Map(
    normalizeFactList(objects, 40)
      .map((name) => [name.toLowerCase(), name])
      .filter((entry) => entry[0] && entry[1])
  );
  const output = [];
  for (const item of Array.isArray(input) ? input : []) {
    const key = String(item?.objectName || item?.object_name || '').toLowerCase().trim();
    const objectName = allowed.get(key);
    if (!objectName) continue;
    output.push({
      objectName,
      evidence: normalizeEvidenceList(item?.evidence || [], 10)
    });
  }
  return output;
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

const normalizeStyleAssetRole = (value, fallback = 'scene_anchor') => {
  const role = String(value || '').toLowerCase();
  if (role === 'scene_anchor') return 'scene_anchor';
  if (role === 'character_form') return 'character_form';
  if (role === 'object_anchor') return 'object_anchor';
  return fallback;
};

const normalizeConfidence = (value, fallback = 0.5) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
};

const normalizeStyleBox = (box) => {
  if (!box || typeof box !== 'object') return undefined;

  const x = Math.max(0, Math.min(1, Number(box.x) || 0));
  const y = Math.max(0, Math.min(1, Number(box.y) || 0));
  const width = Math.max(0, Math.min(1, Number(box.width) || 0));
  const height = Math.max(0, Math.min(1, Number(box.height) || 0));
  if (width <= 0 || height <= 0) {
    return undefined;
  }

  return {
    x,
    y,
    width: Math.min(width, 1 - x),
    height: Math.min(height, 1 - y)
  };
};

const computeCropCoverage = (box, fallback = undefined) => {
  const normalized = normalizeStyleBox(box);
  if (!normalized) return fallback;
  return Math.max(0, Math.min(1, normalized.width * normalized.height));
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
      sceneId: ref.sceneId ? toSceneId(ref.sceneId) : '',
      assetRole: normalizeStyleAssetRole(ref.assetRole, 'scene_anchor'),
      box: normalizeStyleBox(ref.box),
      cropCoverage: computeCropCoverage(ref.box, normalizeConfidence(ref.cropCoverage, undefined)),
      pageIndex: Number.isInteger(ref.pageIndex) ? Number(ref.pageIndex) : undefined,
      confidence: normalizeConfidence(ref.confidence, 0.5),
      qualityScore: normalizeConfidence(ref.qualityScore, 0.5),
      embeddingHash: normalizePhrase(ref.embeddingHash || ''),
      detectedCharacters: Array.isArray(ref.detectedCharacters)
        ? ref.detectedCharacters
            .map((entry) => ({
              name: normalizePhrase(entry?.name || ''),
              confidence: normalizeConfidence(entry?.confidence, 0.5),
              box: normalizeStyleBox(entry?.box)
            }))
            .filter((entry) => entry.name)
            .slice(0, 4)
        : [],
      detectedObjects: Array.isArray(ref.detectedObjects)
        ? ref.detectedObjects
            .map((entry) => ({
              name: normalizePhrase(entry?.name || ''),
              confidence: normalizeConfidence(entry?.confidence, 0.5),
              box: normalizeStyleBox(entry?.box)
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
  const normalizeKey = (input) =>
    String(input || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const normalized = normalizeKey(value);
  if (!normalized) return '';

  const exact = allowedMap.get(normalized);
  if (exact) {
    return exact;
  }

  const queryTokens = normalized
    .split(' ')
    .filter((token) => token && token.length > 1 && !STOP_WORDS.has(token));

  let bestName = '';
  let bestScore = 0;

  for (const [allowedKey, canonicalName] of allowedMap.entries()) {
    if (!allowedKey) continue;

    let score = 0;
    if (allowedKey.includes(normalized) || normalized.includes(allowedKey)) {
      score = 0.82;
    } else {
      const allowedTokens = allowedKey
        .split(' ')
        .filter((token) => token && token.length > 1 && !STOP_WORDS.has(token));

      if (queryTokens.length > 0 && allowedTokens.length > 0) {
        const overlap = queryTokens.filter((token) => allowedTokens.includes(token)).length;
        const denominator = Math.max(queryTokens.length, allowedTokens.length);
        score = overlap / denominator;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestName = canonicalName;
    }
  }

  return bestScore >= 0.55 ? bestName : '';
};

const inferSceneIdFromEvidence = (sceneCatalog, pageIndex) => {
  if (!Number.isInteger(pageIndex)) return '';

  let bestScene = null;
  let bestScore = 0;

  for (const scene of Array.isArray(sceneCatalog) ? sceneCatalog : []) {
    const evidence = [
      ...(Array.isArray(scene?.illustratedEvidence) ? scene.illustratedEvidence : []),
      ...(Array.isArray(scene?.describedEvidence) ? scene.describedEvidence : [])
    ];
    for (const item of evidence) {
      if (!Number.isInteger(item?.pageIndex) || item.pageIndex !== pageIndex) continue;
      const confidence = normalizeConfidence(item?.confidence, 0.55);
      if (!bestScene || confidence > bestScore) {
        bestScene = scene;
        bestScore = confidence;
      }
    }
  }

  if (bestScene?.id) {
    return bestScene.id;
  }

  return '';
};

const resolveSceneIdFromCatalog = (sceneCatalog, sceneCandidate) => {
  const candidateText = normalizePhrase(sceneCandidate);
  if (!candidateText) return '';

  const candidateSlug = toSceneId(candidateText, '');
  if (!candidateSlug) return '';

  let bestSceneId = '';
  let bestScore = 0;

  for (const scene of Array.isArray(sceneCatalog) ? sceneCatalog : []) {
    const sceneId = normalizePhrase(scene?.id);
    if (!sceneId) continue;

    const labels = [sceneId, scene?.title, ...(Array.isArray(scene?.aliases) ? scene.aliases : [])]
      .map((value) => normalizePhrase(value))
      .filter(Boolean);

    for (const label of labels) {
      const labelSlug = toSceneId(label, '');
      if (!labelSlug) continue;

      let score = 0;
      if (labelSlug === candidateSlug) {
        score = 1;
      } else if (labelSlug.includes(candidateSlug) || candidateSlug.includes(labelSlug)) {
        score = 0.78;
      } else {
        const candidateTokens = candidateSlug.split('-').filter(Boolean);
        const labelTokens = labelSlug.split('-').filter(Boolean);
        if (candidateTokens.length > 0 && labelTokens.length > 0) {
          const overlap = candidateTokens.filter((token) => labelTokens.includes(token)).length;
          const denominator = Math.max(candidateTokens.length, labelTokens.length);
          score = overlap / denominator;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestSceneId = sceneId;
      }
    }
  }

  return bestScore >= 0.55 ? bestSceneId : '';
};

const assignSceneIdsToUnboundRefs = (references, sceneCatalog) => {
  const normalizedRefs = Array.isArray(references) ? references : [];
  if (normalizedRefs.length === 0) return normalizedRefs;

  const catalog = Array.isArray(sceneCatalog) ? sceneCatalog : [];
  if (catalog.length === 0) return normalizedRefs;

  const sceneByPage = new Map();
  for (const ref of normalizedRefs) {
    if (ref?.kind !== 'scene' || !ref?.sceneId || !Number.isInteger(ref?.pageIndex)) continue;
    sceneByPage.set(Number(ref.pageIndex), ref.sceneId);
  }

  const singleSceneId = catalog.length === 1 ? normalizePhrase(catalog[0]?.id) : '';

  return normalizedRefs.map((ref) => {
    if (!ref || ref.kind !== 'scene' || ref.sceneId) {
      return ref;
    }

    let resolvedSceneId = inferSceneIdFromEvidence(catalog, ref.pageIndex);

    if (!resolvedSceneId && Number.isInteger(ref.pageIndex)) {
      for (const delta of [0, -1, 1, -2, 2]) {
        const byPage = sceneByPage.get(Number(ref.pageIndex) + delta);
        if (byPage) {
          resolvedSceneId = byPage;
          break;
        }
      }
    }

    if (!resolvedSceneId && singleSceneId) {
      resolvedSceneId = singleSceneId;
    }

    if (!resolvedSceneId) {
      return ref;
    }

    return {
      ...ref,
      sceneId: resolvedSceneId,
      confidence: normalizeConfidence(ref.confidence, 0.5)
    };
  });
};

const classifyStyleReferenceBatch = async (ai, references, storyFacts, indexOffset = 0) => {
  if (!Array.isArray(references) || references.length === 0) {
    return [];
  }

  const allowedCharacters = (storyFacts?.characterCatalog || []).map((entry) => entry.name).filter(Boolean);
  const allowedObjects = (storyFacts?.objects || []).slice(0, 24);
  const allowedScenes = (storyFacts?.sceneCatalog || []).map((entry) => ({ id: entry.id, title: entry.title }));

  const parts = [
    {
      text: [
        'Classify each style reference image.',
        `Character names allowed: ${allowedCharacters.join(', ') || 'none'}.`,
        `Object names allowed: ${allowedObjects.join(', ') || 'none'}.`,
        `Scene IDs allowed: ${allowedScenes.map((scene) => `${scene.id}:${scene.title}`).join(', ') || 'none'}.`,
        `You will receive ${references.length} images in order.`,
        'Use LOCAL image indexes from 0 to image_count - 1.',
        'Return strict JSON with classifications array.',
        'Each item must contain:',
        '- image_index (number, local index)',
        '- kind (scene | character | object)',
        '- scene_id (optional, must be one of allowed scene IDs if provided)',
        '- asset_role (scene_anchor | character_form | object_anchor)',
        '- confidence (0..1)',
        '- characters (array of {name, confidence, box?})',
        '- objects (array of {name, confidence, box?})',
        'Rules:',
        '- If image is a character crop, use kind=character.',
        '- If image highlights a key object, use kind=object.',
        '- Use kind=scene for page-wide or environmental references.',
        '- If kind=scene, set scene_id to the closest allowed scene id whenever plausible.',
        '- box must be normalized 0..1 coordinates and only for visible entities.'
      ].join('\n')
    }
  ];

  references.forEach((reference, localIndex) => {
    parts.push({ text: `Reference image local index ${localIndex}` });
    parts.push({ inlineData: { mimeType: reference.mimeType, data: reference.data } });
  });

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
                  scene_id: { type: Type.STRING },
                  asset_role: { type: Type.STRING },
                  confidence: { type: Type.NUMBER },
                  characters: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        name: { type: Type.STRING },
                        confidence: { type: Type.NUMBER },
                        box: {
                          type: Type.OBJECT,
                          properties: {
                            x: { type: Type.NUMBER },
                            y: { type: Type.NUMBER },
                            width: { type: Type.NUMBER },
                            height: { type: Type.NUMBER }
                          }
                        }
                      },
                      required: ['name', 'confidence']
                    }
                  },
                  objects: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        name: { type: Type.STRING },
                        confidence: { type: Type.NUMBER },
                        box: {
                          type: Type.OBJECT,
                          properties: {
                            x: { type: Type.NUMBER },
                            y: { type: Type.NUMBER },
                            width: { type: Type.NUMBER },
                            height: { type: Type.NUMBER }
                          }
                        }
                      },
                      required: ['name', 'confidence']
                    }
                  }
                },
                required: ['image_index', 'kind', 'asset_role', 'confidence', 'characters', 'objects']
              }
            }
          },
          required: ['classifications']
        }
      }
    })
  );

  const localClassifications = parseJsonSafe(response.text, { classifications: [] }).classifications || [];
  return localClassifications
    .map((entry) => {
      const rawIndex = Number(entry?.image_index);
      if (!Number.isInteger(rawIndex)) {
        return null;
      }

      let globalIndex = -1;
      if (rawIndex >= 0 && rawIndex < references.length) {
        globalIndex = indexOffset + rawIndex;
      } else if (rawIndex >= indexOffset && rawIndex < indexOffset + references.length) {
        globalIndex = rawIndex;
      }

      if (globalIndex < 0) return null;

      return {
        ...entry,
        image_index: globalIndex
      };
    })
    .filter(Boolean);
};

const classifyStyleReferences = async (ai, styleRefs, storyFacts) => {
  const references = normalizeStyleReferenceAssets(styleRefs).slice(0, STYLE_REF_POOL_LIMIT);
  if (references.length === 0) {
    return [];
  }

  const classifications = [];
  for (let start = 0; start < references.length; start += STYLE_REF_CLASSIFY_BATCH_SIZE) {
    const batch = references.slice(start, start + STYLE_REF_CLASSIFY_BATCH_SIZE);
    try {
      const batchClassifications = await classifyStyleReferenceBatch(ai, batch, storyFacts, start);
      classifications.push(...batchClassifications);
    } catch (error) {
      console.warn('[setup] style reference classification batch failed', start, error?.message || error);
    }
  }

  return classifications;
};

const mergeStyleReferenceClassification = (styleRefs, classifications, storyFacts) => {
  const references = normalizeStyleReferenceAssets(styleRefs).slice(0, STYLE_REF_POOL_LIMIT);
  const classificationMap = new Map();
  for (const item of Array.isArray(classifications) ? classifications : []) {
    const idx = Number(item?.image_index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= references.length) continue;
    classificationMap.set(idx, item);
  }

  const allowedCharacters = buildAllowedCharacterMap(storyFacts);
  const allowedObjects = buildAllowedObjectMap(storyFacts);
  const sceneCatalog = storyFacts?.sceneCatalog || [];
  const allowedScenes = new Map(
    sceneCatalog
      .map((scene) => [String(scene?.id || '').toLowerCase(), String(scene?.id || '').trim()])
      .filter((entry) => entry[0] && entry[1])
  );

  const merged = references.map((reference, index) => {
    const classification = classificationMap.get(index);
    const characters = (Array.isArray(classification?.characters) ? classification.characters : [])
      .map((item) => {
        const name = normalizeToAllowedName(item?.name, allowedCharacters);
        if (!name) return null;
        const box = normalizeStyleBox(item?.box);
        return {
          name,
          confidence: normalizeConfidence(item?.confidence, classification?.confidence || 0.6),
          box
        };
      })
      .filter(Boolean);
    const objects = (Array.isArray(classification?.objects) ? classification.objects : [])
      .map((item) => {
        const name = normalizeToAllowedName(item?.name, allowedObjects);
        if (!name) return null;
        const box = normalizeStyleBox(item?.box);
        return {
          name,
          confidence: normalizeConfidence(item?.confidence, classification?.confidence || 0.6),
          box
        };
      })
      .filter(Boolean);

    const characterName = characters[0]?.name || normalizeToAllowedName(reference.characterName, allowedCharacters);
    const objectName = objects[0]?.name || normalizeToAllowedName(reference.objectName, allowedObjects);
    const rawSceneCandidate = normalizePhrase(classification?.scene_id || reference.sceneId || '');
    const sceneIdCandidate = rawSceneCandidate.toLowerCase().trim();
    const sceneId =
      allowedScenes.get(sceneIdCandidate) ||
      resolveSceneIdFromCatalog(sceneCatalog, rawSceneCandidate) ||
      inferSceneIdFromEvidence(sceneCatalog, reference?.pageIndex) ||
      '';

    let kind = normalizeStyleReferenceKind(classification?.kind, reference.kind || 'scene');
    if (characterName) kind = 'character';
    else if (objectName && kind !== 'character') kind = 'object';

    const primaryCharacter = characters
      .filter((item) => item.name === characterName)
      .sort((a, b) => b.confidence - a.confidence)[0];
    const primaryObject = objects
      .filter((item) => item.name === objectName)
      .sort((a, b) => b.confidence - a.confidence)[0];
    const primaryBox = kind === 'character'
      ? primaryCharacter?.box
      : kind === 'object'
        ? primaryObject?.box
        : undefined;
    const cropCoverage = computeCropCoverage(
      primaryBox,
      computeCropCoverage(reference.box, reference.cropCoverage)
    );

    const resolvedSceneId = kind === 'scene' && !sceneId && sceneCatalog.length === 1
      ? normalizePhrase(sceneCatalog[0]?.id)
      : sceneId;

    return {
      ...reference,
      kind,
      sceneId: resolvedSceneId || undefined,
      assetRole: normalizeStyleAssetRole(
        classification?.asset_role,
        kind === 'character' ? 'character_form' : kind === 'object' ? 'object_anchor' : 'scene_anchor'
      ),
      characterName: characterName || undefined,
      objectName: objectName || undefined,
      box: primaryBox || normalizeStyleBox(reference.box),
      cropCoverage,
      confidence: normalizeConfidence(classification?.confidence, reference.confidence ?? 0.5),
      qualityScore: normalizeConfidence(classification?.confidence, reference.qualityScore ?? 0.5),
      detectedCharacters: characters.map((item) => ({
        name: item.name,
        confidence: item.confidence,
        box: item.box
      })),
      detectedObjects: objects.map((item) => ({
        name: item.name,
        confidence: item.confidence,
        box: item.box
      }))
    };
  });

  return assignSceneIdsToUnboundRefs(merged, sceneCatalog);
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

const mergeStyleReferencePools = (...groups) => {
  const merged = [];
  const seen = new Set();

  for (const group of groups) {
    for (const ref of Array.isArray(group) ? group : []) {
      const fingerprint = styleRefFingerprint(ref);
      if (!fingerprint || seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      merged.push(ref);
      if (merged.length >= STYLE_REF_POOL_LIMIT) {
        return merged;
      }
    }
  }

  return merged;
};

const isTightMappedRef = (reference, kind) => {
  if (!reference || reference.kind !== kind) {
    return false;
  }

  if (reference.source === 'pdf_page' && kind !== 'scene') {
    return false;
  }

  const coverage = Number(reference.cropCoverage);
  if (!Number.isFinite(coverage) || coverage <= 0) {
    return false;
  }

  return coverage <= MAX_ENTITY_CROP_COVERAGE;
};

const buildEntityImageMapsFromStyleRefs = (styleRefs, storyFacts) => {
  const characterBuckets = new Map();
  const objectBuckets = new Map();
  const sceneBuckets = new Map();
  const characterEvidenceBuckets = new Map();
  const objectEvidenceBuckets = new Map();
  const allowedCharacters = buildAllowedCharacterMap(storyFacts);
  const allowedObjects = buildAllowedObjectMap(storyFacts);
  const allowedScenes = new Map(
    (storyFacts?.sceneCatalog || [])
      .map((scene) => [String(scene?.id || '').toLowerCase(), String(scene?.id || '').trim()])
      .filter((entry) => entry[0] && entry[1])
  );

  (Array.isArray(styleRefs) ? styleRefs : []).forEach((reference, index) => {
    if ((reference?.confidence || 0) < MIN_DETECTION_CONFIDENCE) {
      return;
    }

    const normalizedSceneId = allowedScenes.get(String(reference?.sceneId || '').toLowerCase().trim());
    if (normalizedSceneId) {
      const entry = sceneBuckets.get(normalizedSceneId) || { styleRefIndexes: [], confidenceSamples: [] };
      if (!entry.styleRefIndexes.includes(index) && entry.styleRefIndexes.length < MAX_SCENE_REFS_PER_SCENE) {
        entry.styleRefIndexes.push(index);
      }
      entry.confidenceSamples.push(normalizeConfidence(reference?.confidence, 0.65));
      sceneBuckets.set(normalizedSceneId, entry);
    }

    const detectedCharacterNames = [
      normalizeToAllowedName(reference?.characterName, allowedCharacters),
      ...(Array.isArray(reference?.detectedCharacters) ? reference.detectedCharacters : [])
        .map((entry) => normalizeToAllowedName(entry?.name, allowedCharacters))
    ].filter(Boolean);

    const canUseCharacterRef = isTightMappedRef(reference, 'character');
    for (const characterName of [...new Set(detectedCharacterNames)]) {
      const list = characterBuckets.get(characterName) || [];
      if (canUseCharacterRef && !list.includes(index) && list.length < MAX_CHARACTER_REFS_PER_CHARACTER) {
        list.push(index);
        characterBuckets.set(characterName, list);
      }

      const evidence = characterEvidenceBuckets.get(characterName) || [];
      if (Number.isInteger(reference?.pageIndex)) {
        evidence.push({
          pageIndex: Number(reference.pageIndex),
          confidence: normalizeConfidence(reference?.confidence, 0.65),
          snippet: 'illustrated reference'
        });
      }
      characterEvidenceBuckets.set(characterName, evidence);
    }

    const detectedObjectNames = [
      normalizeToAllowedName(reference?.objectName, allowedObjects),
      ...(Array.isArray(reference?.detectedObjects) ? reference.detectedObjects : [])
        .map((entry) => normalizeToAllowedName(entry?.name, allowedObjects))
    ].filter(Boolean);

    const canUseObjectRef = isTightMappedRef(reference, 'object');
    for (const objectName of [...new Set(detectedObjectNames)]) {
      const list = objectBuckets.get(objectName) || [];
      if (canUseObjectRef && !list.includes(index) && list.length < MAX_OBJECT_REFS_PER_OBJECT) {
        list.push(index);
        objectBuckets.set(objectName, list);
      }

      const evidence = objectEvidenceBuckets.get(objectName) || [];
      if (Number.isInteger(reference?.pageIndex)) {
        evidence.push({
          pageIndex: Number(reference.pageIndex),
          confidence: normalizeConfidence(reference?.confidence, 0.65),
          snippet: 'illustrated reference'
        });
      }
      objectEvidenceBuckets.set(objectName, evidence);
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
    ),
    sceneImageMap: normalizeSceneImageMap(
      Array.from(sceneBuckets.entries()).map(([sceneId, entry]) => ({
        sceneId,
        styleRefIndexes: entry.styleRefIndexes,
        confidence: normalizeConfidence(
          entry.confidenceSamples.length > 0
            ? entry.confidenceSamples.reduce((sum, value) => sum + value, 0) / entry.confidenceSamples.length
            : 0.65,
          0.65
        )
      })),
      storyFacts?.sceneCatalog || [],
      styleRefs.length
    ),
    characterEvidenceMap: normalizeCharacterEvidenceMap(
      Array.from(characterEvidenceBuckets.entries()).map(([characterName, evidence]) => ({
        characterName,
        evidence
      })),
      storyFacts?.characterCatalog || []
    ),
    objectEvidenceMap: normalizeObjectEvidenceMap(
      Array.from(objectEvidenceBuckets.entries()).map(([objectName, evidence]) => ({
        objectName,
        evidence
      })),
      storyFacts?.objects || []
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
  const sceneCatalog = normalizeSceneCatalog(
    facts?.sceneCatalog || facts?.scene_catalog,
    facts
  );

  const normalized = {
    characters: characterCatalog.map((entry) => entry.name),
    characterCatalog,
    characterImageMap: normalizeCharacterImageMap(
      facts?.characterImageMap || facts?.character_image_map,
      characterCatalog,
      STYLE_REF_INDEX_LIMIT
    ),
    objectImageMap: normalizeObjectImageMap(
      facts?.objectImageMap || facts?.object_image_map,
      facts?.objects,
      STYLE_REF_INDEX_LIMIT
    ),
    sceneCatalog,
    sceneImageMap: normalizeSceneImageMap(
      facts?.sceneImageMap || facts?.scene_image_map,
      sceneCatalog,
      STYLE_REF_INDEX_LIMIT
    ),
    characterEvidenceMap: normalizeCharacterEvidenceMap(
      facts?.characterEvidenceMap || facts?.character_evidence_map,
      characterCatalog
    ),
    objectEvidenceMap: normalizeObjectEvidenceMap(
      facts?.objectEvidenceMap || facts?.object_evidence_map,
      facts?.objects
    ),
    scenes: normalizeFactList(facts?.scenes, 16),
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

  if (!Array.isArray(normalized.scenes) || normalized.scenes.length === 0) {
    normalized.scenes = (normalized.sceneCatalog || []).map((scene) => scene.title).slice(0, 16);
  }

  return normalized;
};

const compactStoryBriefForPrompt = (storyBrief) =>
  truncate(storyBrief || '', MAX_STORY_BRIEF_PROMPT_CHARS);

const compactStoryTextForPrompt = (storyText) =>
  truncate(storyText || '', MAX_STORY_TEXT_PROMPT_CHARS);

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
    scenes: (normalized.sceneCatalog || []).slice(0, MAX_FACT_PROMPT_ITEMS).map((entry) => ({
      id: entry.id,
      title: truncate(entry.title, 44),
      aliases: entry.aliases.slice(0, 3)
    })),
    sceneImageMap: (normalized.sceneImageMap || []).slice(0, MAX_FACT_PROMPT_ITEMS).map((entry) => ({
      sceneId: entry.sceneId,
      styleRefIndexes: entry.styleRefIndexes.slice(0, 3),
      confidence: entry.confidence
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
  ...((storyFacts?.sceneCatalog || []).flatMap((scene) => [scene.title, ...(scene.aliases || [])])),
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

const normalizeAnswerAgentOptions = (answers, question, storyBrief, storyFacts) => {
  const deduped = [];
  const seen = new Set();

  for (const answer of Array.isArray(answers) ? answers : []) {
    const text = simplifyOptionText(answer?.text || '', question);
    const canonical = canonicalOption(text);
    if (!text || !canonical || seen.has(canonical)) continue;
    seen.add(canonical);

    const supportLevelRaw = Number(answer?.support_level);
    const computedSupport = computeSupportLevel(
      text,
      normalizePhrase(answer?.evidence || ''),
      storyFacts,
      question,
      storyBrief
    );
    const supportLevel = Number.isFinite(supportLevelRaw)
      ? Math.max(0, Math.min(100, Math.round(supportLevelRaw)))
      : computedSupport;

    deduped.push({
      text,
      isCorrect: Boolean(answer?.is_correct),
      supportLevel,
      evidence: normalizePhrase(answer?.evidence || '')
    });
  }

  if (deduped.length === 0) {
    return [];
  }

  deduped.sort((a, b) => b.supportLevel - a.supportLevel);
  const flaggedCorrect = deduped.filter((item) => item.isCorrect);
  const selectedCorrect = flaggedCorrect.length > 0 ? flaggedCorrect[0] : deduped[0];

  const distractors = deduped
    .filter((item) => item.text !== selectedCorrect.text)
    .map((item) => ({ ...item, isCorrect: false }));

  return [
    { ...selectedCorrect, isCorrect: true },
    ...distractors
  ];
};

const enforceThreeAnswerOptions = ({
  options,
  question,
  storyBrief,
  storyFacts
}) => {
  const normalizedOptions = Array.isArray(options) ? options : [];
  const fallback = buildFallbackOptions(question, storyBrief, storyFacts);
  const normalizedCorrect = normalizedOptions.find((item) => item.isCorrect);
  const correct = normalizedCorrect || fallback.find((item) => item.isCorrect);

  if (!correct) {
    return fallback.slice(0, 3);
  }

  const distractors = normalizedOptions
    .filter((item) => !item.isCorrect && canonicalOption(item.text) !== canonicalOption(correct.text))
    .slice(0, 2);

  if (distractors.length < 2) {
    const existing = new Set(distractors.map((item) => canonicalOption(item.text)));
    for (const item of fallback.filter((entry) => !entry.isCorrect)) {
      const key = canonicalOption(item.text);
      if (!key || existing.has(key) || key === canonicalOption(correct.text)) continue;
      distractors.push(item);
      existing.add(key);
      if (distractors.length >= 2) break;
    }
  }

  return [{ ...correct, isCorrect: true }, ...distractors.slice(0, 2)];
};

const buildAnswerAgentPrompt = ({ question, compactHistory, compactStoryFacts, storyText }) =>
  [
    'You are an answer generator for a non-verbal child reading-comprehension activity.',
    'Use the extracted story text as the primary source of truth.',
    'Generate exactly 3 options for the parent question.',
    'Rules:',
    '- Exactly 3 options total.',
    '- Exactly 1 option must be correct.',
    '- Each option max 10 words, child-friendly wording.',
    '- Wrong options should be plausible but still incorrect.',
    '- Keep text concrete and easy to illustrate.',
    `Story text:\n${storyText || 'No story text provided.'}`,
    `Story facts helper: ${JSON.stringify(compactStoryFacts)}`,
    `Conversation:\n${compactHistory || 'None yet.'}`,
    `Parent question: ${question}`,
    'Return strict JSON only.',
    'Schema:',
    '{ "answers": [ { "text": string, "is_correct": boolean, "evidence": string, "support_level": number } ] }'
  ].join('\n');

const generateAnswersFromStoryText = async (ai, { question, storyText, history, storyFacts, storyBrief, storyPdf }) => {
  const compactHistory = compactHistoryForPrompt(history);
  const compactStoryFacts = compactFactsForPrompt(storyFacts);
  const compactStoryText = compactStoryTextForPrompt(storyText);
  const answerAgentPrompt = buildAnswerAgentPrompt({
    question,
    compactHistory,
    compactStoryFacts,
    storyText: compactStoryText
  });

  const runAgent = async () => {
    const parts = [];
    if (storyPdf?.mimeType && storyPdf?.data) {
      parts.push({
        inlineData: {
          mimeType: storyPdf.mimeType,
          data: storyPdf.data
        }
      });
    }
    parts.push({ text: answerAgentPrompt });

    const response = await retryWithBackoff(() =>
      ai.models.generateContent({
        model: ANSWER_AGENT_MODEL,
        contents: {
          parts
        },
        config: {
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 0 },
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              answers: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    text: { type: Type.STRING },
                    is_correct: { type: Type.BOOLEAN },
                    evidence: { type: Type.STRING },
                    support_level: { type: Type.NUMBER }
                  },
                  required: ['text', 'is_correct', 'evidence', 'support_level']
                }
              }
            },
            required: ['answers']
          }
        }
      })
    );

    const payload = parseJsonSafe(response.text, { answers: [] });
    const normalized = normalizeAnswerAgentOptions(payload.answers, question, storyBrief, storyFacts);
    const finalOptions = enforceThreeAnswerOptions({
      options: normalized,
      question,
      storyBrief,
      storyFacts
    });
    const hasThree = finalOptions.length === 3;
    const correctCount = finalOptions.filter((item) => item.isCorrect).length;

    return {
      raw: response.text || '',
      options: finalOptions,
      valid: hasThree && correctCount === 1
    };
  };

  const first = await runAgent();
  if (first.valid) {
    return {
      options: first.options,
      answerAgentPrompt,
      answerAgentRaw: first.raw
    };
  }

  const second = await runAgent();
  if (second.valid) {
    return {
      options: second.options,
      answerAgentPrompt,
      answerAgentRaw: second.raw
    };
  }

  return {
    options: enforceThreeAnswerOptions({
      options: [],
      question,
      storyBrief,
      storyFacts
    }),
    answerAgentPrompt,
    answerAgentRaw: second.raw || first.raw || ''
  };
};

const toIllustrationPlanText = (plan, answerText) => {
  const safePlan = plan || {};
  const mustIncludeScenes = Array.isArray(safePlan?.must_include?.scenes) ? safePlan.must_include.scenes : [];
  const mustIncludeCharacters = Array.isArray(safePlan?.must_include?.characters) ? safePlan.must_include.characters : [];
  const mustIncludeObjects = Array.isArray(safePlan?.must_include?.objects) ? safePlan.must_include.objects : [];
  const mustAvoid = Array.isArray(safePlan?.must_avoid?.entities) ? safePlan.must_avoid.entities : [];
  const compositionNotes = normalizePhrase(safePlan?.composition_notes || '');
  const sceneDescription = normalizePhrase(safePlan?.scene_description || answerText || '');

  return [
    `Scene description: ${sceneDescription}`,
    mustIncludeScenes.length > 0 ? `Must include scenes: ${mustIncludeScenes.join(', ')}` : 'Must include scenes: none',
    mustIncludeCharacters.length > 0 ? `Must include characters: ${mustIncludeCharacters.join(', ')}` : 'Must include characters: none',
    mustIncludeObjects.length > 0 ? `Must include objects: ${mustIncludeObjects.join(', ')}` : 'Must include objects: none',
    mustAvoid.length > 0 ? `Must avoid entities: ${mustAvoid.join(', ')}` : 'Must avoid entities: none',
    compositionNotes ? `Composition notes: ${compositionNotes}` : 'Composition notes: Keep a clean single-subject composition.'
  ].join('\n');
};

const buildIllustrationAgentPrompt = ({
  question,
  answerText,
  isCorrect,
  participants,
  storyFacts,
  selectedRefs
}) => {
  const allowedScenes = (storyFacts?.sceneCatalog || []).map((scene) => `${scene.id}:${scene.title}`);
  const allowedCharacters = (storyFacts?.characterCatalog || []).map((entry) => entry.name);
  const allowedObjects = storyFacts?.objects || [];
  const refsSummary = (Array.isArray(selectedRefs) ? selectedRefs : [])
    .map((ref, idx) => `${idx + 1}) ${ref.kind}/${ref.source} scene=${ref.sceneId || '-'} char=${ref.characterName || '-'} obj=${ref.objectName || '-'}`)
    .join('\n');

  return [
    'You are an illustration-planning agent for children story answer cards.',
    'Create a concise, visual scene plan for one answer option.',
    `Parent question: ${question}`,
    `Answer option: ${answerText}`,
    `Is this answer correct: ${isCorrect ? 'yes' : 'no'}`,
    `Detected participants scenes=${(participants?.scenes || []).join(', ') || 'none'} characters=${(participants?.characters || []).join(', ') || 'none'} objects=${(participants?.objects || []).join(', ') || 'none'}`,
    `Allowed scenes: ${allowedScenes.join(', ') || 'none'}`,
    `Allowed characters: ${allowedCharacters.join(', ') || 'none'}`,
    `Allowed objects: ${allowedObjects.join(', ') || 'none'}`,
    `Selected style refs:\n${refsSummary || 'none'}`,
    'Rules:',
    '- Never invent entities outside allowed characters/objects/scenes.',
    '- If no character refs are selected, prefer scene/object composition with zero extra characters.',
    '- Keep composition simple for quick recognition by non-verbal children.',
    '- Keep style-compatible framing hints.',
    'Return strict JSON only with this schema:',
    '{ "scene_description": string, "must_include": { "scenes": string[], "characters": string[], "objects": string[] }, "must_avoid": { "entities": string[] }, "composition_notes": string }'
  ].join('\n');
};

const generateIllustrationPlanForAnswer = async (ai, payload) => {
  const illustrationAgentPrompt = buildIllustrationAgentPrompt(payload);

  const response = await retryWithBackoff(() =>
    ai.models.generateContent({
      model: ILLUSTRATION_AGENT_MODEL,
      contents: {
        parts: [{ text: illustrationAgentPrompt }]
      },
      config: {
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 },
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            scene_description: { type: Type.STRING },
            must_include: {
              type: Type.OBJECT,
              properties: {
                scenes: { type: Type.ARRAY, items: { type: Type.STRING } },
                characters: { type: Type.ARRAY, items: { type: Type.STRING } },
                objects: { type: Type.ARRAY, items: { type: Type.STRING } }
              },
              required: ['scenes', 'characters', 'objects']
            },
            must_avoid: {
              type: Type.OBJECT,
              properties: {
                entities: { type: Type.ARRAY, items: { type: Type.STRING } }
              },
              required: ['entities']
            },
            composition_notes: { type: Type.STRING }
          },
          required: ['scene_description', 'must_include', 'must_avoid', 'composition_notes']
        }
      }
    })
  );

  const plan = parseJsonSafe(response.text, {
    scene_description: payload.answerText || '',
    must_include: { scenes: [], characters: [], objects: [] },
    must_avoid: { entities: [] },
    composition_notes: 'Keep the image simple with one clear focal subject.'
  });

  return {
    illustrationAgentPrompt,
    illustrationPlan: plan
  };
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

const buildImagePrompt = ({ optionText, renderMode, storyBrief, artStyle, storyFacts, participants, selectedRefs, illustrationPlan }) => {
  const allowedCharacterEntries = (storyFacts?.characterCatalog || [])
    .map((entry) => ({
      name: normalizePhrase(entry?.name),
      source: normalizeCharacterSource(entry?.source)
    }))
    .filter((entry) => entry.name);
  const characterSourceMap = new Map(
    allowedCharacterEntries.map((entry) => [entry.name.toLowerCase(), entry.source])
  );
  const selectedCharacterNames = [...new Set(
    (Array.isArray(selectedRefs) ? selectedRefs : [])
      .map((ref) => normalizePhrase(ref?.characterName || ''))
      .filter(Boolean)
  )];
  const selectedObjectNames = [...new Set(
    (Array.isArray(selectedRefs) ? selectedRefs : [])
      .map((ref) => normalizePhrase(ref?.objectName || ''))
      .filter(Boolean)
  )];
  const participantCharacterSet = new Set([
    ...(participants?.characters || []),
    ...(participants?.inferredCharacters || [])
  ]);
  const participantObjectSet = new Set([
    ...(participants?.objects || []),
    ...(participants?.inferredObjects || [])
  ]);
  const allowedCharacters = (
    selectedCharacterNames.length > 0
      ? selectedCharacterNames
      : allowedCharacterEntries
          .map((entry) => entry.name)
          .filter((name) => participantCharacterSet.size === 0 || participantCharacterSet.has(name))
  ).slice(0, 12);
  const allowedObjects = (
    selectedObjectNames.length > 0
      ? selectedObjectNames
      : [...participantObjectSet]
  ).slice(0, 12);
  const sceneCatalog = storyFacts?.sceneCatalog || [];
  const participantScenes = (participants?.scenes || [])
    .map((id) => sceneCatalog.find((scene) => scene.id === id))
    .filter(Boolean);
  const planSceneDescription = normalizePhrase(illustrationPlan?.scene_description || '');
  const planMustIncludeScenes = Array.isArray(illustrationPlan?.must_include?.scenes)
    ? illustrationPlan.must_include.scenes.map((item) => normalizePhrase(item)).filter(Boolean)
    : [];
  const planMustIncludeCharacters = Array.isArray(illustrationPlan?.must_include?.characters)
    ? illustrationPlan.must_include.characters.map((item) => normalizePhrase(item)).filter(Boolean)
    : [];
  const planMustIncludeObjects = Array.isArray(illustrationPlan?.must_include?.objects)
    ? illustrationPlan.must_include.objects.map((item) => normalizePhrase(item)).filter(Boolean)
    : [];
  const planMustAvoid = Array.isArray(illustrationPlan?.must_avoid?.entities)
    ? illustrationPlan.must_avoid.entities.map((item) => normalizePhrase(item)).filter(Boolean)
    : [];
  const compositionNotes = normalizePhrase(illustrationPlan?.composition_notes || '');
  const primaryCharacter = allowedCharacters[0] || '';
  const normalizedOption = canonicalOption(optionText);
  const optionUsesKnownCharacter = allowedCharacters.some((name) => {
    const normalizedName = canonicalOption(name);
    return normalizedName && normalizedOption.includes(normalizedName);
  });

  const characterRules = allowedCharacters.length > 0
    ? [
        `- Allowed characters from this book only: ${allowedCharacters.map((name) => `${name} (${characterSourceMap.get(name.toLowerCase()) || 'book'})`).join(', ')}.`,
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
    participantCharacterSet.size > 0
      ? `- Character visual anchors from references: ${[...participantCharacterSet].join(', ')}.`
      : '- Use reference style consistency for all visible characters.',
    selectedCharacterNames.length > 0
      ? `- Characters visible in selected references: ${selectedCharacterNames.join(', ')}.`
      : '- If characters appear, match selected references exactly.',
    selectedObjectNames.length > 0
      ? `- Objects visible in selected references: ${selectedObjectNames.join(', ')}.`
      : '- If objects appear, match selected references exactly.',
    allowedObjects.length > 0
      ? `- Allowed objects for this card: ${allowedObjects.join(', ')}.`
      : '- Keep object vocabulary limited to book objects only.',
    participantScenes.length > 0
      ? `- Matched scene context IDs: ${participantScenes.map((scene) => `${scene.id} (${scene.title})`).join(', ')}.`
      : '- Use story setting as scene context if scene is ambiguous.',
    planMustIncludeScenes.length > 0
      ? `- Illustration plan scenes: ${planMustIncludeScenes.join(', ')}.`
      : '- Illustration plan scenes: none specified.',
    planMustIncludeCharacters.length > 0
      ? `- Illustration plan characters: ${planMustIncludeCharacters.join(', ')}.`
      : '- Illustration plan characters: none specified.',
    planMustIncludeObjects.length > 0
      ? `- Illustration plan objects: ${planMustIncludeObjects.join(', ')}.`
      : '- Illustration plan objects: none specified.',
    planMustAvoid.length > 0
      ? `- Must avoid entities: ${planMustAvoid.join(', ')}.`
      : '- Must avoid entities: none specified.',
    compositionNotes
      ? `- Composition guidance: ${compositionNotes}.`
      : '- Composition guidance: keep one primary subject with minimal clutter.',
    '- Keep clean linework, soft kid-friendly colors, and one clear focal subject.',
    '- Composition must be easy for a non-verbal child to recognize quickly.',
    '- Do not invent any character or object outside the provided allowed lists.',
    ...characterRules
  ];

  const semanticLayer =
    renderMode === RENDER_MODE_BLEND
      ? [
          'SEMANTIC LAYER:',
          `- Main subject to depict: "${planSceneDescription || optionText}".`,
          '- Blend the subject naturally into the story world when plausible.',
          `- Story world context: ${storyFacts?.setting || storyBrief}.`,
          '- Keep the scene simple with minimal clutter.'
        ]
      : [
          'SEMANTIC LAYER:',
          `- Main subject to depict: "${planSceneDescription || optionText}".`,
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

const inferSceneIdsFromText = (text, storyFacts) => {
  const canonicalText = canonicalOption(text);
  if (!canonicalText) return [];

  const matches = [];
  for (const scene of storyFacts?.sceneCatalog || []) {
    const pool = [scene.title, ...(scene.aliases || [])].map((value) => canonicalOption(value));
    if (pool.some((item) => item && (canonicalText.includes(item) || item.includes(canonicalText)))) {
      matches.push(scene.id);
    }
  }

  if (matches.length > 0) {
    return [...new Set(matches)];
  }

  const tags = inferWorldTagsFromText(text);
  const fallback = [];
  for (const scene of storyFacts?.sceneCatalog || []) {
    const sceneText = `${scene.title} ${(scene.aliases || []).join(' ')}`.toLowerCase();
    if (tags.some((tag) => sceneText.includes(tag))) {
      fallback.push(scene.id);
    }
  }

  return [...new Set(fallback)];
};

const buildTurnContextParticipantsHeuristic = (text, storyFacts, refsWithMeta, questionParticipants) => {
  const explicitScenes = inferSceneIdsFromText(text, storyFacts);
  const scenes = explicitScenes.length > 0
    ? explicitScenes
    : Array.isArray(questionParticipants?.scenes) && questionParticipants.scenes.length > 0
      ? questionParticipants.scenes.slice(0, 3)
      : (storyFacts?.sceneCatalog || []).slice(0, 1).map((scene) => scene.id);

  const explicitCharacters = inferOptionCharacters(text, storyFacts);
  const explicitObjects = inferOptionObjects(text, storyFacts);

  const inferredCharacters = [];
  const inferredObjects = [];
  for (const ref of refsWithMeta) {
    if (!scenes.includes(ref.sceneId || '')) continue;
    if (ref.characterName && !explicitCharacters.includes(ref.characterName) && !inferredCharacters.includes(ref.characterName)) {
      inferredCharacters.push(ref.characterName);
    }
    if (ref.objectName && !explicitObjects.includes(ref.objectName) && !inferredObjects.includes(ref.objectName)) {
      inferredObjects.push(ref.objectName);
    }
  }

  return {
    scenes,
    characters: explicitCharacters,
    objects: explicitObjects,
    inferredCharacters: inferredCharacters.slice(0, 3),
    inferredObjects: inferredObjects.slice(0, 3)
  };
};

const extractParticipantsWithModel = async (ai, text, storyFacts) => {
  const allowedScenes = (storyFacts?.sceneCatalog || []).map((scene) => ({
    id: scene.id,
    title: scene.title,
    aliases: scene.aliases || []
  }));
  const allowedCharacters = (storyFacts?.characterCatalog || []).map((entry) => entry.name).filter(Boolean);
  const allowedObjects = (storyFacts?.objects || []).filter(Boolean);

  const response = await retryWithBackoff(() =>
    ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: {
        parts: [
          {
            text: [
              'Extract participating entities from the text.',
              `Text: ${text}`,
              `Allowed scene IDs: ${allowedScenes.map((scene) => scene.id).join(', ') || 'none'}`,
              `Allowed scene aliases: ${allowedScenes.map((scene) => `${scene.id}:${scene.title} ${(scene.aliases || []).join('|')}`).join('; ') || 'none'}`,
              `Allowed characters: ${allowedCharacters.join(', ') || 'none'}`,
              `Allowed objects: ${allowedObjects.join(', ') || 'none'}`,
              'Return strict JSON only.',
              'JSON schema:',
              '{ "scene_ids": string[], "character_names": string[], "object_names": string[] }',
              'Rules:',
              '- Use only values from allowed lists.',
              '- If no match, return empty arrays.'
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
            scene_ids: { type: Type.ARRAY, items: { type: Type.STRING } },
            character_names: { type: Type.ARRAY, items: { type: Type.STRING } },
            object_names: { type: Type.ARRAY, items: { type: Type.STRING } }
          },
          required: ['scene_ids', 'character_names', 'object_names']
        }
      }
    })
  );

  const payload = parseJsonSafe(response.text, {
    scene_ids: [],
    character_names: [],
    object_names: []
  });

  const sceneIdSet = new Set(allowedScenes.map((scene) => String(scene.id || '').toLowerCase()));
  const characterNameSet = new Set(allowedCharacters.map((name) => name.toLowerCase()));
  const objectNameSet = new Set(allowedObjects.map((name) => name.toLowerCase()));

  const scenes = (Array.isArray(payload.scene_ids) ? payload.scene_ids : [])
    .map((item) => String(item || '').trim())
    .filter((item) => sceneIdSet.has(item.toLowerCase()));
  const characters = (Array.isArray(payload.character_names) ? payload.character_names : [])
    .map((item) => String(item || '').trim())
    .filter((item) => characterNameSet.has(item.toLowerCase()));
  const objects = (Array.isArray(payload.object_names) ? payload.object_names : [])
    .map((item) => String(item || '').trim())
    .filter((item) => objectNameSet.has(item.toLowerCase()));

  return {
    scenes: [...new Set(scenes)].slice(0, 4),
    characters: [...new Set(characters)].slice(0, 4),
    objects: [...new Set(objects)].slice(0, 4)
  };
};

const resolveTurnContextParticipants = async (ai, text, storyFacts, refsWithMeta, questionParticipants) => {
  const heuristic = buildTurnContextParticipantsHeuristic(text, storyFacts, refsWithMeta, questionParticipants);

  let structured = null;
  try {
    structured = await extractParticipantsWithModel(ai, text, storyFacts);
  } catch (error) {
    console.warn('[turn] participant extraction fallback to heuristic', error?.message || error);
  }

  const scenes = structured?.scenes?.length
    ? structured.scenes
    : heuristic.scenes;
  const characters = structured?.characters?.length
    ? structured.characters
    : heuristic.characters;
  const objects = structured?.objects?.length
    ? structured.objects
    : heuristic.objects;

  const inferredCharacters = [];
  const inferredObjects = [];
  for (const ref of refsWithMeta) {
    if (!scenes.includes(ref.sceneId || '')) continue;
    if (ref.characterName && !characters.includes(ref.characterName) && !inferredCharacters.includes(ref.characterName)) {
      inferredCharacters.push(ref.characterName);
    }
    if (ref.objectName && !objects.includes(ref.objectName) && !inferredObjects.includes(ref.objectName)) {
      inferredObjects.push(ref.objectName);
    }
  }

  return {
    scenes: [...new Set(scenes)].slice(0, 4),
    characters: [...new Set(characters)].slice(0, 4),
    objects: [...new Set(objects)].slice(0, 4),
    inferredCharacters: inferredCharacters.slice(0, 3),
    inferredObjects: inferredObjects.slice(0, 3)
  };
};

const scoreStyleReference = (reference, participants) => {
  let score = (reference.confidence || 0.5) * 100 + (reference.qualityScore || reference.confidence || 0.5) * 40;

  if (participants.scenes.includes(reference.sceneId || '')) {
    score += 48;
  }

  if (reference.characterName && participants.characters.includes(reference.characterName)) {
    score += 62;
  } else if (reference.characterName && participants.inferredCharacters.includes(reference.characterName)) {
    score += 34;
  }

  if (reference.objectName && participants.objects.includes(reference.objectName)) {
    score += 54;
  } else if (reference.objectName && participants.inferredObjects.includes(reference.objectName)) {
    score += 28;
  }

  if (reference.assetRole === 'scene_anchor' && participants.scenes.length > 0) score += 12;
  if (reference.assetRole === 'character_form' && participants.characters.length > 0) score += 10;
  if (reference.assetRole === 'object_anchor' && participants.objects.length > 0) score += 8;

  return score;
};

const pickRankedRefs = ({
  refsWithMeta,
  selectedIndexes,
  selectedRefs,
  predicate,
  targetCount,
  participants,
  categoryPenaltyTracker
}) => {
  const ranked = refsWithMeta
    .map((reference, index) => ({ reference, index }))
    .filter((entry) => predicate(entry.reference))
    .map((entry) => ({
      ...entry,
      score: scoreStyleReference(entry.reference, participants)
    }))
    .sort((a, b) => b.score - a.score);

  for (const item of ranked) {
    if (selectedRefs.length >= STYLE_REF_MAX_TOTAL) break;
    if (selectedRefs.length >= targetCount) break;
    if (selectedIndexes.has(item.index)) continue;

    const dedupeKey = item.reference.characterName || item.reference.objectName || item.reference.sceneId || `${item.index}`;
    const repeats = categoryPenaltyTracker.get(dedupeKey) || 0;
    if (repeats >= 2 && item.score < 130) {
      continue;
    }

    selectedIndexes.add(item.index);
    selectedRefs.push(item.reference);
    categoryPenaltyTracker.set(dedupeKey, repeats + 1);
  }
};

const selectStyleRefsForOption = async (
  ai,
  stylePrimer,
  styleReferences,
  storyFacts,
  optionText,
  questionParticipants,
  participantsOverride = null
) => {
  const refsSource = Array.isArray(styleReferences) && styleReferences.length > 0
    ? styleReferences
    : (Array.isArray(stylePrimer) ? stylePrimer.map((item) => ({ ...item, kind: 'scene', source: 'upload' })) : []);
  const refsWithMeta = normalizeStyleReferenceAssets(
    refsSource,
    'upload',
    false
  ).slice(0, STYLE_REF_POOL_LIMIT);
  const participants = participantsOverride || await resolveTurnContextParticipants(
    ai,
    optionText,
    storyFacts,
    refsWithMeta,
    questionParticipants
  );
  const selectedRefs = [];
  const selectedIndexes = new Set();
  const categoryPenaltyTracker = new Map();

  const dynamicSceneTarget = participants.scenes.length > 0 ? 6 : 0;
  const dynamicCharacterTarget =
    participants.characters.length + participants.inferredCharacters.length > 0 ? 6 : 0;
  const dynamicObjectTarget =
    participants.objects.length + participants.inferredObjects.length > 0 ? 4 : 0;

  pickRankedRefs({
    refsWithMeta,
    selectedIndexes,
    selectedRefs,
    predicate: (reference) =>
      reference.kind === 'scene' &&
      participants.scenes.includes(reference.sceneId || ''),
    targetCount: Math.min(STYLE_REF_MAX_TOTAL, dynamicSceneTarget),
    participants,
    categoryPenaltyTracker
  });

  pickRankedRefs({
    refsWithMeta,
    selectedIndexes,
    selectedRefs,
    predicate: (reference) =>
      isTightMappedRef(reference, 'character') &&
      (participants.characters.includes(reference.characterName || '') ||
        participants.inferredCharacters.includes(reference.characterName || '')),
    targetCount: Math.min(STYLE_REF_MAX_TOTAL, dynamicSceneTarget + dynamicCharacterTarget),
    participants,
    categoryPenaltyTracker
  });

  pickRankedRefs({
    refsWithMeta,
    selectedIndexes,
    selectedRefs,
    predicate: (reference) =>
      isTightMappedRef(reference, 'object') &&
      (participants.objects.includes(reference.objectName || '') ||
        participants.inferredObjects.includes(reference.objectName || '')),
    targetCount: Math.min(STYLE_REF_MAX_TOTAL, dynamicSceneTarget + dynamicCharacterTarget + dynamicObjectTarget),
    participants,
    categoryPenaltyTracker
  });

  if (selectedRefs.length === 0 && Array.isArray(questionParticipants?.scenes) && questionParticipants.scenes.length > 0) {
    pickRankedRefs({
      refsWithMeta,
      selectedIndexes,
      selectedRefs,
      predicate: (reference) =>
        reference.kind === 'scene' && questionParticipants.scenes.includes(reference.sceneId || ''),
      targetCount: 1,
      participants: {
        ...participants,
        scenes: questionParticipants.scenes
      },
      categoryPenaltyTracker
    });
  }

  if (selectedRefs.length < MIN_STYLE_REF_GROUNDING) {
    const groundingTarget = Math.min(STYLE_REF_MAX_TOTAL, MIN_STYLE_REF_GROUNDING);

    pickRankedRefs({
      refsWithMeta,
      selectedIndexes,
      selectedRefs,
      predicate: (reference) => reference.kind === 'scene',
      targetCount: groundingTarget,
      participants: {
        ...participants,
        scenes: participants.scenes.length > 0
          ? participants.scenes
          : (Array.isArray(questionParticipants?.scenes) ? questionParticipants.scenes : [])
      },
      categoryPenaltyTracker
    });

    pickRankedRefs({
      refsWithMeta,
      selectedIndexes,
      selectedRefs,
      predicate: (reference) => isTightMappedRef(reference, 'character'),
      targetCount: groundingTarget,
      participants,
      categoryPenaltyTracker
    });

    pickRankedRefs({
      refsWithMeta,
      selectedIndexes,
      selectedRefs,
      predicate: (reference) => isTightMappedRef(reference, 'object'),
      targetCount: groundingTarget,
      participants,
      categoryPenaltyTracker
    });
  }

  return {
    refs: selectedRefs.slice(0, STYLE_REF_MAX_TOTAL),
    participants,
    selectedStyleRefIndexes: [...selectedIndexes].slice(0, STYLE_REF_MAX_TOTAL)
  };
};

const extractSceneCatalogFromStory = async (ai, storyFile, storyBrief, storyFacts) => {
  try {
    const response = await retryWithBackoff(() =>
      ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: {
          parts: [
            { inlineData: { mimeType: storyFile.mimeType, data: storyFile.data } },
            {
              text: [
                'Extract canonical scenes from this children story.',
                'Return JSON with scenes array only.',
                'Each scene item must include:',
                '- id (slug-like stable id)',
                '- title',
                '- aliases (up to 5)',
                '- described_evidence (array of {pageIndex, snippet, confidence})',
                'Rules:',
                '- Include only scenes grounded in the book.',
                '- Keep snippets short.',
                '- pageIndex is 0-based and may be omitted if unknown.'
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
              scenes: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    title: { type: Type.STRING },
                    aliases: { type: Type.ARRAY, items: { type: Type.STRING } },
                    described_evidence: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          pageIndex: { type: Type.NUMBER },
                          snippet: { type: Type.STRING },
                          confidence: { type: Type.NUMBER }
                        },
                        required: ['snippet', 'confidence']
                      }
                    }
                  },
                  required: ['id', 'title', 'aliases', 'described_evidence']
                }
              }
            },
            required: ['scenes']
          }
        }
      })
    );

    const payload = parseJsonSafe(response.text, { scenes: [] });
    return normalizeSceneCatalog(payload.scenes || [], {
      ...storyFacts,
      places: storyFacts?.places || []
    });
  } catch (error) {
    console.warn('[setup] scene catalog extraction failed', error?.message || error);
    return normalizeSceneCatalog([], storyFacts);
  }
};

const extractStoryTextFromPdf = async (ai, storyFile, storyBrief) => {
  try {
    const response = await retryWithBackoff(() =>
      ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: {
          parts: [
            { inlineData: { mimeType: storyFile.mimeType, data: storyFile.data } },
            {
              text: [
                'Extract the readable book text from this children story PDF in reading order.',
                'Focus on story sentences and dialog.',
                'Skip page numbers, copyright lines, and decorative non-story text.',
                'Return strict JSON only with one field: story_text.'
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
              story_text: { type: Type.STRING }
            },
            required: ['story_text']
          }
        }
      })
    );

    const payload = parseJsonSafe(response.text, { story_text: '' });
    const normalized = String(payload.story_text || '')
      .replace(/\r/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const compact = compactStoryTextForPrompt(normalized);

    if (compact) {
      return compact;
    }
  } catch (error) {
    console.warn('[setup] story text extraction failed', error?.message || error);
  }

  return compactStoryTextForPrompt(storyBrief || '');
};

const extractPagesTextFromPdf = async (ai, storyFile) => {
  try {
    const response = await retryWithBackoff(() =>
      ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: {
          parts: [
            { inlineData: { mimeType: storyFile.mimeType, data: storyFile.data } },
            {
              text: [
                'Extract page-level story text from this children story PDF.',
                'Return strict JSON with pages only.',
                'Each page item must include page_num (1-based), raw_text, clean_text.',
                'Keep raw_text and clean_text concise (max ~500 chars each per page).',
                'If page has no story text, return empty strings for that page.',
                `Limit output to at most ${MAX_PAGES_TEXT_ITEMS} pages.`
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
              pages: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    page_num: { type: Type.NUMBER },
                    raw_text: { type: Type.STRING },
                    clean_text: { type: Type.STRING }
                  },
                  required: ['page_num', 'raw_text', 'clean_text']
                }
              }
            },
            required: ['pages']
          }
        }
      })
    );

    const payload = parseJsonSafe(response.text, { pages: [] });
    const pagesText = normalizePagesTextEntries(payload.pages || []);
    const storyText = compactStoryTextForPrompt(
      pagesText
        .map((entry) => entry.cleanText)
        .filter(Boolean)
        .join('\n\n')
    );

    return { pagesText, storyText };
  } catch (error) {
    console.warn('[setup] page text extraction failed', error?.message || error);
    return { pagesText: [], storyText: '' };
  }
};

const buildStyleBibleFromModel = async (ai, { summary, artStyle, styleReferences, imageIdsByIndex }) => {
  const sceneRefs = (Array.isArray(styleReferences) ? styleReferences : [])
    .map((ref, index) => ({ ...ref, index }))
    .filter((ref) => ref.kind === 'scene')
    .sort((a, b) => (b.qualityScore || b.confidence || 0) - (a.qualityScore || a.confidence || 0));
  const picked = sceneRefs.slice(0, MAX_STYLE_BIBLE_REFS);
  const styleReferenceImageIds = picked.map((ref) => imageIdsByIndex.get(ref.index)).filter(Boolean);

  if (picked.length === 0) {
    return {
      id: 'style_bible_main',
      globalStyleDescription: artStyle || 'Children storybook style',
      palette: ['soft pastel colors'],
      lineQuality: 'soft outlines',
      lighting: 'bright and child-friendly',
      compositionHabits: ['single focal subject', 'clear simple scenes'],
      styleReferenceImageIds
    };
  }

  try {
    const parts = picked.map((ref) => ({
      inlineData: {
        mimeType: ref.mimeType,
        data: ref.data
      }
    }));
    parts.push({
      text: [
        'Create a concise style bible from these book illustrations.',
        `Book summary: ${summary}`,
        `Known art style: ${artStyle}`,
        'Return strict JSON only with fields:',
        '- global_style_description',
        '- palette (array of color words)',
        '- line_quality',
        '- lighting',
        '- composition_habits (array)'
      ].join('\n')
    });

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
              global_style_description: { type: Type.STRING },
              palette: { type: Type.ARRAY, items: { type: Type.STRING } },
              line_quality: { type: Type.STRING },
              lighting: { type: Type.STRING },
              composition_habits: { type: Type.ARRAY, items: { type: Type.STRING } }
            },
            required: [
              'global_style_description',
              'palette',
              'line_quality',
              'lighting',
              'composition_habits'
            ]
          }
        }
      })
    );

    const parsed = parseJsonSafe(response.text, {});
    return {
      id: 'style_bible_main',
      globalStyleDescription: normalizePhrase(parsed.global_style_description || artStyle || 'Children storybook style'),
      palette: normalizeFactList(parsed.palette || [], 8),
      lineQuality: normalizePhrase(parsed.line_quality || 'soft outlines'),
      lighting: normalizePhrase(parsed.lighting || 'balanced lighting'),
      compositionHabits: normalizeFactList(parsed.composition_habits || [], 8),
      styleReferenceImageIds
    };
  } catch (error) {
    console.warn('[setup] style bible extraction failed', error?.message || error);
    return {
      id: 'style_bible_main',
      globalStyleDescription: artStyle || 'Children storybook style',
      palette: ['soft pastel colors'],
      lineQuality: 'soft outlines',
      lighting: 'bright and child-friendly',
      compositionHabits: ['single focal subject', 'clear simple scenes'],
      styleReferenceImageIds
    };
  }
};

const buildEntityRecords = (storyFacts, imageIdsByIndex) => {
  const records = [];
  const styleTags = normalizeFactList(storyFacts?.worldTags || [], 8);

  for (const character of storyFacts?.characterCatalog || []) {
    const styleRefIndexes = (storyFacts?.characterImageMap || [])
      .find((entry) => entry.characterName === character.name)
      ?.styleRefIndexes || [];
    const mappedImageIds = styleRefIndexes
      .map((index) => imageIdsByIndex.get(index))
      .filter(Boolean);
    const visualAssets = mappedImageIds.map((imageId, idx) => ({
      imageId,
      role: idx === 0 ? 'gold_face' : idx === 1 ? 'gold_body' : 'reference',
      styleRefIndex: styleRefIndexes[idx]
    }));

    records.push({
      entityId: makeEntityId('character', character.name),
      name: character.name,
      aliases: [],
      type: 'character',
      canonicalDescription: `${character.name} from the story`,
      mustHaveTraits: [],
      negativeTraits: [],
      styleTags,
      visualAssets,
      goldRefs: {
        face: mappedImageIds[0],
        body: mappedImageIds[1]
      }
    });
  }

  for (const objectName of storyFacts?.objects || []) {
    const styleRefIndexes = (storyFacts?.objectImageMap || [])
      .find((entry) => entry.objectName === objectName)
      ?.styleRefIndexes || [];
    const visualAssets = styleRefIndexes
      .map((index) => ({
        imageId: imageIdsByIndex.get(index),
        role: 'reference',
        styleRefIndex: index
      }))
      .filter((asset) => Boolean(asset.imageId));

    records.push({
      entityId: makeEntityId('object', objectName),
      name: objectName,
      aliases: [],
      type: 'object',
      canonicalDescription: `${objectName} from the story`,
      mustHaveTraits: [],
      negativeTraits: [],
      styleTags,
      visualAssets
    });
  }

  for (const placeName of storyFacts?.places || []) {
    records.push({
      entityId: makeEntityId('location', placeName),
      name: placeName,
      aliases: [],
      type: 'location',
      canonicalDescription: `Location in the story: ${placeName}`,
      mustHaveTraits: [],
      negativeTraits: [],
      styleTags,
      visualAssets: []
    });
  }

  for (const scene of storyFacts?.sceneCatalog || []) {
    const sceneIndexes = (storyFacts?.sceneImageMap || [])
      .find((entry) => entry.sceneId === scene.id)
      ?.styleRefIndexes || [];
    const visualAssets = sceneIndexes
      .map((index) => ({
        imageId: imageIdsByIndex.get(index),
        role: 'reference',
        styleRefIndex: index
      }))
      .filter((asset) => Boolean(asset.imageId));
    records.push({
      entityId: makeEntityId('scene', scene.title || scene.id),
      name: scene.title || scene.id,
      aliases: normalizeFactList(scene.aliases || [], 6),
      type: 'scene',
      canonicalDescription: `Scene in the story: ${scene.title || scene.id}`,
      mustHaveTraits: [],
      negativeTraits: [],
      styleTags,
      visualAssets
    });
  }

  return records;
};

const buildQaReadyBookPackage = async (
  ai,
  {
    storyFile,
    summary,
    artStyle,
    storyText,
    storyFacts,
    styleReferences,
    pagesText
  }
) => {
  const normalizedPagesText = normalizePagesTextEntries(pagesText || []);
  const textStats = evaluateTextQuality(normalizedPagesText);
  const indexedRefs = (Array.isArray(styleReferences) ? styleReferences : []).map((ref, index) => ({ ref, index }));
  const imageIdsByIndex = new Map(indexedRefs.map(({ index }) => [index, toImageIdFromStyleRefIndex(index)]));

  const pageRefs = indexedRefs.filter(({ ref }) => ref.source === 'pdf_page' && Number.isInteger(ref.pageIndex));
  const pagesImages = pageRefs.map(({ ref, index }) => ({
    pageNum: Number(ref.pageIndex) + 1,
    imageId: imageIdsByIndex.get(index),
    path: `page_images/page_${String(Number(ref.pageIndex) + 1).padStart(4, '0')}.png`,
    styleRefIndex: index
  }));
  const illustrationPages = [...new Set(
    pageRefs
      .filter(({ ref }) => ref.kind === 'scene')
      .map(({ ref }) => Number(ref.pageIndex) + 1)
  )].sort((a, b) => a - b);

  const styleBible = await buildStyleBibleFromModel(ai, {
    summary,
    artStyle,
    styleReferences,
    imageIdsByIndex
  });
  const entityRecords = buildEntityRecords(storyFacts, imageIdsByIndex);

  const characterRecords = entityRecords.filter((record) => record.type === 'character');
  const mainCharacters = characterRecords
    .filter((record) =>
      (storyFacts?.characterCatalog || [])
        .find((entry) => entry.name === record.name)?.source !== 'mentioned'
    );
  const mainCharacterSet = (mainCharacters.length > 0 ? mainCharacters : characterRecords).slice(0, 4);
  const mainCharactersWithGold = mainCharacterSet.filter((record) => Boolean(record.goldRefs?.face || record.goldRefs?.bootstrap));
  const allCharactersWithGold = characterRecords.filter((record) => Boolean(record.goldRefs?.face || record.goldRefs?.bootstrap));
  const hasGoldRefsPercent = mainCharacterSet.length > 0
    ? Math.round((mainCharactersWithGold.length / mainCharacterSet.length) * 100)
    : 0;

  const validationWarnings = [];
  if (!String(storyFile?.mimeType || '').includes('pdf')) {
    validationWarnings.push('File is not marked as PDF mime type.');
  }
  if (String(storyFile?.data || '').includes('L0VuY3J5cHQ')) {
    validationWarnings.push('PDF appears encrypted; parsing quality may be limited.');
  }
  if (textStats.textQuality === 'poor') {
    validationWarnings.push('Low text quality detected. OCR may be required for strong Q&A accuracy.');
  }
  if ((styleBible.styleReferenceImageIds || []).length < MIN_STYLE_BIBLE_REFS) {
    validationWarnings.push('Style bible has fewer than 5 representative references.');
  }
  if (mainCharacterSet.length > 0 && mainCharactersWithGold.length === 0) {
    validationWarnings.push('Main characters are missing gold refs.');
  }

  const pageCount = Math.max(
    normalizedPagesText.length,
    ...pagesImages.map((entry) => entry.pageNum),
    0
  );
  const fileHash = hashStringFast(`${storyFile?.data?.slice(0, 10000) || ''}:${storyFile?.data?.length || 0}`);
  const bookId = `book_${fileHash}`;
  const notes = [
    'Pass character gold refs to image generation whenever that character appears.',
    'Use a stable small reference set per render: 2-3 style + 1-2 character refs.',
    'Avoid random page refs at runtime; prefer pinned style and gold refs.',
    ...(validationWarnings.length > 0 ? validationWarnings.map((warning) => `Warning: ${warning}`) : [])
  ];

  const qaReadyManifest = {
    styleBibleId: styleBible.id,
    entityRecordsId: 'entity_records_main',
    pageTextCount: normalizedPagesText.length,
    pageImageCount: pagesImages.length,
    illustrationPageCount: illustrationPages.length,
    textQuality: textStats.textQuality,
    hasGoldRefsPercent,
    checklist: {
      normalizedPdf: true,
      pageImages: pagesImages.length > 0,
      styleBible: (styleBible.styleReferenceImageIds || []).length >= MIN_STYLE_BIBLE_REFS,
      entityCatalog: entityRecords.length > 0,
      mainCharactersGoldRefs: mainCharacterSet.length === 0 || mainCharactersWithGold.length > 0,
      cleanTextPerPage: textStats.textQuality !== 'poor',
      allRecurringCharactersGoldRefs:
        characterRecords.length > 0 && allCharactersWithGold.length === characterRecords.length,
      keyObjectsGoldRefs:
        (storyFacts?.objects || []).length === 0 ||
        (storyFacts?.objectImageMap || []).some((entry) => (entry.styleRefIndexes || []).length > 0)
    },
    notes
  };

  return {
    version: QA_PACKAGE_VERSION,
    createdAt: Date.now(),
    manifest: {
      bookId,
      title: truncate(summary || 'Untitled book', 120),
      fileHash,
      pageCount,
      originalFileSize: estimateBase64Bytes(storyFile?.data || ''),
      mimeType: storyFile?.mimeType || 'application/pdf',
      textQuality: textStats.textQuality,
      validationWarnings,
      normalizedAt: Date.now()
    },
    pagesText: normalizedPagesText,
    pagesImages,
    illustrationPages,
    styleBible,
    entityRecords,
    qaReadyManifest
  };
};

const enrichSceneEvidenceFromStyleRefs = (sceneCatalog, styleReferences) => {
  const byScene = new Map(
    (Array.isArray(sceneCatalog) ? sceneCatalog : []).map((scene) => [scene.id, { ...scene }])
  );

  for (const ref of Array.isArray(styleReferences) ? styleReferences : []) {
    const sceneId = normalizePhrase(ref?.sceneId || '');
    if (!sceneId || !byScene.has(sceneId)) continue;
    const scene = byScene.get(sceneId);
    if (!scene) continue;
    if (!Number.isInteger(ref?.pageIndex)) continue;

    scene.illustratedEvidence = normalizeEvidenceList(
      [
        ...(scene.illustratedEvidence || []),
        {
          pageIndex: Number(ref.pageIndex),
          snippet: 'illustrated reference',
          confidence: normalizeConfidence(ref?.confidence, 0.65)
        }
      ],
      8
    );
  }

  return Array.from(byScene.values());
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
              '   - scenes: major scenes with short titles',
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
                scenes: { type: Type.ARRAY, items: { type: Type.STRING } },
                objects: { type: Type.ARRAY, items: { type: Type.STRING } },
                events: { type: Type.ARRAY, items: { type: Type.STRING } },
                setting: { type: Type.STRING },
                world_tags: { type: Type.ARRAY, items: { type: Type.STRING } }
              },
              required: ['characters', 'character_catalog', 'places', 'scenes', 'objects', 'events', 'setting', 'world_tags']
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
  const pagesTextPromise = extractPagesTextFromPdf(ai, storyFile);
  const storyTextPromise = extractStoryTextFromPdf(ai, storyFile, storyBrief);

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

  const initialStoryFacts = normalizeStoryFacts(
    {
      ...(parsed.story_facts || {}),
      character_catalog: [
        ...((parsed.story_facts && parsed.story_facts.character_catalog) || []),
        ...extractedCharacterCatalog
      ]
    },
    storyBrief
  );
  const sceneCatalog = await extractSceneCatalogFromStory(ai, storyFile, storyBrief, initialStoryFacts);
  const storyFacts = normalizeStoryFacts(
    {
      ...initialStoryFacts,
      sceneCatalog
    },
    storyBrief
  );

  const incomingStyleRefs = normalizeStyleReferenceAssets(
    (Array.isArray(styleImages) ? styleImages : []).slice(0, STYLE_REF_POOL_LIMIT).map((item) => ({
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

  const coverImage = await generateImageDataUrl(ai, coverParts, '3:4');

  const coverMs = Math.round(performance.now() - coverStart);
  const totalMs = Math.round(performance.now() - setupStart);

  const coverPrimer = toFileDataFromDataUrl(coverImage);
  let finalStyleReferences = mergeStyleReferencePools(
    canonicalStyleRefs,
    classifiedStyleRefs,
    incomingStyleRefs
  );
  if (finalStyleReferences.length === 0 && coverPrimer) {
    finalStyleReferences = mergeStyleReferencePools([
      {
        ...coverPrimer,
        kind: 'scene',
        source: 'generated',
        confidence: 0.7,
        qualityScore: 0.7,
        assetRole: 'scene_anchor'
      }
    ]);
  }

  const stylePrimerSource = canonicalStyleRefs.length > 0
    ? canonicalStyleRefs
    : finalStyleReferences;
  const stylePrimer = stylePrimerSource.slice(0, STYLE_REF_MAX_TOTAL).map((reference) => ({
    mimeType: reference.mimeType,
    data: reference.data
  }));
  const enrichedSceneCatalog = enrichSceneEvidenceFromStyleRefs(
    storyFacts.sceneCatalog || [],
    finalStyleReferences
  );
  const {
    characterImageMap,
    objectImageMap,
    sceneImageMap,
    characterEvidenceMap,
    objectEvidenceMap
  } = buildEntityImageMapsFromStyleRefs(finalStyleReferences, {
    ...storyFacts,
    sceneCatalog: enrichedSceneCatalog
  });
  const storyFactsWithImageMap = normalizeStoryFacts(
    {
      ...storyFacts,
      sceneCatalog: enrichedSceneCatalog,
      characterImageMap,
      objectImageMap,
      sceneImageMap,
      characterEvidenceMap,
      objectEvidenceMap
    },
    storyBrief
  );
  const pagesTextPayload = await pagesTextPromise;
  const storyText = pagesTextPayload.storyText || await storyTextPromise;
  const qaReadyPackage = await buildQaReadyBookPackage(ai, {
    storyFile,
    summary,
    artStyle,
    storyText,
    storyFacts: storyFactsWithImageMap,
    styleReferences: finalStyleReferences,
    pagesText: pagesTextPayload.pagesText
  });

  return {
    storyPack: {
      summary,
      artStyle,
      storyBrief,
      storyText,
      qaReadyPackage,
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
  storyText,
  storyPdf,
  storyBrief,
  storyFacts,
  artStyle,
  stylePrimer,
  styleReferences,
  history
) => {
  if (!String(storyText || '').trim()) {
    throw new Error('This story is missing extracted book text. Open setup and save again.');
  }

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
  ).slice(0, STYLE_REF_POOL_LIMIT);
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
  const questionParticipants = await resolveTurnContextParticipants(
    ai,
    question,
    normalizedFacts,
    effectiveStyleReferences,
    null
  );
  const answerAgentResult = await generateAnswersFromStoryText(ai, {
    question,
    storyText,
    storyPdf,
    history,
    storyFacts: normalizedFacts,
    storyBrief
  });
  const resolvedOptions = answerAgentResult.options;
  const regenerationCount = 0;

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
      const combinedContext = `${question}\n${card.text}`;
      const participants = await resolveTurnContextParticipants(
        ai,
        combinedContext,
        normalizedFacts,
        effectiveStyleReferences,
        questionParticipants
      );
      const { refs: refsForOption, selectedStyleRefIndexes } = await selectStyleRefsForOption(
        ai,
        effectiveStylePrimer,
        effectiveStyleReferences,
        normalizedFacts,
        card.text,
        questionParticipants,
        participants
      );
      const refSummary = refsForOption
        .map((ref, idx) => {
          const linkedIndex = selectedStyleRefIndexes[idx];
          const entity = ref.characterName || ref.objectName || ref.sceneId || 'none';
          const coverage = Number.isFinite(Number(ref.cropCoverage))
            ? `${Math.round(Number(ref.cropCoverage) * 100)}%`
            : '-';
          return `${Number.isInteger(linkedIndex) ? linkedIndex : '?'}:${ref.kind}:${entity}:${coverage}`;
        })
        .join(';');
      console.info(
        `[turn] ${card.id} selected_refs=${selectedStyleRefIndexes.join(',') || 'none'} ` +
          `participants scenes=${participants.scenes.join('|') || 'none'} ` +
          `chars=${participants.characters.join('|') || 'none'} ` +
          `objects=${participants.objects.join('|') || 'none'} ` +
          `refs_meta=${refSummary || 'none'}`
      );

      for (const ref of refsForOption) {
        parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.data } });
      }

      const selectedStyleRefs = refsForOption.map((ref, idx) => ({
        index: Number.isInteger(selectedStyleRefIndexes[idx]) ? selectedStyleRefIndexes[idx] : -1,
        kind: ref.kind,
        source: ref.source,
        sceneId: ref.sceneId || undefined,
        characterName: ref.characterName || undefined,
        objectName: ref.objectName || undefined,
        cropCoverage: Number.isFinite(Number(ref.cropCoverage)) ? Number(ref.cropCoverage) : undefined,
        confidence: Number.isFinite(Number(ref.confidence)) ? Number(ref.confidence) : undefined
      }));

      const { illustrationAgentPrompt, illustrationPlan } = await generateIllustrationPlanForAnswer(ai, {
        question,
        answerText: card.text,
        isCorrect: Boolean(card.isCorrect),
        participants,
        storyFacts: normalizedFacts,
        selectedRefs: refsForOption
      });
      const illustrationPlanText = toIllustrationPlanText(illustrationPlan, card.text);
      const imagePrompt = buildImagePrompt({
        optionText: card.text,
        renderMode: card.renderMode,
        storyBrief,
        artStyle,
        storyFacts: normalizedFacts,
        participants,
        selectedRefs: refsForOption,
        illustrationPlan
      });

      parts.push({
        text: imagePrompt
      });

      let imageGenerationError = '';
      try {
        card.imageUrl = (
          await retryWithBackoff(() => generateImageDataUrl(ai, parts, '1:1'), 1, 350)
        ) || undefined;
      } catch (error) {
        console.warn('[image] generation failed', card.id, error?.message || error);
        imageGenerationError = String(error?.message || error || 'image generation failed');
        card.imageUrl = undefined;
      }

      card.isLoadingImage = false;
      card.debug = {
        answerAgentPrompt: answerAgentResult.answerAgentPrompt,
        answerAgentRaw: answerAgentResult.answerAgentRaw,
        illustrationAgentPrompt,
        illustrationPlan: illustrationPlanText,
        selectedStyleRefIndexes,
        selectedStyleRefs,
        selectedParticipants: participants,
        imagePrompt,
        imageModel: IMAGE_MODEL,
        imageGenerationError: imageGenerationError || undefined
      };
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
