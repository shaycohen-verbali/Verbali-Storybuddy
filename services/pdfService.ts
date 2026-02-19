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
  maxAssets = 120
): Promise<StyleReferenceAsset[]> => {
  const pageImages = await convertPdfToImages(base64Data, {
    maxPages: Math.min(maxAssets, 120),
    scale: 1.28,
    quality: 0.78
  });

  if (pageImages.length === 0) {
    return [];
  }

  const assets: StyleReferenceAsset[] = [];
  const seen = new Set<string>();
  const sceneIndexes = selectEvenlySpacedIndexes(pageImages.length, Math.min(maxAssets, pageImages.length));
  for (const pageIndex of sceneIndexes) {
    if (assets.length >= maxAssets) break;
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
      confidence: 0.66,
      qualityScore: 0.66
    });
  }

  return assets.slice(0, maxAssets);
};

export const extractStyleScreenshotsFromPdf = async (base64Data: string, maxAssets = 80): Promise<string[]> => {
  const assets = await extractStyleReferenceAssetsFromPdf(base64Data, maxAssets);
  return assets.map((asset) => `data:${asset.mimeType};base64,${asset.data}`);
};
