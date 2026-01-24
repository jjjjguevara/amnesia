/**
 * PDF Settings Tab
 *
 * PDF rendering mode, scale, layout, OCR, and provider settings.
 */

import { Notice, Setting } from 'obsidian';
import type AmnesiaPlugin from '../../main';
import {
    createTabHeader,
    createSection,
    createExplainerBox,
} from '../settings-ui/section-helpers';
import {
    type PdfPerformancePreset,
    PDF_PERFORMANCE_PRESETS,
} from '../settings';
import {
    getPerformanceSettingsManager,
} from '../../reader/renderer/pdf/performance-settings-manager';

export interface PdfSettingsProps {
    plugin: AmnesiaPlugin;
    containerEl: HTMLElement;
}

export function PdfSettings({ plugin, containerEl }: PdfSettingsProps): void {
    const { settings } = plugin;

    // ==========================================================================
    // TAB HEADER
    // ==========================================================================

    createTabHeader(
        containerEl,
        'PDF',
        'Configure PDF rendering, scale, layout, and OCR settings.'
    );

    // ==========================================================================
    // RENDERING MODE
    // ==========================================================================

    const modeSection = createSection(containerEl, 'cpu', 'Rendering Mode');

    createExplainerBox(modeSection,
        'Auto mode uses the server for better performance when available, ' +
        'falling back to PDF.js (in-browser) when offline.'
    );

    new Setting(modeSection)
        .setName('Provider Mode')
        .setDesc('Choose how PDFs are rendered')
        .addDropdown(dropdown => dropdown
            .addOption('auto', 'Automatic (Recommended)')
            .addOption('server', 'Server Only')
            .setValue(settings.pdf.preferMode)
            .onChange(async (value) => {
                settings.pdf.preferMode = value as 'auto' | 'server';
                await plugin.saveSettings();
            }));

    // ==========================================================================
    // DISPLAY SETTINGS
    // ==========================================================================

    const displaySection = createSection(containerEl, 'layout', 'Display');

    new Setting(displaySection)
        .setName('Default Scale')
        .setDesc('Zoom level for PDF pages (1.0 = 100%)')
        .addSlider(slider => slider
            .setLimits(0.5, 3.0, 0.1)
            .setValue(settings.pdf.scale)
            .setDynamicTooltip()
            .onChange(async (value) => {
                settings.pdf.scale = value;
                await plugin.saveSettings();
            }))
        .addExtraButton(button => button
            .setIcon('reset')
            .setTooltip('Reset to 150%')
            .onClick(async () => {
                settings.pdf.scale = 1.5;
                await plugin.saveSettings();
                // Refresh the settings display
                containerEl.empty();
                PdfSettings({ plugin, containerEl });
            }));

    new Setting(displaySection)
        .setName('Page Layout')
        .setDesc('How pages are displayed')
        .addDropdown(dropdown => dropdown
            .addOption('single', 'Single Page')
            .addOption('dual', 'Dual Pages')
            .addOption('book', 'Book Spread (cover on right)')
            .setValue(settings.pdf.pageLayout)
            .onChange(async (value) => {
                settings.pdf.pageLayout = value as 'single' | 'dual' | 'book';
                await plugin.saveSettings();
            }));

    new Setting(displaySection)
        .setName('Default Rotation')
        .setDesc('Default page rotation')
        .addDropdown(dropdown => dropdown
            .addOption('0', '0° (Normal)')
            .addOption('90', '90° Clockwise')
            .addOption('180', '180°')
            .addOption('270', '270° Counter-clockwise')
            .setValue(String(settings.pdf.rotation))
            .onChange(async (value) => {
                settings.pdf.rotation = parseInt(value) as 0 | 90 | 180 | 270;
                await plugin.saveSettings();
            }));

    // ==========================================================================
    // TEXT & SELECTION
    // ==========================================================================

    const textSection = createSection(containerEl, 'text-cursor', 'Text & Selection');

    new Setting(textSection)
        .setName('Show Text Layer')
        .setDesc('Enable text selection and search in PDFs')
        .addToggle(toggle => toggle
            .setValue(settings.pdf.showTextLayer)
            .onChange(async (value) => {
                settings.pdf.showTextLayer = value;
                await plugin.saveSettings();
            }));

    new Setting(textSection)
        .setName('Region Selection')
        .setDesc('Allow drawing rectangles for OCR on scanned pages')
        .addToggle(toggle => toggle
            .setValue(settings.pdf.enableRegionSelection)
            .onChange(async (value) => {
                settings.pdf.enableRegionSelection = value;
                await plugin.saveSettings();
            }));

    // ==========================================================================
    // OCR SETTINGS
    // ==========================================================================

    const ocrSection = createSection(containerEl, 'scan', 'OCR (Optical Character Recognition)');

    createExplainerBox(ocrSection,
        'OCR extracts text from scanned PDFs and images. Requires the server to be running. ' +
        'Tesseract is faster for simple documents; Ollama provides better accuracy for complex layouts.'
    );

    new Setting(ocrSection)
        .setName('Enable OCR')
        .setDesc('Enable OCR for scanned PDFs (requires server)')
        .addToggle(toggle => toggle
            .setValue(settings.pdf.enableOcr)
            .onChange(async (value) => {
                settings.pdf.enableOcr = value;
                await plugin.saveSettings();
            }));

    new Setting(ocrSection)
        .setName('OCR Provider')
        .setDesc('Which OCR engine to use')
        .addDropdown(dropdown => dropdown
            .addOption('tesseract', 'Tesseract (Fast)')
            .addOption('ollama', 'Ollama Vision (Accurate)')
            .setValue(settings.pdf.ocrProvider)
            .onChange(async (value) => {
                settings.pdf.ocrProvider = value as 'tesseract' | 'ollama';
                await plugin.saveSettings();
            }));

    // ==========================================================================
    // PERFORMANCE & OPTIMIZATION
    // ==========================================================================

    const perfSection = createSection(containerEl, 'gauge', 'Performance & Optimization');

    createExplainerBox(perfSection,
        'Fine-tune rendering quality and performance. Higher DPI produces sharper text but uses more memory and bandwidth.'
    );

    new Setting(perfSection)
        .setName('Render DPI')
        .setDesc('DPI for server-side rendering. Higher = sharper, slower.')
        .addDropdown(dropdown => dropdown
            .addOption('72', '72 DPI (Fast, Low Quality)')
            .addOption('96', '96 DPI (Screen)')
            .addOption('150', '150 DPI (Recommended)')
            .addOption('200', '200 DPI (High Quality)')
            .addOption('300', '300 DPI (Print Quality)')
            .setValue(String(settings.pdf.renderDpi))
            .onChange(async (value) => {
                settings.pdf.renderDpi = parseInt(value) as 72 | 96 | 150 | 200 | 300;
                await plugin.saveSettings();
                // Apply to active readers immediately
                plugin.updatePdfRenderSettings();
            }));

    new Setting(perfSection)
        .setName('Image Format')
        .setDesc('Output format for rendered pages')
        .addDropdown(dropdown => dropdown
            .addOption('png', 'PNG (Best for text)')
            .addOption('jpeg', 'JPEG (Smaller files)')
            .addOption('webp', 'WebP (Best compression)')
            .setValue(settings.pdf.imageFormat)
            .onChange(async (value) => {
                settings.pdf.imageFormat = value as 'png' | 'jpeg' | 'webp';
                await plugin.saveSettings();
                // Apply to active readers immediately
                plugin.updatePdfRenderSettings();
            }));

    new Setting(perfSection)
        .setName('Image Quality')
        .setDesc('Quality for JPEG/WebP (1-100)')
        .addSlider(slider => slider
            .setLimits(50, 100, 5)
            .setValue(settings.pdf.imageQuality)
            .setDynamicTooltip()
            .onChange(async (value) => {
                settings.pdf.imageQuality = value;
                await plugin.saveSettings();
                // Apply to active readers immediately
                plugin.updatePdfRenderSettings();
            }))
        .addExtraButton(button => button
            .setIcon('reset')
            .setTooltip('Reset to 85')
            .onClick(async () => {
                settings.pdf.imageQuality = 85;
                await plugin.saveSettings();
                containerEl.empty();
                PdfSettings({ plugin, containerEl });
            }));

    // ==========================================================================
    // CACHING & PRELOADING
    // ==========================================================================

    const cacheSection = createSection(containerEl, 'hard-drive', 'Caching & Preloading');

    createExplainerBox(cacheSection,
        'Caching stores rendered pages for faster navigation. Preloading fetches upcoming pages in advance.'
    );

    new Setting(cacheSection)
        .setName('Enable Page Cache')
        .setDesc('Cache rendered pages for faster navigation')
        .addToggle(toggle => toggle
            .setValue(settings.pdf.enablePageCache)
            .onChange(async (value) => {
                settings.pdf.enablePageCache = value;
                await plugin.saveSettings();
            }));

    new Setting(cacheSection)
        .setName('Memory Budget')
        .setDesc('Maximum memory for page cache (MB). Higher = more pages cached.')
        .addSlider(slider => slider
            .setLimits(50, 500, 50)
            .setValue(settings.pdf.memoryBudgetMB)
            .setDynamicTooltip()
            .onChange(async (value) => {
                settings.pdf.memoryBudgetMB = value;
                await plugin.saveSettings();
            }))
        .addExtraButton(button => button
            .setIcon('reset')
            .setTooltip('Reset to 200 MB')
            .onClick(async () => {
                settings.pdf.memoryBudgetMB = 200;
                await plugin.saveSettings();
                containerEl.empty();
                PdfSettings({ plugin, containerEl });
            }));

    new Setting(cacheSection)
        .setName('Cache Size (Legacy)')
        .setDesc('Maximum pages to keep in memory cache (used for entry-based caching)')
        .addSlider(slider => slider
            .setLimits(5, 50, 5)
            .setValue(settings.pdf.pageCacheSize)
            .setDynamicTooltip()
            .onChange(async (value) => {
                settings.pdf.pageCacheSize = value;
                await plugin.saveSettings();
            }))
        .addExtraButton(button => button
            .setIcon('reset')
            .setTooltip('Reset to 10')
            .onClick(async () => {
                settings.pdf.pageCacheSize = 10;
                await plugin.saveSettings();
                containerEl.empty();
                PdfSettings({ plugin, containerEl });
            }));

    new Setting(cacheSection)
        .setName('Preload Pages')
        .setDesc('Number of pages to preload ahead of current position')
        .addSlider(slider => slider
            .setLimits(0, 5, 1)
            .setValue(settings.pdf.pagePreloadCount)
            .setDynamicTooltip()
            .onChange(async (value) => {
                settings.pdf.pagePreloadCount = value;
                await plugin.saveSettings();
            }))
        .addExtraButton(button => button
            .setIcon('reset')
            .setTooltip('Reset to 2')
            .onClick(async () => {
                settings.pdf.pagePreloadCount = 2;
                await plugin.saveSettings();
                containerEl.empty();
                PdfSettings({ plugin, containerEl });
            }));

    // ==========================================================================
    // RENDERING QUALITY
    // ==========================================================================

    const qualitySection = createSection(containerEl, 'sliders', 'Rendering Quality');

    new Setting(qualitySection)
        .setName('Image Smoothing')
        .setDesc('Smooth image scaling (disable for pixelated look)')
        .addToggle(toggle => toggle
            .setValue(settings.pdf.enableImageSmoothing)
            .onChange(async (value) => {
                settings.pdf.enableImageSmoothing = value;
                await plugin.saveSettings();
            }));

    new Setting(qualitySection)
        .setName('Text Anti-aliasing')
        .setDesc('Smooth text edges for better readability')
        .addToggle(toggle => toggle
            .setValue(settings.pdf.enableTextAntialiasing)
            .onChange(async (value) => {
                settings.pdf.enableTextAntialiasing = value;
                await plugin.saveSettings();
            }));

    // ==========================================================================
    // BATCH REQUESTS
    // ==========================================================================

    const batchSection = createSection(containerEl, 'zap', 'Batch Requests');

    createExplainerBox(batchSection,
        'Batch requests combine multiple page requests into a single network call, ' +
        'reducing latency when scrolling through documents.'
    );

    new Setting(batchSection)
        .setName('Enable Batch Requests')
        .setDesc('Request multiple pages at once for faster loading')
        .addToggle(toggle => toggle
            .setValue(settings.pdf.enableBatchRequests)
            .onChange(async (value) => {
                settings.pdf.enableBatchRequests = value;
                await plugin.saveSettings();
            }));

    new Setting(batchSection)
        .setName('Batch Size')
        .setDesc('Number of pages per batch request (1-20)')
        .addSlider(slider => slider
            .setLimits(1, 20, 1)
            .setValue(settings.pdf.batchSize)
            .setDynamicTooltip()
            .onChange(async (value) => {
                settings.pdf.batchSize = value;
                await plugin.saveSettings();
            }));

    // ==========================================================================
    // ADVANCED PERFORMANCE
    // ==========================================================================

    const advancedSection = createSection(containerEl, 'settings-2', 'Advanced Performance');

    createExplainerBox(advancedSection,
        'Advanced settings for optimizing PDF rendering performance. ' +
        'These settings control text layer virtualization, prefetching strategy, and DOM recycling.'
    );

    new Setting(advancedSection)
        .setName('Text Layer Mode')
        .setDesc('How text layer is rendered for selection')
        .addDropdown(dropdown => dropdown
            .addOption('full', 'Full (All text spans)')
            .addOption('virtualized', 'Virtualized (Only visible)')
            .addOption('disabled', 'Disabled (No text selection)')
            .setValue(settings.pdf.textLayerMode)
            .onChange(async (value) => {
                settings.pdf.textLayerMode = value as 'full' | 'virtualized' | 'disabled';
                await plugin.saveSettings();
            }));

    new Setting(advancedSection)
        .setName('Prefetch Strategy')
        .setDesc('How pages are prefetched during reading')
        .addDropdown(dropdown => dropdown
            .addOption('none', 'None (No prefetching)')
            .addOption('fixed', 'Fixed (Same pages ahead/behind)')
            .addOption('adaptive', 'Adaptive (Based on scroll behavior)')
            .setValue(settings.pdf.prefetchStrategy)
            .onChange(async (value) => {
                settings.pdf.prefetchStrategy = value as 'none' | 'fixed' | 'adaptive';
                await plugin.saveSettings();
            }));

    new Setting(advancedSection)
        .setName('DOM Element Pooling')
        .setDesc('Recycle page DOM elements for better scroll performance')
        .addToggle(toggle => toggle
            .setValue(settings.pdf.enableDomPooling)
            .onChange(async (value) => {
                settings.pdf.enableDomPooling = value;
                await plugin.saveSettings();
            }));

    new Setting(advancedSection)
        .setName('Use IntersectionObserver')
        .setDesc('Use browser-native visibility detection (recommended)')
        .addToggle(toggle => toggle
            .setValue(settings.pdf.useIntersectionObserver)
            .onChange(async (value) => {
                settings.pdf.useIntersectionObserver = value;
                await plugin.saveSettings();
            }));

    // ==========================================================================
    // VIRTUALIZATION PERFORMANCE
    // ==========================================================================

    const virtualizationSection = createSection(containerEl, 'activity', 'Virtualization Performance');

    createExplainerBox(virtualizationSection,
        'Controls how pages are created and destroyed during scrolling. ' +
        'Tune these settings to prevent blank pages during rapid scrolling or at high zoom levels.'
    );

    new Setting(virtualizationSection)
        .setName('Render Debounce (ms)')
        .setDesc('Delay before rendering pages during scroll. Lower = more responsive, higher = less server load.')
        .addSlider(slider => slider
            .setLimits(50, 500, 25)
            .setValue(settings.pdf.renderDebounceMs)
            .setDynamicTooltip()
            .onChange(async (value) => {
                settings.pdf.renderDebounceMs = value;
                await plugin.saveSettings();
                plugin.updatePdfRenderSettings();
            }))
        .addExtraButton(button => button
            .setIcon('reset')
            .setTooltip('Reset to 150 ms')
            .onClick(async () => {
                settings.pdf.renderDebounceMs = 150;
                await plugin.saveSettings();
                containerEl.empty();
                PdfSettings({ plugin, containerEl });
            }));

    new Setting(virtualizationSection)
        .setName('Creation Buffer (px)')
        .setDesc('Minimum distance from viewport where pages are created. Higher = smoother scroll but more memory.')
        .addSlider(slider => slider
            .setLimits(50, 500, 25)
            .setValue(settings.pdf.minCreationBuffer)
            .setDynamicTooltip()
            .onChange(async (value) => {
                settings.pdf.minCreationBuffer = value;
                await plugin.saveSettings();
                plugin.updatePdfRenderSettings();
            }))
        .addExtraButton(button => button
            .setIcon('reset')
            .setTooltip('Reset to 150 px')
            .onClick(async () => {
                settings.pdf.minCreationBuffer = 150;
                await plugin.saveSettings();
                containerEl.empty();
                PdfSettings({ plugin, containerEl });
            }));

    new Setting(virtualizationSection)
        .setName('Keep Buffer (px)')
        .setDesc('Minimum distance from viewport where pages are kept alive. Higher = fewer re-renders but more memory.')
        .addSlider(slider => slider
            .setLimits(100, 1000, 50)
            .setValue(settings.pdf.minDestructionBuffer)
            .setDynamicTooltip()
            .onChange(async (value) => {
                settings.pdf.minDestructionBuffer = value;
                await plugin.saveSettings();
                plugin.updatePdfRenderSettings();
            }))
        .addExtraButton(button => button
            .setIcon('reset')
            .setTooltip('Reset to 300 px')
            .onClick(async () => {
                settings.pdf.minDestructionBuffer = 300;
                await plugin.saveSettings();
                containerEl.empty();
                PdfSettings({ plugin, containerEl });
            }));

    // ==========================================================================
    // PERFORMANCE PRESETS (WASM Tile Renderer)
    // ==========================================================================

    const presetSection = createSection(containerEl, 'gauge', 'Performance Presets');

    createExplainerBox(presetSection,
        'Performance presets optimize the tile-based renderer for different use cases. ' +
        'Changes apply immediately without restart.'
    );

    // Preset selector
    new Setting(presetSection)
        .setName('Preset')
        .setDesc('Choose a performance profile or customize individual settings')
        .addDropdown(dropdown => dropdown
            .addOption('balanced', 'Balanced (Recommended)')
            .addOption('performance', 'Performance (High-end devices)')
            .addOption('memory-saver', 'Memory Saver (Low-end devices)')
            .addOption('quality', 'Quality (Best visual fidelity)')
            .addOption('custom', 'Custom')
            .setValue(settings.pdf.performancePreset)
            .onChange(async (value) => {
                const preset = value as PdfPerformancePreset;
                settings.pdf.performancePreset = preset;

                // Apply preset values if not custom
                if (preset !== 'custom') {
                    settings.pdf.tilePerformance = { ...PDF_PERFORMANCE_PRESETS[preset] };
                    // Update the live manager
                    getPerformanceSettingsManager().applyPreset(preset);
                }

                await plugin.saveSettings();
                // Refresh to show/hide custom settings
                containerEl.empty();
                PdfSettings({ plugin, containerEl });
            }));

    // Show detailed settings only when custom preset is selected
    if (settings.pdf.performancePreset === 'custom') {
        const customSection = createSection(containerEl, 'sliders', 'Custom Performance Settings');

        // L1 Cache Size
        new Setting(customSection)
            .setName('L1 Cache Size (MB)')
            .setDesc('Memory cache for hot tiles. Higher = faster but more RAM.')
            .addSlider(slider => slider
                .setLimits(20, 150, 10)
                .setValue(settings.pdf.tilePerformance.l1CacheSizeMB)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.pdf.tilePerformance.l1CacheSizeMB = value;
                    getPerformanceSettingsManager().updateSetting('l1CacheSizeMB', value);
                    await plugin.saveSettings();
                }));

        // L2 Cache Size
        new Setting(customSection)
            .setName('L2 Cache Size (MB)')
            .setDesc('IndexedDB cache for warm tiles. Higher = more disk usage.')
            .addSlider(slider => slider
                .setLimits(50, 500, 25)
                .setValue(settings.pdf.tilePerformance.l2CacheSizeMB)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.pdf.tilePerformance.l2CacheSizeMB = value;
                    getPerformanceSettingsManager().updateSetting('l2CacheSizeMB', value);
                    await plugin.saveSettings();
                }));

        // Worker Count (requires restart)
        new Setting(customSection)
            .setName('Worker Count (requires restart)')
            .setDesc('Number of WASM workers. 0 = auto (based on CPU cores).')
            .addSlider(slider => slider
                .setLimits(0, 4, 1)
                .setValue(settings.pdf.tilePerformance.workerCount)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.pdf.tilePerformance.workerCount = value;
                    getPerformanceSettingsManager().updateSetting('workerCount', value);
                    await plugin.saveSettings();
                    new Notice('Worker count updated. Restart the plugin to apply the new value.');
                }));

        // Scroll Debounce
        new Setting(customSection)
            .setName('Scroll Debounce (ms)')
            .setDesc('Delay before re-rendering during scroll. Lower = more responsive.')
            .addSlider(slider => slider
                .setLimits(8, 100, 4)
                .setValue(settings.pdf.tilePerformance.scrollDebounceMsOverride)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.pdf.tilePerformance.scrollDebounceMsOverride = value;
                    getPerformanceSettingsManager().updateSetting('scrollDebounceMsOverride', value);
                    await plugin.saveSettings();
                }));

        // Zoom Debounce
        new Setting(customSection)
            .setName('Zoom Debounce (ms)')
            .setDesc('Delay before final quality render after zoom. Lower = faster.')
            .addSlider(slider => slider
                .setLimits(25, 300, 25)
                .setValue(settings.pdf.tilePerformance.zoomDebounceMs)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.pdf.tilePerformance.zoomDebounceMs = value;
                    getPerformanceSettingsManager().updateSetting('zoomDebounceMs', value);
                    await plugin.saveSettings();
                }));

        // Prefetch Viewports
        new Setting(customSection)
            .setName('Prefetch Viewports')
            .setDesc('Number of viewports to prefetch ahead during scroll.')
            .addSlider(slider => slider
                .setLimits(1, 4, 1)
                .setValue(settings.pdf.tilePerformance.prefetchViewports)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.pdf.tilePerformance.prefetchViewports = value;
                    getPerformanceSettingsManager().updateSetting('prefetchViewports', value);
                    await plugin.saveSettings();
                }));

        // Fast Scroll Quality
        new Setting(customSection)
            .setName('Fast Scroll Quality (%)')
            .setDesc('Quality reduction during fast scrolling. Lower = smoother scroll.')
            .addSlider(slider => slider
                .setLimits(25, 100, 5)
                .setValue(Math.round(settings.pdf.tilePerformance.fastScrollQuality * 100))
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.pdf.tilePerformance.fastScrollQuality = value / 100;
                    getPerformanceSettingsManager().updateSetting('fastScrollQuality', value / 100);
                    await plugin.saveSettings();
                }));

        // Progressive Zoom Toggle
        new Setting(customSection)
            .setName('Progressive Zoom')
            .setDesc('Enable multi-resolution zoom for instant feedback.')
            .addToggle(toggle => toggle
                .setValue(settings.pdf.tilePerformance.enableProgressiveZoom)
                .onChange(async (value) => {
                    settings.pdf.tilePerformance.enableProgressiveZoom = value;
                    getPerformanceSettingsManager().updateSetting('enableProgressiveZoom', value);
                    await plugin.saveSettings();
                }));

        // Hybrid Rendering Toggle
        new Setting(customSection)
            .setName('Hybrid Rendering')
            .setDesc('Use full-page rendering at low zoom, tiles at high zoom.')
            .addToggle(toggle => toggle
                .setValue(settings.pdf.tilePerformance.enableHybridRendering)
                .onChange(async (value) => {
                    settings.pdf.tilePerformance.enableHybridRendering = value;
                    getPerformanceSettingsManager().updateSetting('enableHybridRendering', value);
                    await plugin.saveSettings();
                }));
    }
}
