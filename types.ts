export interface FileData {
  data: string; // Base64
  mimeType: string;
}

export type StyleReferenceKind = 'scene' | 'character' | 'object';
export type StyleReferenceSource = 'pdf_page' | 'upload' | 'crop' | 'generated';

export interface StyleReferenceBox {
  x: number; // 0..1 normalized
  y: number; // 0..1 normalized
  width: number; // 0..1 normalized
  height: number; // 0..1 normalized
}

export interface StyleReferenceDetection {
  name: string;
  confidence: number; // 0..1
  box?: StyleReferenceBox;
}

export interface EntityEvidence {
  pageIndex: number;
  snippet?: string;
  confidence: number; // 0..1
}

export type StyleAssetRole = 'scene_anchor' | 'character_form' | 'object_anchor';

export interface StyleReferenceAsset extends FileData {
  kind: StyleReferenceKind;
  source: StyleReferenceSource;
  characterName?: string;
  objectName?: string;
  sceneId?: string;
  assetRole?: StyleAssetRole;
  box?: StyleReferenceBox;
  cropCoverage?: number; // normalized area 0..1
  pageIndex?: number;
  confidence?: number;
  qualityScore?: number;
  embeddingHash?: string;
  detectedCharacters?: StyleReferenceDetection[];
  detectedObjects?: StyleReferenceDetection[];
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
  storyText?: string;
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
  debug?: TurnCardDebug;
}

export interface ChatTurn {
  role: 'parent' | 'child';
  text: string;
}

export interface StoryPack {
  summary: string;
  artStyle: string;
  storyBrief: string;
  storyText?: string;
  storyFacts: StoryFacts;
  coverImage?: string | null;
  stylePrimer: FileData[];
  styleReferences?: StyleReferenceAsset[];
}

export interface StoryFacts {
  characters: string[];
  characterCatalog: StoryCharacterFact[];
  characterImageMap?: StoryCharacterImageMap[];
  objectImageMap?: StoryObjectImageMap[];
  sceneCatalog?: SceneFact[];
  sceneImageMap?: SceneImageMap[];
  characterEvidenceMap?: StoryCharacterEvidenceMap[];
  objectEvidenceMap?: StoryObjectEvidenceMap[];
  scenes?: string[];
  places: string[];
  objects: string[];
  events: string[];
  setting: string;
  worldTags: string[];
}

export interface StoryCharacterImageMap {
  characterName: string;
  styleRefIndexes: number[];
}

export interface StoryObjectImageMap {
  objectName: string;
  styleRefIndexes: number[];
}

export interface StoryCharacterEvidenceMap {
  characterName: string;
  evidence: EntityEvidence[];
}

export interface StoryObjectEvidenceMap {
  objectName: string;
  evidence: EntityEvidence[];
}

export interface SceneFact {
  id: string;
  title: string;
  aliases: string[];
  describedEvidence: EntityEvidence[];
  illustratedEvidence: EntityEvidence[];
}

export interface SceneImageMap {
  sceneId: string;
  styleRefIndexes: number[];
  confidence: number;
}

export interface TurnContextParticipants {
  scenes: string[];
  characters: string[];
  objects: string[];
  inferredCharacters: string[];
  inferredObjects: string[];
}

export interface SelectedStyleRefDebug {
  index: number;
  kind: StyleReferenceKind;
  source: StyleReferenceSource;
  sceneId?: string;
  characterName?: string;
  objectName?: string;
  cropCoverage?: number;
  confidence?: number;
}

export interface TurnCardDebug {
  selectedStyleRefIndexes?: number[];
  selectedStyleRefs?: SelectedStyleRefDebug[];
  selectedParticipants?: TurnContextParticipants;
  answerAgentPrompt?: string;
  answerAgentRaw?: string;
  illustrationAgentPrompt?: string;
  illustrationPlan?: string;
  imagePrompt?: string;
  imageModel?: string;
  imageGenerationError?: string;
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
  styleReferences?: StyleReferenceAsset[];
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
  storyText: string;
  storyPdf?: FileData;
  storyBrief: string;
  storyFacts?: StoryFacts;
  artStyle: string;
  stylePrimer: FileData[];
  styleReferences?: StyleReferenceAsset[];
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
