/**
 * Standalone HUD Integration
 *
 * Self-contained HUD that works without Doc Doctor.
 * Manages status bar registration, HUD lifecycle, and rendering.
 */

import { Menu } from 'obsidian';
import type { App, Plugin } from 'obsidian';
import type { SvelteComponent } from 'svelte';
import type { Store } from '../../helpers/store';
import type { AmnesiaHUDState, AmnesiaHUDAction } from '../types';
import { createHUDStore, HUDActions } from '../state/hud-store';
import type { AmnesiaHUDProvider } from '../providers/AmnesiaHUDProvider';
import StatusBarItem from '../components/StatusBarItem.svelte';
import CompactView from '../components/CompactView.svelte';

export class AmnesiaHUD {
  private app: App;
  private plugin: Plugin;
  private provider: AmnesiaHUDProvider;
  private store: Store<AmnesiaHUDState, AmnesiaHUDAction>;

  private statusBarEl: HTMLElement | null = null;
  private statusBarComponent: SvelteComponent | null = null;
  private compactViewComponent: SvelteComponent | null = null;
  private compactViewContainer: HTMLElement | null = null;

  private unsubscribeStore: (() => void) | null = null;

  constructor(app: App, plugin: Plugin, provider: AmnesiaHUDProvider) {
    this.app = app;
    this.plugin = plugin;
    this.provider = provider;
    this.store = createHUDStore();
  }

  /**
   * Initialize the HUD
   */
  async initialize(): Promise<void> {
    console.log('[AmnesiaHUD] Initializing standalone HUD...');

    // Create status bar item
    this.createStatusBarItem();

    // Subscribe to store changes
    this.unsubscribeStore = this.store.subscribe((state) => {
      this.handleStateChange(state);
    });

    console.log('[AmnesiaHUD] Standalone HUD initialized');
  }

  /**
   * Create status bar item
   */
  private createStatusBarItem(): void {
    // Get status bar from Obsidian
    const statusBar = (this.app as any).statusBar?.containerEl;
    if (!statusBar) {
      console.warn('[AmnesiaHUD] Status bar not available');
      return;
    }

    // Create container element
    this.statusBarEl = document.createElement('div');
    this.statusBarEl.addClass('amnesia-hud-status-container');

    // Mount Svelte component (Svelte 4 syntax)
    this.statusBarComponent = new StatusBarItem({
      target: this.statusBarEl,
      props: {
        provider: this.provider,
        showServerStatus: true,
      },
    });

    // Add event listeners
    this.statusBarEl.addEventListener('click', () => {
      this.store.dispatch(HUDActions.toggle());
    });

    this.statusBarEl.addEventListener('contextmenu', (event) => {
      this.handleContextMenu(event as MouseEvent);
    });

    // Insert into status bar
    statusBar.insertBefore(this.statusBarEl, statusBar.firstChild);
  }

  /**
   * Handle state changes
   */
  private handleStateChange(state: AmnesiaHUDState): void {
    if (state.isOpen) {
      this.showCompactView();
    } else {
      this.hideCompactView();
    }
  }

  /**
   * Show the compact view
   */
  private showCompactView(): void {
    if (this.compactViewContainer) return; // Already showing

    // Create container
    this.compactViewContainer = document.createElement('div');
    this.compactViewContainer.addClass('amnesia-hud-portal');
    document.body.appendChild(this.compactViewContainer);

    // Mount Svelte component (Svelte 4 syntax)
    this.compactViewComponent = new CompactView({
      target: this.compactViewContainer,
      props: {
        store: this.store,
        provider: this.provider,
        referenceEl: this.statusBarEl,
      },
    });

    // Listen for close events (Svelte 4 uses $on)
    this.compactViewComponent.$on('close', () => {
      this.store.dispatch(HUDActions.close());
    });
  }

  /**
   * Hide the compact view
   */
  private hideCompactView(): void {
    if (!this.compactViewContainer) return;

    // Destroy Svelte component (Svelte 4 uses $destroy)
    if (this.compactViewComponent) {
      this.compactViewComponent.$destroy();
      this.compactViewComponent = null;
    }

    // Remove container
    this.compactViewContainer.remove();
    this.compactViewContainer = null;
  }

  /**
   * Handle context menu
   */
  private handleContextMenu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();

    const menu = new Menu();
    const state = this.store.getValue();

    // Pin/Unpin HUD
    menu.addItem((item) =>
      item
        .setTitle(state.isPinned ? 'Unpin HUD' : 'Pin HUD')
        .setIcon(state.isPinned ? 'pin-off' : 'pin')
        .onClick(() => {
          this.store.dispatch(HUDActions.pin(!state.isPinned));
        })
    );

    menu.addSeparator();

    // Quick jump to tabs
    menu.addItem((item) =>
      item
        .setTitle('Reading')
        .setIcon('book-open')
        .onClick(() => {
          this.store.dispatch(HUDActions.open());
          this.store.dispatch(HUDActions.setTab('reading'));
        })
    );

    menu.addItem((item) =>
      item
        .setTitle('Library')
        .setIcon('library')
        .onClick(() => {
          this.store.dispatch(HUDActions.open());
          this.store.dispatch(HUDActions.setTab('library'));
        })
    );

    menu.addItem((item) =>
      item
        .setTitle('Stats')
        .setIcon('bar-chart-2')
        .onClick(() => {
          this.store.dispatch(HUDActions.open());
          this.store.dispatch(HUDActions.setTab('stats'));
        })
    );

    menu.addItem((item) =>
      item
        .setTitle('Server')
        .setIcon('server')
        .onClick(() => {
          this.store.dispatch(HUDActions.open());
          this.store.dispatch(HUDActions.setTab('server'));
        })
    );

    menu.addSeparator();

    // Server controls
    const serverStatus = this.provider.getServerStatusInfo();
    if (serverStatus.status === 'running') {
      menu.addItem((item) =>
        item
          .setTitle('Stop Server')
          .setIcon('square')
          .onClick(() => {
            this.provider.stopServer();
          })
      );
      menu.addItem((item) =>
        item
          .setTitle('Restart Server')
          .setIcon('refresh-cw')
          .onClick(() => {
            this.provider.restartServer();
          })
      );
    } else if (serverStatus.status === 'stopped' || serverStatus.status === 'error') {
      menu.addItem((item) =>
        item
          .setTitle('Start Server')
          .setIcon('play')
          .onClick(() => {
            this.provider.startServer();
          })
      );
    }

    menu.addSeparator();

    // HUD Settings
    menu.addItem((item) =>
      item
        .setTitle('HUD Settings...')
        .setIcon('settings')
        .onClick(() => {
          // Open settings to HUD tab
          (this.app as any).setting.open();
          (this.app as any).setting.openTabById?.('amnesia');
        })
    );

    menu.showAtMouseEvent(event);
  }

  /**
   * Toggle HUD visibility
   */
  toggle(): void {
    this.store.dispatch(HUDActions.toggle());
  }

  /**
   * Open HUD
   */
  open(): void {
    this.store.dispatch(HUDActions.open());
  }

  /**
   * Close HUD
   */
  close(): void {
    this.store.dispatch(HUDActions.close());
  }

  /**
   * Check if HUD is open
   */
  isOpen(): boolean {
    return this.store.getValue().isOpen;
  }

  /**
   * Get the store (for external access)
   */
  getStore(): Store<AmnesiaHUDState, AmnesiaHUDAction> {
    return this.store;
  }

  /**
   * Destroy the HUD
   */
  destroy(): void {
    console.log('[AmnesiaHUD] Destroying standalone HUD...');

    // Unsubscribe from store
    if (this.unsubscribeStore) {
      this.unsubscribeStore();
      this.unsubscribeStore = null;
    }

    // Hide compact view
    this.hideCompactView();

    // Destroy status bar component (Svelte 4 uses $destroy)
    if (this.statusBarComponent) {
      this.statusBarComponent.$destroy();
      this.statusBarComponent = null;
    }

    // Remove status bar element
    if (this.statusBarEl) {
      this.statusBarEl.remove();
      this.statusBarEl = null;
    }

    // Destroy provider
    this.provider.destroy();

    console.log('[AmnesiaHUD] Standalone HUD destroyed');
  }
}
