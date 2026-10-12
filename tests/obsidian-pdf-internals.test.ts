import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { getAllPdfViews } from '../src/obsidian-pdf-internals';

function makeDeferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

vi.mock('obsidian', () => ({ FileView: class FileView {} }));

function makeViewer() {
	const file = { path: 'paper.pdf' };
	let savedBytes = new Uint8Array([1]);
	const documents = new Map<number, ReturnType<typeof makeDocument>>();
	function makeDocument(revision: number) {
		return { numPages: 1, getPage: vi.fn(async () => ({ rotate: 0, revision, render: vi.fn(() => ({ promise: Promise.resolve() })) })) };
	}
	const originalDocument = makeDocument(1);
	const originalTask = { promise: Promise.resolve(originalDocument), destroy: vi.fn(async () => {}) };
	const tasks: typeof originalTask[] = [];
	const library = {
		getDocument: vi.fn(({ data }: { data: Uint8Array }) => {
			const document = makeDocument(data[0]!);
			documents.set(data[0]!, document);
			const task = { promise: Promise.resolve(document), destroy: vi.fn(async () => {}) };
			tasks.push(task);
			return task;
		}),
	};
	const context = { save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), drawImage: vi.fn(), globalCompositeOperation: 'source-over' };
	const canvas = {
		width: 600, height: 800, parentNode: {}, getContext: () => context,
		ownerDocument: { createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }) },
	};
	const builder = {
		pdfPage: { rotate: 0 }, div: { remove: vi.fn() }, annotationLayer: {}, _cancelled: false,
		cancel: vi.fn(),
		render: vi.fn(async function (this: { div: { remove: ReturnType<typeof vi.fn> } | null }) {
			this.div = { remove: vi.fn() };
		}),
	};
	const page = { pdfPage: { rotate: 0 }, pdfPageRotate: 0, viewport: { width: 600, height: 800 }, structTreeLayer: null, annotationLayer: builder, canvas,
		_getRenderingContext: (canvasContext: unknown, transform: unknown) => ({ canvasContext, transform }),
		detailView: { update: vi.fn() } };
	// PDF.js 5.3.34 as shipped in Obsidian: a regular pdfDocument data property,
	// and a destructive setDocument() method. There is no _pdfDocument field.
	const pdfViewer = { pdfDocument: originalDocument, pagesCount: 1, currentPageNumber: 1, getPageView: () => page, setDocument: vi.fn(), forceRendering: vi.fn() };
	const application = { pdfViewer, pdfDocument: originalDocument, pdfLoadingTask: originalTask };
	const originalLoad = vi.fn(async () => {});
	const rawView = {
		file,
		containerEl: { ownerDocument: { defaultView: { pdfjsLib: library } } },
		onLoadFile: originalLoad,
		onClose: vi.fn(async () => {}),
		viewer: { child: { pdfViewer: application } },
	};
	const app = {
		workspace: { getLeavesOfType: () => [{ view: rawView }] },
		vault: { readBinary: vi.fn(async () => savedBytes.slice().buffer) },
	} as unknown as App;
	const view = getAllPdfViews(app)[0]!;
	return {
		view, rawView, file, app, originalLoad, originalTask, tasks, documents, pdfViewer, application, page, canvas, context,
		save: (bytes: Uint8Array) => { savedBytes = bytes; },
	};
}

afterEach(() => { vi.restoreAllMocks(); });

describe('Obsidian PDF in-place integration', () => {
	it('keeps the page and canvas across repeated saves using the shipped viewer shape', async () => {
		const f = makeViewer();
		for (const revision of [2, 3, 4]) {
			const bytes = new Uint8Array([revision]);
			const token = await f.view.prepareInPlacePdfWrite(bytes);
			expect(token).not.toBeNull();
			f.save(bytes);
			await f.rawView.onLoadFile(f.file);
			expect(await f.view.refreshAnnotationsInPlace(bytes, [0], token!)).toBe('refreshed');
			expect(f.pdfViewer.pdfDocument).toBe(f.documents.get(revision));
			expect(f.application.pdfDocument).toBe(f.documents.get(revision));
			expect(f.application.pdfLoadingTask).toBe(f.tasks.at(-1));
			expect(f.page.canvas).toBe(f.canvas);
		}
		expect(f.originalLoad).not.toHaveBeenCalled();
		expect(f.context.drawImage).toHaveBeenCalledTimes(3);
		expect(f.page.detailView.update).toHaveBeenCalledTimes(3);
		expect(f.pdfViewer.forceRendering).toHaveBeenCalledTimes(3);
		expect(f.pdfViewer.setDocument).not.toHaveBeenCalled();
		expect(f.originalTask.destroy).not.toHaveBeenCalled();
		expect(f.tasks[0]!.destroy).toHaveBeenCalledOnce();
		expect(f.tasks[1]!.destroy).toHaveBeenCalledOnce();
		expect(f.tasks[2]!.destroy).not.toHaveBeenCalled();
		await f.rawView.onClose();
		expect(f.originalTask.destroy).toHaveBeenCalledOnce();
		expect(f.tasks[2]!.destroy).toHaveBeenCalledOnce();
	});

	it('adopts the prepared preview document once and keeps it alive after preview cleanup', async () => {
		const f = makeViewer();
		const bytes = new Uint8Array([2]);
		const preview = f.view.previewPdfUpdate(bytes, [0]);
		const token = await f.view.prepareInPlacePdfWrite(bytes);
		f.save(bytes);
		expect(await f.view.refreshAnnotationsInPlace(bytes, [0], token!, preview)).toBe('refreshed');
		expect(f.tasks).toHaveLength(1);
		preview.dispose();
		await Promise.resolve();
		expect(f.tasks[0]!.destroy).not.toHaveBeenCalled();
		expect(f.context.drawImage).toHaveBeenCalledOnce();
		await f.rawView.onClose();
		expect(f.tasks[0]!.destroy).toHaveBeenCalledOnce();
	});
	it('does not adopt a preview for a different output byte object', async () => {
		const f = makeViewer();
		const bytes = new Uint8Array([2]);
		const preview = f.view.previewPdfUpdate(bytes.slice(), [0]);
		const token = await f.view.prepareInPlacePdfWrite(bytes);
		f.save(bytes);
		expect(await f.view.refreshAnnotationsInPlace(bytes, [0], token!, preview)).toBe('refreshed');
		expect(f.tasks).toHaveLength(2);
		preview.dispose();
		await Promise.resolve();
		expect(f.tasks[0]!.destroy).toHaveBeenCalledOnce();
		await f.rawView.onClose();
	});
	it('does not install an updated document if a reload replaces it during annotation refresh', async () => {
		const f = makeViewer();
		const render = makeDeferred<void>();
		f.page.annotationLayer!.render = vi.fn(() => render.promise);
		const bytes = new Uint8Array([2]);
		const token = await f.view.prepareInPlacePdfWrite(bytes);
		f.save(bytes);
		const refreshing = f.view.refreshAnnotationsInPlace(bytes, [0], token!);
		await vi.waitFor(() => expect(f.page.annotationLayer!.render).toHaveBeenCalledOnce());
		await f.rawView.onLoadFile({ path: 'another.pdf' } as typeof f.file);
		const replacementDocument = { numPages: 1, getPage: vi.fn() };
		f.pdfViewer.pdfDocument = replacementDocument;
		f.application.pdfDocument = replacementDocument;
		render.resolve();
		expect(await refreshing).toBe('superseded');
		expect(f.pdfViewer.pdfDocument).toBe(replacementDocument);
		expect(f.tasks[0]!.destroy).toHaveBeenCalledOnce();
	});
	it('keeps the guard active throughout a slow write and starts the event window afterward', async () => {
		const f = makeViewer();
		const now = vi.spyOn(Date, 'now').mockReturnValue(100);
		const bytes = new Uint8Array([2]);
		const token = await f.view.prepareInPlacePdfWrite(bytes);
		expect(token).not.toBeNull();
		now.mockReturnValue(5100);
		f.save(bytes);
		const pendingNotification = f.rawView.onLoadFile(f.file);
		now.mockReturnValue(5200);
		expect(await f.view.refreshAnnotationsInPlace(bytes, [0], token!)).toBe('refreshed');
		await pendingNotification;
		now.mockReturnValue(6100);
		await f.rawView.onLoadFile(f.file);
		expect(f.originalLoad).not.toHaveBeenCalled();
	});

	it('still reloads when the file bytes differ from the plugin-owned write', async () => {
		const f = makeViewer();
		expect(await f.view.prepareInPlacePdfWrite(new Uint8Array([2]))).not.toBeNull();
		f.save(new Uint8Array([9]));
		await f.rawView.onLoadFile(f.file);
		expect(f.originalLoad).toHaveBeenCalledOnce();
	});

	it.each(['navigation', 'reload', 'close', 'dispose'] as const)('abandons a delayed file read after %s', async (action) => {
		const f = makeViewer();
		await f.view.prepareInPlacePdfWrite(new Uint8Array([2]));
		const delayed = makeDeferred<ArrayBuffer>();
		vi.mocked(f.app.vault.readBinary).mockReturnValueOnce(delayed.promise);
		const pending = f.rawView.onLoadFile(f.file);
		if (action === 'navigation') {
			const other = { path: 'other.pdf' };
			await f.rawView.onLoadFile(other);
			f.rawView.file = other;
		} else if (action === 'reload') {
			f.save(new Uint8Array([9]));
			await f.rawView.onLoadFile(f.file);
		} else if (action === 'close') await f.rawView.onClose();
		else await f.view.disposeInPlaceUpdates();
		const loads = f.originalLoad.mock.calls.length;
		delayed.resolve(new Uint8Array([9]).buffer);
		await pending;
		expect(f.originalLoad).toHaveBeenCalledTimes(loads);
		if (action === 'navigation') expect(f.rawView.file.path).toBe('other.pdf');
	});

	it('abandons a delayed hash after navigation, even when its read already finished', async () => {
		const f = makeViewer();
		await f.view.prepareInPlacePdfWrite(new Uint8Array([2]));
		const delayed = makeDeferred<ArrayBuffer>();
		const digest = vi.spyOn(globalThis.crypto.subtle, 'digest').mockReturnValueOnce(delayed.promise);
		const pending = f.rawView.onLoadFile(f.file);
		await vi.waitFor(() => expect(digest).toHaveBeenCalledOnce());
		const other = { path: 'other.pdf' };
		await f.rawView.onLoadFile(other);
		f.rawView.file = other;
		delayed.resolve(new Uint8Array(32).buffer);
		await pending;
		expect(f.originalLoad).toHaveBeenCalledOnce();
	});

	it('does not reload a stale notification when its delayed read fails', async () => {
		const f = makeViewer();
		await f.view.prepareInPlacePdfWrite(new Uint8Array([2]));
		let reject!: (error: Error) => void;
		vi.mocked(f.app.vault.readBinary).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
		const pending = f.rawView.onLoadFile(f.file);
		await f.rawView.onClose();
		reject(new Error('read failed after close'));
		await pending;
		expect(f.originalLoad).not.toHaveBeenCalled();
	});

	it('rejects a pdfDocument setter instead of accidentally resetting every page', async () => {
		const f = makeViewer();
		const set = vi.fn();
		Object.defineProperty(f.pdfViewer, 'pdfDocument', { get: () => f.application.pdfDocument, set });
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(await f.view.prepareInPlacePdfWrite(new Uint8Array([2]))).toBeNull();
		expect(set).not.toHaveBeenCalled();
	});
});
