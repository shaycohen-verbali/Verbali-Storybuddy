import * as pdfjsLib from 'pdfjs-dist';

// Set worker source to the CDN version matching the library
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://esm.sh/pdfjs-dist@4.0.379/build/pdf.worker.mjs';

export const convertPdfToImages = async (base64Data: string): Promise<string[]> => {
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

    // Limit to first 20 pages to prevent memory crashes on huge books
    const pagesToProcess = Math.min(numPages, 20);

    for (let i = 1; i <= pagesToProcess; i++) {
      const page = await pdf.getPage(i);
      
      const scale = 1.5; // Good quality for cropping
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

        images.push(canvas.toDataURL('image/jpeg', 0.8));
      }
    }

    return images;
  } catch (error) {
    console.error("Error converting PDF to images:", error);
    throw new Error("Failed to process PDF pages.");
  }
};
