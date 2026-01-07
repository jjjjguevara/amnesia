/**
 * HUD Settings Tab
 *
 * Configuration for the Heads-Up Display (status bar and floating panel).
 */

import { Setting } from 'obsidian';
import type AmnesiaPlugin from '../../main';
import type { HudStatusBarMetric } from '../settings';
import type { TabName } from '../../hud/types';
import {
    createTabHeader,
    createSection,
    createSubsectionHeader,
    createExplainerBox,
} from '../settings-ui/section-helpers';

export interface HudSettingsProps {
    plugin: AmnesiaPlugin;
    containerEl: HTMLElement;
}

export function HudSettings({ plugin, containerEl }: HudSettingsProps): void {
    const { settings } = plugin;

    // ==========================================================================
    // TAB HEADER
    // ==========================================================================

    createTabHeader(
        containerEl,
        'HUD',
        'Configure the Heads-Up Display for quick access to reading stats and library info.'
    );

    // ==========================================================================
    // GENERAL SETTINGS
    // ==========================================================================

    const generalSection = createSection(containerEl, 'layout-dashboard', 'General');

    createExplainerBox(generalSection,
        'The HUD provides a quick-access panel from the status bar showing your reading activity, library stats, and server status.'
    );

    new Setting(generalSection)
        .setName('Enable HUD')
        .setDesc('Show the HUD in the status bar')
        .addToggle(toggle => toggle
            .setValue(settings.hud.enabled)
            .onChange(async (value) => {
                settings.hud.enabled = value;
                await plugin.saveSettings();
                // Note: HUD will be reloaded on next plugin restart
            }));

    new Setting(generalSection)
        .setName('Default Tab')
        .setDesc('Which tab to show when opening the HUD')
        .addDropdown(dropdown => dropdown
            .addOption('reading', 'Reading')
            .addOption('library', 'Library')
            .addOption('stats', 'Stats')
            .addOption('server', 'Server')
            .addOption('series', 'Series')
            .setValue(settings.hud.defaultTab)
            .onChange(async (value) => {
                settings.hud.defaultTab = value as TabName;
                await plugin.saveSettings();
            }));

    new Setting(generalSection)
        .setName('Remember Last Tab')
        .setDesc('Open HUD to the last viewed tab instead of the default')
        .addToggle(toggle => toggle
            .setValue(settings.hud.rememberLastTab)
            .onChange(async (value) => {
                settings.hud.rememberLastTab = value;
                await plugin.saveSettings();
            }));

    // ==========================================================================
    // STATUS BAR
    // ==========================================================================

    const statusBarSection = createSection(containerEl, 'bar-chart', 'Status Bar');

    new Setting(statusBarSection)
        .setName('Show Server Status')
        .setDesc('Display server status indicator in the status bar')
        .addToggle(toggle => toggle
            .setValue(settings.hud.showServerStatus)
            .onChange(async (value) => {
                settings.hud.showServerStatus = value;
                await plugin.saveSettings();
            }));

    new Setting(statusBarSection)
        .setName('Show Badges')
        .setDesc('Show count badges on HUD tabs')
        .addToggle(toggle => toggle
            .setValue(settings.hud.showBadges)
            .onChange(async (value) => {
                settings.hud.showBadges = value;
                await plugin.saveSettings();
            }));

    // Status bar metrics (multi-select would be ideal, using toggles for now)
    createSubsectionHeader(statusBarSection, 'Displayed Metrics');

    const metricOptions: { id: HudStatusBarMetric; name: string; desc: string }[] = [
        { id: 'reading-count', name: 'Reading Count', desc: 'Number of books currently reading' },
        { id: 'highlight-count', name: 'Highlight Count', desc: 'Total number of highlights' },
        { id: 'today-highlights', name: "Today's Highlights", desc: 'Highlights created today' },
        { id: 'streak', name: 'Reading Streak', desc: 'Consecutive days with reading activity' },
    ];

    for (const metric of metricOptions) {
        new Setting(statusBarSection)
            .setName(metric.name)
            .setDesc(metric.desc)
            .addToggle(toggle => toggle
                .setValue(settings.hud.statusBarMetrics.includes(metric.id))
                .onChange(async (value) => {
                    if (value) {
                        if (!settings.hud.statusBarMetrics.includes(metric.id)) {
                            settings.hud.statusBarMetrics.push(metric.id);
                        }
                    } else {
                        settings.hud.statusBarMetrics = settings.hud.statusBarMetrics.filter(m => m !== metric.id);
                    }
                    await plugin.saveSettings();
                }));
    }

    // ==========================================================================
    // TAB VISIBILITY
    // ==========================================================================

    const tabsSection = createSection(containerEl, 'layout-grid', 'Tab Visibility');

    createExplainerBox(tabsSection,
        'Choose which tabs appear in the HUD. Hidden tabs are still accessible via keyboard shortcuts.'
    );

    const tabOptions: { id: keyof typeof settings.hud.tabVisibility; name: string; desc: string }[] = [
        { id: 'reading', name: 'Reading Tab', desc: 'Currently reading books and recent activity' },
        { id: 'library', name: 'Library Tab', desc: 'Library stats and recently added books' },
        { id: 'stats', name: 'Stats Tab', desc: 'Highlight statistics and activity charts' },
        { id: 'server', name: 'Server Tab', desc: 'Local server status and controls' },
        { id: 'series', name: 'Series Tab', desc: 'Series progress tracking' },
    ];

    for (const tab of tabOptions) {
        new Setting(tabsSection)
            .setName(tab.name)
            .setDesc(tab.desc)
            .addToggle(toggle => toggle
                .setValue(settings.hud.tabVisibility[tab.id])
                .onChange(async (value) => {
                    settings.hud.tabVisibility[tab.id] = value;
                    await plugin.saveSettings();
                }));
    }

    // ==========================================================================
    // APPEARANCE
    // ==========================================================================

    const appearanceSection = createSection(containerEl, 'palette', 'Appearance');

    new Setting(appearanceSection)
        .setName('Panel Width')
        .setDesc('Width of the floating HUD panel in pixels')
        .addSlider(slider => slider
            .setLimits(300, 600, 50)
            .setValue(settings.hud.compactViewWidth)
            .setDynamicTooltip()
            .onChange(async (value) => {
                settings.hud.compactViewWidth = value;
                await plugin.saveSettings();
            }));

    new Setting(appearanceSection)
        .setName('Auto-close Delay')
        .setDesc('Automatically close unpinned HUD after inactivity (seconds, 0 = never)')
        .addSlider(slider => slider
            .setLimits(0, 60, 5)
            .setValue(settings.hud.autoCloseDelay / 1000)
            .setDynamicTooltip()
            .onChange(async (value) => {
                settings.hud.autoCloseDelay = value * 1000;
                await plugin.saveSettings();
            }));

    // ==========================================================================
    // INTEGRATION
    // ==========================================================================

    const integrationSection = createSection(containerEl, 'plug', 'Integration');

    new Setting(integrationSection)
        .setName('Doc Doctor Integration')
        .setDesc('Register as a HUD provider with Doc Doctor when available')
        .addToggle(toggle => toggle
            .setValue(settings.hud.useDocDoctorIntegration)
            .onChange(async (value) => {
                settings.hud.useDocDoctorIntegration = value;
                await plugin.saveSettings();
            }));

    // ==========================================================================
    // KEYBOARD SHORTCUTS INFO
    // ==========================================================================

    const keyboardSection = createSection(containerEl, 'keyboard', 'Keyboard Shortcuts');

    createExplainerBox(keyboardSection,
        `<strong>Available shortcuts:</strong>
        <ul style="margin: 8px 0; padding-left: 20px;">
            <li><code>Escape</code> - Close HUD or go back</li>
            <li><code>Tab</code> / <code>Arrow Keys</code> - Navigate tabs</li>
            <li><code>Ctrl+Shift+H</code> - Toggle HUD</li>
            <li><code>Ctrl+P</code> (in HUD) - Toggle pin</li>
        </ul>
        Configure additional hotkeys in Obsidian's Hotkeys settings.`
    );
}
