export interface FileData {
  data: string; // Base64
  mimeType: string;
}

export interface StoryContext {
  storyContent: FileData | null;
  styleImages: FileData[];
}

export interface CharacterForm {
  id: string;
  description: string;
  imageUrl: string;
}

export interface CharacterProfile {
  id: string;
  name: string;
  baseDescription: string;
  forms: CharacterForm[];
}

export interface StoryObject {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
}

export interface StoryMetadata {
  summary: string;
  characters: CharacterProfile[];
  objects: StoryObject[];
  artStyle?: string;
  storyBrief?: string;
  storyFacts?: StoryFacts;
}

export type RenderMode = 'blend_with_story_world' | 'standalone_option_world';

export interface Option {
  id: string;
  text: string;
  imageUrl?: string;
  isLoadingImage: boolean;
  type?: 'correct' | 'wrong' | 'neutral';
  isCorrect?: boolean;
  renderMode?: RenderMode;
  supportLevel?: number;
}

export interface ChatTurn {
  role: 'parent' | 'child';
  text: string;
}

export interface StoryPack {
  summary: string;
  artStyle: string;
  storyBrief: string;
  storyFacts: StoryFacts;
  coverImage?: string | null;
  stylePrimer: FileData[];
}

export interface StoryFacts {
  characters: string[];
  characterCatalog: StoryCharacterFact[];
  places: string[];
  objects: string[];
  events: string[];
  setting: string;
  worldTags: string[];
}

export interface StoryCharacterFact {
  name: string;
  source: 'mentioned' | 'illustrated' | 'both';
}

export interface StoryManifest {
  id: string;
  title: string;
  coverImage?: string;
  createdAt: number;
  summary: string;
  artStyle: string;
  publisherId?: string | null;
}

export interface Publisher {
  id: string;
  name: string;
  createdAt: number;
  coverImage?: string;
}

export interface StoryAssets {
  id: string;
  storyBrief: string;
  stylePrimer: FileData[];
  pdfData?: FileData;
  metadata: StoryMetadata;
}

export interface SetupTimings {
  analyzeMs: number;
  coverMs: number;
  totalMs: number;
}

export interface PipelineTimings {
  transcribeMs: number;
  optionsMs: number;
  imageMsById: Record<string, number>;
  fullCardsMs: number;
  totalMs: number;
}

export interface SetupStoryRequest {
  storyFile: FileData;
  styleImages: FileData[];
}

export interface SetupStoryResponse {
  storyPack: StoryPack;
  timings: SetupTimings;
  payloadBytes: number;
}

export interface TurnRequest {
  audioBase64: string;
  mimeType: string;
  storyBrief: string;
  storyFacts?: StoryFacts;
  artStyle: string;
  stylePrimer: FileData[];
  history: ChatTurn[];
}

export interface TurnResponse {
  question: string;
  cards: Option[];
  timings: PipelineTimings;
  payloadBytes: number;
}

export enum AppMode {
  LIBRARY = 'LIBRARY',
  SETUP = 'SETUP',
  STORY = 'STORY',
}

export type ProcessingStage = 'idle' | 'transcribing' | 'generating_options' | 'generating_images' | 'completed' | 'error';

export interface StoredStory {
  id: string;
  title: string;
  coverImage?: string;
  createdAt: number;
  metadata: StoryMetadata;
  pdfData: FileData;
}
