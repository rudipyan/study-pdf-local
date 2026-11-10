import { describe, expect, it, vi } from 'vitest';

const internals = vi.hoisted(() => ({ views: [] as any[] }));

vi.mock('obsidian', () => {
	class Base {}
	return {
		Plugin: Base, Component: Base, Modal: Base, FileView: Base, PluginSettingTab: Base, Setting: Base,
		Scope: Base, TFile: Base, Notice: vi.fn(), Platform: {}, setIcon: vi.fn(), setTooltip: vi.fn(),
	};
});
vi.mock('../src/obsidian-pdf-internals', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/obsidian-pdf-internals')>();
	return { ...actual, getAllPdfViews: () => internals.views };
});

import StudyPdf from '../src/main';

function setup(duringPrepare?: () => void) {
	const plugin = new StudyPdf() as any;
	const file = { path: 'article.pdf', stat: { mtime: 1, size: 1 } };
	const token = { fingerprint: 'prepared', generation: 1, writeId: 1 };
	let stored = new Uint8Array([1]);
	const preview = { dispose: vi.fn() };
	const view = {
		file,
		containerEl: {} as HTMLElement,
		previewPdfUpdate: vi.fn(() => preview),
		prepareInPlacePdfWrite: vi.fn(async () => { duringPrepare?.(); return token; }),
		cancelInPlacePdfWrite: vi.fn(),
		refreshAnnotationsInPlace: vi.fn(async () => 'refreshed'),
	};
	const modifyBinary = vi.fn(async (_file: typeof file, bytes: ArrayBuffer) => { stored = new Uint8Array(bytes); });
	const readBinary = vi.fn(async () => stored.slice().buffer);
	plugin.app = {
		vault: {
			readBinary,
			modifyBinary,
			getAbstractFileByPath: () => file,
		},
	};
	plugin.assertCapturedPdfCurrent = vi.fn();
	plugin.isCapturedPdfFileCurrent = vi.fn(() => true);
	plugin.isCapturedPdfCurrent = vi.fn(() => true);
	plugin.refreshAnnotationToolbars = vi.fn();
	plugin.invalidateHighlightIndex = vi.fn();
	plugin.pdfRevisionKey = vi.fn(() => 'article.pdf:1:1');
	internals.views = [view];
	return {
		plugin,
		file,
		view,
		token,
		preview,
		readBinary,
		modifyBinary,
		stored: () => stored,
		externalWrite: (bytes: number[]) => { stored = new Uint8Array(bytes); },
		capture: { file, path: file.path, pdfView: view },
	};
}

describe('PDF mutation final byte check', () => {
	it('rejects an edit made while in-place preparation is pending and disposes the prepared token', async () => {
		const f = setup();
		f.view.prepareInPlacePdfWrite.mockImplementation(async () => {
			f.externalWrite([9]);
			return f.token;
		});

		await expect(f.plugin.mutateCapturedPdf(f.capture, [0], async () => ({ bytes: new Uint8Array([2]), value: 1 })))
			.rejects.toThrow(/PDF changed since this operation began/);

		expect(f.readBinary).toHaveBeenCalledTimes(3);
		expect(f.stored()).toEqual(new Uint8Array([9]));
		expect(f.modifyBinary).not.toHaveBeenCalled();
		expect(f.view.cancelInPlacePdfWrite).toHaveBeenCalledExactlyOnceWith(f.token);
		expect(f.preview.dispose).toHaveBeenCalledOnce();
		expect(f.plugin.refreshAnnotationToolbars).toHaveBeenCalledOnce();
	});

	it('writes the prepared output when the source bytes remain current', async () => {
		const f = setup();

		await expect(f.plugin.mutateCapturedPdf(f.capture, [0], async () => ({ bytes: new Uint8Array([2]), value: 1 })))
			.resolves.toMatchObject({ changed: true, value: 1 });

		expect(f.readBinary).toHaveBeenCalledTimes(3);
		expect(f.stored()).toEqual(new Uint8Array([2]));
		expect(f.modifyBinary).toHaveBeenCalledOnce();
		expect(f.view.prepareInPlacePdfWrite).toHaveBeenCalledOnce();
		expect(f.view.refreshAnnotationsInPlace).toHaveBeenCalledOnce();
		expect(f.view.cancelInPlacePdfWrite).not.toHaveBeenCalled();
		expect(f.preview.dispose).toHaveBeenCalledOnce();
	});

	it('does not prepare or write when the transform produces unchanged bytes', async () => {
		const f = setup();

		await expect(f.plugin.mutateCapturedPdf(f.capture, [0], async (bytes: Uint8Array) => ({ bytes, value: 0 })))
			.resolves.toMatchObject({ changed: false, value: 0 });

		expect(f.readBinary).toHaveBeenCalledOnce();
		expect(f.view.prepareInPlacePdfWrite).not.toHaveBeenCalled();
		expect(f.modifyBinary).not.toHaveBeenCalled();
	});
});
