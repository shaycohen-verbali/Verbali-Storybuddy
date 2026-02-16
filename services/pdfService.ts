import * as pdfjsLib from 'pdfjs-dist';

// Set worker source to the CDN version matching the library
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://esm.sh/pdfjs-dist@4.0.379/build/pdf.worker.mjs';

interface ConvertPdfOptions {
  maxPages?: number;
  scale?: number;
  quality?: number;
}

const sampleEvenly = <T>(list: T[], count: number): T[] => {
  if (count <= 0 || list.length === 0) {
    return [];
  }

  if (list.length <= count) {
    return [...list];
  }

  const sampled: T[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.min(list.length - 1, Math.round((i * (list.length - 1)) / Math.max(1, count - 1)));
    sampled.push(list[idx]);
  }

  return sampled;
};

const createCharacterFocusCrop = async (pageDataUrl: string): Promise<string | null> => {
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = reject;
      img.src = pageDataUrl;
    });

    const cropWidth = Math.round(img.width * 0.65);
    const cropHeight = Math.round(img.height * 0.65);
    const sx = Math.max(0, Math.round((img.width - cropWidth) / 2));
    const sy = Math.max(0, Math.round((img.height - cropHeight) * 0.45));

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }

    ctx.drawImage(img, sx, sy, cropWidth, cropHeight, 0, 0, 512, 512);
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    return null;
  }
};

export const convertPdfToImages = async (base64Data: string, options: ConvertPdfOptions = {}): Promise<string[]> => {
  try {
    const binaryString = atob(base64Data);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const loadingTask = pdfjsLib.getDocument({ data: bytes });
    const pdf = await loadingTask.promise;
    const numPages = pdf.numPages;
    const images: string[] = [];

    const maxPages = options.maxPages ?? 20;
    const scale = options.scale ?? 1.5;
    const quality = options.quality ?? 0.8;
    const pagesToProcess = Math.min(numPages, maxPages);

    for (let i = 1; i <= pagesToProcess; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      canvas.height = viewport.height;
      canvas.width = viewport.width;

      if (context) {
        await page.render({
          canvasContext: context,
          viewport: viewport,
        }).promise;

        images.push(canvas.toDataURL('image/jpeg', quality));
      }
    }

    return images;
  } catch (error) {
    console.error("Error converting PDF to images:", error);
    throw new Error("Failed to process PDF pages.");
  }
};

export const extractStyleScreenshotsFromPdf = async (base64Data: string, maxAssets = 8): Promise<string[]> => {
  const pageImages = await convertPdfToImages(base64Data, {
    maxPages: 12,
    scale: 1.2,
    quality: 0.78
  });

  if (pageImages.length === 0) {
    return [];
  }

  const pagePool = pageImages.length > 2 ? pageImages.slice(1) : pageImages;
  const sampledPages = sampleEvenly(pagePool, Math.min(4, pagePool.length));

  const assets: string[] = [];
  for (const pageImage of sampledPages) {
    if (assets.length < maxAssets) {
      assets.push(pageImage);
    }

    if (assets.length < maxAssets) {
      const crop = await createCharacterFocusCrop(pageImage);
      if (crop) {
        assets.push(crop);
      }
    }
  }

  return assets.slice(0, maxAssets);
};
