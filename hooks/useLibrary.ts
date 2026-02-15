import { useCallback, useEffect, useState } from 'react';
import { StoryAssets, StoryManifest } from '../types';
import * as StorageService from '../services/storageService';

export const useLibrary = () => {
  const [stories, setStories] = useState<StoryManifest[]>([]);
  const [activeManifest, setActiveManifest] = useState<StoryManifest | null>(null);
  const [activeAssets, setActiveAssets] = useState<StoryAssets | null>(null);

  const refreshStories = useCallback(async () => {
    const manifests = await StorageService.getStoryManifests();
    setStories(manifests);
  }, []);

  useEffect(() => {
    refreshStories().catch((error) => {
      console.error('Failed to load story manifests', error);
    });
  }, [refreshStories]);

  const selectStory = useCallback(async (manifest: StoryManifest) => {
    const assets = await StorageService.getStoryAssets(manifest.id);
    if (!assets) {
      throw new Error('Story assets not found.');
    }

    setActiveManifest(manifest);
    setActiveAssets(assets);
  }, []);

  const saveNewStory = useCallback(async (manifest: StoryManifest, assets: StoryAssets) => {
    await StorageService.saveStory(manifest, assets);
    setStories((prev) => [manifest, ...prev.filter((item) => item.id !== manifest.id)]);
    setActiveManifest(manifest);
    setActiveAssets(assets);
  }, []);

  const deleteStory = useCallback(async (id: string) => {
    await StorageService.deleteStory(id);
    setStories((prev) => prev.filter((story) => story.id !== id));

    setActiveManifest((prev) => (prev?.id === id ? null : prev));
    setActiveAssets((prev) => (prev?.id === id ? null : prev));
  }, []);

  return {
    stories,
    activeManifest,
    activeAssets,
    refreshStories,
    selectStory,
    saveNewStory,
    deleteStory
  };
};
