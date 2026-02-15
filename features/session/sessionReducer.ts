import { ChatTurn, Option, PipelineTimings, ProcessingStage } from '../../types';

export interface TurnSessionState {
  processingStage: ProcessingStage;
  currentQuestion: string;
  options: Option[];
  selectedOptionId: string | null;
  conversationHistory: ChatTurn[];
  lastAudioBlob: Blob | null;
  error: string | null;
  lastTimings: PipelineTimings | null;
}

export const initialTurnSessionState: TurnSessionState = {
  processingStage: 'idle',
  currentQuestion: '',
  options: [],
  selectedOptionId: null,
  conversationHistory: [],
  lastAudioBlob: null,
  error: null,
  lastTimings: null
};

type TurnSessionAction =
  | { type: 'START'; audioBlob: Blob }
  | { type: 'SET_STAGE'; stage: ProcessingStage }
  | { type: 'SET_QUESTION'; question: string }
  | { type: 'SET_OPTIONS'; options: Option[] }
  | { type: 'SELECT_OPTION'; optionId: string; optionText: string }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'SET_TIMINGS'; timings: PipelineTimings }
  | { type: 'RESET' }
  | { type: 'CLEAR_ERROR' };

export const turnSessionReducer = (state: TurnSessionState, action: TurnSessionAction): TurnSessionState => {
  switch (action.type) {
    case 'START':
      return {
        ...state,
        processingStage: 'transcribing',
        lastAudioBlob: action.audioBlob,
        selectedOptionId: null,
        options: [],
        error: null
      };
    case 'SET_STAGE':
      return {
        ...state,
        processingStage: action.stage
      };
    case 'SET_QUESTION':
      return {
        ...state,
        currentQuestion: action.question,
        conversationHistory: [...state.conversationHistory, { role: 'parent', text: action.question }]
      };
    case 'SET_OPTIONS':
      return {
        ...state,
        options: action.options
      };
    case 'SELECT_OPTION':
      if (state.selectedOptionId === action.optionId) {
        return state;
      }
      return {
        ...state,
        selectedOptionId: action.optionId,
        conversationHistory: [...state.conversationHistory, { role: 'child', text: action.optionText }]
      };
    case 'SET_ERROR':
      return {
        ...state,
        processingStage: 'error',
        error: action.error
      };
    case 'SET_TIMINGS':
      return {
        ...state,
        lastTimings: action.timings
      };
    case 'CLEAR_ERROR':
      return {
        ...state,
        error: null
      };
    case 'RESET':
      return {
        ...initialTurnSessionState
      };
    default:
      return state;
  }
};
