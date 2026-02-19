import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runTurnWithBackend, setupStoryWithBackend } from '../services/apiClient';

describe('apiClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('maps setup response shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({
          storyPack: {
            summary: 'A short story',
            artStyle: 'watercolor cartoon',
            storyBrief: 'brief',
            storyFacts: {
              characters: ['Milo'],
              characterCatalog: [{ name: 'Milo', source: 'mentioned' }],
              characterImageMap: [{ characterName: 'Milo', styleRefIndexes: [1] }],
              objectImageMap: [{ objectName: 'shell', styleRefIndexes: [2] }],
              places: ['ocean reef'],
              objects: ['shell'],
              events: ['Milo finds a shell'],
              setting: 'An underwater reef school.',
              worldTags: ['ocean']
            },
            coverImage: null,
            stylePrimer: [],
            styleReferences: [
              { mimeType: 'image/jpeg', data: 'a', kind: 'scene', source: 'pdf_page' },
              { mimeType: 'image/jpeg', data: 'b', kind: 'character', source: 'crop', characterName: 'Milo' }
            ]
          },
          timings: { analyzeMs: 10, coverMs: 20, totalMs: 30 },
          payloadBytes: 123
        })
      })
    );

    const response = await setupStoryWithBackend({
      storyFile: { data: 'abc', mimeType: 'application/pdf' },
      styleImages: []
    });

    expect(response.storyPack.summary).toBe('A short story');
    expect(response.storyPack.storyFacts.places[0]).toBe('ocean reef');
    expect(response.storyPack.styleReferences?.[1].characterName).toBe('Milo');
    expect(response.timings.totalMs).toBe(30);
  });

  it('maps turn response shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({
          question: 'What happened?',
          cards: [
            { id: 'opt-0', text: 'He ran', isLoadingImage: false, renderMode: 'blend_with_story_world' },
            { id: 'opt-1', text: 'He slept', isLoadingImage: false, renderMode: 'standalone_option_world' },
            { id: 'opt-2', text: 'He flew', isLoadingImage: false, renderMode: 'standalone_option_world' }
          ],
          timings: {
            transcribeMs: 100,
            optionsMs: 200,
            imageMsById: { 'opt-0': 300, 'opt-1': 310, 'opt-2': 320 },
            fullCardsMs: 320,
            totalMs: 620
          },
          payloadBytes: 256
        })
      })
    );

    const response = await runTurnWithBackend({
      audioBase64: 'abc',
      mimeType: 'audio/webm',
      storyPdf: { data: 'pdf-base64', mimeType: 'application/pdf' },
      storyBrief: 'brief',
      storyFacts: {
        characters: ['Milo'],
        characterCatalog: [{ name: 'Milo', source: 'mentioned' }],
        characterImageMap: [{ characterName: 'Milo', styleRefIndexes: [0] }],
        objectImageMap: [{ objectName: 'shell', styleRefIndexes: [1] }],
        places: ['reef'],
        objects: ['shell'],
        events: [],
        setting: 'Ocean reef',
        worldTags: ['ocean']
      },
      artStyle: 'style',
      stylePrimer: [],
      styleReferences: [
        { mimeType: 'image/jpeg', data: 'x', kind: 'scene', source: 'pdf_page' },
        { mimeType: 'image/jpeg', data: 'y', kind: 'object', source: 'crop', objectName: 'shell' }
      ],
      history: []
    });

    expect(response.question).toBe('What happened?');
    expect(response.cards).toHaveLength(3);
    expect(response.timings.fullCardsMs).toBe(320);
  });
});
