/**
 * Highlight state management
 */
import type { Reducer } from '../helpers/store';
import type { Highlight, HighlightColor } from '../library/types';

export interface HighlightState {
  highlights: Record<string, Highlight[]>; // bookId -> highlights
  loading: boolean;
  error: string | null;
  selectedHighlightId: string | null;
  pendingSelection: PendingSelection | null;
}

/**
 * Serializable DOMRect for storage
 */
export interface DOMRectJSON {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PendingSelection {
  bookId: string;
  text: string;
  cfi: string;
  chapter?: string;
  pagePercent?: number;
  /** Selection rects for immediate highlight display */
  rects?: DOMRectJSON[];
  /** NEW: Spine index for re-anchoring */
  spineIndex?: number;
  /** NEW: Text quote with context for robust re-anchoring */
  textQuote?: {
    exact: string;
    prefix?: string;
    suffix?: string;
  };
  /** NEW: Text position for fallback anchoring */
  textPosition?: {
    start: number;
    end: number;
  };
}

export type HighlightAction =
  | { type: 'SET_HIGHLIGHTS'; payload: { bookId: string; highlights: Highlight[] } }
  | { type: 'ADD_HIGHLIGHT'; payload: Highlight }
  | { type: 'UPDATE_HIGHLIGHT'; payload: Highlight }
  | { type: 'REMOVE_HIGHLIGHT'; payload: { bookId: string; highlightId: string } }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_ERROR'; payload: string | null }
  | { type: 'SELECT_HIGHLIGHT'; payload: string | null }
  | { type: 'SET_PENDING_SELECTION'; payload: PendingSelection | null };

export const initialHighlightState: HighlightState = {
  highlights: {},
  loading: false,
  error: null,
  selectedHighlightId: null,
  pendingSelection: null,
};

export const highlightReducer: Reducer<HighlightState, HighlightAction> = (state, action) => {
  switch (action.type) {
    case 'SET_HIGHLIGHTS': {
      const { bookId, highlights } = action.payload;
      return {
        ...state,
        highlights: {
          ...state.highlights,
          [bookId]: highlights,
        },
        loading: false,
      };
    }

    case 'ADD_HIGHLIGHT': {
      const highlight = action.payload;
      // Validate bookId is a string to prevent [object Object] key bug
      if (typeof highlight.bookId !== 'string') {
        console.error('[HighlightStore] Invalid bookId type:', typeof highlight.bookId, highlight.bookId);
        return state;
      }
      const bookHighlights = state.highlights[highlight.bookId] || [];
      return {
        ...state,
        highlights: {
          ...state.highlights,
          [highlight.bookId]: [...bookHighlights, highlight],
        },
        pendingSelection: null,
      };
    }

    case 'UPDATE_HIGHLIGHT': {
      const highlight = action.payload;
      // Validate bookId is a string
      if (typeof highlight.bookId !== 'string') {
        console.error('[HighlightStore] Invalid bookId type in UPDATE:', typeof highlight.bookId);
        return state;
      }
      const bookHighlights = state.highlights[highlight.bookId] || [];
      return {
        ...state,
        highlights: {
          ...state.highlights,
          [highlight.bookId]: bookHighlights.map(h =>
            h.id === highlight.id ? highlight : h
          ),
        },
      };
    }

    case 'REMOVE_HIGHLIGHT': {
      const { bookId, highlightId } = action.payload;
      // Validate bookId is a string
      if (typeof bookId !== 'string') {
        console.error('[HighlightStore] Invalid bookId type in REMOVE:', typeof bookId);
        return state;
      }
      const bookHighlights = state.highlights[bookId] || [];
      return {
        ...state,
        highlights: {
          ...state.highlights,
          [bookId]: bookHighlights.filter(h => h.id !== highlightId),
        },
      };
    }

    case 'SET_LOADING':
      return { ...state, loading: action.payload };

    case 'SET_ERROR':
      return { ...state, error: action.payload, loading: false };

    case 'SELECT_HIGHLIGHT':
      return { ...state, selectedHighlightId: action.payload };

    case 'SET_PENDING_SELECTION':
      return { ...state, pendingSelection: action.payload };

    default:
      return state;
  }
};
