<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Store } from '../../../helpers/store';
  import type { AmnesiaHUDState, AmnesiaHUDAction } from '../../types/index';
  import type { AmnesiaHUDProvider } from '../../providers/AmnesiaHUDProvider';
  
  // Import diagnostic services from PDF renderer
  import { getT2HRTracker, type T2HRStats, type TileT2HRResult, getT2HRThreshold } from '../../../reader/renderer/pdf/t2hr-tracker';
  import { getFocalPointTracker, type FocalPointStats, type FocalPointGesture } from '../../../reader/renderer/pdf/focal-point-tracker';
  import { getDeviceProfileSync, type DeviceProfile, type DeviceTier } from '../../../reader/renderer/pdf/device-profiler';
  import { getPerformanceConfig, getCurrentTier, type PerformanceConfig } from '../../../reader/renderer/pdf/performance-config';
  import { getFeatureFlags, type ResolvedFeatureFlags } from '../../../reader/renderer/pdf/feature-flags';
  import { getTileCacheManager } from '../../../reader/renderer/pdf/tile-cache-manager';
  import { runHealthCheck, type HealthCheckReport, type HealthStatus } from '../../../reader/renderer/pdf/optimization-health-check';

  export let provider: AmnesiaHUDProvider;
  export let store: Store<AmnesiaHUDState, AmnesiaHUDAction>;

  // State
  let deviceProfile: DeviceProfile | null = null;
  let deviceTier: DeviceTier = 'medium';
  let performanceConfig: PerformanceConfig | null = null;
  let featureFlags: ResolvedFeatureFlags | null = null;
  let t2hrStats: T2HRStats | null = null;
  let focalPointStats: FocalPointStats | null = null;
  let recentT2HR: TileT2HRResult[] = [];
  let lastGesture: FocalPointGesture | null = null;
  
  // Health check state
  let healthReport: HealthCheckReport | null = null;
  let isRunningHealthCheck = false;
  
  // Refresh interval
  let refreshInterval: ReturnType<typeof setInterval> | null = null;
  
  // Collapsed sections - start compact, expand on demand
  let sectionsExpanded = {
    healthCheck: false,
    device: false,
    t2hr: true,
    focalPoint: false,
    flags: false,
  };

  onMount(() => {
    loadData();
    // Refresh every 500ms for real-time updates
    refreshInterval = setInterval(loadData, 500);
  });

  onDestroy(() => {
    if (refreshInterval) {
      clearInterval(refreshInterval);
    }
  });

  function loadData() {
    // Device profile
    deviceProfile = getDeviceProfileSync();
    deviceTier = getCurrentTier();
    performanceConfig = getPerformanceConfig();
    featureFlags = getFeatureFlags().resolveFlags();
    
    // T2HR metrics
    const t2hr = getT2HRTracker();
    t2hrStats = t2hr.getStats();
    recentT2HR = t2hr.getRecentResults(10);
    
    // Focal point metrics
    const focal = getFocalPointTracker();
    focalPointStats = focal.getStats();
    lastGesture = focal.getLastGesture();
  }

  function toggleSection(section: keyof typeof sectionsExpanded) {
    sectionsExpanded[section] = !sectionsExpanded[section];
  }

  function getT2HRStatus(zoom: number, avgMs: number): 'pass' | 'warn' | 'fail' {
    const threshold = getT2HRThreshold(zoom);
    if (avgMs <= threshold.target) return 'pass';
    if (avgMs <= threshold.warn) return 'pass';
    if (avgMs <= threshold.fail) return 'warn';
    return 'fail';
  }

  function formatMs(ms: number | null | undefined): string {
    if (ms === null || ms === undefined) return '-';
    return `${Math.round(ms)}ms`;
  }

  function formatPercent(value: number | null | undefined): string {
    if (value === null || value === undefined) return '-';
    return `${Math.round(value * 100)}%`;
  }

  async function exportJson() {
    const data = {
      timestamp: new Date().toISOString(),
      device: deviceProfile,
      deviceTier,
      performanceConfig,
      featureFlags,
      t2hr: {
        stats: t2hrStats,
        recentMeasurements: recentT2HR,
      },
      focalPoint: {
        stats: focalPointStats,
        lastGesture,
      },
    };
    
    const json = JSON.stringify(data, null, 2);
    
    // Try to save to vault
    try {
      const vaultPath = '.obsidian/plugins/amnesia/diagnostics';
      const fileName = `diag-${Date.now()}.json`;
      // Note: This would need proper Obsidian API integration
      console.log(`[Diagnostics] Export:\n${json}`);
      alert(`Diagnostics exported to console. Check devtools.`);
    } catch (e) {
      console.error('Export failed:', e);
    }
  }

  function clearData() {
    getT2HRTracker().clear();
    getFocalPointTracker().clear();
    healthReport = null;
    loadData();
  }

  async function handleRunHealthCheck() {
    isRunningHealthCheck = true;
    sectionsExpanded.healthCheck = true;
    
    // Small delay to show loading state
    await new Promise(r => setTimeout(r, 100));
    
    healthReport = runHealthCheck();
    isRunningHealthCheck = false;
  }

  function getStatusIcon(status: HealthStatus): string {
    switch (status) {
      case 'pass': return '✓';
      case 'warn': return '⚠';
      case 'fail': return '✗';
      default: return '?';
    }
  }

  // Reactive: Config match check
  $: configMatchesExpected = performanceConfig && deviceTier ? 
    checkConfigMatchesTier(performanceConfig, deviceTier) : true;

  function checkConfigMatchesTier(config: PerformanceConfig, tier: DeviceTier): boolean {
    // Check if key config values match expected for tier
    const expected: Record<DeviceTier, { maxScale: number; workers: number }> = {
      extreme: { maxScale: 64, workers: 4 },
      high: { maxScale: 32, workers: 4 },
      medium: { maxScale: 16, workers: 2 },
      low: { maxScale: 8, workers: 1 },
    };
    const e = expected[tier];
    return config.maxScaleTier >= e.maxScale && config.workerCount >= e.workers;
  }
</script>

<div class="diagnostics-tab">
  <!-- Health Check Section -->
  <section class="diag-section health-check-section">
    <button class="section-header" on:click={() => toggleSection('healthCheck')}>
      <span class="section-icon">{sectionsExpanded.healthCheck ? '▼' : '▶'}</span>
      <span class="section-title">HEALTH CHECK</span>
      {#if healthReport}
        <span class="section-status {healthReport.overallStatus}">
          {getStatusIcon(healthReport.overallStatus)} {healthReport.summary}
        </span>
      {:else}
        <span class="section-status muted">Not run</span>
      {/if}
    </button>
    
    {#if sectionsExpanded.healthCheck}
      <div class="section-content">
        {#if !healthReport}
          <div class="health-prompt">
            <p>Run a comprehensive health check to validate your configuration and performance.</p>
            <button class="run-check-btn" on:click={handleRunHealthCheck} disabled={isRunningHealthCheck}>
              {isRunningHealthCheck ? 'Running...' : 'Run Health Check'}
            </button>
          </div>
        {:else}
          <div class="health-results">
            <div class="health-summary {healthReport.overallStatus}">
              <span class="summary-icon">{getStatusIcon(healthReport.overallStatus)}</span>
              <span class="summary-text">
                {healthReport.overallStatus === 'pass' ? 'All checks passed' :
                 healthReport.overallStatus === 'warn' ? 'Some warnings found' :
                 healthReport.overallStatus === 'fail' ? 'Critical issues found' : 'Incomplete data'}
              </span>
            </div>
            
            <div class="check-list">
              {#each healthReport.checks as check}
                <div class="check-item {check.status}">
                  <span class="check-icon">{getStatusIcon(check.status)}</span>
                  <span class="check-name">{check.name}</span>
                  <span class="check-message">{check.message}</span>
                </div>
              {/each}
            </div>
            
            {#if healthReport.recommendations.length > 0}
              <div class="recommendations">
                <span class="subsection-title">Recommendations:</span>
                <ul class="rec-list">
                  {#each healthReport.recommendations as rec}
                    <li>{rec}</li>
                  {/each}
                </ul>
              </div>
            {/if}
            
            <button class="run-check-btn secondary" on:click={handleRunHealthCheck} disabled={isRunningHealthCheck}>
              {isRunningHealthCheck ? 'Running...' : 'Re-run Check'}
            </button>
          </div>
        {/if}
      </div>
    {/if}
  </section>

  <!-- Device & Config Section -->
  <section class="diag-section">
    <button class="section-header" on:click={() => toggleSection('device')}>
      <span class="section-icon">{sectionsExpanded.device ? '▼' : '▶'}</span>
      <span class="section-title">DEVICE & CONFIG</span>
      <span class="section-status {configMatchesExpected ? 'pass' : 'warn'}">
        {configMatchesExpected ? '✓' : '⚠'}
      </span>
    </button>
    
    {#if sectionsExpanded.device && deviceProfile}
      <div class="section-content">
        <div class="info-grid">
          <span class="label">Tier:</span>
          <span class="value tier-{deviceTier}">{deviceTier}</span>
          
          <span class="label">Memory:</span>
          <span class="value">{deviceProfile.memory.totalGB.toFixed(1)}GB</span>
          
          <span class="label">CPU:</span>
          <span class="value">{deviceProfile.cpu.cores} cores</span>
          
          <span class="label">GPU:</span>
          <span class="value gpu">{deviceProfile.gpu.renderer?.slice(0, 30) || 'Unknown'}</span>
          
          <span class="label">Max Canvas:</span>
          <span class="value">{deviceProfile.canvas.maxDimension}px</span>
        </div>
        
        {#if performanceConfig}
          <div class="config-section">
            <span class="subsection-title">Applied Config:</span>
            <div class="config-grid">
              <span class="config-item">
                maxScale: {performanceConfig.maxScaleTier}
                <span class="check {performanceConfig.maxScaleTier >= 16 ? 'pass' : 'warn'}">
                  {performanceConfig.maxScaleTier >= 16 ? '✓' : '⚠'}
                </span>
              </span>
              <span class="config-item">
                workers: {performanceConfig.workerCount}
                <span class="check pass">✓</span>
              </span>
              <span class="config-item">
                concurrent: {performanceConfig.maxConcurrentRenders}
                <span class="check pass">✓</span>
              </span>
              <span class="config-item">
                l1Cache: {performanceConfig.l1CacheSize}
                <span class="check pass">✓</span>
              </span>
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </section>

  <!-- T2HR Section (Two-Source Model) -->
  <section class="diag-section">
    <button class="section-header" on:click={() => toggleSection('t2hr')}>
      <span class="section-icon">{sectionsExpanded.t2hr ? '▼' : '▶'}</span>
      <span class="section-title">TIME-TO-HIGHEST-RES (T2HR)</span>
      <span class="section-status {t2hrStats && t2hrStats.combined.avgMs <= 500 ? 'pass' : 'warn'}">
        {t2hrStats ? formatMs(t2hrStats.combined.avgMs) : '-'}
      </span>
    </button>
    
    {#if sectionsExpanded.t2hr}
      <div class="section-content">
        {#if t2hrStats && t2hrStats.combined.count > 0}
          <!-- Combined Summary -->
          <div class="t2hr-summary">
            <span class="metric">
              <span class="metric-label">Tiles:</span>
              <span class="metric-value">{t2hrStats.combined.count}</span>
            </span>
            <span class="metric">
              <span class="metric-label">Avg:</span>
              <span class="metric-value">{formatMs(t2hrStats.combined.avgMs)}</span>
            </span>
          </div>
          
          <!-- Two-Source Breakdown -->
          <div class="source-table">
            <div class="table-header source-header">
              <span>Source</span>
              <span>Count</span>
              <span>Avg</span>
              <span>P95</span>
              <span>Pending</span>
              <span>Never</span>
            </div>
            
            <!-- Zoom-initiated -->
            <div class="table-row source-row {t2hrStats.zoomTilesNeverDisplayed > 5 ? 'problem' : ''}">
              <span class="source-label zoom">ZOOM</span>
              <span>{t2hrStats.zoom.count}</span>
              <span>{formatMs(t2hrStats.zoom.avgMs)}</span>
              <span>{formatMs(t2hrStats.zoom.p95Ms)}</span>
              <span class="pending-count">{t2hrStats.zoom.pendingCount}</span>
              <span class="never-count {t2hrStats.zoom.neverDisplayedCount > 0 ? 'warn' : ''}">{t2hrStats.zoom.neverDisplayedCount}</span>
            </div>
            
            <!-- Pan-initiated -->
            <div class="table-row source-row">
              <span class="source-label pan">PAN</span>
              <span>{t2hrStats.pan.count}</span>
              <span>{formatMs(t2hrStats.pan.avgMs)}</span>
              <span>{formatMs(t2hrStats.pan.p95Ms)}</span>
              <span class="pending-count">{t2hrStats.pan.pendingCount}</span>
              <span class="never-count">{t2hrStats.pan.neverDisplayedCount}</span>
            </div>
            
            <!-- Scroll-initiated -->
            {#if t2hrStats.scroll.count > 0}
              <div class="table-row source-row">
                <span class="source-label scroll">SCROLL</span>
                <span>{t2hrStats.scroll.count}</span>
                <span>{formatMs(t2hrStats.scroll.avgMs)}</span>
                <span>{formatMs(t2hrStats.scroll.p95Ms)}</span>
                <span class="pending-count">{t2hrStats.scroll.pendingCount}</span>
                <span class="never-count">{t2hrStats.scroll.neverDisplayedCount}</span>
              </div>
            {/if}
          </div>
          
          <!-- Nudge Bug Indicator -->
          {#if t2hrStats.zoomTilesNeverDisplayed > 5 && t2hrStats.panTilesDisplayedImmediately > 0}
            <div class="nudge-bug-alert">
              <span class="alert-icon">⚠</span>
              <span class="alert-text">
                NUDGE BUG: {t2hrStats.zoomTilesNeverDisplayed} zoom tiles never displayed, 
                but {t2hrStats.panTilesDisplayedImmediately} pan tiles showed immediately.
                Tiles render but don't push to canvas until pan triggers re-composite.
              </span>
            </div>
          {/if}
          
          <!-- Highest-Res Rate -->
          <div class="quality-metrics">
            <span class="metric">
              <span class="metric-label">Zoom Highest-Res:</span>
              <span class="metric-value {t2hrStats.zoom.highestResRate >= 0.9 ? 'good' : 'bad'}">
                {formatPercent(t2hrStats.zoom.highestResRate)}
              </span>
            </span>
            <span class="metric">
              <span class="metric-label">Pan Highest-Res:</span>
              <span class="metric-value {t2hrStats.pan.highestResRate >= 0.9 ? 'good' : 'bad'}">
                {formatPercent(t2hrStats.pan.highestResRate)}
              </span>
            </span>
          </div>
          
          <!-- Recent Tiles -->
          {#if recentT2HR.length > 0}
            <div class="recent-section">
              <span class="subsection-title">Recent Tiles:</span>
              <div class="recent-list">
                {#each recentT2HR.slice().reverse().slice(0, 8) as tile}
                  <div class="recent-item">
                    <span class="recent-source {tile.source}">{tile.source.slice(0,1).toUpperCase()}</span>
                    <span class="recent-page">p{tile.page}</span>
                    <span class="recent-time">{formatMs(tile.t2hrMs)}</span>
                    <span class="recent-scale">s{tile.actualScale}</span>
                    <span class="recent-status {tile.isHighestRes ? 'sharp' : 'fallback'}">
                      {tile.isHighestRes ? '◆' : '◇'}
                    </span>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        {:else}
          <div class="diag-empty">
            No T2HR data yet. Zoom or pan to generate measurements.
          </div>
        {/if}
      </div>
    {/if}
  </section>

  <!-- Focal Point Section -->
  <section class="diag-section">
    <button class="section-header" on:click={() => toggleSection('focalPoint')}>
      <span class="section-icon">{sectionsExpanded.focalPoint ? '▼' : '▶'}</span>
      <span class="section-title">FOCAL-POINT PRIORITY</span>
      <span class="section-status {focalPointStats?.prioritizationEffective ? 'pass' : 'warn'}">
        {focalPointStats ? (focalPointStats.prioritizationEffective ? '✓' : '⚠') : '-'}
      </span>
    </button>
    
    {#if sectionsExpanded.focalPoint}
      <div class="section-content">
        {#if focalPointStats && focalPointStats.gestureCount > 0}
          <div class="focal-summary">
            <span class="metric">
              <span class="metric-label">Gestures:</span>
              <span class="metric-value">{focalPointStats.gestureCount}</span>
            </span>
            <span class="metric">
              <span class="metric-label">Critical First:</span>
              <span class="metric-value {focalPointStats.avgCriticalFirstRate >= 0.7 ? 'good' : 'bad'}">
                {formatPercent(focalPointStats.avgCriticalFirstRate)}
              </span>
            </span>
            <span class="metric">
              <span class="metric-label">Inversions:</span>
              <span class="metric-value {focalPointStats.avgPriorityInversions < 5 ? 'good' : 'bad'}">
                {focalPointStats.avgPriorityInversions.toFixed(1)}
              </span>
            </span>
          </div>
          
          <!-- Priority Distribution -->
          <div class="priority-dist">
            <span class="subsection-title">Avg Distribution:</span>
            <div class="priority-bars">
              <div class="priority-bar critical">
                <span class="bar-label">critical</span>
                <span class="bar-value">{focalPointStats.avgPriorityDistribution.critical}</span>
              </div>
              <div class="priority-bar high">
                <span class="bar-label">high</span>
                <span class="bar-value">{focalPointStats.avgPriorityDistribution.high}</span>
              </div>
              <div class="priority-bar medium">
                <span class="bar-label">medium</span>
                <span class="bar-value">{focalPointStats.avgPriorityDistribution.medium}</span>
              </div>
              <div class="priority-bar low">
                <span class="bar-label">low</span>
                <span class="bar-value">{focalPointStats.avgPriorityDistribution.low}</span>
              </div>
            </div>
          </div>
          
          <!-- Recommendation -->
          {#if focalPointStats.recommendation}
            <div class="recommendation">
              {focalPointStats.recommendation}
            </div>
          {/if}
        {:else}
          <div class="diag-empty">
            No focal-point data yet. Zoom or pan to generate measurements.
          </div>
        {/if}
      </div>
    {/if}
  </section>

  <!-- Feature Flags Section -->
  <section class="diag-section">
    <button class="section-header" on:click={() => toggleSection('flags')}>
      <span class="section-icon">{sectionsExpanded.flags ? '▼' : '▶'}</span>
      <span class="section-title">FEATURE FLAGS</span>
    </button>
    
    {#if sectionsExpanded.flags && featureFlags}
      <div class="section-content">
        <div class="flags-grid">
          {#each Object.entries(featureFlags) as [key, value]}
            <span class="flag-item">
              <span class="flag-status {value ? 'on' : 'off'}">{value ? '✓' : '○'}</span>
              <span class="flag-name">{key}</span>
            </span>
          {/each}
        </div>
      </div>
    {/if}
  </section>

  <!-- Actions -->
  <div class="actions">
    <button class="action-btn" on:click={exportJson}>Export JSON</button>
    <button class="action-btn danger" on:click={clearData}>Clear Data</button>
  </div>
</div>

<style>
  .diagnostics-tab {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-1);
    font-size: var(--font-ui-smaller);
    /* Note: scrolling handled by parent .hud-content */
  }

  .diag-section {
    background: var(--background-secondary);
    border-radius: var(--radius-s);
    overflow: hidden;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: var(--size-4-1);
    width: 100%;
    padding: var(--size-4-1) var(--size-4-2);
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    color: var(--text-normal);
    font-size: 11px;
  }

  .section-header:hover {
    background: var(--background-modifier-hover);
  }

  .section-icon {
    font-size: 10px;
    color: var(--text-muted);
  }

  .section-title {
    flex: 1;
    font-weight: 600;
    font-size: var(--font-ui-smaller);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .section-status {
    font-family: var(--font-monospace);
    font-size: var(--font-ui-smaller);
  }

  .section-status.pass { color: var(--color-green); }
  .section-status.warn { color: var(--color-yellow); }
  .section-status.fail { color: var(--color-red); }

  .section-content {
    padding: var(--size-4-1) var(--size-4-2);
    border-top: 1px solid var(--background-modifier-border);
  }

  .info-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--size-4-1) var(--size-4-2);
  }

  .label {
    color: var(--text-muted);
  }

  .value {
    font-family: var(--font-monospace);
  }

  .value.gpu {
    font-size: 10px;
    word-break: break-all;
  }

  .tier-extreme { color: var(--color-purple); }
  .tier-high { color: var(--color-green); }
  .tier-medium { color: var(--color-yellow); }
  .tier-low { color: var(--color-orange); }

  .config-section {
    margin-top: var(--size-4-2);
    padding-top: var(--size-4-2);
    border-top: 1px solid var(--background-modifier-border);
  }

  .subsection-title {
    display: block;
    font-size: 10px;
    color: var(--text-muted);
    text-transform: uppercase;
    margin-bottom: var(--size-4-1);
  }

  .config-grid {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-4-1);
  }

  .config-item {
    font-family: var(--font-monospace);
    font-size: 11px;
    padding: 2px 6px;
    background: var(--background-primary);
    border-radius: var(--radius-s);
  }

  .check {
    margin-left: 4px;
  }

  .check.pass { color: var(--color-green); }
  .check.warn { color: var(--color-yellow); }

  .t2hr-summary, .focal-summary {
    display: flex;
    gap: var(--size-4-2);
    margin-bottom: var(--size-4-1);
    flex-wrap: wrap;
  }

  .metric {
    display: flex;
    align-items: baseline;
    gap: 4px;
  }

  .metric-label {
    font-size: 10px;
    color: var(--text-muted);
  }

  .metric-value {
    font-family: var(--font-monospace);
    font-weight: 600;
    font-size: 11px;
  }

  .metric-value.good { color: var(--color-green); }
  .metric-value.bad { color: var(--color-red); }

  .zoom-table {
    margin: var(--size-4-1) 0;
    font-family: var(--font-monospace);
    font-size: 10px;
  }

  .table-header, .table-row {
    display: grid;
    grid-template-columns: 32px 50px 50px 60px 32px;
    gap: 4px;
    padding: 2px 0;
  }

  .table-header {
    color: var(--text-muted);
    font-size: 10px;
    border-bottom: 1px solid var(--background-modifier-border);
  }

  .table-row:not(:last-child) {
    border-bottom: 1px solid var(--background-modifier-border-hover);
  }

  .target {
    color: var(--text-muted);
    font-size: 10px;
  }

  .status-badge {
    text-align: center;
  }

  .status-badge.pass { color: var(--color-green); }
  .status-badge.warn { color: var(--color-yellow); }
  .status-badge.fail { color: var(--color-red); }

  .bottleneck {
    margin-top: var(--size-4-2);
    padding: var(--size-4-2);
    background: var(--background-primary);
    border-radius: var(--radius-s);
  }

  .bottleneck-label {
    color: var(--text-muted);
    margin-right: var(--size-4-1);
  }

  .bottleneck-value {
    font-family: var(--font-monospace);
    color: var(--color-yellow);
  }

  .recent-section {
    margin-top: var(--size-4-2);
  }

  .recent-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .recent-item {
    display: grid;
    grid-template-columns: 20px 28px 50px 28px 16px;
    gap: var(--size-4-1);
    font-family: var(--font-monospace);
    font-size: 11px;
    padding: 2px 4px;
    background: var(--background-primary);
    border-radius: var(--radius-s);
    align-items: center;
  }

  .recent-status.sharp { color: var(--color-green); }
  .recent-status.fallback { color: var(--color-yellow); }

  .priority-dist {
    margin-top: var(--size-4-2);
  }

  .priority-bars {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .priority-bar {
    display: flex;
    justify-content: space-between;
    padding: 2px 6px;
    border-radius: var(--radius-s);
    font-family: var(--font-monospace);
    font-size: 11px;
  }

  .priority-bar.critical { background: rgba(var(--color-red-rgb), 0.2); }
  .priority-bar.high { background: rgba(var(--color-orange-rgb), 0.2); }
  .priority-bar.medium { background: rgba(var(--color-yellow-rgb), 0.2); }
  .priority-bar.low { background: rgba(var(--color-green-rgb), 0.2); }

  .recommendation {
    margin-top: var(--size-4-2);
    padding: var(--size-4-2);
    background: rgba(var(--color-yellow-rgb), 0.1);
    border-left: 3px solid var(--color-yellow);
    font-size: 11px;
    color: var(--text-muted);
  }

  .flags-grid {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-4-1);
  }

  .flag-item {
    display: flex;
    align-items: center;
    gap: 4px;
    font-family: var(--font-monospace);
    font-size: 10px;
    padding: 2px 6px;
    background: var(--background-primary);
    border-radius: var(--radius-s);
  }

  .flag-status.on { color: var(--color-green); }
  .flag-status.off { color: var(--text-muted); }

  .diag-empty {
    color: var(--text-muted);
    font-style: italic;
    text-align: center;
    padding: var(--size-4-2);
    font-size: 10px;
  }

  .actions {
    display: flex;
    gap: var(--size-4-1);
    margin-top: var(--size-4-1);
    padding-top: var(--size-4-1);
    border-top: 1px solid var(--background-modifier-border);
  }

  .action-btn {
    flex: 1;
    padding: var(--size-4-1) var(--size-4-2);
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    border: none;
    border-radius: var(--radius-s);
    cursor: pointer;
    font-size: 10px;
  }

  .action-btn:hover {
    background: var(--interactive-accent-hover);
  }

  .action-btn.danger {
    background: var(--background-modifier-error);
  }

  .action-btn.danger:hover {
    background: var(--background-modifier-error-hover);
  }

  /* Health Check Styles */
  .health-check-section {
    border: 1px solid var(--background-modifier-border);
  }

  .section-status.muted {
    color: var(--text-muted);
  }

  .health-prompt {
    text-align: center;
    padding: var(--size-4-2);
  }

  .health-prompt p {
    margin-bottom: var(--size-4-2);
    color: var(--text-muted);
    font-size: 11px;
  }

  .run-check-btn {
    padding: var(--size-4-2) var(--size-4-4);
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    border: none;
    border-radius: var(--radius-s);
    cursor: pointer;
    font-size: var(--font-ui-smaller);
    font-weight: 500;
  }

  .run-check-btn:hover:not(:disabled) {
    background: var(--interactive-accent-hover);
  }

  .run-check-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .run-check-btn.secondary {
    background: var(--background-modifier-border);
    color: var(--text-normal);
    margin-top: var(--size-4-2);
  }

  .run-check-btn.secondary:hover:not(:disabled) {
    background: var(--background-modifier-hover);
  }

  .health-summary {
    display: flex;
    align-items: center;
    gap: var(--size-4-2);
    padding: var(--size-4-2);
    border-radius: var(--radius-s);
    margin-bottom: var(--size-4-2);
  }

  .health-summary.pass { background: rgba(var(--color-green-rgb), 0.15); }
  .health-summary.warn { background: rgba(var(--color-yellow-rgb), 0.15); }
  .health-summary.fail { background: rgba(var(--color-red-rgb), 0.15); }
  .health-summary.unknown { background: var(--background-primary); }

  .summary-icon {
    font-size: 16px;
  }

  .health-summary.pass .summary-icon { color: var(--color-green); }
  .health-summary.warn .summary-icon { color: var(--color-yellow); }
  .health-summary.fail .summary-icon { color: var(--color-red); }

  .summary-text {
    font-weight: 500;
  }

  .check-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .check-item {
    display: grid;
    grid-template-columns: 20px 1fr;
    gap: var(--size-4-1);
    padding: 4px 6px;
    background: var(--background-primary);
    border-radius: var(--radius-s);
    font-size: 11px;
  }

  .check-icon {
    text-align: center;
  }

  .check-item.pass .check-icon { color: var(--color-green); }
  .check-item.warn .check-icon { color: var(--color-yellow); }
  .check-item.fail .check-icon { color: var(--color-red); }
  .check-item.unknown .check-icon { color: var(--text-muted); }

  .check-name {
    font-weight: 500;
    grid-column: 2;
  }

  .check-message {
    grid-column: 2;
    color: var(--text-muted);
    font-size: 10px;
  }

  .recommendations {
    margin-top: var(--size-4-2);
    padding: var(--size-4-2);
    background: rgba(var(--color-yellow-rgb), 0.1);
    border-left: 3px solid var(--color-yellow);
    border-radius: var(--radius-s);
  }

  .rec-list {
    margin: var(--size-4-1) 0 0 var(--size-4-3);
    padding: 0;
    font-size: 11px;
    color: var(--text-muted);
  }

  .rec-list li {
    margin-bottom: 4px;
  }

  /* T2HR Two-Source Styles */
  .source-table {
    margin: var(--size-4-1) 0;
    font-family: var(--font-monospace);
    font-size: 10px;
  }

  .source-header {
    grid-template-columns: 50px 40px 50px 50px 45px 40px !important;
  }

  .source-row {
    grid-template-columns: 50px 40px 50px 50px 45px 40px !important;
  }

  .source-row.problem {
    background: rgba(var(--color-red-rgb), 0.1);
  }

  .source-label {
    font-weight: 600;
    font-size: 9px;
  }

  .source-label.zoom { color: var(--color-purple); }
  .source-label.pan { color: var(--color-blue); }
  .source-label.scroll { color: var(--color-cyan); }

  .pending-count {
    color: var(--color-yellow);
  }

  .never-count {
    color: var(--text-muted);
  }

  .never-count.warn {
    color: var(--color-red);
    font-weight: 600;
  }

  .nudge-bug-alert {
    display: flex;
    gap: var(--size-4-2);
    margin: var(--size-4-2) 0;
    padding: var(--size-4-2);
    background: rgba(var(--color-red-rgb), 0.15);
    border-left: 3px solid var(--color-red);
    border-radius: var(--radius-s);
    font-size: 10px;
  }

  .alert-icon {
    color: var(--color-red);
    font-size: 14px;
  }

  .alert-text {
    color: var(--text-normal);
    line-height: 1.4;
  }

  .quality-metrics {
    display: flex;
    gap: var(--size-4-3);
    margin: var(--size-4-2) 0;
    padding: var(--size-4-2);
    background: var(--background-primary);
    border-radius: var(--radius-s);
  }

  .recent-source {
    width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 2px;
    font-size: 9px;
    font-weight: 700;
  }

  .recent-source.zoom { background: rgba(var(--color-purple-rgb), 0.3); color: var(--color-purple); }
  .recent-source.pan { background: rgba(var(--color-blue-rgb), 0.3); color: var(--color-blue); }
  .recent-source.scroll { background: rgba(var(--color-cyan-rgb), 0.3); color: var(--color-cyan); }
  .recent-source.initial { background: var(--background-modifier-border); color: var(--text-muted); }

  .recent-page {
    color: var(--text-muted);
    font-size: 10px;
  }

  .recent-scale {
    color: var(--text-muted);
    font-size: 10px;
  }
</style>
