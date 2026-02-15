import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { getStoryAssets, getStoryManifests } from '../services/storageService';
import { StoredStory } from '../types';

const DB_NAME = 'StoryBuddyDB';

const createLegacyRecord = async () => {
  await new Promise<void>((resolve, reject) => {
    const openReq = indexedDB.open(DB_NAME, 1);

    openReq.onupgradeneeded = () => {
      const db = openReq.result;
      if (!db.objectStoreNames.contains('stories')) {
        db.createObjectStore('stories', { keyPath: 'id' });
      }
    };

    openReq.onsuccess = () => {
      const db = openReq.result;
      const tx = db.transaction(['stories'], 'readwrite');
      const store = tx.objectStore('stories');

      const legacy: StoredStory = {
        id: 'legacy-1',
        title: 'Legacy Story',
        coverImage: 'data:image/png;base64,xyz',
        createdAt: Date.now(),
        metadata: {
          summary: 'Legacy summary',
          artStyle: 'legacy style',
          characters: [],
          objects: []
        },
        pdfData: { data: 'pdf', mimeType: 'application/pdf' }
      };

      store.put(legacy);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };

    openReq.onerror = () => reject(openReq.error);
  });
};

describe('storageService migration', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });

  it('migrates legacy v1 stories into v2 manifest/assets stores', async () => {
    await createLegacyRecord();

    const manifests = await getStoryManifests();
    expect(manifests.length).toBe(1);
    expect(manifests[0].id).toBe('legacy-1');
    expect(manifests[0].summary).toBe('Legacy summary');

    const assets = await getStoryAssets('legacy-1');
    expect(assets?.storyBrief).toBe('Legacy summary');
    expect(assets?.pdfData?.mimeType).toBe('application/pdf');
  });
});
