import React, { useEffect, useRef, useState } from 'react';
import { Upload, BookOpen, X, AlertCircle, CheckCircle, ArrowRight, Loader2, Sparkles } from 'lucide-react';
import { FileData, SetupStoryResponse, StoryPack } from '../types';
import { USE_BACKEND_PIPELINE } from '../services/apiClient';
import { extractStyleScreenshotsFromPdf } from '../services/pdfService';

interface SetupInitialView {
  storyId?: string;
  createdAt?: number;
  readOnly?: boolean;
  title?: string;
  storyFile?: FileData | null;
  styleImages?: FileData[];
  storyPack?: StoryPack | null;
}

export interface ExistingSetupUpdatePayload {
  storyId: string;
  createdAt: number;
  storyFile: FileData | null;
  styleImages: FileData[];
  storyPack: StoryPack;
}

interface SetupPanelProps {
  onPrepareStory: (storyFile: FileData, styleImages: FileData[]) => Promise<SetupStoryResponse>;
  onComplete: (storyFile: FileData, styleImages: FileData[], storyPack: StoryPack) => void;
  onSaveExisting?: (payload: ExistingSetupUpdatePayload) => Promise<void> | void;
  onStartFromSetup?: () => void;
  initialView?: SetupInitialView | null;
  onClose: () => void;
}

const parseDataUrl = (dataUrl: string): FileData => {
  const match = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!match) {
    return { mimeType: 'image/jpeg', data: '' };
  }

  return { mimeType: match[1], data: match[2] };
};

const fileToDataUrl = async (file: File): Promise<string> => {
  const reader = new FileReader();
  return new Promise((resolve, reject) => {
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

const compressImageFile = async (file: File): Promise<FileData> => {
  const dataUrl = await fileToDataUrl(file);

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = dataUrl;
  });

  const maxEdge = 512;
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const width = Math.round(img.width * scale);
  const height = Math.round(img.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return parseDataUrl(dataUrl);
  }

  ctx.drawImage(img, 0, 0, width, height);
  return parseDataUrl(canvas.toDataURL('image/jpeg', 0.78));
};

const mergePrimerSources = (preferred: FileData[], fallback: FileData[]): FileData[] => {
  const merged: FileData[] = [];
  const seen = new Set<string>();

  for (const item of [...preferred, ...fallback]) {
    if (!item?.data || !item?.mimeType) continue;
    const middleStart = Math.max(0, Math.floor(item.data.length / 2) - 32);
    const middle = item.data.slice(middleStart, middleStart + 64);
    const key = `${item.mimeType}:${item.data.length}:${item.data.slice(0, 64)}:${middle}:${item.data.slice(-64)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }

  return merged.slice(0, 120);
};

const SetupPanel: React.FC<SetupPanelProps> = ({
  onPrepareStory,
  onComplete,
  onSaveExisting,
  onStartFromSetup,
  initialView,
  onClose
}) => {
  const storyInputRef = useRef<HTMLInputElement>(null);
  const styleInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);

  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [currentStory, setCurrentStory] = useState<FileData | null>(null);
  const [styleReferences, setStyleReferences] = useState<FileData[]>([]);
  const [preparedPack, setPreparedPack] = useState<StoryPack | null>(null);
  const [isReadOnlyView, setIsReadOnlyView] = useState(false);

  const isExistingStory = Boolean(initialView?.storyId);
  const canEdit = !isReadOnlyView;
  const maxPdfSizeBytes = USE_BACKEND_PIPELINE ? 3 * 1024 * 1024 : 50 * 1024 * 1024;

  useEffect(() => {
    if (!initialView) {
      setCurrentStory(null);
      setStyleReferences([]);
      setPreparedPack(null);
      setIsReadOnlyView(false);
      setErrorMsg(null);
      setIsProcessing(false);
      return;
    }

    setCurrentStory(initialView.storyFile || null);
    setStyleReferences(initialView.styleImages || []);
    setPreparedPack(initialView.storyPack || null);
    setIsReadOnlyView(Boolean(initialView.readOnly));
    setErrorMsg(null);
    setIsProcessing(false);
  }, [initialView]);

  const runSetupFromCurrentStory = async (sourceStory?: FileData | null, sourceStyles?: FileData[]) => {
    const storySource = sourceStory || currentStory;
    if (!storySource) {
      setErrorMsg('Original PDF is required to re-run setup.');
      return;
    }

    setErrorMsg(null);
    setIsProcessing(true);

    try {
      let effectiveStyles = sourceStyles ?? styleReferences;
      if (effectiveStyles.length === 0) {
        const screenshots = await extractStyleScreenshotsFromPdf(storySource.data, 80);
        effectiveStyles = screenshots
          .map((dataUrl) => parseDataUrl(dataUrl))
          .filter((item) => item.data.length > 0);
      }

      if (effectiveStyles.length > 0) {
        setStyleReferences(effectiveStyles);
      }

      const setupStyles = effectiveStyles.slice(0, 8);
      const setupResponse = await onPrepareStory(storySource, setupStyles);
      setPreparedPack((prev) => ({
        ...setupResponse.storyPack,
        coverImage: prev?.coverImage || setupResponse.storyPack.coverImage
      }));

      if (effectiveStyles.length === 0 && setupResponse.storyPack.stylePrimer.length > 0) {
        setStyleReferences(setupResponse.storyPack.stylePrimer);
      }
    } catch (error: any) {
      console.error(error);
      setErrorMsg(error?.message || 'Failed to process story');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleStoryUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!canEdit) {
      return;
    }

    const file = e.target.files?.[0];
    if (!file) {
      return;
    }

    if (file.size > maxPdfSizeBytes) {
      if (USE_BACKEND_PIPELINE) {
        setErrorMsg('PDF is too large for cloud processing. Use a PDF smaller than 3MB.');
      } else {
        setErrorMsg('File is too large. Please use a file smaller than 50MB.');
      }
      return;
    }

    try {
      const dataUrl = await fileToDataUrl(file);
      const storyFile: FileData = { data: dataUrl.split(',')[1] || '', mimeType: file.type };
      setCurrentStory(storyFile);
      const screenshots = await extractStyleScreenshotsFromPdf(storyFile.data, 80);
      const screenshotReferences = screenshots
        .map((value) => parseDataUrl(value))
        .filter((item) => item.data.length > 0);
      if (screenshotReferences.length > 0) {
        setStyleReferences(screenshotReferences);
      }
      await runSetupFromCurrentStory(storyFile, screenshotReferences);
    } catch (error: any) {
      console.error(error);
      setErrorMsg(error?.message || 'Failed to read story file');
    }
  };

  const handleStyleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!canEdit) {
      return;
    }

    const files = e.target.files;
    if (!files || files.length === 0) {
      return;
    }

    const newStyles: FileData[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.type.startsWith('image/')) {
        continue;
      }
      newStyles.push(await compressImageFile(file));
    }

    setStyleReferences((prev) => [...prev, ...newStyles]);
  };

  const handleCoverUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!canEdit) {
      return;
    }

    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith('image/')) {
      return;
    }

    try {
      const dataUrl = await fileToDataUrl(file);
      setPreparedPack((prev) => {
        if (!prev) {
          return prev;
        }

        return {
          ...prev,
          coverImage: dataUrl
        };
      });
    } catch (error: any) {
      console.error(error);
      setErrorMsg(error?.message || 'Failed to update cover image');
    }
  };

  const removeStyleImage = (index: number) => {
    if (!canEdit) {
      return;
    }

    setStyleReferences((prev) => prev.filter((_, i) => i !== index));
  };

  const handleRerunAnalysis = async () => {
    try {
      if (!currentStory) {
        await runSetupFromCurrentStory();
        return;
      }

      const screenshots = await extractStyleScreenshotsFromPdf(currentStory.data, 80);
      const screenshotReferences = screenshots
        .map((value) => parseDataUrl(value))
        .filter((item) => item.data.length > 0);
      if (screenshotReferences.length > 0) {
        setStyleReferences(screenshotReferences);
      }
      await runSetupFromCurrentStory(currentStory, screenshotReferences);
    } catch (error: any) {
      console.error(error);
      setErrorMsg(error?.message || 'Failed to refresh screenshots from the book');
    }
  };

  const handleFinish = async () => {
    try {
      if (isReadOnlyView) {
        onStartFromSetup?.();
        return;
      }

      if (!preparedPack) {
        return;
      }

      const finalPrimer = mergePrimerSources(styleReferences, preparedPack.stylePrimer);
      const finalPack: StoryPack = {
        ...preparedPack,
        stylePrimer: finalPrimer
      };

      if (isExistingStory && initialView?.storyId) {
        await onSaveExisting?.({
          storyId: initialView.storyId,
          createdAt: initialView.createdAt || Date.now(),
          storyFile: currentStory,
          styleImages: finalPrimer,
          storyPack: finalPack
        });
        onClose();
        return;
      }

      if (!currentStory) {
        setErrorMsg('Please upload a story PDF first.');
        return;
      }

      await Promise.resolve(onComplete(currentStory, finalPrimer, finalPack));
      onClose();
    } catch (error: any) {
      console.error(error);
      setErrorMsg(error?.message || 'Failed to save setup changes');
    }
  };

  const summary = preparedPack?.summary || '';
  const generatedCover = preparedPack?.coverImage || null;
  const characterCatalog = preparedPack?.storyFacts?.characterCatalog || [];
  const hasAnalysis = Boolean(summary || preparedPack) || isReadOnlyView;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-3xl w-full max-w-5xl h-[90vh] overflow-hidden shadow-2xl flex flex-col">
        <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-white z-10">
          <div>
            <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
              <BookOpen className="w-6 h-6 text-kid-blue" />
              {isExistingStory ? 'Story Setup' : 'Prepare Story'}
            </h2>
            {initialView?.title && (
              <p className="text-sm text-gray-500 mt-1">{initialView.title}</p>
            )}
          </div>

          <div className="flex items-center gap-2">
            {isExistingStory && isReadOnlyView && (
              <button
                onClick={() => setIsReadOnlyView(false)}
                className="px-4 py-2 rounded-full bg-gray-100 text-gray-700 text-sm font-bold hover:bg-gray-200 transition"
              >
                Edit Setup
              </button>
            )}
            <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-full text-gray-400 transition">
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-8 bg-gray-50/50">
          {errorMsg && (
            <div className="bg-red-50 text-red-600 p-4 rounded-xl flex items-center gap-3 mb-6">
              <AlertCircle className="w-6 h-6 flex-shrink-0" />
              <p className="font-medium text-sm">{errorMsg}</p>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="space-y-6">
              <section className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                <h3 className="text-lg font-bold text-gray-700 mb-4 flex items-center gap-2">
                  <span className="bg-kid-blue text-white w-6 h-6 rounded-full flex items-center justify-center text-xs">1</span>
                  Upload Story
                </h3>

                {!currentStory && canEdit ? (
                  <div
                    onClick={() => storyInputRef.current?.click()}
                    className="border-2 border-dashed border-gray-300 rounded-xl p-8 flex flex-col items-center justify-center cursor-pointer hover:bg-blue-50 hover:border-kid-blue transition group"
                  >
                    <Upload className="w-10 h-10 text-gray-300 group-hover:text-kid-blue mb-2" />
                    <span className="text-gray-500 font-medium">Click to upload PDF</span>
                    <input type="file" ref={storyInputRef} onChange={handleStoryUpload} className="hidden" accept=".pdf" />
                  </div>
                ) : currentStory ? (
                  <div className="flex items-center gap-3 p-4 bg-blue-50 text-kid-blue rounded-xl border border-blue-100">
                    <CheckCircle className="w-5 h-5" />
                    <span className="font-bold">Book Loaded</span>
                    {canEdit && (
                      <button
                        onClick={() => {
                          setCurrentStory(null);
                          setPreparedPack(null);
                        }}
                        className="ml-auto text-xs underline"
                      >
                        Change
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="p-4 bg-gray-50 rounded-xl border border-gray-200 text-sm text-gray-500">
                    No original PDF stored for this story.
                  </div>
                )}
              </section>

              {(isProcessing || hasAnalysis) && (
                <section className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 animate-fade-in-up">
                  <h3 className="text-lg font-bold text-gray-700 mb-4 flex items-center gap-2">
                    <span className="bg-kid-orange text-white w-6 h-6 rounded-full flex items-center justify-center text-xs">2</span>
                    Story Analysis
                  </h3>

                  {isProcessing ? (
                    <div className="flex flex-col items-center py-8 text-gray-400">
                      <Loader2 className="w-8 h-8 animate-spin mb-2 text-kid-orange" />
                      <span>Reading and building setup...</span>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div>
                        <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">Summary</label>
                        <p className="text-gray-700 text-lg leading-relaxed">{summary || 'No summary available.'}</p>
                      </div>

                      {generatedCover && (
                        <div>
                          <label className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 block">Cover</label>
                          <div className="relative aspect-[3/4] w-48 rounded-xl overflow-hidden shadow-lg">
                            <img src={generatedCover} alt="Cover" className="w-full h-full object-cover" />
                          </div>
                        </div>
                      )}

                      {canEdit && (
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => coverInputRef.current?.click()}
                            className="px-4 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm font-bold hover:bg-gray-200 transition"
                          >
                            Update Cover
                          </button>
                          <input
                            type="file"
                            ref={coverInputRef}
                            onChange={handleCoverUpload}
                            className="hidden"
                            accept="image/*"
                          />

                          {currentStory && (
                            <button
                              onClick={handleRerunAnalysis}
                              className="px-4 py-2 rounded-lg bg-kid-teal/10 text-kid-teal text-sm font-bold hover:bg-kid-teal/20 transition flex items-center gap-1"
                            >
                              <Sparkles className="w-4 h-4" /> Re-run Analysis
                            </button>
                          )}
                        </div>
                      )}

                      <div>
                        <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">Character Mapping</label>
                        {characterCatalog.length > 0 ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {characterCatalog.map((character) => (
                              <span
                                key={`${character.name}-${character.source}`}
                                className="px-3 py-1 rounded-full bg-kid-teal/10 text-kid-teal text-xs font-bold"
                              >
                                {character.name} ({character.source})
                              </span>
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-gray-500 mt-1">No characters mapped yet.</p>
                        )}
                      </div>
                    </div>
                  )}
                </section>
              )}
            </div>

            <div className={`space-y-6 transition-opacity duration-500 ${!hasAnalysis ? 'opacity-50 pointer-events-none' : 'opacity-100'}`}>
              <section className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 h-full flex flex-col">
                <h3 className="text-lg font-bold text-gray-700 mb-2 flex items-center gap-2">
                  <span className="bg-kid-pink text-white w-6 h-6 rounded-full flex items-center justify-center text-xs">3</span>
                  Style References
                </h3>
                <p className="text-gray-500 text-sm mb-6">
                  Page screenshots from across the book plus uploaded references used for option image generation.
                </p>

                <div className="grid grid-cols-3 gap-4 mb-4">
                  {styleReferences.map((style, idx) => (
                    <div key={idx} className="relative aspect-square rounded-xl overflow-hidden border border-gray-200 group">
                      <img src={`data:${style.mimeType};base64,${style.data}`} className="w-full h-full object-cover" />
                      {canEdit && (
                        <button
                          onClick={() => removeStyleImage(idx)}
                          className="absolute top-1 right-1 bg-red-500 text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  ))}

                  {canEdit && (
                    <button
                      onClick={() => styleInputRef.current?.click()}
                      className="aspect-square rounded-xl border-2 border-dashed border-gray-300 flex flex-col items-center justify-center text-gray-400 hover:border-kid-pink hover:text-kid-pink hover:bg-pink-50 transition"
                    >
                      <Upload className="w-6 h-6 mb-1" />
                      <span className="text-xs font-bold">Add Image</span>
                    </button>
                  )}

                  <input type="file" ref={styleInputRef} onChange={handleStyleUpload} className="hidden" accept="image/*" multiple />
                </div>

                <div className="mt-auto pt-6 border-t border-gray-100">
                  <button
                    onClick={handleFinish}
                    disabled={isProcessing || (!isReadOnlyView && !preparedPack)}
                    className="w-full py-4 bg-kid-blue text-white font-bold rounded-xl shadow-lg hover:bg-blue-600 transition flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <BookOpen className="w-5 h-5" />
                    {isReadOnlyView ? 'Start Story' : isExistingStory ? 'Save Updates' : 'Start Story'}
                    <ArrowRight className="w-5 h-5" />
                  </button>
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SetupPanel;
