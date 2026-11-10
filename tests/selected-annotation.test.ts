import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('obsidian', () => {
	class Base {}
	return { Plugin: Base, Modal: Base, FileView: Base, PluginSettingTab: Base, Setting: Base,
		Component: Base, Scope: Base, TFile: Base, Notice: vi.fn(), Platform: {}, setIcon: vi.fn(), setTooltip: vi.fn() };
});
vi.mock('../src/ui/color-palette-modal', () => ({ showColorPaletteModal: vi.fn() }));
vi.mock('../src/pdf-region-copy', () => ({ copyPdfRegionImage: vi.fn(async () => {}) }));
import StudyPdf from '../src/main';
import { showColorPaletteModal } from '../src/ui/color-palette-modal';
import { copyPdfRegionImage } from '../src/pdf-region-copy';
import type { CandidateChoice, CandidateChoiceActions } from '../src/ui/color-palette-modal';

type Harness = {
	settings: { colors: []; defaultColorId: string };
	activePopup: unknown;
	selectedAnnotation: unknown;
	menuGeneration: number;
	isUnloading: boolean;
	isCapturedPdfCurrent: ReturnType<typeof vi.fn>;
	getFocusedPdfViewForKeyEvent: ReturnType<typeof vi.fn>;
	performRemoveTarget: ReturnType<typeof vi.fn>;
	showCandidateChooser(...args: unknown[]): void;
	handlePdfKeyboardShortcut(document: Document, event: KeyboardEvent): void;
	hideActiveMenu(): void;
};
beforeEach(() => vi.clearAllMocks());
function fixture() {
	const writeText = vi.fn(async () => {});
	let textSelection = '';
	const doc = { activeElement: null as unknown, querySelector: vi.fn(() => null as unknown),
		defaultView: { navigator: { clipboard: { writeText } }, getSelection: () => ({ isCollapsed: !textSelection, toString: () => textSelection }) },
	} as unknown as Document;
	const file = { path: 'article.pdf' };
	const clearOutline = vi.fn();
	const getTextContent = vi.fn(async () => ({
		items: [{ str: 'Before highlighted words after', transform: [1, 0, 0, 1, 0, 12], width: 300 }],
	}));
	const pdf = { getPage: vi.fn(async () => ({ getTextContent })) };
	const view = { file, containerEl: { ownerDocument: doc }, markSelectedAnnotation: vi.fn(() => clearOutline), getPdfJsDocument: () => pdf };
	const popup = { el: { isConnected: true, ownerDocument: doc } as HTMLElement, hide: vi.fn(), reposition: vi.fn() };
	let actions!: CandidateChoiceActions;
	vi.mocked(showColorPaletteModal).mockImplementation((_doc, _position, _candidates, _colors, _default, value) => { actions = value; return popup; });
	const plugin = Object.create(StudyPdf.prototype) as Harness;
	Object.assign(plugin, { settings: { colors: [], defaultColorId: '' }, menuGeneration: 0, isUnloading: false,
		isCapturedPdfCurrent: vi.fn(() => true), getFocusedPdfViewForKeyEvent: vi.fn(() => view), performRemoveTarget: vi.fn(),
	});
	const capture = { pdfView: view, file, path: file.path };
	const candidate: CandidateChoice = { pageIndex: 0, target: { pageIndex: 0, objectNumber: 12, generationNumber: 0, sourceFingerprint: 'source' },
		quote: 'The exact annotated quotation', note: null, currentColor: null, unsupportedReason: null };
	const select = (candidates = [candidate]) => plugin.showCandidateChooser(doc, { x: 1, y: 2 }, candidates, capture);
	const key = (overrides: Partial<KeyboardEvent> = {}) => {
		const event = { key: 'c', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false,
			defaultPrevented: false, isComposing: false, keyCode: 67, composedPath: () => [],
			preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...overrides } as unknown as KeyboardEvent;
		plugin.handlePdfKeyboardShortcut(doc, event); return event;
	};
	return { plugin, doc, view, popup, candidate, select, key, writeText, clearOutline, pdf, getTextContent,
		actions: () => actions, textSelection: (text: string) => { textSelection = text; } };
}

describe('selected annotation keyboard copy', () => {
	it('copies a selected quotation without closing the chooser or clearing its faint outline', async () => {
		const f = fixture(); f.select(); const event = f.key(); await Promise.resolve();
		expect(f.writeText).toHaveBeenCalledExactlyOnceWith(f.candidate.quote);
		expect(event.preventDefault).toHaveBeenCalledOnce(); expect(f.popup.hide).not.toHaveBeenCalled();
		expect(f.clearOutline).not.toHaveBeenCalled();
		f.actions().onDismiss!(); expect(f.clearOutline).toHaveBeenCalledOnce();
	});
	it('copies the selected area using the existing image path', () => {
		const f = fixture(); const box = { left: 1, bottom: 2, right: 3, top: 4 };
		f.select([{ ...f.candidate, regionBox: box, quote: null }]); f.key();
		expect(copyPdfRegionImage).toHaveBeenCalledWith(f.view, 0, box, expect.any(Function));
		expect(f.writeText).not.toHaveBeenCalled();
	});
	it.each(['shortcut', 'button'])('recovers an imported highlight from its page when copied by %s', async (action) => {
		const f = fixture();
		const imported = { ...f.candidate, pageIndex: 2, quote: null, quoteRects: [{ left: 70, right: 235, bottom: 10, top: 20 }] };
		f.select([imported]);
		expect(f.pdf.getPage).not.toHaveBeenCalled();
		if (action === 'shortcut') expect(f.key().preventDefault).toHaveBeenCalledOnce();
		else f.actions().onCopy(imported);
		await vi.waitFor(() => expect(f.writeText).toHaveBeenCalledExactlyOnceWith('highlighted words'));
		expect(f.pdf.getPage).toHaveBeenCalledExactlyOnceWith(3);
		if (action === 'shortcut') expect(f.popup.hide).not.toHaveBeenCalled();
		else expect(f.popup.hide).toHaveBeenCalledOnce();
	});
	it('does not copy recovered text after the PDF changes', async () => {
		const f = fixture();
		const imported = { ...f.candidate, quote: null, quoteRects: [{ left: 70, right: 235, bottom: 10, top: 20 }] };
		f.select([imported]);
		f.key();
		f.plugin.isCapturedPdfCurrent.mockReturnValue(false);
		await vi.waitFor(() => expect(f.getTextContent).toHaveBeenCalledOnce());
		expect(f.writeText).not.toHaveBeenCalled();
	});
	it('starts a clipboard write before the asynchronous page text is ready', async () => {
		const f = fixture();
		const write = vi.fn(async ([item]: { data: Record<string, Promise<Blob>> }[]) => {
			const blob = await item!.data['text/plain'];
			expect(await blob?.text()).toBe('highlighted words');
		});
		const win = f.doc.defaultView!;
		Object.assign(win, { ClipboardItem: class { constructor(readonly data: Record<string, Promise<Blob>>) {} } });
		Object.assign(win.navigator.clipboard, { write });
		const imported = { ...f.candidate, quote: null, quoteRects: [{ left: 70, right: 235, bottom: 10, top: 20 }] };
		f.select([imported]);
		f.actions().onCopy(imported);
		expect(write).toHaveBeenCalledOnce();
		expect(f.getTextContent).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(f.popup.hide).toHaveBeenCalledOnce());
		expect(f.writeText).not.toHaveBeenCalled();
	});
	it('lets actual text selection and editable notes use normal copy', () => {
		const f = fixture(); f.select(); f.textSelection('A manually selected fragment');
		expect(f.key().preventDefault).not.toHaveBeenCalled();
		f.textSelection(''); Object.assign(f.doc, { activeElement: { closest: () => ({}) } });
		expect(f.key().preventDefault).not.toHaveBeenCalled(); expect(f.writeText).not.toHaveBeenCalled();
	});
	it.each([{ repeat: true }, { isComposing: true }, { shiftKey: true }, { altKey: true }, { ctrlKey: true }, { defaultPrevented: true }])(
		'ignores modified, consumed or composing shortcuts: %o', (override) => {
			const f = fixture(); f.select(); expect(f.key(override).preventDefault).not.toHaveBeenCalled(); expect(f.writeText).not.toHaveBeenCalled();
		},
	);
	it('never copies an ambiguous, stale, modal or empty quotation', () => {
		const f = fixture(); f.select([f.candidate, f.candidate]); f.key();
		expect(f.view.markSelectedAnnotation).not.toHaveBeenCalled();
		f.select(); f.plugin.isCapturedPdfCurrent.mockReturnValue(false); f.key();
		f.plugin.isCapturedPdfCurrent.mockReturnValue(true); vi.mocked(f.doc.querySelector).mockReturnValue({} as Element); f.key();
		vi.mocked(f.doc.querySelector).mockReturnValue(null); f.select([{ ...f.candidate, quote: null }]); f.key();
		expect(f.writeText).not.toHaveBeenCalled();
	});
	it('clears the visual selection on dismissal and keeps Backspace removal working', () => {
		const f = fixture(); f.select(); f.key({ key: 'Backspace', metaKey: false });
		expect(f.clearOutline).toHaveBeenCalledOnce(); expect(f.plugin.performRemoveTarget).toHaveBeenCalledOnce();
	});
});
