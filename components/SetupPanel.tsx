import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Upload, BookOpen, X, AlertCircle, CheckCircle, ArrowRight, Loader2, Sparkles, FolderOpen } from 'lucide-react';
import { FileData, Publisher, SetupStoryResponse, StoryPack, StyleReferenceAsset } from '../types';
import { USE_BACKEND_PIPELINE } from '../services/apiClient';
import { extractStyleReferenceAssetsFromPdf } from '../services/pdfService';

interface SetupInitialView {
  storyId?: string;
  createdAt?: number;
  readOnly?: boolean;
  title?: string;
  publisherId?: string | null;
  publisherName?: string;
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
  publisherId: string | null;
}

interface SetupPanelProps {
  publishers: Publisher[];
  onPrepareStory: (storyFile: FileData, styleImages: FileData[]) => Promise<SetupStoryResponse>;
  onComplete: (storyFile: FileData, styleImages: FileData[], storyPack: StoryPack, publisherId: string | null) => void;
  onSaveExisting?: (payload: ExistingSetupUpdatePayload) => Promise<void> | void;
  onUpdatePublisherImage?: (publisherId: string, coverImage: string) => Promise<void> | void;
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

const STYLE_REF_SCENE_QUOTA = 6;
const STYLE_REF_CHARACTER_QUOTA = 4;
const STYLE_REF_OBJECT_QUOTA = 4;
const STYLE_REF_TOTAL = 14;

const toFingerprint = (item: FileData): string => {
  const middleStart = Math.max(0, Math.floor(item.data.length / 2) - 32);
  return `${item.mimeType}:${item.data.length}:${item.data.slice(0, 64)}:${item.data.slice(middleStart, middleStart + 64)}:${item.data.slice(-64)}`;
};

const toStyleReferenceAsset = (
  item: Partial<StyleReferenceAsset> & FileData,
  fallback: Partial<StyleReferenceAsset> = {}
): StyleReferenceAsset => ({
  mimeType: item.mimeType,
  data: item.data,
  kind: item.kind || fallback.kind || 'scene',
  source: item.source || fallback.source || 'upload',
  characterName: item.characterName || fallback.characterName,
  objectName: item.objectName || fallback.objectName,
  sceneId: item.sceneId || fallback.sceneId,
  assetRole: item.assetRole || fallback.assetRole,
  pageIndex: item.pageIndex ?? fallback.pageIndex,
  confidence: item.confidence ?? fallback.confidence ?? 0.5,
  qualityScore: item.qualityScore ?? fallback.qualityScore,
  embeddingHash: item.embeddingHash || fallback.embeddingHash,
  detectedCharacters: item.detectedCharacters || fallback.detectedCharacters || [],
  detectedObjects: item.detectedObjects || fallback.detectedObjects || []
});

const stripStyleReferenceAsset = (item: StyleReferenceAsset): FileData => ({
  mimeType: item.mimeType,
  data: item.data
});

const mergeStyleReferenceAssets = (
  preferred: StyleReferenceAsset[],
  fallback: StyleReferenceAsset[]
): StyleReferenceAsset[] => {
  const merged: StyleReferenceAsset[] = [];
  const seen = new Set<string>();

  for (const item of [...preferred, ...fallback]) {
    if (!item?.data || !item?.mimeType) continue;
    const key = toFingerprint(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }

  return merged.slice(0, 120);
};

const buildBalancedSetupPayload = (styleRefs: StyleReferenceAsset[]): StyleReferenceAsset[] => {
  const refs = mergeStyleReferenceAssets(styleRefs, []);
  const ranked = [...refs].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const selected: StyleReferenceAsset[] = [];
  const used = new Set<string>();

  const pick = (kind: StyleReferenceAsset['kind'], limit: number) => {
    for (const ref of ranked) {
      if (selected.length >= STYLE_REF_TOTAL) return;
      if (ref.kind !== kind) continue;
      const key = toFingerprint(ref);
      if (used.has(key)) continue;
      const countForKind = selected.filter((item) => item.kind === kind).length;
      if (countForKind >= limit) continue;
      selected.push(ref);
      used.add(key);
    }
  };

  pick('scene', STYLE_REF_SCENE_QUOTA);
  pick('character', STYLE_REF_CHARACTER_QUOTA);
  pick('object', STYLE_REF_OBJECT_QUOTA);

  for (const ref of ranked) {
    if (selected.length >= STYLE_REF_TOTAL) break;
    const key = toFingerprint(ref);
    if (used.has(key)) continue;
    selected.push(ref);
    used.add(key);
  }

  return selected.slice(0, STYLE_REF_TOTAL);
};

const getStyleRefCounts = (refs: StyleReferenceAsset[]) => ({
  scene: refs.filter((ref) => ref.kind === 'scene').length,
  character: refs.filter((ref) => ref.kind === 'character').length,
  object: refs.filter((ref) => ref.kind === 'object').length
});

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
  publishers,
  onPrepareStory,
  onComplete,
  onSaveExisting,
  onUpdatePublisherImage,
  onStartFromSetup,
  initialView,
  onClose
}) => {
  const storyInputRef = useRef<HTMLInputElement>(null);
  const styleInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const publisherImageInputRef = useRef<HTMLInputElement>(null);

  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [currentStory, setCurrentStory] = useState<FileData | null>(null);
  const [styleReferences, setStyleReferences] = useState<StyleReferenceAsset[]>([]);
  const [preparedPack, setPreparedPack] = useState<StoryPack | null>(null);
  const [isReadOnlyView, setIsReadOnlyView] = useState(false);
  const [selectedPublisherId, setSelectedPublisherId] = useState<string | null>(null);
  const [warningsAcknowledged, setWarningsAcknowledged] = useState(false);

  const isExistingStory = Boolean(initialView?.storyId);
  const canEdit = !isReadOnlyView;
  const maxPdfSizeBytes = USE_BACKEND_PIPELINE ? 3 * 1024 * 1024 : 50 * 1024 * 1024;

  useEffect(() => {
    if (!initialView) {
      setCurrentStory(null);
      setStyleReferences([]);
      setPreparedPack(null);
      setIsReadOnlyView(false);
      setSelectedPublisherId(null);
      setWarningsAcknowledged(false);
      setErrorMsg(null);
      setIsProcessing(false);
      return;
    }

    setCurrentStory(initialView.storyFile || null);
    const initialRefs = initialView.storyPack?.styleReferences?.length
      ? initialView.storyPack.styleReferences
      : (initialView.styleImages || []).map((item) => toStyleReferenceAsset(item, { kind: 'scene', source: 'upload' }));
    setStyleReferences(initialRefs);
    setPreparedPack(initialView.storyPack || null);
    setIsReadOnlyView(Boolean(initialView.readOnly));
    setSelectedPublisherId(initialView.publisherId || null);
    setWarningsAcknowledged(false);
    setErrorMsg(null);
    setIsProcessing(false);
  }, [initialView]);

  const runSetupFromCurrentStory = async (sourceStory?: FileData | null, sourceStyles?: StyleReferenceAsset[]) => {
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
        const extracted = await extractStyleReferenceAssetsFromPdf(storySource.data, 80);
        effectiveStyles = extracted.filter((item) => item.data.length > 0);
      }

      if (effectiveStyles.length > 0) {
        setStyleReferences(mergeStyleReferenceAssets(effectiveStyles, []));
      }

      const setupPayload = buildBalancedSetupPayload(effectiveStyles).map(stripStyleReferenceAsset);
      const setupResponse = await onPrepareStory(storySource, setupPayload);
      setPreparedPack((prev) => ({
        ...setupResponse.storyPack,
        coverImage: prev?.coverImage || setupResponse.storyPack.coverImage
      }));
      setWarningsAcknowledged(false);

      if (setupResponse.storyPack.styleReferences?.length) {
        setStyleReferences(setupResponse.storyPack.styleReferences);
      } else if (effectiveStyles.length === 0 && setupResponse.storyPack.stylePrimer.length > 0) {
        setStyleReferences(
          setupResponse.storyPack.stylePrimer.map((item) =>
            toStyleReferenceAsset(item, { kind: 'scene', source: 'generated' })
          )
        );
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
      const screenshotReferences = await extractStyleReferenceAssetsFromPdf(storyFile.data, 80);
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

    const newStyles: StyleReferenceAsset[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.type.startsWith('image/')) {
        continue;
      }
      const compressed = await compressImageFile(file);
      newStyles.push(toStyleReferenceAsset(compressed, { kind: 'scene', source: 'upload', confidence: 0.7 }));
    }

    setStyleReferences((prev) => mergeStyleReferenceAssets([...prev, ...newStyles], []));
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

  const handlePublisherImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!canEdit || !selectedPublisherId) {
      return;
    }

    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith('image/')) {
      return;
    }

    try {
      const dataUrl = await fileToDataUrl(file);
      await onUpdatePublisherImage?.(selectedPublisherId, dataUrl);
    } catch (error: any) {
      console.error(error);
      setErrorMsg(error?.message || 'Failed to update publisher image');
    } finally {
      if (publisherImageInputRef.current) {
        publisherImageInputRef.current.value = '';
      }
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

      const screenshotReferences = await extractStyleReferenceAssetsFromPdf(currentStory.data, 80);
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

      if (hasMappingWarnings && !warningsAcknowledged) {
        setErrorMsg('Please review and acknowledge mapping warnings before saving.');
        return;
      }

      const preparedRefs = preparedPack.styleReferences?.length
        ? preparedPack.styleReferences
        : preparedPack.stylePrimer.map((item) =>
            toStyleReferenceAsset(item, { kind: 'scene', source: 'generated' })
          );
      const finalStyleRefs = buildBalancedSetupPayload(
        mergeStyleReferenceAssets(styleReferences, preparedRefs)
      );
      const finalPrimer = mergePrimerSources(
        finalStyleRefs.map(stripStyleReferenceAsset),
        preparedPack.stylePrimer
      ).slice(0, STYLE_REF_TOTAL);
      const finalPack: StoryPack = {
        ...preparedPack,
        stylePrimer: finalPrimer,
        styleReferences: finalStyleRefs
      };

      if (isExistingStory && initialView?.storyId) {
        await onSaveExisting?.({
          storyId: initialView.storyId,
          createdAt: initialView.createdAt || Date.now(),
          storyFile: currentStory,
          styleImages: finalPrimer,
          storyPack: finalPack,
          publisherId: selectedPublisherId
        });
        onClose();
        return;
      }

      if (!currentStory) {
        setErrorMsg('Please upload a story PDF first.');
        return;
      }

      await Promise.resolve(onComplete(currentStory, finalPrimer, finalPack, selectedPublisherId));
      onClose();
    } catch (error: any) {
      console.error(error);
      setErrorMsg(error?.message || 'Failed to save setup changes');
    }
  };

  const summary = preparedPack?.summary || '';
  const generatedCover = preparedPack?.coverImage || null;
  const characterCatalog = preparedPack?.storyFacts?.characterCatalog || [];
  const objectCatalog = preparedPack?.storyFacts?.objects || [];
  const sceneCatalog = preparedPack?.storyFacts?.sceneCatalog || [];
  const preparedStyleRefs = preparedPack?.styleReferences?.length
    ? preparedPack.styleReferences
    : (preparedPack?.stylePrimer || []).map((item) =>
        toStyleReferenceAsset(item, { kind: 'scene', source: 'generated' })
      );
  const mappingWarnings = useMemo(() => {
    if (!preparedPack) {
      return {
        unmappedCharacters: [] as string[],
        unmappedObjects: [] as string[],
        unmappedScenes: [] as string[],
        lowConfidenceRefs: [] as Array<{ index: number; ref: StyleReferenceAsset }>
      };
    }

    const facts = preparedPack.storyFacts;
    const characterMap = new Map(
      (facts.characterImageMap || []).map((entry) => [entry.characterName.toLowerCase(), entry.styleRefIndexes])
    );
    const objectMap = new Map(
      (facts.objectImageMap || []).map((entry) => [entry.objectName.toLowerCase(), entry.styleRefIndexes])
    );
    const sceneMap = new Map(
      (facts.sceneImageMap || []).map((entry) => [entry.sceneId.toLowerCase(), entry.styleRefIndexes])
    );

    const unmappedCharacters = (facts.characterCatalog || [])
      .map((entry) => entry.name)
      .filter((name) => (characterMap.get(name.toLowerCase()) || []).length === 0);
    const unmappedObjects = (facts.objects || [])
      .filter((name) => (objectMap.get(name.toLowerCase()) || []).length === 0);
    const unmappedScenes = (facts.sceneCatalog || [])
      .filter((scene) => (sceneMap.get(scene.id.toLowerCase()) || []).length === 0)
      .map((scene) => scene.title);
    const lowConfidenceRefs = preparedStyleRefs
      .map((ref, index) => ({ index, ref }))
      .filter(({ ref }) => {
        const confidence = ref.qualityScore ?? ref.confidence ?? 0;
        return confidence > 0 && confidence < 0.7;
      })
      .slice(0, 8);

    return {
      unmappedCharacters,
      unmappedObjects,
      unmappedScenes,
      lowConfidenceRefs
    };
  }, [preparedPack, preparedStyleRefs]);
  const hasMappingWarnings =
    mappingWarnings.unmappedCharacters.length > 0 ||
    mappingWarnings.unmappedObjects.length > 0 ||
    mappingWarnings.unmappedScenes.length > 0 ||
    mappingWarnings.lowConfidenceRefs.length > 0;

  useEffect(() => {
    setWarningsAcknowledged(false);
  }, [hasMappingWarnings, preparedPack?.summary, preparedStyleRefs.length]);

  const setupPreviewRefs = buildBalancedSetupPayload(styleReferences);
  const styleCounts = getStyleRefCounts(setupPreviewRefs);
  const selectedPublisher = publishers.find((publisher) => publisher.id === selectedPublisherId) || null;
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
            {(selectedPublisher?.name || initialView?.publisherName) && (
              <p className="text-xs text-kid-orange font-semibold mt-1">
                Publisher: {selectedPublisher?.name || initialView?.publisherName}
              </p>
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
                        <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">Book Publisher</label>
                        {canEdit ? (
                          <select
                            value={selectedPublisherId || ''}
                            onChange={(event) => setSelectedPublisherId(event.target.value || null)}
                            className="mt-2 w-full px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 bg-white"
                          >
                            <option value="">Regular Book (No Publisher)</option>
                            {publishers.map((publisher) => (
                              <option key={publisher.id} value={publisher.id}>
                                {publisher.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <p className="text-sm text-gray-600 mt-1">{selectedPublisher?.name || 'Regular Book'}</p>
                        )}
                      </div>

                      {selectedPublisher && (
                        <div>
                          <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                            Publisher Image
                          </label>
                          <div className="mt-2 flex items-center gap-3">
                            <div className="w-14 h-14 rounded-lg overflow-hidden border border-gray-200 bg-gray-50 flex items-center justify-center text-gray-300">
                              {selectedPublisher.coverImage ? (
                                <img src={selectedPublisher.coverImage} className="w-full h-full object-cover" />
                              ) : (
                                <FolderOpen className="w-6 h-6" />
                              )}
                            </div>
                            {canEdit && (
                              <>
                                <button
                                  onClick={() => publisherImageInputRef.current?.click()}
                                  className="px-3 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm font-bold hover:bg-gray-200 transition"
                                >
                                  Update Publisher Image
                                </button>
                                <input
                                  type="file"
                                  ref={publisherImageInputRef}
                                  onChange={handlePublisherImageUpload}
                                  className="hidden"
                                  accept="image/*"
                                />
                              </>
                            )}
                          </div>
                        </div>
                      )}

                      <div>
                        <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">Character Mapping</label>
                        {characterCatalog.length > 0 ? (
                          <div className="mt-2 space-y-2">
                            {characterCatalog.map((character) => {
                              const mapEntry = (preparedPack?.storyFacts?.characterImageMap || []).find(
                                (entry) => entry.characterName.toLowerCase() === character.name.toLowerCase()
                              );
                              const mappedIndexes = mapEntry?.styleRefIndexes || [];
                              const mappedRefs = mappedIndexes
                                .map((index) => preparedStyleRefs[index] || null)
                                .filter((entry): entry is StyleReferenceAsset => Boolean(entry));

                              return (
                                <div key={`${character.name}-${character.source}`} className="rounded-lg border border-gray-100 p-2">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="px-3 py-1 rounded-full bg-kid-teal/10 text-kid-teal text-xs font-bold">
                                      {character.name} ({character.source})
                                    </span>
                                    <span className="text-[11px] text-gray-500 font-semibold">
                                      {mappedIndexes.length} mapped refs
                                    </span>
                                  </div>
                                  {mappedRefs.length > 0 && (
                                    <div className="mt-2 flex gap-2">
                                      {mappedRefs.slice(0, 3).map((ref, index) => (
                                        <img
                                          key={`${character.name}-ref-${index}`}
                                          src={`data:${ref.mimeType};base64,${ref.data}`}
                                          className="w-10 h-10 rounded-md object-cover border border-gray-200"
                                        />
                                      ))}
                                    </div>
                                  )}
                                  {mappedRefs.length === 0 && (
                                    <p className="mt-2 text-[11px] text-amber-600 font-semibold">
                                      No standalone crop found
                                    </p>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="text-sm text-gray-500 mt-1">No characters mapped yet.</p>
                        )}
                      </div>

                      <div>
                        <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">Object Mapping</label>
                        {objectCatalog.length > 0 ? (
                          <div className="mt-2 space-y-2">
                            {objectCatalog.map((objectName) => {
                              const mapEntry = (preparedPack?.storyFacts?.objectImageMap || []).find(
                                (entry) => entry.objectName.toLowerCase() === objectName.toLowerCase()
                              );
                              const mappedIndexes = mapEntry?.styleRefIndexes || [];
                              const mappedRefs = mappedIndexes
                                .map((index) => preparedStyleRefs[index] || null)
                                .filter((entry): entry is StyleReferenceAsset => Boolean(entry));

                              return (
                                <div key={objectName} className="rounded-lg border border-gray-100 p-2">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="px-3 py-1 rounded-full bg-amber-50 text-amber-700 text-xs font-bold">
                                      {objectName}
                                    </span>
                                    <span className="text-[11px] text-gray-500 font-semibold">
                                      {mappedIndexes.length} mapped refs
                                    </span>
                                  </div>
                                  {mappedRefs.length > 0 && (
                                    <div className="mt-2 flex gap-2">
                                      {mappedRefs.slice(0, 3).map((ref, index) => (
                                        <img
                                          key={`${objectName}-ref-${index}`}
                                          src={`data:${ref.mimeType};base64,${ref.data}`}
                                          className="w-10 h-10 rounded-md object-cover border border-gray-200"
                                        />
                                      ))}
                                    </div>
                                  )}
                                  {mappedRefs.length === 0 && (
                                    <p className="mt-2 text-[11px] text-amber-600 font-semibold">
                                      No object screenshot mapped
                                    </p>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="text-sm text-gray-500 mt-1">No objects mapped yet.</p>
                        )}
                      </div>

                      <div>
                        <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">Scene Mapping</label>
                        {sceneCatalog.length > 0 ? (
                          <div className="mt-2 space-y-2">
                            {sceneCatalog.map((scene) => {
                              const mapEntry = (preparedPack?.storyFacts?.sceneImageMap || []).find(
                                (entry) => entry.sceneId.toLowerCase() === scene.id.toLowerCase()
                              );
                              const mappedIndexes = mapEntry?.styleRefIndexes || [];
                              const mappedRefs = mappedIndexes
                                .map((index) => preparedStyleRefs[index] || null)
                                .filter((entry): entry is StyleReferenceAsset => Boolean(entry));

                              return (
                                <div key={scene.id} className="rounded-lg border border-gray-100 p-2">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="px-3 py-1 rounded-full bg-sky-50 text-sky-700 text-xs font-bold">
                                      {scene.title}
                                    </span>
                                    <span className="text-[11px] text-gray-500 font-semibold">
                                      {mappedIndexes.length} mapped refs
                                    </span>
                                  </div>
                                  {mappedRefs.length > 0 && (
                                    <div className="mt-2 flex gap-2">
                                      {mappedRefs.slice(0, 3).map((ref, index) => (
                                        <img
                                          key={`${scene.id}-ref-${index}`}
                                          src={`data:${ref.mimeType};base64,${ref.data}`}
                                          className="w-10 h-10 rounded-md object-cover border border-gray-200"
                                        />
                                      ))}
                                    </div>
                                  )}
                                  {mappedRefs.length === 0 && (
                                    <p className="mt-2 text-[11px] text-amber-600 font-semibold">
                                      No scene screenshot mapped
                                    </p>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="text-sm text-gray-500 mt-1">No scenes mapped yet.</p>
                        )}
                      </div>

                      {hasMappingWarnings && (
                        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-3">
                          <div className="flex items-center gap-2 text-amber-900">
                            <AlertCircle className="w-4 h-4" />
                            <p className="text-sm font-bold">Review Warnings</p>
                          </div>

                          {mappingWarnings.unmappedCharacters.length > 0 && (
                            <div>
                              <p className="text-xs font-bold uppercase text-amber-700">Unmapped Characters</p>
                              <div className="mt-1 flex flex-wrap gap-2">
                                {mappingWarnings.unmappedCharacters.map((name) => (
                                  <span key={name} className="px-2 py-1 rounded-full bg-white text-amber-700 text-xs font-semibold border border-amber-200">
                                    {name}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          {mappingWarnings.unmappedObjects.length > 0 && (
                            <div>
                              <p className="text-xs font-bold uppercase text-amber-700">Unmapped Objects</p>
                              <div className="mt-1 flex flex-wrap gap-2">
                                {mappingWarnings.unmappedObjects.map((name) => (
                                  <span key={name} className="px-2 py-1 rounded-full bg-white text-amber-700 text-xs font-semibold border border-amber-200">
                                    {name}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          {mappingWarnings.unmappedScenes.length > 0 && (
                            <div>
                              <p className="text-xs font-bold uppercase text-amber-700">Unmapped Scenes</p>
                              <div className="mt-1 flex flex-wrap gap-2">
                                {mappingWarnings.unmappedScenes.map((name) => (
                                  <span key={name} className="px-2 py-1 rounded-full bg-white text-amber-700 text-xs font-semibold border border-amber-200">
                                    {name}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          {mappingWarnings.lowConfidenceRefs.length > 0 && (
                            <div>
                              <p className="text-xs font-bold uppercase text-amber-700">Low-Confidence References</p>
                              <div className="mt-2 flex flex-wrap gap-2">
                                {mappingWarnings.lowConfidenceRefs.map(({ index, ref }) => (
                                  <div key={`warning-ref-${index}`} className="relative w-12 h-12 rounded-md overflow-hidden border border-amber-200 bg-white">
                                    <img src={`data:${ref.mimeType};base64,${ref.data}`} className="w-full h-full object-cover" />
                                    <span className="absolute bottom-0 left-0 right-0 bg-black/55 text-white text-[9px] text-center">
                                      {Math.round((ref.qualityScore ?? ref.confidence ?? 0) * 100)}%
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {canEdit && (
                            <label className="flex items-center gap-2 text-xs text-amber-900 font-semibold">
                              <input
                                type="checkbox"
                                checked={warningsAcknowledged}
                                onChange={(event) => setWarningsAcknowledged(event.target.checked)}
                              />
                              I reviewed these warnings and want to save anyway.
                            </label>
                          )}
                        </div>
                      )}
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
                  Mixed references used for generation. Setup sends up to 14 refs (6 scene, 4 character, 4 object).
                </p>
                <div className="flex flex-wrap gap-2 mb-4">
                  <span className="px-2 py-1 rounded-full bg-gray-100 text-gray-700 text-xs font-bold">
                    Setup Pack {setupPreviewRefs.length}/{STYLE_REF_TOTAL}
                  </span>
                  <span className="px-2 py-1 rounded-full bg-sky-50 text-sky-700 text-xs font-bold">
                    Scene {styleCounts.scene}
                  </span>
                  <span className="px-2 py-1 rounded-full bg-emerald-50 text-emerald-700 text-xs font-bold">
                    Character {styleCounts.character}
                  </span>
                  <span className="px-2 py-1 rounded-full bg-amber-50 text-amber-700 text-xs font-bold">
                    Object {styleCounts.object}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-4 mb-4">
                  {styleReferences.map((style, idx) => (
                    <div key={idx} className="relative aspect-square rounded-xl overflow-hidden border border-gray-200 group">
                      <img src={`data:${style.mimeType};base64,${style.data}`} className="w-full h-full object-cover" />
                      <span className="absolute left-1 top-1 px-1.5 py-0.5 rounded bg-black/60 text-white text-[10px] font-semibold uppercase">
                        {style.kind}
                      </span>
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
                    disabled={isProcessing || (!isReadOnlyView && !preparedPack) || (!isReadOnlyView && hasMappingWarnings && !warningsAcknowledged)}
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
