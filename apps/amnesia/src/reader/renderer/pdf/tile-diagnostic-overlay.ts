/**
 * Tile Diagnostic Overlay
 *
 * A floating diagnostic panel that shows real-time tile rendering state.
 * Helps debug tile corruption issues by visualizing:
 * - Current zoom and scale
 * - Tile cache status
 * - Active renders
 * - Scale mismatches
 *
 * Usage:
 *   const overlay = getTileDiagnosticOverlay();
 *   overlay.show();
 *   overlay.update({ zoom: 8.0, tileScale: 12, ... });
 */

import { getTileCacheManager } from './tile-cache-manager';
import { getRenderCoordinator } from './render-coordinator';
import { getFeatureFlags } from './feature-flags';
import { getScaleStateManager } from './scale-state-manager';
import type { GesturePhase } from './zoom-scale-service';

/**
 * Phase transition record for timing analysis (amnesia-e4i)
 */
export interface PhaseTransition {
  from: GesturePhase;
  to: GesturePhase;
  timestamp: number;
  duration: number;  // How long we were in 'from' phase (ms)
}

export interface DiagnosticState {
  zoom: number;
  tileScale: number;
  requestedScale: number;
  pixelRatio: number;
  renderMode: 'tiled' | 'full-page';
  activeTileRenders: number;
  queuedTileRenders: number;
  cacheL1Count: number;
  cacheL2Count: number;
  lastRenderTime: number;
  scaleMismatch: boolean;
  lastTileCoords?: { page: number; x: number; y: number; scale: number }[];
  
  // Enhanced fields for amnesia-e4i debugging
  /** Current scale epoch for INV-2 tracking */
  currentEpoch: number;
  /** Last tile's epoch (for mismatch detection) */
  lastTileEpoch: number;
  /** Count of epoch mismatches in last 10s */
  epochMismatchCount: number;
  /** Current gesture phase */
  gesturePhase: GesturePhase;
  /** Focal point in canvas coordinates */
  focalPoint: { x: number; y: number } | null;
  /** Expected tile count for current viewport */
  expectedTileCount: number;
  /** Actual tiles received */
  actualTileCount: number;
  /** Coverage percentage */
  coveragePercent: number;
  /** Unique scales in last batch */
  uniqueScalesInBatch: number[];
  /** Average cssStretch */
  avgCssStretch: number;
  /** Tiles dropped in last 10s */
  dropsLast10s: number;
  /** Tiles aborted in last 10s */
  abortsLast10s: number;
  /** Last drop/abort reason */
  lastDropReason: string | null;
  
  // Phase timing (amnesia-e4i)
  /** Recent phase transitions for timing analysis */
  phaseTransitions: PhaseTransition[];
  /** Average duration spent in each phase (ms) */
  avgPhaseDurations: Record<GesturePhase, number>;
  /** Timestamp when current phase started */
  lastPhaseChangeTime: number;
  /** How long we've been in current phase (ms) */
  currentPhaseDuration: number;
}

let overlayInstance: TileDiagnosticOverlay | null = null;

export class TileDiagnosticOverlay {
  private container: HTMLDivElement | null = null;
  private state: DiagnosticState = {
    zoom: 1,
    tileScale: 1,
    requestedScale: 1,
    pixelRatio: 2,
    renderMode: 'full-page',
    activeTileRenders: 0,
    queuedTileRenders: 0,
    cacheL1Count: 0,
    cacheL2Count: 0,
    lastRenderTime: 0,
    scaleMismatch: false,
    // Enhanced fields
    currentEpoch: 0,
    lastTileEpoch: 0,
    epochMismatchCount: 0,
    gesturePhase: 'idle',
    focalPoint: null,
    expectedTileCount: 0,
    actualTileCount: 0,
    coveragePercent: 100,
    uniqueScalesInBatch: [],
    avgCssStretch: 1,
    dropsLast10s: 0,
    abortsLast10s: 0,
    lastDropReason: null,
    // Phase timing defaults
    phaseTransitions: [],
    avgPhaseDurations: { idle: 0, active: 0, settling: 0, rendering: 0 },
    lastPhaseChangeTime: performance.now(),
    currentPhaseDuration: 0,
  };
  
  // Tracking for rate-limited counters
  private dropEvents: number[] = [];
  private abortEvents: number[] = [];
  private epochMismatchEvents: number[] = [];
  private updateInterval: number | null = null;
  
  // Phase transition tracking (amnesia-e4i)
  private phaseTransitionHistory: PhaseTransition[] = [];
  private static readonly MAX_PHASE_TRANSITIONS = 50; // Limit to prevent memory leaks

  show(): void {
    if (this.container) return;

    this.container = document.createElement('div');
    this.container.id = 'tile-diagnostic-overlay';
    this.container.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      width: 320px;
      background: rgba(0, 0, 0, 0.85);
      color: #00ff00;
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 11px;
      padding: 12px;
      border-radius: 8px;
      z-index: 99999;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
      user-select: none;
      pointer-events: auto;
    `;

    this.render();
    document.body.appendChild(this.container);

    // Auto-update every 100ms
    this.updateInterval = window.setInterval(() => this.autoUpdate(), 100);
  }

  hide(): void {
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  toggle(): void {
    if (this.container) {
      this.hide();
    } else {
      this.show();
    }
  }

  update(partial: Partial<DiagnosticState>): void {
    this.state = { ...this.state, ...partial };
    // Only update data elements, don't re-render (preserves event listeners)
    this.updateDataElements();
  }

  private autoUpdate(): void {
    // Pull live data from various sources
    try {
      const cacheManager = getTileCacheManager();
      const cacheStats = cacheManager.getStats?.() ?? { l1Count: 0, l2Count: 0, l3Count: 0 };

      const coordinator = getRenderCoordinator();
      const coordStats = (coordinator as any).getStats?.() ?? {
        activeRenders: (coordinator as any).activeRenders ?? 0,
        queueSize: (coordinator as any).semaphore?.waiting ?? 0,
      };

      this.state.cacheL1Count = cacheStats.l1Count ?? 0;
      this.state.cacheL2Count = cacheStats.l2Count ?? 0;
      this.state.activeTileRenders = coordStats.activeRenders ?? 0;
      this.state.queuedTileRenders = coordStats.queueSize ?? 0;

      // Check for scale mismatch
      this.state.scaleMismatch = Math.abs(this.state.tileScale - this.state.requestedScale) > 0.5;

      // Pull from ScaleStateManager if available
      const scaleManager = getScaleStateManager('default');
      if (scaleManager) {
        this.state.currentEpoch = scaleManager.getEpoch();
        this.state.gesturePhase = scaleManager.getState().gesturePhase;
        const focalPoint = scaleManager.getFocalPoint();
        this.state.focalPoint = focalPoint;
      }
      
      // Calculate coverage
      if (this.state.expectedTileCount > 0) {
        this.state.coveragePercent = (this.state.actualTileCount / this.state.expectedTileCount) * 100;
      }
      
      // Clean up old events (older than 10 seconds)
      const now = performance.now();
      const cutoff = now - 10000;
      this.dropEvents = this.dropEvents.filter(t => t > cutoff);
      this.abortEvents = this.abortEvents.filter(t => t > cutoff);
      this.epochMismatchEvents = this.epochMismatchEvents.filter(t => t > cutoff);
      
      this.state.dropsLast10s = this.dropEvents.length;
      this.state.abortsLast10s = this.abortEvents.length;
      this.state.epochMismatchCount = this.epochMismatchEvents.length;
      
      // Update current phase duration (amnesia-e4i)
      this.state.currentPhaseDuration = now - this.state.lastPhaseChangeTime;

      // Only update data elements, not the whole DOM (preserves event listeners)
      this.updateDataElements();
    } catch {
      // Ignore errors during auto-update
    }
  }
  
  /**
   * Record a tile drop event (called externally when tiles are dropped from queue)
   */
  recordDrop(reason: string): void {
    this.dropEvents.push(performance.now());
    this.state.lastDropReason = reason;
  }
  
  /**
   * Record a tile abort event (called externally when tiles are aborted)
   */
  recordAbort(reason: string): void {
    this.abortEvents.push(performance.now());
    this.state.lastDropReason = reason;
  }
  
  /**
   * Record an epoch mismatch (called when stale tile is detected)
   */
  recordEpochMismatch(tileEpoch: number): void {
    this.epochMismatchEvents.push(performance.now());
    this.state.lastTileEpoch = tileEpoch;
  }
  
  /**
   * Record a phase transition (amnesia-e4i: for timing analysis)
   * Called when gesture phase changes (idle → active → settling → rendering → idle)
   */
  recordPhaseTransition(from: GesturePhase, to: GesturePhase): void {
    const now = performance.now();
    const duration = now - this.state.lastPhaseChangeTime;
    
    const transition: PhaseTransition = { from, to, timestamp: now, duration };
    this.phaseTransitionHistory.push(transition);
    
    // Limit history to prevent memory leaks
    while (this.phaseTransitionHistory.length > TileDiagnosticOverlay.MAX_PHASE_TRANSITIONS) {
      this.phaseTransitionHistory.shift();
    }
    
    // Update state
    this.state.phaseTransitions = [...this.phaseTransitionHistory];
    this.state.lastPhaseChangeTime = now;
    this.state.gesturePhase = to;
    
    // Update averages
    this.updatePhaseAverages();
    
    // Log for debugging
    const durationStr = duration < 1000 ? `${duration.toFixed(0)}ms` : `${(duration / 1000).toFixed(1)}s`;
    console.log(`[PhaseTransition] ${from} → ${to} (was in ${from} for ${durationStr})`);
  }
  
  /**
   * Format duration in human-readable form
   */
  private formatDuration(ms: number): string {
    if (ms < 1) return '0ms';
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }
  
  /**
   * Update average phase durations based on transition history
   */
  private updatePhaseAverages(): void {
    const phaseDurations: Record<GesturePhase, number[]> = {
      idle: [],
      active: [],
      settling: [],
      rendering: [],
    };
    
    // Collect durations by phase (the 'from' phase tells us how long we were in it)
    for (const t of this.phaseTransitionHistory) {
      if (t.from in phaseDurations) {
        phaseDurations[t.from].push(t.duration);
      }
    }
    
    // Calculate averages
    for (const phase of Object.keys(phaseDurations) as GesturePhase[]) {
      const durations = phaseDurations[phase];
      if (durations.length > 0) {
        const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
        this.state.avgPhaseDurations[phase] = avg;
      }
    }
  }
  
  /**
   * Get current state (for export/debugging)
   */
  getState(): DiagnosticState {
    return { ...this.state };
  }

  private updateDataElements(): void {
    if (!this.container) return;
    
    const s = this.state;
    const update = (id: string, value: string, color?: string) => {
      const el = this.container?.querySelector(`#${id}`);
      if (el) {
        el.textContent = value;
        if (color) (el as HTMLElement).style.color = color;
      }
    };

    const mismatchColor = s.scaleMismatch ? '#ff4444' : '#00ff00';
    const coverageColor = s.coveragePercent < 95 ? '#ff4444' : s.coveragePercent < 100 ? '#ffaa00' : '#00ff00';
    const epochColor = s.epochMismatchCount > 0 ? '#ff4444' : '#00ff00';
    const phaseColor = s.gesturePhase === 'active' ? '#ffaa00' : s.gesturePhase === 'settling' ? '#00ffff' : '#00ff00';
    const multiScaleColor = s.uniqueScalesInBatch.length > 1 ? '#ffaa00' : '#00ff00';
    
    // Camera section
    update('diag-zoom', `${s.zoom.toFixed(2)}x`);
    update('diag-epoch', String(s.currentEpoch), epochColor);
    update('diag-mode', s.renderMode.toUpperCase(), s.renderMode === 'tiled' ? '#00ffff' : '#ffff00');
    update('diag-phase', s.gesturePhase.toUpperCase(), phaseColor);
    update('diag-focal', s.focalPoint ? `(${s.focalPoint.x.toFixed(0)}, ${s.focalPoint.y.toFixed(0)})` : 'none');
    
    // Scale section
    update('diag-pixelratio', s.pixelRatio.toFixed(1));
    update('diag-reqscale', s.requestedScale.toFixed(2));
    update('diag-tilescale', `${s.tileScale.toFixed(2)} ${s.scaleMismatch ? '⚠️' : '✓'}`, mismatchColor);
    update('diag-cssstretch', s.avgCssStretch.toFixed(2));
    update('diag-uniquescales', s.uniqueScalesInBatch.length > 0 ? `[${s.uniqueScalesInBatch.join(', ')}]` : '[]', multiScaleColor);
    
    // Coverage section
    update('diag-expected', String(s.expectedTileCount));
    update('diag-actual', String(s.actualTileCount));
    update('diag-coverage', `${s.coveragePercent.toFixed(1)}%`, coverageColor);
    
    // Queue section
    update('diag-active', String(s.activeTileRenders), s.activeTileRenders > 10 ? '#ffaa00' : '#fff');
    update('diag-queue', String(s.queuedTileRenders), s.queuedTileRenders > 100 ? '#ff4444' : '#fff');
    update('diag-drops', String(s.dropsLast10s), s.dropsLast10s > 0 ? '#ff4444' : '#888');
    update('diag-aborts', String(s.abortsLast10s), s.abortsLast10s > 0 ? '#ffaa00' : '#888');
    
    // Cache section
    update('diag-l1', `${s.cacheL1Count} tiles`);
    update('diag-l2', `${s.cacheL2Count} tiles`);
    update('diag-rendertime', `${s.lastRenderTime.toFixed(0)}ms`);
    
    // Phase timing section (amnesia-e4i)
    const phaseDurationColor = s.currentPhaseDuration > 2000 ? '#ff4444' : s.currentPhaseDuration > 500 ? '#ffaa00' : '#00ff00';
    update('diag-phase-duration', this.formatDuration(s.currentPhaseDuration), phaseDurationColor);
    update('diag-transition-count', String(s.phaseTransitions.length));
    update('diag-avg-active', this.formatDuration(s.avgPhaseDurations.active), s.avgPhaseDurations.active > 500 ? '#ffaa00' : '#00ff00');
    update('diag-avg-settling', this.formatDuration(s.avgPhaseDurations.settling), s.avgPhaseDurations.settling > 500 ? '#ff4444' : s.avgPhaseDurations.settling > 300 ? '#ffaa00' : '#00ff00');
    update('diag-avg-rendering', this.formatDuration(s.avgPhaseDurations.rendering), s.avgPhaseDurations.rendering > 1000 ? '#ff4444' : '#00ff00');
    update('diag-avg-idle', this.formatDuration(s.avgPhaseDurations.idle), '#888');
    
    // Invariant status
    const inv2Status = s.epochMismatchCount === 0 ? '✓' : '⚠️';
    const inv6Status = s.uniqueScalesInBatch.length <= 1 ? '✓' : '⚠️';
    const inv6aStatus = Math.abs(s.avgCssStretch - 1) < 0.5 ? '✓' : '⚠️';
    update('diag-inv2', inv2Status, s.epochMismatchCount === 0 ? '#00ff00' : '#ff4444');
    update('diag-inv6', inv6Status, s.uniqueScalesInBatch.length <= 1 ? '#00ff00' : '#ffaa00');
    update('diag-inv6a', inv6aStatus, Math.abs(s.avgCssStretch - 1) < 0.5 ? '#00ff00' : '#ffaa00');
  }

  private render(): void {
    if (!this.container) return;

    const s = this.state;
    const mismatchColor = s.scaleMismatch ? '#ff4444' : '#00ff00';
    const modeColor = s.renderMode === 'tiled' ? '#00ffff' : '#ffff00';
    const coverageColor = s.coveragePercent < 95 ? '#ff4444' : s.coveragePercent < 100 ? '#ffaa00' : '#00ff00';
    const epochColor = s.epochMismatchCount > 0 ? '#ff4444' : '#00ff00';
    const phaseColor = s.gesturePhase === 'active' ? '#ffaa00' : s.gesturePhase === 'settling' ? '#00ffff' : '#00ff00';

    this.container.innerHTML = `
      <div style="display: flex; justify-content: space-between; margin-bottom: 8px; border-bottom: 1px solid #444; padding-bottom: 8px;">
        <strong style="color: #fff;">TILE DIAGNOSTICS (amnesia-e4i)</strong>
        <span id="diag-close" style="color: #888; cursor: pointer; font-size: 14px; padding: 4px;">✕</span>
      </div>

      <!-- CAMERA SECTION -->
      <div style="color: #666; font-size: 10px; margin-bottom: 4px;">CAMERA</div>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 8px;">
        <tr>
          <td style="color: #888;">Zoom:</td>
          <td id="diag-zoom" style="color: #fff; text-align: right;">${s.zoom.toFixed(2)}x</td>
          <td style="color: #888; padding-left: 12px;">Epoch:</td>
          <td id="diag-epoch" style="color: ${epochColor}; text-align: right;">${s.currentEpoch}</td>
        </tr>
        <tr>
          <td style="color: #888;">Mode:</td>
          <td id="diag-mode" style="color: ${modeColor}; text-align: right;">${s.renderMode.toUpperCase()}</td>
          <td style="color: #888; padding-left: 12px;">Phase:</td>
          <td id="diag-phase" style="color: ${phaseColor}; text-align: right;">${s.gesturePhase.toUpperCase()}</td>
        </tr>
        <tr>
          <td style="color: #888;">Focal:</td>
          <td id="diag-focal" style="color: #fff; text-align: right;" colspan="3">${s.focalPoint ? `(${s.focalPoint.x.toFixed(0)}, ${s.focalPoint.y.toFixed(0)})` : 'none'}</td>
        </tr>
      </table>

      <!-- SCALE SECTION -->
      <div style="color: #666; font-size: 10px; margin-bottom: 4px; border-top: 1px solid #333; padding-top: 8px;">SCALE</div>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 8px;">
        <tr>
          <td style="color: #888;">Requested:</td>
          <td id="diag-reqscale" style="color: #fff; text-align: right;">${s.requestedScale.toFixed(2)}</td>
          <td style="color: #888; padding-left: 12px;">Actual:</td>
          <td id="diag-tilescale" style="color: ${mismatchColor}; text-align: right;">${s.tileScale.toFixed(2)} ${s.scaleMismatch ? '⚠️' : '✓'}</td>
        </tr>
        <tr>
          <td style="color: #888;">DPR:</td>
          <td id="diag-pixelratio" style="color: #fff; text-align: right;">${s.pixelRatio.toFixed(1)}</td>
          <td style="color: #888; padding-left: 12px;">cssStretch:</td>
          <td id="diag-cssstretch" style="color: #fff; text-align: right;">${s.avgCssStretch.toFixed(2)}</td>
        </tr>
        <tr>
          <td style="color: #888;">Scales:</td>
          <td id="diag-uniquescales" style="color: ${s.uniqueScalesInBatch.length > 1 ? '#ffaa00' : '#00ff00'}; text-align: right;" colspan="3">${s.uniqueScalesInBatch.length > 0 ? `[${s.uniqueScalesInBatch.join(', ')}]` : '[]'}</td>
        </tr>
      </table>

      <!-- COVERAGE SECTION -->
      <div style="color: #666; font-size: 10px; margin-bottom: 4px; border-top: 1px solid #333; padding-top: 8px;">COVERAGE</div>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 8px;">
        <tr>
          <td style="color: #888;">Expected:</td>
          <td id="diag-expected" style="color: #fff; text-align: right;">${s.expectedTileCount}</td>
          <td style="color: #888; padding-left: 12px;">Actual:</td>
          <td id="diag-actual" style="color: #fff; text-align: right;">${s.actualTileCount}</td>
        </tr>
        <tr>
          <td style="color: #888;">Coverage:</td>
          <td id="diag-coverage" style="color: ${coverageColor}; text-align: right;" colspan="3">${s.coveragePercent.toFixed(1)}%</td>
        </tr>
      </table>

      <!-- QUEUE SECTION -->
      <div style="color: #666; font-size: 10px; margin-bottom: 4px; border-top: 1px solid #333; padding-top: 8px;">QUEUE</div>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 8px;">
        <tr>
          <td style="color: #888;">Active:</td>
          <td id="diag-active" style="color: ${s.activeTileRenders > 10 ? '#ffaa00' : '#fff'}; text-align: right;">${s.activeTileRenders}</td>
          <td style="color: #888; padding-left: 12px;">Queued:</td>
          <td id="diag-queue" style="color: ${s.queuedTileRenders > 100 ? '#ff4444' : '#fff'}; text-align: right;">${s.queuedTileRenders}</td>
        </tr>
        <tr>
          <td style="color: #888;">Drops (10s):</td>
          <td id="diag-drops" style="color: ${s.dropsLast10s > 0 ? '#ff4444' : '#888'}; text-align: right;">${s.dropsLast10s}</td>
          <td style="color: #888; padding-left: 12px;">Aborts (10s):</td>
          <td id="diag-aborts" style="color: ${s.abortsLast10s > 0 ? '#ffaa00' : '#888'}; text-align: right;">${s.abortsLast10s}</td>
        </tr>
      </table>

      <!-- CACHE SECTION -->
      <div style="color: #666; font-size: 10px; margin-bottom: 4px; border-top: 1px solid #333; padding-top: 8px;">CACHE</div>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 8px;">
        <tr>
          <td style="color: #888;">L1:</td>
          <td id="diag-l1" style="color: #fff; text-align: right;">${s.cacheL1Count} tiles</td>
          <td style="color: #888; padding-left: 12px;">L2:</td>
          <td id="diag-l2" style="color: #fff; text-align: right;">${s.cacheL2Count} tiles</td>
        </tr>
        <tr>
          <td style="color: #888;">Last Render:</td>
          <td id="diag-rendertime" style="color: #fff; text-align: right;" colspan="3">${s.lastRenderTime.toFixed(0)}ms</td>
        </tr>
      </table>

      <!-- PHASE TIMING SECTION (amnesia-e4i) -->
      <div style="color: #666; font-size: 10px; margin-bottom: 4px; border-top: 1px solid #333; padding-top: 8px;">PHASE TIMING</div>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 8px;">
        <tr>
          <td style="color: #888;">In Phase:</td>
          <td id="diag-phase-duration" style="color: ${s.currentPhaseDuration > 2000 ? '#ff4444' : s.currentPhaseDuration > 500 ? '#ffaa00' : '#00ff00'}; text-align: right;">${this.formatDuration(s.currentPhaseDuration)}</td>
          <td style="color: #888; padding-left: 12px;">Transitions:</td>
          <td id="diag-transition-count" style="color: #fff; text-align: right;">${s.phaseTransitions.length}</td>
        </tr>
        <tr>
          <td style="color: #888;">Avg Active:</td>
          <td id="diag-avg-active" style="color: ${s.avgPhaseDurations.active > 500 ? '#ffaa00' : '#00ff00'}; text-align: right;">${this.formatDuration(s.avgPhaseDurations.active)}</td>
          <td style="color: #888; padding-left: 12px;">Avg Settling:</td>
          <td id="diag-avg-settling" style="color: ${s.avgPhaseDurations.settling > 500 ? '#ff4444' : s.avgPhaseDurations.settling > 300 ? '#ffaa00' : '#00ff00'}; text-align: right;">${this.formatDuration(s.avgPhaseDurations.settling)}</td>
        </tr>
        <tr>
          <td style="color: #888;">Avg Rendering:</td>
          <td id="diag-avg-rendering" style="color: ${s.avgPhaseDurations.rendering > 1000 ? '#ff4444' : '#00ff00'}; text-align: right;">${this.formatDuration(s.avgPhaseDurations.rendering)}</td>
          <td style="color: #888; padding-left: 12px;">Avg Idle:</td>
          <td id="diag-avg-idle" style="color: #888; text-align: right;">${this.formatDuration(s.avgPhaseDurations.idle)}</td>
        </tr>
      </table>

      <!-- INVARIANTS SECTION -->
      <div style="color: #666; font-size: 10px; margin-bottom: 4px; border-top: 1px solid #333; padding-top: 8px;">INVARIANTS</div>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 8px;">
        <tr>
          <td style="color: #888;">INV-2 (Epoch):</td>
          <td id="diag-inv2" style="color: ${s.epochMismatchCount === 0 ? '#00ff00' : '#ff4444'}; text-align: right;">${s.epochMismatchCount === 0 ? '✓' : '⚠️'}</td>
          <td style="color: #888; padding-left: 12px;">INV-6 (Scale):</td>
          <td id="diag-inv6" style="color: ${s.uniqueScalesInBatch.length <= 1 ? '#00ff00' : '#ffaa00'}; text-align: right;">${s.uniqueScalesInBatch.length <= 1 ? '✓' : '⚠️'}</td>
        </tr>
        <tr>
          <td style="color: #888;">INV-6a (Stretch):</td>
          <td id="diag-inv6a" style="color: ${Math.abs(s.avgCssStretch - 1) < 0.5 ? '#00ff00' : '#ffaa00'}; text-align: right;">${Math.abs(s.avgCssStretch - 1) < 0.5 ? '✓' : '⚠️'}</td>
          <td colspan="2"></td>
        </tr>
      </table>

      <!-- RECENT TILES -->
      <div id="diag-tiles-section" style="margin-top: 8px; border-top: 1px solid #333; padding-top: 8px; display: ${s.lastTileCoords && s.lastTileCoords.length > 0 ? 'block' : 'none'};">
        <div style="color: #888; margin-bottom: 4px;">Recent Tiles:</div>
        <div id="diag-tiles-list" style="font-size: 10px; color: #666; max-height: 60px; overflow-y: auto;">
          ${(s.lastTileCoords || []).slice(-5).map(t =>
            `<div>p${t.page} (${t.x},${t.y}) s${t.scale}</div>`
          ).join('')}
        </div>
      </div>

      <!-- BUTTONS -->
      <div style="margin-top: 8px; border-top: 1px solid #333; padding-top: 8px; display: flex; gap: 4px; flex-wrap: wrap;">
        <button id="diag-debug-tiles" style="background: #444; border: 1px solid #666; color: #fff; padding: 6px 12px; cursor: pointer; border-radius: 4px; flex: 1;">
          Debug Tiles
        </button>
        <button id="diag-clear-cache" style="background: #444; border: 1px solid #666; color: #fff; padding: 6px 12px; cursor: pointer; border-radius: 4px; flex: 1;">
          Clear Cache
        </button>
        <button id="diag-export" style="background: #444; border: 1px solid #666; color: #fff; padding: 6px 12px; cursor: pointer; border-radius: 4px; flex: 1;">
          Export
        </button>
      </div>
    `;

    // Attach event listeners ONCE after initial render
    this.attachEventListeners();
  }

  private attachEventListeners(): void {
    if (!this.container) return;

    // Attach event listeners with explicit binding to survive innerHTML updates
    const closeBtn = this.container.querySelector('#diag-close');
    const debugBtn = this.container.querySelector('#diag-debug-tiles');
    const clearBtn = this.container.querySelector('#diag-clear-cache');
    const exportBtn = this.container.querySelector('#diag-export');
    
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.hide();
      });
    }
    
    if (debugBtn) {
      debugBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const flagsManager = getFeatureFlags();
        const current = flagsManager.isEnabled('useDebugTiles');
        flagsManager.setFlag('useDebugTiles', !current);
        alert(`Debug tiles ${!current ? 'ENABLED' : 'DISABLED'} - scroll/pan to see effect`);
        console.log(`[DIAG] Debug tiles ${!current ? 'ENABLED' : 'DISABLED'} - scroll to see effect`);
      });
    }
    
    if (clearBtn) {
      clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        getTileCacheManager().clear();
        alert('Cache cleared - scroll to re-render tiles');
        console.log('[DIAG] Cache cleared');
      });
    }
    
    if (exportBtn) {
      exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.exportDiagnostics();
      });
    }
  }
  
  /**
   * Export current diagnostic state and recent events as JSON.
   * Downloads as a file for analysis.
   */
  private exportDiagnostics(): void {
    const exportData = {
      timestamp: new Date().toISOString(),
      state: this.getState(),
      events: {
        dropsLast10s: this.dropEvents.length,
        abortsLast10s: this.abortEvents.length,
        epochMismatchesLast10s: this.epochMismatchEvents.length,
        // Include raw timestamps for timeline analysis
        dropTimestamps: this.dropEvents.slice(-50),
        abortTimestamps: this.abortEvents.slice(-50),
        epochMismatchTimestamps: this.epochMismatchEvents.slice(-50),
      },
      cacheStats: (() => {
        try {
          return getTileCacheManager().getStats?.() ?? null;
        } catch { return null; }
      })(),
      coordinatorStats: (() => {
        try {
          const coordinator = getRenderCoordinator();
          return (coordinator as any).getStats?.() ?? null;
        } catch { return null; }
      })(),
    };
    
    // Create and download JSON file
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tile-diagnostics-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    console.log('[DIAG] Exported diagnostics:', exportData);
  }
}

export function getTileDiagnosticOverlay(): TileDiagnosticOverlay {
  if (!overlayInstance) {
    overlayInstance = new TileDiagnosticOverlay();
  }
  return overlayInstance;
}

// Expose to window for console access
if (typeof window !== 'undefined') {
  (window as any).tileDiag = {
    show: () => getTileDiagnosticOverlay().show(),
    hide: () => getTileDiagnosticOverlay().hide(),
    toggle: () => getTileDiagnosticOverlay().toggle(),
    update: (state: Partial<DiagnosticState>) => getTileDiagnosticOverlay().update(state),
    getState: () => getTileDiagnosticOverlay().getState(),
    recordDrop: (reason: string) => getTileDiagnosticOverlay().recordDrop(reason),
    recordAbort: (reason: string) => getTileDiagnosticOverlay().recordAbort(reason),
    recordEpochMismatch: (epoch: number) => getTileDiagnosticOverlay().recordEpochMismatch(epoch),
  };
}
