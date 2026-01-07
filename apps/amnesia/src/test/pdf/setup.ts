/**
 * PDF Test Setup
 *
 * Sets up DOM mocks required for PDF component testing.
 * These components use canvas, DOM elements, and browser APIs.
 */

import { vi } from 'vitest';

// Mock getComputedStyle
vi.stubGlobal('getComputedStyle', (el: any) => ({
  getPropertyValue: (prop: string) => '',
  columnWidth: '',
  columnCount: '',
  columnGap: '',
}));

// Mock ResizeObserver
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', MockResizeObserver);

// Mock IntersectionObserver
class MockIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {}
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

// Mock MutationObserver
class MockMutationObserver {
  constructor(callback: MutationCallback) {}
  observe() {}
  disconnect() {}
  takeRecords() { return []; }
}
vi.stubGlobal('MutationObserver', MockMutationObserver);

// Create mock canvas context
function createMockContext2D(): CanvasRenderingContext2D {
  return {
    canvas: {} as HTMLCanvasElement,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'high',
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    clearRect: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    measureText: vi.fn(() => ({ width: 0 })),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    arcTo: vi.fn(),
    rect: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    clip: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    rotate: vi.fn(),
    translate: vi.fn(),
    transform: vi.fn(),
    setTransform: vi.fn(),
    resetTransform: vi.fn(),
    getTransform: vi.fn(() => new DOMMatrix()),
    drawImage: vi.fn(),
    createLinearGradient: vi.fn(() => ({
      addColorStop: vi.fn(),
    })),
    createRadialGradient: vi.fn(() => ({
      addColorStop: vi.fn(),
    })),
    createPattern: vi.fn(),
    getImageData: vi.fn(() => ({
      data: new Uint8ClampedArray(4),
      width: 1,
      height: 1,
    })),
    putImageData: vi.fn(),
    createImageData: vi.fn(() => ({
      data: new Uint8ClampedArray(4),
      width: 1,
      height: 1,
    })),
    setLineDash: vi.fn(),
    getLineDash: vi.fn(() => []),
    lineDashOffset: 0,
    shadowBlur: 0,
    shadowColor: '',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    direction: 'ltr',
    filter: '',
    fontKerning: 'auto',
    isPointInPath: vi.fn(() => false),
    isPointInStroke: vi.fn(() => false),
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    getContextAttributes: vi.fn(() => ({})),
    bezierCurveTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    ellipse: vi.fn(),
    roundRect: vi.fn(),
    drawFocusIfNeeded: vi.fn(),
    scrollPathIntoView: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

// Store original createElement
const originalCreateElement = document.createElement.bind(document);

// Override document.createElement to return mock canvas with getContext
document.createElement = ((tagName: string, options?: ElementCreationOptions) => {
  const element = originalCreateElement(tagName, options);

  if (tagName.toLowerCase() === 'canvas') {
    // Add getContext method
    (element as HTMLCanvasElement).getContext = ((contextId: string) => {
      if (contextId === '2d') {
        return createMockContext2D();
      }
      return null;
    }) as any;

    // Add other canvas properties
    Object.defineProperty(element, 'width', {
      get: () => 100,
      set: () => {},
    });
    Object.defineProperty(element, 'height', {
      get: () => 100,
      set: () => {},
    });
  }

  return element;
}) as typeof document.createElement;

// Mock URL.createObjectURL and revokeObjectURL
if (!URL.createObjectURL) {
  URL.createObjectURL = vi.fn(() => 'blob:mock-url');
}
if (!URL.revokeObjectURL) {
  URL.revokeObjectURL = vi.fn();
}

// Mock Image with decode support
class MockImage {
  src = '';
  width = 100;
  height = 100;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  decode(): Promise<void> {
    return Promise.resolve();
  }

  set crossOrigin(_: string) {}
}
vi.stubGlobal('Image', MockImage);

// Mock requestAnimationFrame
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
  return setTimeout(() => callback(performance.now()), 0);
});

vi.stubGlobal('cancelAnimationFrame', (id: number) => {
  clearTimeout(id);
});

// Mock window.devicePixelRatio
Object.defineProperty(window, 'devicePixelRatio', {
  value: 2,
  writable: true,
});

// Mock Selection API
vi.stubGlobal('getSelection', () => ({
  isCollapsed: true,
  toString: () => '',
  getRangeAt: () => ({
    getClientRects: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
  }),
  rangeCount: 0,
}));

export {};
