import { StoryAssets, StoryManifest, StoredStory } from '../types';

const DB_NAME = 'StoryBuddyDB';
const DB_VERSION = 2;
const LEGACY_STORE = 'stories';
const MANIFEST_STORE = 'story_manifests';
const ASSETS_STORE = 'story_assets';

let dbPromise: Promise<IDBDatabase> | null = null;

const legacyToManifest = (legacy: StoredStory): StoryManifest => ({
  id: legacy.id,
  title: legacy.title,
  coverImage: legacy.coverImage,
  createdAt: legacy.createdAt,
  summary: legacy.metadata.summary,
  artStyle: legacy.metadata.artStyle || 'Children\'s book illustration'
});

const legacyToAssets = (legacy: StoredStory): StoryAssets => ({
  id: legacy.id,
  storyBrief: legacy.metadata.storyBrief || legacy.metadata.summary,
  stylePrimer: legacy.coverImage
    ? [{ mimeType: legacy.coverImage.split(';')[0].replace('data:', ''), data: legacy.coverImage.split(',')[1] || '' }]
    : [],
  pdfData: legacy.pdfData,
  metadata: {
    ...legacy.metadata,
    storyBrief: legacy.metadata.storyBrief || legacy.metadata.summary
  }
});

const openDB = (): Promise<IDBDatabase> => {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (event) => reject('Database error: ' + (event.target as any).error);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const tx = (event.target as IDBOpenDBRequest).transaction;

      if (!db.objectStoreNames.contains(MANIFEST_STORE)) {
        db.createObjectStore(MANIFEST_STORE, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(ASSETS_STORE)) {
        db.createObjectStore(ASSETS_STORE, { keyPath: 'id' });
      }

      if (!tx || !db.objectStoreNames.contains(LEGACY_STORE)) {
        return;
      }

      const oldStore = tx.objectStore(LEGACY_STORE);
      const manifestStore = tx.objectStore(MANIFEST_STORE);
      const assetsStore = tx.objectStore(ASSETS_STORE);

      oldStore.openCursor().onsuccess = (cursorEvent) => {
        const cursor = (cursorEvent.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (!cursor) {
          return;
        }

        const legacy = cursor.value as StoredStory;
        manifestStore.put(legacyToManifest(legacy));
        assetsStore.put(legacyToAssets(legacy));
        cursor.continue();
      };
    };

    request.onsuccess = (event) => resolve((event.target as IDBOpenDBRequest).result);
  });

  return dbPromise;
};

export const saveStory = async (manifest: StoryManifest, assets: StoryAssets): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([MANIFEST_STORE, ASSETS_STORE], 'readwrite');
    tx.objectStore(MANIFEST_STORE).put(manifest);
    tx.objectStore(ASSETS_STORE).put(assets);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject('Error saving story');
  });
};

export const getStoryManifests = async (): Promise<StoryManifest[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([MANIFEST_STORE], 'readonly');
    const request = tx.objectStore(MANIFEST_STORE).getAll();

    request.onsuccess = () => resolve((request.result || []).sort((a, b) => b.createdAt - a.createdAt));
    request.onerror = () => reject('Error getting story manifests');
  });
};

export const getStoryAssets = async (id: string): Promise<StoryAssets | null> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([ASSETS_STORE], 'readonly');
    const request = tx.objectStore(ASSETS_STORE).get(id);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject('Error getting story assets');
  });
};

export const deleteStory = async (id: string): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([MANIFEST_STORE, ASSETS_STORE], 'readwrite');
    tx.objectStore(MANIFEST_STORE).delete(id);
    tx.objectStore(ASSETS_STORE).delete(id);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject('Error deleting story');
  });
};
