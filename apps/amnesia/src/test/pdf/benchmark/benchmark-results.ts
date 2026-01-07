/**
 * Benchmark Results
 *
 * Storage and formatting for PDF benchmark results.
 */

import { formatBytes, formatDuration } from './benchmark-utils';

export interface BenchmarkResult {
  name: string;
  metric: string;
  value: number;
  unit: string;
  baseline?: number;
  target?: number;
  passed?: boolean;
}

export interface BenchmarkSuite {
  name: string;
  timestamp: Date;
  commit?: string;
  results: BenchmarkResult[];
  summary: {
    passed: number;
    failed: number;
    total: number;
  };
}

/**
 * Performance targets for PDF optimization
 */
export const PERFORMANCE_TARGETS = {
  /** Time to render first page (ms) */
  firstPageLoad: 500,
  /** Average single page render time (ms) */
  pageRenderTime: 100,
  /** Minimum acceptable FPS during scroll */
  scrollFps: 55,
  /** Maximum memory during 100-page scroll (bytes) */
  memoryPeak: 200 * 1024 * 1024, // 200MB
  /** Maximum DOM nodes for text layer during scroll */
  domNodeCount: 500,
  /** Minimum cache hit rate (percentage) */
  cacheHitRate: 80,
  /** Minimum prefetch accuracy (percentage) */
  prefetchAccuracy: 70,
};

/**
 * Create a benchmark result
 */
export function createResult(
  name: string,
  metric: string,
  value: number,
  unit: string,
  options: { baseline?: number; target?: number } = {}
): BenchmarkResult {
  const result: BenchmarkResult = {
    name,
    metric,
    value,
    unit,
    baseline: options.baseline,
    target: options.target,
  };

  if (options.target !== undefined) {
    // For time/memory metrics, lower is better
    // For rate/fps metrics, higher is better
    const lowerIsBetter = ['ms', 's', 'bytes', 'MB', 'nodes'].some(u =>
      unit.toLowerCase().includes(u.toLowerCase())
    );
    result.passed = lowerIsBetter ? value <= options.target : value >= options.target;
  }

  return result;
}

/**
 * Create a benchmark suite
 */
export function createSuite(name: string, results: BenchmarkResult[]): BenchmarkSuite {
  const passed = results.filter(r => r.passed === true).length;
  const failed = results.filter(r => r.passed === false).length;

  return {
    name,
    timestamp: new Date(),
    results,
    summary: {
      passed,
      failed,
      total: results.length,
    },
  };
}

/**
 * Format a single result as a string
 */
export function formatResult(result: BenchmarkResult): string {
  let valueStr: string;

  if (result.unit === 'ms') {
    valueStr = formatDuration(result.value);
  } else if (result.unit === 'bytes') {
    valueStr = formatBytes(result.value);
  } else {
    valueStr = `${result.value.toFixed(2)} ${result.unit}`;
  }

  let line = `${result.name}: ${valueStr}`;

  if (result.target !== undefined) {
    const targetStr = result.unit === 'bytes'
      ? formatBytes(result.target)
      : `${result.target} ${result.unit}`;
    const status = result.passed ? '✓' : '✗';
    line += ` (target: ${targetStr}) ${status}`;
  }

  if (result.baseline !== undefined) {
    const improvement = ((result.baseline - result.value) / result.baseline) * 100;
    const sign = improvement > 0 ? '+' : '';
    line += ` [${sign}${improvement.toFixed(1)}% vs baseline]`;
  }

  return line;
}

/**
 * Format a suite as a string report
 */
export function formatSuiteReport(suite: BenchmarkSuite): string {
  const lines: string[] = [
    `=== ${suite.name} ===`,
    `Date: ${suite.timestamp.toISOString()}`,
    suite.commit ? `Commit: ${suite.commit}` : '',
    '',
    'Results:',
    ...suite.results.map(r => `  ${formatResult(r)}`),
    '',
    `Summary: ${suite.summary.passed}/${suite.summary.total} passed`,
  ];

  return lines.filter(l => l !== '').join('\n');
}

/**
 * Format suite as markdown table
 */
export function formatSuiteMarkdown(suite: BenchmarkSuite): string {
  const lines: string[] = [
    `## ${suite.name}`,
    '',
    `**Date:** ${suite.timestamp.toISOString()}`,
    suite.commit ? `**Commit:** ${suite.commit}` : '',
    '',
    '| Metric | Value | Target | Status |',
    '|--------|-------|--------|--------|',
  ];

  for (const result of suite.results) {
    const valueStr = result.unit === 'bytes'
      ? formatBytes(result.value)
      : result.unit === 'ms'
      ? formatDuration(result.value)
      : `${result.value.toFixed(2)} ${result.unit}`;

    const targetStr = result.target !== undefined
      ? result.unit === 'bytes'
        ? formatBytes(result.target)
        : `${result.target} ${result.unit}`
      : '-';

    const status = result.passed === undefined
      ? '-'
      : result.passed
      ? '✅'
      : '❌';

    lines.push(`| ${result.name} | ${valueStr} | ${targetStr} | ${status} |`);
  }

  lines.push('');
  lines.push(`**Summary:** ${suite.summary.passed}/${suite.summary.total} passed`);

  return lines.join('\n');
}

/**
 * Compare two suites and show improvements
 */
export function compareSuites(
  baseline: BenchmarkSuite,
  current: BenchmarkSuite
): string {
  const lines: string[] = [
    `=== Comparison: ${baseline.name} → ${current.name} ===`,
    '',
  ];

  for (const currentResult of current.results) {
    const baselineResult = baseline.results.find(r => r.metric === currentResult.metric);

    if (baselineResult) {
      const improvement = ((baselineResult.value - currentResult.value) / baselineResult.value) * 100;
      const sign = improvement > 0 ? '+' : '';
      const arrow = improvement > 0 ? '↓' : improvement < 0 ? '↑' : '→';

      lines.push(
        `${currentResult.name}: ${formatResult(currentResult)} ` +
        `${arrow} ${sign}${improvement.toFixed(1)}%`
      );
    } else {
      lines.push(`${currentResult.name}: ${formatResult(currentResult)} (new)`);
    }
  }

  return lines.join('\n');
}

/**
 * Store results to localStorage (for browser environment)
 */
export function storeResults(key: string, suite: BenchmarkSuite): void {
  try {
    const existing = localStorage.getItem('pdf-benchmarks') || '{}';
    const data = JSON.parse(existing);
    data[key] = suite;
    localStorage.setItem('pdf-benchmarks', JSON.stringify(data));
  } catch {
    // Ignore storage errors in test environment
  }
}

/**
 * Load results from localStorage
 */
export function loadResults(key: string): BenchmarkSuite | null {
  try {
    const existing = localStorage.getItem('pdf-benchmarks') || '{}';
    const data = JSON.parse(existing);
    return data[key] || null;
  } catch {
    return null;
  }
}
