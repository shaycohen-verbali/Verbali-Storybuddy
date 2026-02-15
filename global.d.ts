interface Window {
  aistudio?: {
    hasSelectedApiKey: () => Promise<boolean>;
    openSelectKey: () => Promise<void>;
  };
}

interface ImportMetaEnv {
  readonly VITE_GEMINI_API_KEY?: string;
  readonly VITE_USE_BACKEND_PIPELINE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
