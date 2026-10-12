import { Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import type { App, Plugin, SettingDefinitionItem } from 'obsidian';
import type { PdfHighlighterSettings } from './color-palette';
import { PaletteEditorSession } from './palette-editor';

export {
	DEFAULT_SETTINGS,
	getDefaultColor,
	hexToRgbColor,
	normalizePdfHighlighterSettings,
	normalizePdfHighlighterSettingsForLoad,
	persistPdfHighlighterSettingsIfNeeded,
} from './color-palette';
export type {
	HighlightColorOption,
	PdfHighlighterSettings,
	PdfHighlighterSettingsLoadResult,
} from './color-palette';

/** What the settings tab needs from the plugin, without importing its concrete class. */
export interface SettingsHost {
	settings: PdfHighlighterSettings;
	saveSettings(settings?: PdfHighlighterSettings): Promise<void | PdfHighlighterSettings>;
}

class PaletteEditorModal extends Modal {
	private readonly editor: PaletteEditorSession;
	private releaseMount: (() => void) | null = null;

	constructor(app: App, editor: PaletteEditorSession) {
		super(app);
		this.editor = editor;
	}

	onOpen(): void {
		this.titleEl.setText('Customize highlight colors');
		this.contentEl.addClass('study-pdf-palette-modal');
		this.releaseMount = this.editor.mount(this.contentEl);
	}

	onClose(): void {
		this.releaseMount?.();
		this.releaseMount = null;
		this.contentEl.empty();
	}
}

export class PdfHighlighterSettingTab extends PluginSettingTab {
	private readonly host: SettingsHost;
	private paletteEditor: PaletteEditorSession | null = null;

	constructor(app: App, plugin: Plugin, host: SettingsHost) {
		super(app, plugin);
		this.host = host;
	}

	private getPaletteEditor(): PaletteEditorSession {
		if (!this.paletteEditor) {
			this.paletteEditor = new PaletteEditorSession(this.host, (error) => {
				const detail = error instanceof Error ? error.message : String(error);
				new Notice(`Study PDF: could not save highlight colors — ${detail}`);
			});
		}
		return this.paletteEditor;
	}

	private addPaletteModalButton(setting: Setting): void {
		setting
			.setDesc('Set the colors and default used for highlights you create from now on.')
			.addButton((button) => button
				.setButtonText('Edit highlight colors')
				.setCta()
				.onClick(() => new PaletteEditorModal(this.app, this.getPaletteEditor()).open()));
	}

	/** Obsidian 1.13+ renders declarative definitions instead of calling display(). */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [{
			type: 'group',
			heading: 'Highlight colors',
			items: [{
				name: 'Customize palette',
				aliases: ['default highlight color', 'custom color', 'hex'],
				render: (setting: Setting) => this.addPaletteModalButton(setting),
			}],
		}];
	}

	/** Fallback for earlier Obsidian versions without declarative settings. */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl).setName('Highlight colors').setHeading();
		this.addPaletteModalButton(new Setting(containerEl).setName('Customize palette'));
	}
}
