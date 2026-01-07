/**
 * Amnesia HUD State Store
 *
 * Redux-like state management for the HUD using the existing Store pattern.
 */

import { Store } from '../../helpers/store';
import type {
  AmnesiaHUDState,
  AmnesiaHUDAction,
  TabName,
  DetailViewState,
} from '../types';
import { initialHUDState } from '../types';

// =============================================================================
// Reducer
// =============================================================================

export function hudReducer(
  state: AmnesiaHUDState,
  action: AmnesiaHUDAction
): AmnesiaHUDState {
  switch (action.type) {
    case 'TOGGLE_HUD':
      return {
        ...state,
        isOpen: !state.isOpen,
        // Clear detail view when closing
        detailView: state.isOpen ? null : state.detailView,
        viewHistory: state.isOpen ? [] : state.viewHistory,
      };

    case 'OPEN_HUD':
      return { ...state, isOpen: true };

    case 'CLOSE_HUD':
      return {
        ...state,
        isOpen: false,
        detailView: null,
        viewHistory: [],
      };

    case 'PIN_HUD':
      return { ...state, isPinned: action.payload };

    case 'SET_ACTIVE_TAB':
      return {
        ...state,
        activeTab: action.payload,
        // Clear detail view when switching tabs
        detailView: null,
        viewHistory: [],
      };

    case 'PUSH_DETAIL_VIEW':
      return {
        ...state,
        viewHistory: state.detailView
          ? [...state.viewHistory, state.detailView]
          : state.viewHistory,
        detailView: action.payload,
      };

    case 'POP_DETAIL_VIEW': {
      const history = [...state.viewHistory];
      const previousView = history.pop() || null;
      return {
        ...state,
        detailView: previousView,
        viewHistory: history,
      };
    }

    case 'CLEAR_HISTORY':
      return {
        ...state,
        detailView: null,
        viewHistory: [],
      };

    case 'SET_POSITION':
      return { ...state, position: action.payload };

    case 'RESTORE_STATE':
      return { ...state, ...action.payload };

    default:
      return state;
  }
}

// =============================================================================
// Store Factory
// =============================================================================

export function createHUDStore(): Store<AmnesiaHUDState, AmnesiaHUDAction> {
  return new Store<AmnesiaHUDState, AmnesiaHUDAction>(
    initialHUDState,
    hudReducer
  );
}

// =============================================================================
// Action Creators (for convenience)
// =============================================================================

export const HUDActions = {
  toggle: (): AmnesiaHUDAction => ({ type: 'TOGGLE_HUD' }),
  open: (): AmnesiaHUDAction => ({ type: 'OPEN_HUD' }),
  close: (): AmnesiaHUDAction => ({ type: 'CLOSE_HUD' }),
  pin: (pinned: boolean): AmnesiaHUDAction => ({ type: 'PIN_HUD', payload: pinned }),
  setTab: (tab: TabName): AmnesiaHUDAction => ({ type: 'SET_ACTIVE_TAB', payload: tab }),
  pushDetail: (view: DetailViewState): AmnesiaHUDAction => ({
    type: 'PUSH_DETAIL_VIEW',
    payload: view,
  }),
  popDetail: (): AmnesiaHUDAction => ({ type: 'POP_DETAIL_VIEW' }),
  clearHistory: (): AmnesiaHUDAction => ({ type: 'CLEAR_HISTORY' }),
  setPosition: (pos: { x: number; y: number } | null): AmnesiaHUDAction => ({
    type: 'SET_POSITION',
    payload: pos,
  }),
  restoreState: (state: Partial<AmnesiaHUDState>): AmnesiaHUDAction => ({
    type: 'RESTORE_STATE',
    payload: state,
  }),
};
