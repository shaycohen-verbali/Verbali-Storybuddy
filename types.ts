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
  qaReadyPackage?: QaReadyBookPackage;
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
  qaReadyPackage?: QaReadyBookPackage;
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

export type TextQuality = 'good' | 'mixed' | 'poor';
export type EntityType = 'character' | 'object' | 'location' | 'scene';
export type VisualAssetRole = 'gold_face' | 'gold_body' | 'gold_bootstrap' | 'reference';

export interface BookPackageManifest {
  bookId: string;
  title: string;
  author?: string;
  fileHash: string;
  pageCount: number;
  originalFileSize: number;
  mimeType: string;
  textQuality: TextQuality;
  validationWarnings: string[];
  normalizedAt: number;
}

export interface PageTextRecord {
  pageNum: number;
  rawText: string;
  cleanText: string;
  charCount: number;
}

export interface PageImageRecord {
  pageNum: number;
  imageId: string;
  path: string;
  styleRefIndex: number;
  width?: number;
  height?: number;
}

export interface StyleBibleRecord {
  id: string;
  globalStyleDescription: string;
  palette: string[];
  lineQuality: string;
  lighting: string;
  compositionHabits: string[];
  styleReferenceImageIds: string[];
}

export interface EntityVisualAssetRecord {
  imageId: string;
  role: VisualAssetRole;
  styleRefIndex?: number;
}

export interface EntityRecord {
  entityId: string;
  name: string;
  aliases: string[];
  type: EntityType;
  canonicalDescription: string;
  mustHaveTraits: string[];
  negativeTraits: string[];
  styleTags: string[];
  visualAssets: EntityVisualAssetRecord[];
  goldRefs?: {
    face?: string;
    body?: string;
    bootstrap?: string;
  };
}

export interface QaReadyChecklist {
  normalizedPdf: boolean;
  pageImages: boolean;
  styleBible: boolean;
  entityCatalog: boolean;
  mainCharactersGoldRefs: boolean;
  cleanTextPerPage: boolean;
  allRecurringCharactersGoldRefs: boolean;
  keyObjectsGoldRefs: boolean;
}

export interface QaReadyManifest {
  styleBibleId: string;
  entityRecordsId: string;
  pageTextCount: number;
  pageImageCount: number;
  illustrationPageCount: number;
  textQuality: TextQuality;
  hasGoldRefsPercent: number;
  checklist: QaReadyChecklist;
  notes: string[];
}

export interface QaReadyBookPackage {
  version: string;
  createdAt: number;
  manifest: BookPackageManifest;
  pagesText: PageTextRecord[];
  pagesImages: PageImageRecord[];
  illustrationPages: number[];
  styleBible: StyleBibleRecord;
  entityRecords: EntityRecord[];
  qaReadyManifest: QaReadyManifest;
}

export interface RuntimeLoadBookRequest {
  book_id: string;
  qa_ready_package: QaReadyBookPackage;
  style_references?: StyleReferenceAsset[];
  force_reload?: boolean;
}

export interface RuntimeLoadBookResponse {
  book_id: string;
  session_id: string;
  book_package_hash: string;
  text_quality: TextQuality;
  entity_count: number;
  style_ref_count: number;
  style_ref_image_id_count: number;
}

export interface RuntimePlanChoice {
  choice_id: 'A' | 'B' | 'C';
  answer_text: string;
}

export interface RuntimePlanResponse {
  qa_plan_id: string;
  session_id: string;
  book_id: string;
  question_text: string;
  choices: RuntimePlanChoice[];
  internal: {
    correct_choice_id: 'A' | 'B' | 'C';
  };
  debug?: {
    resolvedQuestionEntities?: Array<{
      entityId: string;
      confidence: number;
      matchMethod: string;
      matchedValue: string;
    }>;
    unmatchedMentions?: string[];
  };
}

export interface RuntimeRenderImage {
  choice_id: 'A' | 'B' | 'C';
  image_id: string;
  storage_uri: string;
  image_data_url: string | null;
  error: string | null;
}

export interface RuntimeRenderResponse {
  qa_plan_id: string;
  session_id: string;
  book_id: string;
  question_text: string;
  images: RuntimeRenderImage[];
}

export interface RuntimeQuizResponse {
  book_id: string;
  session_id: string;
  qa_plan_id: string;
  question_text: string;
  choices: Array<
    RuntimePlanChoice & {
      image: RuntimeRenderImage | null;
    }
  >;
  internal: {
    correct_choice_id: 'A' | 'B' | 'C';
  };
}
