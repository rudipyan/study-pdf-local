import type { RgbColor } from './annotate';
import type { HighlightColorOption, PdfHighlighterSettings } from './color-palette';

export interface PaletteEditorHost {
	settings: PdfHighlighterSettings;
	saveSettings(settings: PdfHighlighterSettings): Promise<void | PdfHighlighterSettings>;
}

export function clonePaletteSettings(settings: PdfHighlighterSettings): PdfHighlighterSettings {
	return { ...settings, colors: settings.colors.map((color) => ({ ...color })) };
}

export function addPaletteColor(settings: PdfHighlighterSettings): PdfHighlighterSettings {
	const next = clonePaletteSettings(settings);
	let index = 1;
	while (next.colors.some((color) => color.id === `custom-${index}`)) index++;
	const usedNames = new Set(next.colors.map((color) => color.name.trim().toLowerCase()));
	const baseName = `Custom color ${index}`;
	let name = baseName;
	let suffix = 2;
	while (usedNames.has(name.toLowerCase())) name = `${baseName} (${suffix++})`;
	next.colors.push({ id: `custom-${index}`, name, hex: '#f5a623' });
	return next;
}

export function removePaletteColor(settings: PdfHighlighterSettings, colorId: string): PdfHighlighterSettings {
	if (settings.colors.length <= 1 || !settings.colors.some((color) => color.id === colorId)) return settings;
	const next = clonePaletteSettings(settings);
	next.colors = next.colors.filter((color) => color.id !== colorId);
	if (!next.colors.some((color) => color.id === next.defaultColorId)) next.defaultColorId = next.colors[0]!.id;
	return next;
}

export function updatePaletteColor(
	settings: PdfHighlighterSettings,
	colorId: string,
	update: Partial<Pick<HighlightColorOption, 'name' | 'hex'>>,
): PdfHighlighterSettings {
	const next = clonePaletteSettings(settings);
	next.colors = next.colors.map((color) => color.id === colorId ? { ...color, ...update } : color);
	return next;
}

export function getPaletteNameError(
	settings: PdfHighlighterSettings,
	colorId: string,
	name: string,
): string | null {
	const trimmed = name.trim();
	if (!trimmed) return 'Enter a name.';
	const normalized = trimmed.toLowerCase();
	if (settings.colors.some((color) => color.id !== colorId && color.name.trim().toLowerCase() === normalized)) {
		return 'A color with this name already exists.';
	}
	return null;
}

export function setPaletteDefault(settings: PdfHighlighterSettings, colorId: string): PdfHighlighterSettings {
	if (!settings.colors.some((color) => color.id === colorId)) return settings;
	return { ...clonePaletteSettings(settings), defaultColorId: colorId };
}

export function defaultFirstColors(settings: PdfHighlighterSettings): HighlightColorOption[] {
	return settings.colors
		.map((color, index) => ({ color, index }))
		.sort((a, b) => Number(b.color.id === settings.defaultColorId) - Number(a.color.id === settings.defaultColorId) || a.index - b.index)
		.map(({ color }) => ({ ...color }));
}

export function isValidHexDraft(value: string): boolean {
	return /^#[\da-f]{6}$/i.test(value.trim());
}

export function formatRgbHex(color: RgbColor): string {
	const channel = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, '0');
	return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

export function clampPopupPosition(
	anchor: { x: number; y: number },
	size: { width: number; height: number },
	viewport: { offsetLeft: number; offsetTop: number; width: number; height: number },
): { left: number; top: number } {
	const left = viewport.offsetLeft;
	const top = viewport.offsetTop;
	return {
		left: Math.max(left + 4, Math.min(anchor.x + left, left + viewport.width - size.width - 4)),
		top: Math.max(top + 4, Math.min(anchor.y + top, top + viewport.height - size.height - 4)),
	};
}

export function popupMaxSize(viewport: { width: number; height: number }): { width: number; height: number } {
	return { width: Math.max(0, viewport.width - 8), height: Math.max(0, viewport.height - 8) };
}

export function candidateNotePreview(note: string | null | undefined): string | null {
	return note?.trim() ? note : null;
}

export function candidateAccessibleLabel(
	candidate: { quote: string | null | undefined; pageIndex: number },
	index: number,
	total: number,
): string {
	const quote = (candidate.quote?.trim() ?? '').replace(/\s+/g, ' ') || 'no saved quote';
	const excerpt = quote.length > 100 ? `${quote.slice(0, 97)}…` : quote;
	return `highlight ${index + 1} of ${total}, page ${candidate.pageIndex + 1}: “${excerpt}”`;
}

interface FocusSnapshot {
	container: HTMLElement;
	focusKey: string;
	fallbackFocusKeys: string[];
	selectionStart: number | null;
	selectionEnd: number | null;
	selectionDirection: 'forward' | 'backward' | 'none' | null;
}

/** Owns an editable palette draft and serializes all persistence calls. */
export class PaletteEditorSession {
	private draft: PdfHighlighterSettings;
	private saveTail: Promise<void> = Promise.resolve();
	private revision = 0;
	private readonly containers = new Set<HTMLElement>();
	private readonly hexDrafts = new Map<string, string>();
	private readonly nameDrafts = new Map<string, string>();
	private readonly hexDraftVersions = new Map<string, number>();
	private readonly nameDraftVersions = new Map<string, number>();
	private readonly host: PaletteEditorHost;
	private readonly onSaveError: (error: unknown) => void;

	constructor(host: PaletteEditorHost, onSaveError: (error: unknown) => void) {
		this.host = host;
		this.onSaveError = onSaveError;
		this.draft = clonePaletteSettings(host.settings);
	}

	mount(container: HTMLElement): () => void {
		this.containers.add(container);
		this.renderContainer(container);
		return () => {
			this.containers.delete(container);
			container.empty();
		};
	}

	getNameDraft(colorId: string): string | undefined {
		return this.nameDrafts.get(colorId);
	}

	getHexDraft(colorId: string): string | undefined {
		return this.hexDrafts.get(colorId);
	}

	updateNameDraft(colorId: string, value: string): void {
		this.nameDrafts.set(colorId, value);
		this.nameDraftVersions.set(colorId, (this.nameDraftVersions.get(colorId) ?? 0) + 1);
	}

	updateHexDraft(colorId: string, value: string): void {
		this.hexDrafts.set(colorId, value);
		this.hexDraftVersions.set(colorId, (this.hexDraftVersions.get(colorId) ?? 0) + 1);
	}

	commitNameDraft(colorId: string, submittedName: string): Promise<boolean> {
		const submittedVersion = this.nameDraftVersions.get(colorId) ?? 0;
		return this.commitSettings(
			(settings) => updatePaletteColor(settings, colorId, { name: submittedName }),
			{ refresh: false, rollbackOnFailure: false },
		).then((saved) => {
			if (saved && this.nameDraftVersions.get(colorId) === submittedVersion && this.nameDrafts.get(colorId) === submittedName) {
				this.nameDrafts.delete(colorId);
			}
			return saved;
		});
	}

	commitHexDraft(colorId: string, submittedHex: string): Promise<boolean> {
		const submittedVersion = this.hexDraftVersions.get(colorId) ?? 0;
		return this.commitSettings(
			(settings) => updatePaletteColor(settings, colorId, { hex: submittedHex }),
			{ refresh: false, rollbackOnFailure: false },
		).then((saved) => {
			if (saved && this.hexDraftVersions.get(colorId) === submittedVersion && this.hexDrafts.get(colorId) === submittedHex) {
				this.hexDrafts.delete(colorId);
			}
			return saved;
		});
	}

	private captureFocusedInput(): FocusSnapshot | undefined {
		for (const container of this.containers) {
			const active = container.ownerDocument.activeElement;
			if (!(active instanceof container.ownerDocument.defaultView!.HTMLElement) || !container.contains(active)) continue;
			const focusKey = active.getAttribute('data-palette-focus-key');
			if (!focusKey) continue;
			let selectionStart: number | null = null;
			let selectionEnd: number | null = null;
			let selectionDirection: FocusSnapshot['selectionDirection'] = null;
			if (active instanceof container.ownerDocument.defaultView!.HTMLInputElement ||
				active instanceof container.ownerDocument.defaultView!.HTMLTextAreaElement) {
				try {
					selectionStart = active.selectionStart;
					selectionEnd = active.selectionEnd;
					selectionDirection = active.selectionDirection;
				} catch {
					// Color inputs do not expose a text selection range.
				}
			}
			const removedColorId = focusKey.startsWith('palette:remove:')
				? focusKey.slice('palette:remove:'.length)
				: null;
			const defaultColorId = focusKey.startsWith('palette:default:')
				? focusKey.slice('palette:default:'.length)
				: null;
			const fallbackFocusKeys = removedColorId !== null
				? ['palette:add']
				: defaultColorId !== null
					? [`palette:name:${defaultColorId}`, 'palette:add']
					: ['palette:add'];
			return { container, focusKey, fallbackFocusKeys, selectionStart, selectionEnd, selectionDirection };
		}
		return undefined;
	}

	private restoreFocusedInput(snapshot: FocusSnapshot | undefined): void {
		if (!snapshot?.container.isConnected) return;
		const focusable = Array.from(snapshot.container.querySelectorAll<HTMLElement>('[data-palette-focus-key]'));
		const replacement = [snapshot.focusKey, ...snapshot.fallbackFocusKeys]
			.map((focusKey) => focusable.find((element) => element.getAttribute('data-palette-focus-key') === focusKey))
			.find((element) => element !== undefined);
		if (!replacement) return;
		replacement.focus({ preventScroll: true });
		if (snapshot.selectionStart === null || snapshot.selectionEnd === null ||
			!(replacement instanceof snapshot.container.ownerDocument.defaultView!.HTMLInputElement ||
				replacement instanceof snapshot.container.ownerDocument.defaultView!.HTMLTextAreaElement)) return;
		try {
			replacement.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd, snapshot.selectionDirection ?? undefined);
		} catch {
			// Keep focus even if the browser does not support selection restoration.
		}
	}

	private refresh() {
		const focus = this.captureFocusedInput();
		for (const container of this.containers) {
			if (container.isConnected) this.renderContainer(container);
		}
		this.restoreFocusedInput(focus);
	}

	private renderContainer(container: HTMLElement) {
		container.empty();
		const root = container.createDiv({ cls: 'study-pdf-palette-editor' });
		const toolbar = root.createDiv({ cls: 'study-pdf-palette-toolbar' });
		toolbar.createEl('p', { text: 'Changes apply to highlights you create from now on.' });
		const add = toolbar.createEl('button', { text: 'Add color' });
		add.type = 'button';
		add.setAttribute('data-palette-focus-key', 'palette:add');
		add.addEventListener('click', () => { void this.commitSettings((settings) => addPaletteColor(settings)); });
		for (const color of this.draft.colors) this.renderColorRow(root, color);
	}

	private renderColorRow(container: HTMLElement, color: HighlightColorOption) {
		const row = container.createDiv({ cls: 'study-pdf-palette-row' });
		row.dataset.colorId = color.id;
		const safeId = Array.from(color.id, (character) => character.codePointAt(0)!.toString(16)).join('-');
		const nameId = `study-pdf-color-name-${safeId}`;
		const pickerId = `study-pdf-color-picker-${safeId}`;
		const hexId = `study-pdf-color-hex-${safeId}`;

		const nameField = row.createDiv({ cls: 'study-pdf-palette-field' });
		const nameLabel = nameField.createEl('label', { text: 'Name' });
		nameLabel.htmlFor = nameId;
		const nameInput = nameField.createEl('input', { attr: { type: 'text', id: nameId } });
		nameInput.value = this.nameDrafts.get(color.id) ?? color.name;
		nameInput.setAttribute('data-palette-focus-key', `palette:name:${color.id}`);
		nameInput.setAttribute('aria-label', `Name for ${color.name}`);
			const nameError = nameField.createSpan({ cls: 'study-pdf-palette-error', attr: { role: 'alert' } });
		const updateNameError = () => {
			const name = nameInput.value.trim();
			const error = getPaletteNameError(this.draft, color.id, name);
			nameInput.setAttribute('aria-invalid', String(error !== null));
			nameError.setText(error ?? '');
			return error;
		};
		if (this.nameDrafts.has(color.id)) updateNameError();
		nameInput.addEventListener('input', () => {
			this.updateNameDraft(color.id, nameInput.value);
			updateNameError();
		});
		nameInput.addEventListener('change', () => {
			const name = nameInput.value.trim();
			if (updateNameError()) return;
			nameInput.value = name;
			this.updateNameDraft(color.id, name);
			void this.commitNameDraft(color.id, name);
		});

		const colorField = row.createDiv({ cls: 'study-pdf-palette-field study-pdf-palette-picker-field' });
		const colorLabel = colorField.createEl('label', { text: 'Color' });
		colorLabel.htmlFor = pickerId;
		const picker = colorField.createEl('input', { attr: { type: 'color', id: pickerId } });
		picker.value = color.hex;
		picker.setAttribute('data-palette-focus-key', `palette:picker:${color.id}`);
		picker.setAttribute('aria-label', `Choose color for ${color.name}`);

		const hexField = row.createDiv({ cls: 'study-pdf-palette-field' });
		const hexLabel = hexField.createEl('label', { text: 'Hex' });
		hexLabel.htmlFor = hexId;
		const hexInput = hexField.createEl('input', { attr: { type: 'text', id: hexId, spellcheck: 'false' } });
		hexInput.value = this.hexDrafts.get(color.id) ?? color.hex;
		hexInput.setAttribute('data-palette-focus-key', `palette:hex:${color.id}`);
		hexInput.setAttribute('aria-label', `Hex color for ${color.name}`);
		picker.addEventListener('change', () => {
			const hex = picker.value.toLowerCase();
			hexInput.value = hex;
			this.updateHexDraft(color.id, hex);
			void this.commitHexDraft(color.id, hex);
		});
			const hexError = hexField.createSpan({ cls: 'study-pdf-palette-error', attr: { role: 'alert' } });
		const updateHexError = () => {
			const valid = isValidHexDraft(hexInput.value);
			hexInput.setAttribute('aria-invalid', String(!valid));
			hexError.setText(valid ? '' : 'Use #RRGGBB');
		};
		updateHexError();
		hexInput.addEventListener('input', () => {
			this.updateHexDraft(color.id, hexInput.value);
			updateHexError();
		});
		hexInput.addEventListener('change', () => {
			if (!isValidHexDraft(hexInput.value)) {
				updateHexError();
				return;
			}
			const hex = hexInput.value.trim().toLowerCase();
			hexInput.value = hex;
			picker.value = hex;
			this.updateHexDraft(color.id, hex);
			void this.commitHexDraft(color.id, hex);
		});

		const actions = row.createDiv({ cls: 'study-pdf-palette-actions' });
		if (this.draft.defaultColorId === color.id) {
			actions.createSpan({ cls: 'study-pdf-default-indicator', text: 'Default color' });
		} else {
			const setDefault = actions.createEl('button', { text: 'Set as default' });
			setDefault.type = 'button';
			setDefault.setAttribute('data-palette-focus-key', `palette:default:${color.id}`);
			setDefault.setAttribute('aria-label', `Set ${color.name} as default highlight color`);
			setDefault.addEventListener('click', () => { void this.commitSettings((settings) => setPaletteDefault(settings, color.id)); });
		}
		const remove = actions.createEl('button', { text: 'Remove' });
		remove.type = 'button';
		remove.setAttribute('data-palette-focus-key', `palette:remove:${color.id}`);
		remove.disabled = this.draft.colors.length <= 1;
		remove.setAttribute('aria-label', `Remove ${color.name}`);
		remove.addEventListener('click', () => {
			void this.commitSettings((settings) => removePaletteColor(settings, color.id)).then((saved) => {
				if (saved) {
					this.hexDrafts.delete(color.id);
					this.nameDrafts.delete(color.id);
				}
				this.refresh();
			});
		});
	}

	commitSettings(
		update: (settings: PdfHighlighterSettings) => PdfHighlighterSettings,
		options: { refresh?: boolean; rollbackOnFailure?: boolean } = {},
	): Promise<boolean> {
		const shouldRefresh = options.refresh !== false;
		const next = update(this.draft);
		if (next === this.draft) return Promise.resolve(false);
		this.draft = next;
		const revision = ++this.revision;
		const snapshot = clonePaletteSettings(next);
		if (shouldRefresh) this.refresh();
		const operation = this.saveTail.catch(() => undefined).then(() => this.host.saveSettings(snapshot));
		this.saveTail = operation.then(() => undefined, () => undefined);
		return operation.then(
			(persistedSettings) => {
				const persisted = persistedSettings ?? snapshot;
				this.host.settings = clonePaletteSettings(persisted);
				if (revision === this.revision) {
					this.draft = clonePaletteSettings(persisted);
					if (shouldRefresh) this.refresh();
				}
				return true;
			},
			(error: unknown) => {
				this.onSaveError(error);
				if (revision === this.revision && options.rollbackOnFailure !== false) {
					this.draft = clonePaletteSettings(this.host.settings);
					if (shouldRefresh) this.refresh();
				}
				return false;
			},
		);
	}
}
