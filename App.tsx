import React, { useCallback, useEffect, useState } from 'react';
import { BookOpen, Key, ArrowRight, RotateCcw, RefreshCw, AlertCircle, Library as LibraryIcon, Bug, X } from 'lucide-react';
import { AppMode, FileData, Option, Publisher, StoryAssets, StoryManifest, StoryMetadata, StoryPack, StyleReferenceAsset } from './types';
import { USE_BACKEND_PIPELINE } from './services/apiClient';
import RecordButton from './components/RecordButton';
import OptionCard from './components/OptionCard';
import SetupPanel, { ExistingSetupUpdatePayload } from './components/SetupPanel';
import ProcessingSteps from './components/ProcessingSteps';
import Library from './components/Library';
import { useLibrary } from './hooks/useLibrary';
import { useStorySetup } from './hooks/useStorySetup';
import { useTurnPipeline } from './hooks/useTurnPipeline';

interface SetupViewState {
  storyId?: string;
  createdAt?: number;
  readOnly: boolean;
  title?: string;
  publisherId?: string | null;
  publisherName?: string;
  storyFile?: FileData | null;
  styleImages?: FileData[];
  storyPack?: StoryPack | null;
}

const App: React.FC = () => {
  const [hasApiKey, setHasApiKey] = useState(USE_BACKEND_PIPELINE);
  const [currentMode, setCurrentMode] = useState<AppMode>(AppMode.LIBRARY);
  const [setupView, setSetupView] = useState<SetupViewState | null>(null);
  const [showAiDebug, setShowAiDebug] = useState(false);
  const [expandedDebugImage, setExpandedDebugImage] = useState<{ src: string; label?: string } | null>(null);
  const buildCommit = (__APP_COMMIT_SHA__ || 'local-dev').slice(0, 7);
  const buildLabel = `${__APP_REPO_SLUG__}@${buildCommit}`;

  const {
    stories,
    publishers,
    activeManifest,
    activeAssets,
    selectStory,
    saveNewStory,
    deleteStory,
    createPublisher,
    updatePublisherImage
  } = useLibrary();
  const { prepareStory } = useStorySetup();
  const {
    processingStage,
    currentQuestion,
    options,
    selectedOptionId,
    conversationHistory,
    lastAudioBlob,
    error,
    isBusy,
    processRecording,
    retry,
    selectOption,
    resetConversation
  } = useTurnPipeline(activeAssets);

  useEffect(() => {
    if (USE_BACKEND_PIPELINE) {
      return;
    }

    const initLegacyKey = async () => {
      const viteApiKey = import.meta.env.VITE_GEMINI_API_KEY;
      if (viteApiKey) {
        setHasApiKey(true);
        return;
      }

      if (window.aistudio) {
        const selected = await window.aistudio.hasSelectedApiKey();
        setHasApiKey(selected);
      }
    };

    initLegacyKey().catch((error) => {
      console.error('Failed to load key state', error);
    });
  }, []);

  const handleSelectKey = useCallback(async () => {
    if (window.aistudio) {
      await window.aistudio.openSelectKey();
      setHasApiKey(true);
    }
  }, []);

  const handleStorySelect = useCallback(async (story: StoryManifest) => {
    try {
      await selectStory(story);
      resetConversation();
      setSetupView(null);
      setCurrentMode(AppMode.STORY);
    } catch (error) {
      console.error('Failed to select story', error);
      alert('Failed to load story. Please try again.');
    }
  }, [resetConversation, selectStory]);

  const handleOpenStorySetup = useCallback(async (story: StoryManifest) => {
    try {
      const assets = await selectStory(story);
      const storyPublisher = publishers.find((publisher) => publisher.id === (story.publisherId || null));
      setSetupView({
        storyId: story.id,
        createdAt: story.createdAt,
        readOnly: true,
        title: story.title,
        publisherId: story.publisherId ?? null,
        publisherName: storyPublisher?.name,
        storyFile: assets.pdfData || null,
        styleImages: assets.stylePrimer,
        storyPack: {
          summary: assets.metadata.summary || story.summary,
          artStyle: assets.metadata.artStyle || story.artStyle,
          storyBrief: assets.storyBrief,
          storyText: assets.metadata.storyText || assets.storyBrief,
          qaReadyPackage: assets.metadata.qaReadyPackage,
          storyFacts: assets.metadata.storyFacts || {
            characters: [],
            characterCatalog: [],
            characterImageMap: [],
            objectImageMap: [],
            sceneCatalog: [],
            sceneImageMap: [],
            characterEvidenceMap: [],
            objectEvidenceMap: [],
            scenes: [],
            places: [],
            objects: [],
            events: [],
            setting: assets.storyBrief,
            worldTags: []
          },
          coverImage: story.coverImage || null,
          stylePrimer: assets.stylePrimer,
          styleReferences: assets.styleReferences || []
        }
      });
      setCurrentMode(AppMode.SETUP);
    } catch (error) {
      console.error('Failed to open setup view', error);
      alert('Failed to open setup view. Please try again.');
    }
  }, [publishers, selectStory]);

  const handleDeleteStory = useCallback(async (id: string) => {
    if (!confirm('Are you sure you want to delete this story?')) {
      return;
    }

    await deleteStory(id);
    if (activeManifest?.id === id) {
      resetConversation();
      setCurrentMode(AppMode.LIBRARY);
    }
  }, [activeManifest?.id, deleteStory, resetConversation]);

  const handleSetupComplete = useCallback(async (
    storyFile: FileData,
    styleImages: FileData[],
    storyPack: StoryPack,
    publisherId: string | null
  ) => {
    const id = crypto.randomUUID();
    const title = storyPack.summary.substring(0, 50) || 'Untitled Story';

    const metadata: StoryMetadata = {
      summary: storyPack.summary,
      artStyle: storyPack.artStyle,
      storyBrief: storyPack.storyBrief,
      storyText: storyPack.storyText || storyPack.storyBrief,
      qaReadyPackage: storyPack.qaReadyPackage,
      storyFacts: storyPack.storyFacts,
      characters: [],
      objects: []
    };

    const manifest: StoryManifest = {
      id,
      title,
      coverImage: storyPack.coverImage || undefined,
      createdAt: Date.now(),
      summary: storyPack.summary,
      artStyle: storyPack.artStyle,
      publisherId
    };

    const assets: StoryAssets = {
      id,
      storyBrief: storyPack.storyBrief,
      stylePrimer: storyPack.stylePrimer,
      styleReferences: storyPack.styleReferences || [],
      pdfData: storyFile,
      metadata
    };

    await saveNewStory(manifest, assets);
    resetConversation();
    setSetupView(null);
    setCurrentMode(AppMode.STORY);
  }, [resetConversation, saveNewStory]);

  const handleOptionClick = useCallback(async (option: (typeof options)[number]) => {
    await selectOption(option);
  }, [selectOption]);

  const getStyleRefByIndex = useCallback((index: number): StyleReferenceAsset | FileData | null => {
    if (!Number.isInteger(index) || index < 0) {
      return null;
    }

    const refs = activeAssets?.styleReferences || [];
    if (index < refs.length) {
      return refs[index];
    }

    const primer = activeAssets?.stylePrimer || [];
    if (index < primer.length) {
      return primer[index];
    }

    return null;
  }, [activeAssets]);

  const toDataUrl = useCallback((file: StyleReferenceAsset | FileData | null | undefined): string => {
    if (!file?.data || !file?.mimeType) {
      return '';
    }
    return `data:${file.mimeType};base64,${file.data}`;
  }, []);

  const hasTurnDebug = options.some((opt) => Boolean(opt.debug));

  const handleSaveExistingSetup = useCallback(async (payload: ExistingSetupUpdatePayload) => {
    const existingManifest = stories.find((story) => story.id === payload.storyId);
    const existingAssetsPdf = setupView?.storyId === payload.storyId
      ? setupView.storyFile
      : activeAssets?.id === payload.storyId
        ? activeAssets.pdfData || null
        : null;

    const metadata: StoryMetadata = {
      summary: payload.storyPack.summary,
      artStyle: payload.storyPack.artStyle,
      storyBrief: payload.storyPack.storyBrief,
      storyText: payload.storyPack.storyText || payload.storyPack.storyBrief,
      qaReadyPackage: payload.storyPack.qaReadyPackage,
      storyFacts: payload.storyPack.storyFacts,
      characters: [],
      objects: []
    };

    const manifest: StoryManifest = {
      id: payload.storyId,
      title: payload.storyPack.summary.substring(0, 50) || existingManifest?.title || 'Untitled Story',
      coverImage: payload.storyPack.coverImage || undefined,
      createdAt: existingManifest?.createdAt || payload.createdAt,
      summary: payload.storyPack.summary,
      artStyle: payload.storyPack.artStyle,
      publisherId: payload.publisherId
    };

    const assets: StoryAssets = {
      id: payload.storyId,
      storyBrief: payload.storyPack.storyBrief,
      stylePrimer: payload.storyPack.stylePrimer,
      styleReferences: payload.storyPack.styleReferences || [],
      pdfData: payload.storyFile || existingAssetsPdf || undefined,
      metadata
    };

    await saveNewStory(manifest, assets);
    setSetupView(null);
    setCurrentMode(AppMode.LIBRARY);
  }, [activeAssets, saveNewStory, setupView, stories]);

  const handleOpenNewRegularBookSetup = useCallback(() => {
    setSetupView({
      readOnly: false,
      publisherId: null
    });
    setCurrentMode(AppMode.SETUP);
  }, []);

  const handleOpenNewPublisherBookSetup = useCallback((publisher: Publisher) => {
    setSetupView({
      readOnly: false,
      publisherId: publisher.id,
      publisherName: publisher.name
    });
    setCurrentMode(AppMode.SETUP);
  }, []);

  const handleCreatePublisher = useCallback(async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }

    const exists = publishers.some((publisher) => publisher.name.toLowerCase() === trimmed.toLowerCase());
    if (exists) {
      throw new Error('Publisher already exists.');
    }

    await createPublisher(trimmed);
  }, [createPublisher, publishers]);

  const handleUpdatePublisherImage = useCallback(async (publisherId: string, coverImage: string) => {
    await updatePublisherImage(publisherId, coverImage);
  }, [updatePublisherImage]);

  if (!hasApiKey) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-kid-blue to-kid-orange flex items-center justify-center p-4">
        <div className="bg-white rounded-3xl p-8 max-w-md w-full shadow-2xl text-center space-y-6">
          <div className="w-20 h-20 bg-kid-teal/20 rounded-full flex items-center justify-center mx-auto text-kid-teal">
            <Key className="w-10 h-10" />
          </div>
          <h1 className="text-3xl font-bold text-gray-800">Welcome to StoryBuddy!</h1>
          <button onClick={handleSelectKey} className="w-full py-4 bg-kid-blue text-white font-bold rounded-xl shadow-lg hover:bg-blue-500 transition-all flex items-center justify-center gap-2 group">
            Connect API Key <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition" />
          </button>
          <p className="text-xs text-gray-400 font-mono">Build {buildLabel}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 font-sans text-gray-800 flex flex-col">
      <header className="px-6 py-4 flex justify-between items-center bg-white/80 backdrop-blur-md shadow-sm sticky top-0 z-10">
        <div className="flex items-center gap-3 cursor-pointer" onClick={() => setCurrentMode(AppMode.LIBRARY)}>
          <div className="bg-kid-orange p-2 rounded-xl text-white">
            <BookOpen className="w-6 h-6" />
          </div>
          <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-kid-blue to-kid-pink">StoryBuddy</h1>
        </div>
        <div className="flex gap-2">
          {currentMode === AppMode.LIBRARY && (
            <div className="px-3 py-2 bg-white rounded-full shadow-md text-[11px] text-gray-500 font-mono">
              Build {buildLabel}
            </div>
          )}
          {currentMode === AppMode.STORY && (
            <>
              {hasTurnDebug && (
                <button
                  onClick={() => setShowAiDebug((prev) => !prev)}
                  className={`px-4 py-2 rounded-full shadow-md transition font-bold flex items-center gap-2 ${
                    showAiDebug ? 'bg-red-50 text-red-600 border border-red-200' : 'bg-white text-gray-500'
                  }`}
                >
                  <Bug className="w-5 h-5" /> {showAiDebug ? 'Hide AI Debug' : 'AI Debug'}
                </button>
              )}
              {conversationHistory.length > 0 && (
                <button onClick={resetConversation} className="p-3 bg-white rounded-full shadow-md hover:shadow-lg transition text-gray-500 hover:text-red-500">
                  <RotateCcw className="w-6 h-6" />
                </button>
              )}
              <button onClick={() => setCurrentMode(AppMode.LIBRARY)} className="px-4 py-2 bg-white rounded-full shadow-md hover:shadow-lg transition text-gray-500 font-bold flex items-center gap-2">
                <LibraryIcon className="w-5 h-5" /> Library
              </button>
            </>
          )}
        </div>
      </header>

      <main className="flex-1 w-full flex flex-col items-center">
        {currentMode === AppMode.LIBRARY && (
          <Library
            stories={stories}
            publishers={publishers}
            onSelectStory={handleStorySelect}
            onOpenSetup={handleOpenStorySetup}
            onDeleteStory={handleDeleteStory}
            onAddNew={handleOpenNewRegularBookSetup}
            onAddBookToPublisher={handleOpenNewPublisherBookSetup}
            onCreatePublisher={handleCreatePublisher}
            onUpdatePublisherImage={handleUpdatePublisherImage}
          />
        )}

        {currentMode === AppMode.STORY && (
          <div className="w-full max-w-5xl mx-auto p-4 flex flex-col items-center flex-1">
            <div className="w-full mb-8 text-center min-h-[4rem] flex flex-col justify-center">
              {processingStage !== 'idle' && processingStage !== 'completed' && processingStage !== 'error' ? (
                <ProcessingSteps stage={processingStage} />
              ) : error ? (
                <div className="animate-fade-in-up flex flex-col items-center gap-3">
                  <div className="flex items-center gap-2 text-red-500 font-bold bg-red-50 px-4 py-2 rounded-full border border-red-100">
                    <AlertCircle className="w-5 h-5" />
                    {error}
                  </div>
                  {lastAudioBlob && (
                    <button onClick={retry} className="flex items-center gap-2 px-6 py-2 bg-white text-kid-blue font-bold rounded-xl shadow-md hover:bg-gray-50 transition border border-kid-blue/20">
                      <RefreshCw className="w-4 h-4" /> Try Again
                    </button>
                  )}
                </div>
              ) : currentQuestion ? (
                <div className="animate-fade-in-up">
                  <span className="text-sm text-gray-400 font-bold uppercase tracking-wider block mb-1">Parent Asked</span>
                  <h2 className="text-2xl md:text-3xl font-bold text-gray-800">"{currentQuestion}"</h2>
                </div>
              ) : (
                <div className="text-gray-400">
                  <h2 className="text-xl font-medium">Ready for story time!</h2>
                  <p className="text-sm">
                    Tap the mic to ask a question about "{activeManifest?.summary.substring(0, 30) || 'your story'}..."
                  </p>
                </div>
              )}
            </div>

            <div className="w-full grid grid-cols-1 sm:grid-cols-3 gap-6 mb-12 flex-1 items-start">
              {options.length > 0 ? (
                options.map((opt) => (
                  <OptionCard
                    key={opt.id}
                    option={opt}
                    selected={selectedOptionId === opt.id}
                    onClick={handleOptionClick}
                  />
                ))
              ) : (
                !isBusy && !error && Array(3).fill(0).map((_, i) => (
                  <div key={i} className="aspect-[3/4] rounded-3xl border-4 border-dashed border-gray-200 flex flex-col items-center justify-center opacity-50">
                    <div className="w-16 h-16 rounded-full bg-gray-100 mb-4" />
                    <div className="h-4 w-2/3 bg-gray-100 rounded mb-2" />
                    <div className="h-4 w-1/2 bg-gray-100 rounded" />
                  </div>
                ))
              )}
            </div>

            {showAiDebug && hasTurnDebug && (
              <div className="w-full mb-6 rounded-2xl border border-red-200 bg-white/95 p-4 shadow-sm">
                <div className="flex items-center gap-2 mb-3 text-red-700">
                  <Bug className="w-4 h-4" />
                  <h3 className="text-sm font-bold uppercase tracking-wider">AI Request Debug</h3>
                </div>
                <div className="space-y-4">
                  {options.map((option: Option) => {
                    const debug = option.debug;
                    if (!debug) return null;
                    const selectedRefMeta = debug.selectedStyleRefs || [];
                    const selectedRefMetaByIndex = new Map(
                      selectedRefMeta
                        .filter((entry) => Number.isInteger(entry.index) && entry.index >= 0)
                        .map((entry) => [entry.index, entry] as const)
                    );

                    const selectedRefs = (debug.selectedStyleRefIndexes || [])
                      .map((idx) => {
                        const ref = getStyleRefByIndex(idx);
                        return ref ? { idx, ref } : null;
                      })
                      .filter((entry): entry is { idx: number; ref: StyleReferenceAsset | FileData } => Boolean(entry));

                    return (
                      <div key={`debug-${option.id}`} className="rounded-xl border border-gray-200 p-3 bg-gray-50/60">
                        <div className="flex flex-wrap items-center gap-2 mb-2">
                          <span className="px-2 py-1 rounded-full bg-white border border-gray-200 text-xs font-semibold">
                            {option.text}
                          </span>
                          {debug.imageModel && (
                            <span className="px-2 py-1 rounded-full bg-indigo-50 text-indigo-700 text-xs font-semibold">
                              model: {debug.imageModel}
                            </span>
                          )}
                          <span className="px-2 py-1 rounded-full bg-slate-100 text-slate-700 text-xs font-semibold">
                            refs: {(debug.selectedStyleRefIndexes || []).length}
                          </span>
                          {debug.imageGenerationError && (
                            <span className="px-2 py-1 rounded-full bg-red-50 text-red-600 text-xs font-semibold">
                              error: {debug.imageGenerationError}
                            </span>
                          )}
                        </div>

                        <div className="text-[11px] text-gray-600 font-mono mb-2 break-words">
                          scenes: {(debug.selectedParticipants?.scenes || []).join(', ') || 'none'} | chars: {(debug.selectedParticipants?.characters || []).join(', ') || 'none'} | objects: {(debug.selectedParticipants?.objects || []).join(', ') || 'none'}
                        </div>

                        {debug.answerAgentPrompt && (
                          <details className="mb-2">
                            <summary className="text-[11px] font-semibold text-gray-700 cursor-pointer select-none">
                              Answer agent prompt
                            </summary>
                            <pre className="mt-1 text-[11px] leading-relaxed bg-white border border-gray-200 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap text-gray-700">
                              {debug.answerAgentPrompt}
                            </pre>
                          </details>
                        )}

                        {debug.answerAgentRaw && (
                          <details className="mb-2">
                            <summary className="text-[11px] font-semibold text-gray-700 cursor-pointer select-none">
                              Answer agent raw output
                            </summary>
                            <pre className="mt-1 text-[11px] leading-relaxed bg-white border border-gray-200 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap text-gray-700">
                              {debug.answerAgentRaw}
                            </pre>
                          </details>
                        )}

                        {debug.illustrationAgentPrompt && (
                          <details className="mb-2">
                            <summary className="text-[11px] font-semibold text-gray-700 cursor-pointer select-none">
                              Illustration agent prompt
                            </summary>
                            <pre className="mt-1 text-[11px] leading-relaxed bg-white border border-gray-200 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap text-gray-700">
                              {debug.illustrationAgentPrompt}
                            </pre>
                          </details>
                        )}

                        {debug.illustrationPlan && (
                          <details className="mb-2">
                            <summary className="text-[11px] font-semibold text-gray-700 cursor-pointer select-none">
                              Illustration plan
                            </summary>
                            <pre className="mt-1 text-[11px] leading-relaxed bg-white border border-gray-200 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap text-gray-700">
                              {debug.illustrationPlan}
                            </pre>
                          </details>
                        )}

                        {selectedRefs.length > 0 && (
                          <div className="flex flex-wrap gap-2 mb-3">
                            {selectedRefs.map(({ idx, ref }) => {
                              const src = toDataUrl(ref);
                              const meta = selectedRefMetaByIndex.get(idx);
                              return (
                                <button
                                  key={`${option.id}-ref-${idx}`}
                                  onClick={() => setExpandedDebugImage({ src, label: `Ref #${idx} for "${option.text}"` })}
                                  className="relative w-14 h-14 rounded-md overflow-hidden border border-gray-200 bg-white"
                                >
                                  <img src={src} className="w-full h-full object-cover" />
                                  <span className="absolute bottom-0 left-0 right-0 bg-black/55 text-white text-[10px] text-center">
                                    #{idx}
                                  </span>
                                  {meta?.kind && (
                                    <span className="absolute top-0 left-0 right-0 bg-black/55 text-white text-[9px] text-center uppercase">
                                      {meta.kind}
                                    </span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        )}

                        {selectedRefMeta.length > 0 && (
                          <div className="text-[11px] text-gray-600 font-mono mb-3 space-y-1">
                            {selectedRefMeta.map((entry, index) => (
                              <div key={`${option.id}-meta-${index}`} className="break-words">
                                ref#{entry.index >= 0 ? entry.index : '?'} {entry.kind}/{entry.source}
                                {entry.sceneId ? ` scene=${entry.sceneId}` : ''}
                                {entry.characterName ? ` char=${entry.characterName}` : ''}
                                {entry.objectName ? ` obj=${entry.objectName}` : ''}
                                {typeof entry.cropCoverage === 'number' ? ` crop=${Math.round(entry.cropCoverage * 100)}%` : ''}
                                {typeof entry.confidence === 'number' ? ` conf=${Math.round(entry.confidence * 100)}%` : ''}
                              </div>
                            ))}
                          </div>
                        )}

                        {debug.imagePrompt && (
                          <pre className="text-[11px] leading-relaxed bg-white border border-gray-200 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap text-gray-700">
                            {debug.imagePrompt}
                          </pre>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="sticky bottom-8 z-20">
              <RecordButton onRecordingComplete={processRecording} isProcessing={isBusy} />
            </div>
          </div>
        )}
      </main>

      {currentMode === AppMode.SETUP && (
        <SetupPanel
          publishers={publishers}
          onPrepareStory={prepareStory}
          onComplete={handleSetupComplete}
          onSaveExisting={handleSaveExistingSetup}
          onUpdatePublisherImage={handleUpdatePublisherImage}
          onStartFromSetup={() => {
            resetConversation();
            setSetupView(null);
            setCurrentMode(AppMode.STORY);
          }}
          initialView={setupView}
          onClose={() => {
            setSetupView(null);
            setCurrentMode(AppMode.LIBRARY);
          }}
        />
      )}

      {expandedDebugImage && (
        <div
          className="fixed inset-0 z-[80] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
          onClick={() => setExpandedDebugImage(null)}
        >
          <div
            className="relative bg-white rounded-2xl p-3 max-w-4xl w-full max-h-[88vh] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              onClick={() => setExpandedDebugImage(null)}
              className="absolute top-3 right-3 z-10 p-2 rounded-full bg-black/70 text-white hover:bg-black"
            >
              <X className="w-4 h-4" />
            </button>
            <img
              src={expandedDebugImage.src}
              alt={expandedDebugImage.label || 'Reference preview'}
              className="w-full max-h-[78vh] object-contain rounded-lg bg-gray-50"
            />
            {expandedDebugImage.label && (
              <p className="mt-2 text-xs font-semibold text-gray-600 text-center">
                {expandedDebugImage.label}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
