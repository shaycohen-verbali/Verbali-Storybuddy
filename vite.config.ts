import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(() => {
  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.COMMIT_SHA || 'local-dev';
  const repoOwner = process.env.VERCEL_GIT_REPO_OWNER;
  const repoSlug = repoOwner && process.env.VERCEL_GIT_REPO_SLUG
    ? `${repoOwner}/${process.env.VERCEL_GIT_REPO_SLUG}`
    : process.env.VERCEL_GIT_REPO_SLUG || process.env.GITHUB_REPOSITORY || 'unknown-repo';

  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    plugins: [react()],
    define: {
      __APP_COMMIT_SHA__: JSON.stringify(commitSha),
      __APP_REPO_SLUG__: JSON.stringify(repoSlug)
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    }
  };
});
