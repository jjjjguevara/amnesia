/**
 * Auto-Scroll Controller
 *
 * Provides automatic scrolling functionality for the EPUB reader.
 * Supports smooth continuous scrolling with configurable speed.
 * Works with the Shadow DOM-based renderer.
 */

import type { ShadowDOMRenderer } from './shadow-dom-renderer';

export interface AutoScrollOptions {
  /** Initial speed (1-10) */
  speed: number;
  /** Callback when scrolling starts */
  onStart?: () => void;
  /** Callback when scrolling stops */
  onStop?: () => void;
  /** Callback when scrolling pauses */
  onPause?: () => void;
  /** Callback when scrolling resumes */
  onResume?: () => void;
  /** Callback when page changes during auto-scroll */
  onPageChange?: () => void;
}

export interface AutoScrollState {
  isActive: boolean;
  isPaused: boolean;
  speed: number;
}

const DEFAULT_OPTIONS: AutoScrollOptions = {
  speed: 5,
};

// Speed to scroll increment mapping (pixels per interval)
const SPEED_MAP: Record<number, { pixels: number; interval: number }> = {
  1: { pixels: 1, interval: 100 },
  2: { pixels: 1, interval: 80 },
  3: { pixels: 1, interval: 60 },
  4: { pixels: 1, interval: 45 },
  5: { pixels: 1, interval: 35 },
  6: { pixels: 2, interval: 35 },
  7: { pixels: 2, interval: 28 },
  8: { pixels: 3, interval: 28 },
  9: { pixels: 3, interval: 22 },
  10: { pixels: 4, interval: 20 },
};

export class AutoScroller {
  private renderer: ShadowDOMRenderer | null = null;
  private intervalId: number | null = null;
  private options: AutoScrollOptions;
  private state: AutoScrollState;
  private scrollableElements: HTMLElement[] = [];

  constructor(options: Partial<AutoScrollOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.state = {
      isActive: false,
      isPaused: false,
      speed: this.options.speed,
    };
  }

  /**
   * Attach to a ShadowDOMRenderer
   */
  attach(renderer: ShadowDOMRenderer): void {
    this.renderer = renderer;
    this.updateScrollableElements();

    // Update scrollable elements when content changes
    renderer.on('rendered', () => {
      this.updateScrollableElements();
    });
  }

  /**
   * Detach from current renderer
   */
  detach(): void {
    this.stop();
    this.renderer = null;
    this.scrollableElements = [];
  }

  /**
   * Update the list of scrollable elements
   * Looks for the reader content container within the EpubRenderer
   */
  private updateScrollableElements(): void {
    if (!this.renderer) return;

    this.scrollableElements = [];

    // Primary target: the reader content container
    // Our custom renderer uses a content container that can be scrolled
    const readerContainer = document.querySelector('.amnesia-reader-content') as HTMLElement | null;
    if (readerContainer && readerContainer.scrollHeight > readerContainer.clientHeight) {
      this.scrollableElements.push(readerContainer);
      return;
    }

    // Fallback: look for any scrollable container in the reader view
    const readerView = document.querySelector('.amnesia-reader-view') as HTMLElement | null;
    if (readerView) {
      // Check for scrollable children
      const scrollableChild = readerView.querySelector('[style*="overflow"]') as HTMLElement | null;
      if (scrollableChild && scrollableChild.scrollHeight > scrollableChild.clientHeight) {
        this.scrollableElements.push(scrollableChild);
        return;
      }
    }

    // Last fallback: iframe content if exists
    const iframe = document.querySelector('.amnesia-reader-view iframe') as HTMLIFrameElement | null;
    if (iframe?.contentDocument?.documentElement) {
      this.scrollableElements.push(iframe.contentDocument.documentElement);
    }
  }

  /**
   * Start auto-scrolling
   */
  start(): void {
    if (this.state.isActive || !this.renderer) return;

    this.state.isActive = true;
    this.state.isPaused = false;
    this.options.onStart?.();

    this.startInterval();
  }

  /**
   * Stop auto-scrolling
   */
  stop(): void {
    if (!this.state.isActive) return;

    this.clearInterval();
    this.state.isActive = false;
    this.state.isPaused = false;
    this.options.onStop?.();
  }

  /**
   * Pause auto-scrolling
   */
  pause(): void {
    if (!this.state.isActive || this.state.isPaused) return;

    this.clearInterval();
    this.state.isPaused = true;
    this.options.onPause?.();
  }

  /**
   * Resume auto-scrolling
   */
  resume(): void {
    if (!this.state.isActive || !this.state.isPaused) return;

    this.state.isPaused = false;
    this.startInterval();
    this.options.onResume?.();
  }

  /**
   * Toggle between active and stopped
   */
  toggle(): void {
    if (this.state.isActive) {
      this.stop();
    } else {
      this.start();
    }
  }

  /**
   * Toggle between paused and running (when active)
   */
  togglePause(): void {
    if (!this.state.isActive) return;

    if (this.state.isPaused) {
      this.resume();
    } else {
      this.pause();
    }
  }

  /**
   * Set scroll speed (1-10)
   */
  setSpeed(speed: number): void {
    this.state.speed = Math.max(1, Math.min(10, speed));

    // Restart interval with new speed if active
    if (this.state.isActive && !this.state.isPaused) {
      this.clearInterval();
      this.startInterval();
    }
  }

  /**
   * Increase speed
   */
  speedUp(): void {
    this.setSpeed(this.state.speed + 1);
  }

  /**
   * Decrease speed
   */
  slowDown(): void {
    this.setSpeed(this.state.speed - 1);
  }

  /**
   * Get current state
   */
  getState(): AutoScrollState {
    return { ...this.state };
  }

  /**
   * Check if auto-scroll is active
   */
  isActive(): boolean {
    return this.state.isActive;
  }

  /**
   * Check if auto-scroll is paused
   */
  isPaused(): boolean {
    return this.state.isPaused;
  }

  /**
   * Get current speed
   */
  getSpeed(): number {
    return this.state.speed;
  }

  /**
   * Start the scroll interval
   */
  private startInterval(): void {
    const config = SPEED_MAP[this.state.speed] || SPEED_MAP[5];

    this.intervalId = window.setInterval(() => {
      this.scroll(config.pixels);
    }, config.interval);
  }

  /**
   * Clear the scroll interval
   */
  private clearInterval(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Perform a scroll step
   */
  private scroll(pixels: number): void {
    if (!this.renderer || this.scrollableElements.length === 0) return;

    let scrolledAny = false;

    for (const element of this.scrollableElements) {
      const maxScroll = element.scrollHeight - element.clientHeight;
      const currentScroll = element.scrollTop;

      if (currentScroll < maxScroll) {
        element.scrollTop = Math.min(currentScroll + pixels, maxScroll);
        scrolledAny = true;
      }
    }

    // If we couldn't scroll any element, try to go to next page
    if (!scrolledAny) {
      this.goToNextPage();
    }
  }

  /**
   * Navigate to the next page
   */
  private async goToNextPage(): Promise<void> {
    if (!this.renderer) return;

    try {
      // Pause during page transition
      this.clearInterval();

      await this.renderer.next();
      this.options.onPageChange?.();

      // Update scrollable elements for new page
      this.updateScrollableElements();

      // Reset scroll position on new page
      for (const element of this.scrollableElements) {
        element.scrollTop = 0;
      }

      // Resume scrolling after a short delay
      if (this.state.isActive && !this.state.isPaused) {
        setTimeout(() => {
          if (this.state.isActive && !this.state.isPaused) {
            this.startInterval();
          }
        }, 300);
      }
    } catch (error) {
      // Reached end of book
      this.stop();
    }
  }

  /**
   * Destroy the controller
   */
  destroy(): void {
    this.stop();
    this.detach();
  }
}

/**
 * Factory function
 */
export function createAutoScroller(options?: Partial<AutoScrollOptions>): AutoScroller {
  return new AutoScroller(options);
}

export default AutoScroller;
