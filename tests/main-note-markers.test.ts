import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => {
	class Base {}
	return { Plugin: Base, Modal: Base, FileView: Base, PluginSettingTab: Base, Setting: Base,
		Component: Base, Scope: Base, TFile: Base, Notice: vi.fn(), Platform: {}, setIcon: vi.fn(), setTooltip: vi.fn() };
});
vi.mock('../src/ui/icon-popup', () => ({ showNoteEditorPopup: vi.fn() }));

import StudyPdf from '../src/main';
import { showNoteEditorPopup } from '../src/ui/icon-popup';

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal('window', { clearTimeout: vi.fn() });
	vi.mocked(showNoteEditorPopup).mockImplementation(() => ({ el: {} as HTMLElement, hide: vi.fn(), reposition: vi.fn() }));
});
afterEach(() => vi.unstubAllGlobals());

function setup() {
	const plugin = new StudyPdf() as any;
	plugin.app = {};
	const view = { file: { path: 'article.pdf' }, containerEl: { ownerDocument: {} } };
	plugin.isCapturedPdfCurrent = vi.fn(() => true);
	const target = (objectNumber: number) => ({ pageIndex: 0, objectNumber, generationNumber: 0, sourceFingerprint: 'verified-source' });
	plugin.getHighlightIndexForCapture = vi.fn(async () => new Map([[0, [
		{ note: 'First note', target: target(12) },
		{ note: 'Second note', target: target(15) },
	]]]));
	plugin.performSetNoteForTarget = vi.fn(async () => true);
	return { plugin, view };
}

describe('direct note marker actions', () => {
	it('opens and saves the exact annotation ID, without point-based lookup', async () => {
		const { plugin, view } = setup();
		await plugin.openNoteMarker(view, 0, '15R', { x: 100, y: 200 });
		const options = vi.mocked(showNoteEditorPopup).mock.calls[0]![3];
		expect(options.initial).toBe('Second note');
		await options.onSave('Changed second note');
		expect(plugin.performSetNoteForTarget.mock.calls[0]![1].objectNumber).toBe(15);
		expect(plugin.performSetNoteForTarget.mock.calls[0]![2]).toBe('Changed second note');
	});

	it('rejects ambiguous IDs, unsupported IDs, and a view that changed files', async () => {
		const { plugin, view } = setup();
		await plugin.openNoteMarker(view, 0, 'synthetic-id', { x: 0, y: 0 });
		expect(plugin.getHighlightIndexForCapture).not.toHaveBeenCalled();
		plugin.getHighlightIndexForCapture.mockResolvedValue(new Map([[0, [
			{ target: { objectNumber: 12, generationNumber: 0 } }, { target: { objectNumber: 12, generationNumber: 0 } },
		]]]));
		await plugin.openNoteMarker(view, 0, '12R', { x: 0, y: 0 });
		expect(showNoteEditorPopup).not.toHaveBeenCalled();
		plugin.isCapturedPdfCurrent.mockReturnValue(false);
		await plugin.openNoteMarker(view, 0, '15R', { x: 0, y: 0 });
		expect(showNoteEditorPopup).not.toHaveBeenCalled();
	});

	it('does not close a newer popup when an older save finishes', async () => {
		const { plugin, view } = setup();
		await plugin.openNoteMarker(view, 0, '12R', { x: 0, y: 0 });
		const options = vi.mocked(showNoteEditorPopup).mock.calls[0]![3];
		const newer = { hide: vi.fn() };
		plugin.activePopup = newer;
		options.onSaved?.();
		expect(plugin.activePopup).toBe(newer);
		expect(newer.hide).not.toHaveBeenCalled();
	});
});
