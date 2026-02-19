import React, { useCallback, useEffect, useState } from 'react';
import { BookOpen, Key, ArrowRight, RotateCcw, RefreshCw, AlertCircle, Library as LibraryIcon } from 'lucide-react';
import { AppMode, FileData, Publisher, StoryAssets, StoryManifest, StoryMetadata, StoryPack } from './types';
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
    </div>
  );
};

export default App;
