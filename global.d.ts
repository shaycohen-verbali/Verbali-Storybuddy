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

declare const __APP_COMMIT_SHA__: string;
declare const __APP_REPO_SLUG__: string;
