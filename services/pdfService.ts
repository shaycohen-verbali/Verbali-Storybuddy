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

interface ConvertPdfOptions {
  maxPages?: number;
  scale?: number;
  quality?: number;
}

export const convertPdfToImages = async (base64Data: string, options: ConvertPdfOptions = {}): Promise<string[]> => {
  try {
    const pdfjsLib = await getPdfJs();
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

    const maxPages = options.maxPages ?? 80;
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

export const extractStyleScreenshotsFromPdf = async (base64Data: string, maxAssets = 80): Promise<string[]> => {
  const pageImages = await convertPdfToImages(base64Data, {
    maxPages: maxAssets,
    scale: 1.0,
    quality: 0.72
  });

  if (pageImages.length === 0) {
    return [];
  }

  return pageImages.slice(0, maxAssets);
};
