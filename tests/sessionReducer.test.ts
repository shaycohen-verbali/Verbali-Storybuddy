import { describe, expect, it } from 'vitest';
import { initialTurnSessionState, turnSessionReducer } from '../features/session/sessionReducer';

describe('turnSessionReducer', () => {
  it('handles a core session flow and reset', () => {
    let state = turnSessionReducer(initialTurnSessionState, {
      type: 'START',
      audioBlob: new Blob(['a'], { type: 'audio/webm' })
    });

    expect(state.processingStage).toBe('transcribing');
    expect(state.lastAudioBlob).toBeTruthy();

    state = turnSessionReducer(state, { type: 'SET_QUESTION', question: 'Where is the cat?' });
    expect(state.currentQuestion).toBe('Where is the cat?');
    expect(state.conversationHistory[0]).toEqual({ role: 'parent', text: 'Where is the cat?' });

    state = turnSessionReducer(state, {
      type: 'SELECT_OPTION',
      optionId: 'opt-1',
      optionText: 'On the mat'
    });

    expect(state.selectedOptionId).toBe('opt-1');
    expect(state.conversationHistory[1]).toEqual({ role: 'child', text: 'On the mat' });

    state = turnSessionReducer(state, { type: 'RESET' });
    expect(state).toEqual(initialTurnSessionState);
  });
});
