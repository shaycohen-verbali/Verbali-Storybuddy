import React, { useRef, useState } from 'react';
import { Upload, BookOpen, X, AlertCircle, CheckCircle, ArrowRight, Loader2 } from 'lucide-react';
import { FileData, SetupStoryResponse, StoryPack } from '../types';

interface SetupPanelProps {
  onPrepareStory: (storyFile: FileData, styleImages: FileData[]) => Promise<SetupStoryResponse>;
  onComplete: (storyFile: FileData, styleImages: FileData[], storyPack: StoryPack) => void;
  onClose: () => void;
}

const SetupPanel: React.FC<SetupPanelProps> = ({ onPrepareStory, onComplete, onClose }) => {
  const storyInputRef = useRef<HTMLInputElement>(null);
  const styleInputRef = useRef<HTMLInputElement>(null);

  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [currentStory, setCurrentStory] = useState<FileData | null>(null);
  const [styleReferences, setStyleReferences] = useState<FileData[]>([]);
  const [preparedPack, setPreparedPack] = useState<StoryPack | null>(null);

  const handleStoryUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      return;
    }

    setErrorMsg(null);
    setIsProcessing(true);
    setPreparedPack(null);

    try {
      if (file.size > 50 * 1024 * 1024) {
        throw new Error('File is too large. Please use a file smaller than 50MB.');
      }

      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const storyFile: FileData = { data: base64, mimeType: file.type };
      setCurrentStory(storyFile);

      const setupResponse = await onPrepareStory(storyFile, styleReferences);
      setPreparedPack(setupResponse.storyPack);

      // If style references were not provided, keep the backend-selected primer.
      if (styleReferences.length === 0 && setupResponse.storyPack.stylePrimer.length > 0) {
        setStyleReferences(setupResponse.storyPack.stylePrimer);
      }
    } catch (error: any) {
      console.error(error);
      setErrorMsg(error?.message || 'Failed to process story');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleStyleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
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

      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      newStyles.push({ data: base64, mimeType: file.type });
    }

    setStyleReferences((prev) => [...prev, ...newStyles]);
  };

  const removeStyleImage = (index: number) => {
    setStyleReferences((prev) => prev.filter((_, i) => i !== index));
  };

  const handleFinish = () => {
    if (!currentStory || !preparedPack) {
      return;
    }

    const finalPrimer = styleReferences.length > 0 ? styleReferences : preparedPack.stylePrimer;
    onComplete(currentStory, finalPrimer, {
      ...preparedPack,
      stylePrimer: finalPrimer
    });
    onClose();
  };

  const summary = preparedPack?.summary || '';
  const generatedCover = preparedPack?.coverImage || null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-3xl w-full max-w-5xl h-[90vh] overflow-hidden shadow-2xl flex flex-col">
        <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-white z-10">
          <div>
            <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
              <BookOpen className="w-6 h-6 text-kid-blue" />
              Prepare Story
            </h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-full text-gray-400 transition">
            <X className="w-6 h-6" />
          </button>
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

                {!currentStory ? (
                  <div
                    onClick={() => storyInputRef.current?.click()}
                    className="border-2 border-dashed border-gray-300 rounded-xl p-8 flex flex-col items-center justify-center cursor-pointer hover:bg-blue-50 hover:border-kid-blue transition group"
                  >
                    <Upload className="w-10 h-10 text-gray-300 group-hover:text-kid-blue mb-2" />
                    <span className="text-gray-500 font-medium">Click to upload PDF</span>
                    <input type="file" ref={storyInputRef} onChange={handleStoryUpload} className="hidden" accept=".pdf" />
                  </div>
                ) : (
                  <div className="flex items-center gap-3 p-4 bg-blue-50 text-kid-blue rounded-xl border border-blue-100">
                    <CheckCircle className="w-5 h-5" />
                    <span className="font-bold">PDF Uploaded</span>
                    <button
                      onClick={() => {
                        setCurrentStory(null);
                        setPreparedPack(null);
                      }}
                      className="ml-auto text-xs underline"
                    >
                      Change
                    </button>
                  </div>
                )}
              </section>

              {(isProcessing || summary) && (
                <section className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 animate-fade-in-up">
                  <h3 className="text-lg font-bold text-gray-700 mb-4 flex items-center gap-2">
                    <span className="bg-kid-orange text-white w-6 h-6 rounded-full flex items-center justify-center text-xs">2</span>
                    Story Analysis
                  </h3>

                  {isProcessing ? (
                    <div className="flex flex-col items-center py-8 text-gray-400">
                      <Loader2 className="w-8 h-8 animate-spin mb-2 text-kid-orange" />
                      <span>Reading & Drawing Cover...</span>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div>
                        <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">Summary</label>
                        <p className="text-gray-700 text-lg leading-relaxed">{summary}</p>
                      </div>

                      {generatedCover && (
                        <div>
                          <label className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 block">AI Generated Cover</label>
                          <div className="relative aspect-[3/4] w-48 rounded-xl overflow-hidden shadow-lg">
                            <img src={generatedCover} alt="Cover" className="w-full h-full object-cover" />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </section>
              )}
            </div>

            <div className={`space-y-6 transition-opacity duration-500 ${!summary ? 'opacity-50 pointer-events-none' : 'opacity-100'}`}>
              <section className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 h-full flex flex-col">
                <h3 className="text-lg font-bold text-gray-700 mb-2 flex items-center gap-2">
                  <span className="bg-kid-pink text-white w-6 h-6 rounded-full flex items-center justify-center text-xs">3</span>
                  Style References
                </h3>
                <p className="text-gray-500 text-sm mb-6">
                  Upload reference images from the book so generated option cards stay visually consistent.
                </p>

                <div className="grid grid-cols-3 gap-4 mb-4">
                  {styleReferences.map((style, idx) => (
                    <div key={idx} className="relative aspect-square rounded-xl overflow-hidden border border-gray-200 group">
                      <img src={`data:${style.mimeType};base64,${style.data}`} className="w-full h-full object-cover" />
                      <button
                        onClick={() => removeStyleImage(idx)}
                        className="absolute top-1 right-1 bg-red-500 text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => styleInputRef.current?.click()}
                    className="aspect-square rounded-xl border-2 border-dashed border-gray-300 flex flex-col items-center justify-center text-gray-400 hover:border-kid-pink hover:text-kid-pink hover:bg-pink-50 transition"
                  >
                    <Upload className="w-6 h-6 mb-1" />
                    <span className="text-xs font-bold">Add Image</span>
                  </button>
                  <input type="file" ref={styleInputRef} onChange={handleStyleUpload} className="hidden" accept="image/*" multiple />
                </div>

                <div className="mt-auto pt-6 border-t border-gray-100">
                  <button
                    onClick={handleFinish}
                    disabled={!summary}
                    className="w-full py-4 bg-kid-blue text-white font-bold rounded-xl shadow-lg hover:bg-blue-600 transition flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <BookOpen className="w-5 h-5" /> Start Story
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
