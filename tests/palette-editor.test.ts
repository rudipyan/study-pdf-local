import { describe, expect, it } from 'vitest';
import {
	addPaletteColor,
	candidateAccessibleLabel,
	clampPopupPosition,
	candidateNotePreview,
	defaultFirstColors,
	formatRgbHex,
	getPaletteNameError,
	isValidHexDraft,
	PaletteEditorSession,
	popupMaxSize,
	removePaletteColor,
	setPaletteDefault,
	updatePaletteColor,
} from '../src/palette-editor';
import type { PdfHighlighterSettings } from '../src/color-palette';
import { normalizePdfHighlighterSettings } from '../src/color-palette';

type FakeOptions = { cls?: string; text?: string; attr?: Record<string, string> };

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly dataset: Record<string, string> = {};
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, ((event: { target: FakeElement }) => void)[]>();
	parent: FakeElement | null = null;
	value = '';
	type = '';
	disabled = false;
	id = '';
	htmlFor = '';
	textContent = '';
	private readonly rootConnected: boolean;

	constructor(readonly ownerDocument: FakeDocument, readonly tagName: string, rootConnected = false) {
		this.rootConnected = rootConnected;
	}

	get isConnected(): boolean {
		return this.parent ? this.parent.isConnected : this.rootConnected;
	}

	createDiv(options: FakeOptions = {}): FakeElement {
		return this.createChild('div', options);
	}

	createEl(tagName: string, options: FakeOptions = {}): FakeElement {
		return this.createChild(tagName, options);
	}

	private createChild(tagName: string, options: FakeOptions): FakeElement {
		const child = tagName === 'input'
			? new FakeInput(this.ownerDocument, tagName)
			: tagName === 'textarea'
				? new FakeTextArea(this.ownerDocument, tagName)
				: new FakeElement(this.ownerDocument, tagName);
		child.parent = this;
		if (options.cls) child.setAttribute('class', options.cls);
		if (options.text) child.textContent = options.text;
		for (const [name, value] of Object.entries(options.attr ?? {})) child.setAttribute(name, value);
		this.children.push(child);
		return child;
	}

	empty(): void {
		for (const child of this.children) child.parent = null;
		this.children.length = 0;
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
		if (name === 'id') this.id = value;
		if (name.startsWith('data-')) {
			const key = name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
			this.dataset[key] = value;
		}
	}

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	setText(value: string): void {
		this.textContent = value;
	}

	addEventListener(name: string, listener: (event: { target: FakeElement }) => void): void {
		const listeners = this.listeners.get(name) ?? [];
		listeners.push(listener);
		this.listeners.set(name, listeners);
	}

	dispatch(name: string): void {
		for (const listener of this.listeners.get(name) ?? []) listener({ target: this });
	}

	click(): void {
		if (!this.isConnected || this.disabled) return;
		this.focus();
		this.dispatch('click');
	}

	focus(): void {
		this.ownerDocument.activeElement = this;
	}

	contains(candidate: unknown): boolean {
		let current = candidate as FakeElement | null;
		while (current) {
			if (current === this) return true;
			current = current.parent;
		}
		return false;
	}

	querySelectorAll<T = FakeElement>(selector: string): T[] {
		const matches = (element: FakeElement) => selector === '[id]'
			? element.id.length > 0
			: selector === '[data-palette-focus-key]'
				? element.getAttribute('data-palette-focus-key') !== null
				: false;
		const found: FakeElement[] = [];
		const visit = (element: FakeElement) => {
			for (const child of element.children) {
				if (matches(child)) found.push(child);
				visit(child);
			}
		};
		visit(this);
		return found as T[];
	}
}

class FakeInput extends FakeElement {
	selectionStart: number | null = 0;
	selectionEnd: number | null = 0;
	selectionDirection: 'forward' | 'backward' | 'none' | null = 'none';
	setSelectionRange(start: number, end: number, direction?: 'forward' | 'backward' | 'none'): void {
		this.selectionStart = start;
		this.selectionEnd = end;
		this.selectionDirection = direction ?? 'none';
	}
}

class FakeTextArea extends FakeInput {}

class FakeDocument {
	activeElement: FakeElement | null = null;
	readonly defaultView = {
		HTMLElement: FakeElement,
		HTMLInputElement: FakeInput,
		HTMLTextAreaElement: FakeTextArea,
	};
}

function fakeContainer(document: FakeDocument): HTMLElement {
	return new FakeElement(document, 'div', true) as unknown as HTMLElement;
}

function fakeControl(container: HTMLElement, focusKey: string): FakeElement {
	return (container as unknown as FakeElement)
		.querySelectorAll<FakeElement>('[data-palette-focus-key]')
		.find((element) => element.getAttribute('data-palette-focus-key') === focusKey)!;
}

async function waitForSavedCount(saved: readonly unknown[], expected: number): Promise<void> {
	for (let attempt = 0; attempt < 20 && saved.length < expected; attempt++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}

const initial: PdfHighlighterSettings = {
	colors: [
		{ id: 'first', name: 'First', hex: '#123456' },
		{ id: 'second', name: 'Second', hex: '#abcdef' },
	],
	defaultColorId: 'second',
};

describe('palette editor model', () => {
	it('adds stable unique IDs and removes colors without leaving an invalid default', () => {
		const added = addPaletteColor(initial);
		expect(added.colors.map(({ id }) => id)).toEqual(['first', 'second', 'custom-1']);
		expect(added.defaultColorId).toBe('second');
		const afterDefaultRemoval = removePaletteColor(added, 'second');
		expect(afterDefaultRemoval.defaultColorId).toBe('first');
		expect(afterDefaultRemoval.colors.map(({ id }) => id)).toEqual(['first', 'custom-1']);
		expect(removePaletteColor({ colors: [initial.colors[0]!], defaultColorId: 'first' }, 'first'))
			.toEqual({ colors: [initial.colors[0]], defaultColorId: 'first' });
		const addedAgain = addPaletteColor(afterDefaultRemoval);
		expect(addedAgain.colors[addedAgain.colors.length - 1]?.id).toBe('custom-2');
		const nameCollision = addPaletteColor({
			colors: [{ id: 'existing', name: 'Custom color 1', hex: '#102030' }],
			defaultColorId: 'existing',
		});
		expect(nameCollision.colors[1]?.name).toBe('Custom color 1 (2)');
	});

	it('keeps default color first and validates only six-digit hex drafts', () => {
		expect(defaultFirstColors(initial)).toEqual([initial.colors[1], initial.colors[0]]);
		expect(isValidHexDraft('#12aBef')).toBe(true);
		expect(isValidHexDraft('#abc')).toBe(false);
		expect(isValidHexDraft('blue')).toBe(false);
		expect(formatRgbHex({ r: 1, g: 0.5, b: 0 })).toBe('#ff8000');
	});

	it('rejects case-insensitive duplicate names while allowing the current color name', () => {
		expect(getPaletteNameError(initial, 'first', 'SECOND')).toBe('A color with this name already exists.');
		expect(getPaletteNameError(initial, 'first', ' First ')).toBeNull();
		expect(getPaletteNameError(initial, 'first', '   ')).toBe('Enter a name.');
	});
});

describe('popup positioning', () => {
	it('clamps within the visual viewport including its offsets', () => {
		expect(clampPopupPosition(
			{ x: 390, y: 690 },
			{ width: 160, height: 100 },
			{ offsetLeft: 120, offsetTop: 300, width: 280, height: 200 },
		)).toEqual({ left: 236, top: 396 });
	});

	it('caps popup dimensions to the visual viewport before measuring', () => {
		expect(popupMaxSize({ width: 280, height: 200 })).toEqual({ width: 272, height: 192 });
	});

	it('shows existing candidate notes without losing text or empty-note behavior', () => {
		expect(candidateNotePreview('Idea: café\nCheck the next section.')).toBe('Idea: café\nCheck the next section.');
		expect(candidateNotePreview('  \n')).toBeNull();
	});

	it('distinguishes overlapping candidates in accessible labels', () => {
		const candidate = { quote: 'Same passage', pageIndex: 0 };
		expect(candidateAccessibleLabel(candidate, 0, 2)).toBe('highlight 1 of 2, page 1: “Same passage”');
		expect(candidateAccessibleLabel(candidate, 1, 2)).toBe('highlight 2 of 2, page 1: “Same passage”');
		expect(candidateAccessibleLabel({ quote: null, pageIndex: 0 }, 0, 1))
			.toBe('highlight 1 of 1, page 1: “no saved quote”');
	});
});

describe('palette editor persistence', () => {
	it('serializes concurrent saves and recovers after a failed save', async () => {
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
		const saved: PdfHighlighterSettings[] = [];
		const errors: unknown[] = [];
		let calls = 0;
		const host = {
			settings: initial,
			async saveSettings(settings: PdfHighlighterSettings) {
				saved.push({ ...settings, colors: settings.colors.map((color) => ({ ...color })) });
				calls++;
				if (calls === 1) {
					await firstGate;
					throw new Error('storage unavailable');
				}
			},
		};
		const session = new PaletteEditorSession(host, (error) => errors.push(error));
		const first = session.commitSettings((settings) => addPaletteColor(settings));
		const second = session.commitSettings((settings) => setPaletteDefault(settings, 'first'));
		await Promise.resolve();
		await Promise.resolve();
		expect(calls).toBe(1);
		releaseFirst();
		await expect(first).resolves.toBe(false);
		await expect(second).resolves.toBe(true);
		expect(calls).toBe(2);
		expect(saved[1]?.colors).toHaveLength(3);
		expect(host.settings.defaultColorId).toBe('first');
		expect(errors).toHaveLength(1);
	});

	it('keeps the normalized settings returned by persistence as the runtime state', async () => {
		const host = {
			settings: initial,
			async saveSettings(settings: PdfHighlighterSettings) {
				return normalizePdfHighlighterSettings({
					...settings,
					colors: settings.colors.map((color) => color.id === 'first' ? { ...color, name: 'First' } : color),
				});
			},
		};
		const session = new PaletteEditorSession(host, () => undefined);
		await expect(session.commitSettings((settings) => updatePaletteColor(settings, 'first', { name: ' First ' })))
			.resolves.toBe(true);
		expect(host.settings.colors[0]?.name).toBe('First');
	});

	it('does not clear a newer name draft when an earlier save finishes late', async () => {
		let releaseSave!: () => void;
		let startedSave!: () => void;
		const saveStarted = new Promise<void>((resolve) => { startedSave = resolve; });
		const gate = new Promise<void>((resolve) => { releaseSave = resolve; });
		const host = {
			settings: initial,
			async saveSettings(settings: PdfHighlighterSettings) {
				startedSave();
				await gate;
				return settings;
			},
		};
		const session = new PaletteEditorSession(host, () => undefined);
		session.updateNameDraft('first', 'Submitted name');
		const submitted = session.commitNameDraft('first', 'Submitted name');
		await saveStarted;
		session.updateNameDraft('first', 'Newer unsaved edit');
		releaseSave();
		await expect(submitted).resolves.toBe(true);
		expect(session.getNameDraft('first')).toBe('Newer unsaved edit');
	});

	it('does not clear a newer hex draft when an earlier save finishes late', async () => {
		let releaseSave!: () => void;
		let startedSave!: () => void;
		const saveStarted = new Promise<void>((resolve) => { startedSave = resolve; });
		const gate = new Promise<void>((resolve) => { releaseSave = resolve; });
		const host = {
			settings: initial,
			async saveSettings(settings: PdfHighlighterSettings) {
				startedSave();
				await gate;
				return settings;
			},
		};
		const session = new PaletteEditorSession(host, () => undefined);
		session.updateHexDraft('first', '#102030');
		const submitted = session.commitHexDraft('first', '#102030');
		await saveStarted;
		session.updateHexDraft('first', '#405060');
		releaseSave();
		await expect(submitted).resolves.toBe(true);
		expect(session.getHexDraft('first')).toBe('#405060');
	});

	it('keeps Add mounted during a name blur commit and persists both actions from one click', async () => {
		const saved: PdfHighlighterSettings[] = [];
		const host = {
			settings: initial,
			async saveSettings(settings: PdfHighlighterSettings) {
				const snapshot = { ...settings, colors: settings.colors.map((color) => ({ ...color })) };
				saved.push(snapshot);
				return snapshot;
			},
		};
		const document = new FakeDocument();
		const container = fakeContainer(document);
		const session = new PaletteEditorSession(host, () => undefined);
		session.mount(container);

		const nameInput = fakeControl(container, 'palette:name:first');
		const addButton = fakeControl(container, 'palette:add');
		nameInput.value = 'Edited first color';
		nameInput.dispatch('input');
		nameInput.dispatch('change'); // Browser fires this while the Add button is pressed.
		expect(addButton.isConnected).toBe(true);
		addButton.click();
		await waitForSavedCount(saved, 2);

		expect(saved).toHaveLength(2);
		expect(saved[1]?.colors).toHaveLength(3);
		expect(saved[1]?.colors[0]?.name).toBe('Edited first color');
	});

	it('restores focus after default and remove actions with fallbacks for replaced controls', async () => {
		const saved: PdfHighlighterSettings[] = [];
		const host = {
			settings: initial,
			async saveSettings(settings: PdfHighlighterSettings) {
				const snapshot = { ...settings, colors: settings.colors.map((color) => ({ ...color })) };
				saved.push(snapshot);
				return snapshot;
			},
		};
		const document = new FakeDocument();
		const container = fakeContainer(document);
		const session = new PaletteEditorSession(host, () => undefined);
		session.mount(container);

		fakeControl(container, 'palette:default:first').click();
		expect(document.activeElement?.getAttribute('data-palette-focus-key')).toBe('palette:name:first');
		await waitForSavedCount(saved, 1);

		fakeControl(container, 'palette:remove:first').click();
		expect(document.activeElement?.getAttribute('data-palette-focus-key')).toBe('palette:add');
		await waitForSavedCount(saved, 2);
		expect(saved[1]?.colors.map((color) => color.id)).toEqual(['second']);
	});
});
