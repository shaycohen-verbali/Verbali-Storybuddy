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

interface CropTemplate {
  x: number;
  y: number;
  width: number;
  height: number;
  kind: 'character' | 'object';
}

let pdfJsPromise: Promise<PdfJsModule> | null = null;

const CROP_TEMPLATES: CropTemplate[] = [
  { x: 0.12, y: 0.12, width: 0.44, height: 0.62, kind: 'character' },
  { x: 0.44, y: 0.12, width: 0.44, height: 0.62, kind: 'character' },
  { x: 0.23, y: 0.2, width: 0.54, height: 0.66, kind: 'character' },
  { x: 0.1, y: 0.54, width: 0.33, height: 0.33, kind: 'object' },
  { x: 0.57, y: 0.54, width: 0.33, height: 0.33, kind: 'object' }
];

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
  const sampleWidth = Math.max(24, Math.min(96, Math.floor(width / 4)));
  const sampleHeight = Math.max(24, Math.min(96, Math.floor(height / 4)));
  const sampled = ctx.getImageData(0, 0, sampleWidth, sampleHeight).data;
  const lumaValues: number[] = [];

  for (let i = 0; i < sampled.length; i += 16) {
    const r = sampled[i];
    const g = sampled[i + 1];
    const b = sampled[i + 2];
    const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
    lumaValues.push(luma);
  }

  if (lumaValues.length === 0) {
    return 0;
  }

  const avg = lumaValues.reduce((sum, value) => sum + value, 0) / lumaValues.length;
  const variance = lumaValues.reduce((sum, value) => sum + (value - avg) ** 2, 0) / lumaValues.length;
  return variance;
};

const cropFromTemplate = (
  sourceImage: HTMLImageElement,
  template: CropTemplate
): { dataUrl: string; score: number } | null => {
  const sx = Math.max(0, Math.floor(sourceImage.width * template.x));
  const sy = Math.max(0, Math.floor(sourceImage.height * template.y));
  const sw = Math.max(1, Math.floor(sourceImage.width * template.width));
  const sh = Math.max(1, Math.floor(sourceImage.height * template.height));

  if (sw < 80 || sh < 80) {
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
  if (score < 45) {
    return null;
  }

  return {
    dataUrl: canvas.toDataURL('image/jpeg', 0.82),
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
  const cropIndexes = selectEvenlySpacedIndexes(pageImages.length, Math.min(12, pageImages.length));

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
      pageIndex,
      confidence: 0.55
    });
  }

  for (const pageIndex of cropIndexes) {
    if (assets.length >= maxAssets) break;
    const image = await loadImage(pageImages[pageIndex]);
    const candidates: Array<{ dataUrl: string; score: number; kind: 'character' | 'object' }> = [];

    for (const template of CROP_TEMPLATES) {
      const cropped = cropFromTemplate(image, template);
      if (!cropped) continue;
      candidates.push({
        ...cropped,
        kind: template.kind
      });
    }

    candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .forEach((candidate) => {
        if (assets.length >= maxAssets) return;
        const fingerprint = toFingerprint(candidate.dataUrl);
        if (seen.has(fingerprint)) return;
        seen.add(fingerprint);

        const parsed = parseDataUrl(candidate.dataUrl);
        if (!parsed.data) return;

        assets.push({
          ...parsed,
          kind: candidate.kind,
          source: 'crop',
          pageIndex,
          confidence: Math.max(0.25, Math.min(0.95, candidate.score / 220))
        });
      });
  }

  return assets.slice(0, maxAssets);
};

export const extractStyleScreenshotsFromPdf = async (base64Data: string, maxAssets = 80): Promise<string[]> => {
  const assets = await extractStyleReferenceAssetsFromPdf(base64Data, maxAssets);
  return assets.map((asset) => `data:${asset.mimeType};base64,${asset.data}`);
};
