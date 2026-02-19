import { StyleReferenceAsset } from '../types';

type PdfJsModule = {
  GlobalWorkerOptions: {
    workerSrc: string;
  };
  getDocument: (params: { data: Uint8Array }) => {
    promise: Promise<{
      numPages: number;
      getPage: (pageNumber: number) => Promise<{
        getViewport: (params: { scale: number }) => { width: number; height: number };
        render: (params: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => { promise: Promise<void> };
      }>;
    }>;
  };
};

interface ConvertPdfOptions {
  maxPages?: number;
  scale?: number;
  quality?: number;
}

interface RegionCandidate {
  x: number;
  y: number;
  width: number;
  height: number;
}

let pdfJsPromise: Promise<PdfJsModule> | null = null;

const getPdfJs = async (): Promise<PdfJsModule> => {
  if (!pdfJsPromise) {
    pdfJsPromise = import(
      /* @vite-ignore */
      'https://esm.sh/pdfjs-dist@4.0.379/build/pdf.mjs'
    ) as Promise<PdfJsModule>;
  }

  const pdfjsLib = await pdfJsPromise;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://esm.sh/pdfjs-dist@4.0.379/build/pdf.worker.mjs';
  return pdfjsLib;
};

const selectEvenlySpacedIndexes = (length: number, targetCount: number): number[] => {
  if (length <= 0 || targetCount <= 0) {
    return [];
  }

  if (length <= targetCount) {
    return Array.from({ length }, (_, idx) => idx);
  }

  const step = (length - 1) / (targetCount - 1);
  const indexes = new Set<number>();
  for (let i = 0; i < targetCount; i += 1) {
    indexes.add(Math.round(i * step));
  }
  return [...indexes].sort((a, b) => a - b);
};

const toFingerprint = (dataUrl: string): string => {
  const middleStart = Math.max(0, Math.floor(dataUrl.length / 2) - 32);
  return `${dataUrl.length}:${dataUrl.slice(0, 64)}:${dataUrl.slice(middleStart, middleStart + 64)}:${dataUrl.slice(-64)}`;
};

const parseDataUrl = (dataUrl: string): { mimeType: string; data: string } => {
  const match = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!match) {
    return { mimeType: 'image/jpeg', data: '' };
  }
  return { mimeType: match[1], data: match[2] };
};

const loadImage = async (dataUrl: string): Promise<HTMLImageElement> => {
  const image = new Image();
  return new Promise((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = dataUrl;
  });
};

const computeVisualScore = (ctx: CanvasRenderingContext2D, width: number, height: number): number => {
  const sampleWidth = Math.max(24, Math.min(140, Math.floor(width / 3)));
  const sampleHeight = Math.max(24, Math.min(140, Math.floor(height / 3)));
  const sampled = ctx.getImageData(0, 0, sampleWidth, sampleHeight).data;
  if (sampled.length === 0) {
    return 0;
  }

  let lumaSum = 0;
  let lumaSq = 0;
  let edgeSum = 0;
  let count = 0;

  for (let i = 0; i < sampled.length; i += 4) {
    const r = sampled[i];
    const g = sampled[i + 1];
    const b = sampled[i + 2];
    const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
    lumaSum += luma;
    lumaSq += luma * luma;
    count += 1;
    if (i >= 4) {
      edgeSum += Math.abs(luma - (sampled[i - 4] * 0.2126 + sampled[i - 3] * 0.7152 + sampled[i - 2] * 0.0722));
    }
  }

  const mean = lumaSum / Math.max(1, count);
  const variance = lumaSq / Math.max(1, count) - mean * mean;
  return variance + edgeSum / Math.max(1, count);
};

const buildRegionCandidates = (): RegionCandidate[] => {
  const regions: RegionCandidate[] = [];
  const widths = [0.28, 0.34, 0.42, 0.5];
  const heights = [0.28, 0.34, 0.46, 0.58];
  const anchors = [0.08, 0.18, 0.28, 0.38, 0.48, 0.58];

  for (const width of widths) {
    for (const height of heights) {
      for (const x of anchors) {
        for (const y of anchors) {
          if (x + width > 0.96 || y + height > 0.96) continue;
          regions.push({ x, y, width, height });
        }
      }
    }
  }

  return regions;
};

const CROP_REGION_CANDIDATES = buildRegionCandidates();

const cropRegion = (
  sourceImage: HTMLImageElement,
  candidate: RegionCandidate
): { dataUrl: string; score: number } | null => {
  const sx = Math.max(0, Math.floor(sourceImage.width * candidate.x));
  const sy = Math.max(0, Math.floor(sourceImage.height * candidate.y));
  const sw = Math.max(1, Math.floor(sourceImage.width * candidate.width));
  const sh = Math.max(1, Math.floor(sourceImage.height * candidate.height));
  if (sw < 120 || sh < 120) {
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return null;
  }

  ctx.drawImage(sourceImage, sx, sy, sw, sh, 0, 0, sw, sh);
  const score = computeVisualScore(ctx, sw, sh);
  if (score < 30) {
    return null;
  }

  return {
    dataUrl: canvas.toDataURL('image/jpeg', 0.83),
    score
  };
};

export const convertPdfToImages = async (base64Data: string, options: ConvertPdfOptions = {}): Promise<string[]> => {
  try {
    const pdfjsLib = await getPdfJs();
    const binaryString = atob(base64Data);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const loadingTask = pdfjsLib.getDocument({ data: bytes });
    const pdf = await loadingTask.promise;
    const images: string[] = [];

    const maxPages = options.maxPages ?? 80;
    const scale = options.scale ?? 1.3;
    const quality = options.quality ?? 0.78;
    const pagesToProcess = Math.min(pdf.numPages, maxPages);

    for (let i = 1; i <= pagesToProcess; i += 1) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      const context = canvas.getContext('2d');
      if (!context) continue;

      await page.render({
        canvasContext: context,
        viewport
      }).promise;

      images.push(canvas.toDataURL('image/jpeg', quality));
    }

    return images;
  } catch (error) {
    console.error('Error converting PDF to images:', error);
    throw new Error('Failed to process PDF pages.');
  }
};

export const extractStyleReferenceAssetsFromPdf = async (
  base64Data: string,
  maxAssets = 80
): Promise<StyleReferenceAsset[]> => {
  const pageImages = await convertPdfToImages(base64Data, {
    maxPages: Math.min(maxAssets, 80),
    scale: 1.25,
    quality: 0.78
  });

  if (pageImages.length === 0) {
    return [];
  }

  const assets: StyleReferenceAsset[] = [];
  const seen = new Set<string>();
  const sceneIndexes = selectEvenlySpacedIndexes(pageImages.length, Math.min(18, pageImages.length));
  for (const pageIndex of sceneIndexes) {
    const dataUrl = pageImages[pageIndex];
    const fingerprint = toFingerprint(dataUrl);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    const parsed = parseDataUrl(dataUrl);
    if (!parsed.data) continue;

    assets.push({
      ...parsed,
      kind: 'scene',
      source: 'pdf_page',
      assetRole: 'scene_anchor',
      pageIndex,
      confidence: 0.62,
      qualityScore: 0.62
    });
  }

  const cropIndexes = selectEvenlySpacedIndexes(pageImages.length, Math.min(20, pageImages.length));
  for (const pageIndex of cropIndexes) {
    if (assets.length >= maxAssets) break;
    const image = await loadImage(pageImages[pageIndex]);
    const ranked = CROP_REGION_CANDIDATES
      .map((candidate) => cropRegion(image, candidate))
      .filter((item): item is { dataUrl: string; score: number } => Boolean(item))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    for (let idx = 0; idx < ranked.length; idx += 1) {
      if (assets.length >= maxAssets) break;
      const item = ranked[idx];
      const fingerprint = toFingerprint(item.dataUrl);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);

      const parsed = parseDataUrl(item.dataUrl);
      if (!parsed.data) continue;

      const kind = idx % 2 === 0 ? 'character' : 'object';
      assets.push({
        ...parsed,
        kind,
        source: 'crop',
        assetRole: kind === 'character' ? 'character_form' : 'object_anchor',
        pageIndex,
        confidence: Math.max(0.35, Math.min(0.9, item.score / 120)),
        qualityScore: Math.max(0.35, Math.min(0.9, item.score / 120))
      });
    }
  }

  return assets.slice(0, maxAssets);
};

export const extractStyleScreenshotsFromPdf = async (base64Data: string, maxAssets = 80): Promise<string[]> => {
  const assets = await extractStyleReferenceAssetsFromPdf(base64Data, maxAssets);
  return assets.map((asset) => `data:${asset.mimeType};base64,${asset.data}`);
};
