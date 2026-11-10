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

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it.each([false, true])('outlines exact annotation fragments and cleans up, clipped multi-line: %s', (multiLine) => {
	const f = makeViewer(); const classes = new Set<string>();
	const frames: { remove: ReturnType<typeof vi.fn>; setCssStyles: ReturnType<typeof vi.fn> }[] = [];
	const bounds = [{ x: '0', y: '0', width: '0.8', height: '0.2' }, { x: '0', y: '0.3', width: '0.4', height: '0.2' }];
	const element = {
		classList: { add: (value: string) => classes.add(value), remove: (value: string) => classes.delete(value) },
		querySelectorAll: () => multiLine ? bounds.map(bound => ({ getAttribute: (name: keyof typeof bound) => bound[name] })) : [],
		createDiv: () => { const frame = { remove: vi.fn(), setAttribute: vi.fn(), setCssStyles: vi.fn() }; frames.push(frame); return frame; },
	};
	const query = vi.fn(() => [element]);
	Object.assign(f.page, { div: { querySelectorAll: query } });
	const listeners = new Map<string, (event: { pageNumber: number }) => void>();
	Object.assign(f.application, { eventBus: {
		_on: (name: string, fn: (event: { pageNumber: number }) => void) => listeners.set(name, fn),
		_off: (name: string) => listeners.delete(name),
	} });
	const clear = f.view.markSelectedAnnotation!({ pageIndex: 0, objectNumber: 12, generationNumber: 2, sourceFingerprint: 'source' });
	expect(query).toHaveBeenCalledExactlyOnceWith('.highlightAnnotation[data-annotation-id="12R2"]');
	expect(classes.has('study-pdf-selected-annotation')).toBe(true);
	expect(frames).toHaveLength(multiLine ? 2 : 1);
	if (multiLine) expect(frames[1]!.setCssStyles).toHaveBeenCalledWith({ left: '0%', top: '30%', width: '40%', height: '20%' });
	listeners.get('annotationlayerrendered')!({ pageNumber: 2 }); expect(query).toHaveBeenCalledOnce();
	listeners.get('annotationlayerrendered')!({ pageNumber: 1 }); expect(query).toHaveBeenCalledTimes(2);
	clear(); expect(classes.size).toBe(0); expect(listeners.size).toBe(0);
	for (const frame of frames) expect(frame.remove).toHaveBeenCalledOnce();
});

it('defers selected-outline rebuilds during scale bursts and ignores disposed callbacks', () => {
 vi.useFakeTimers(); const f = makeViewer(); const createDiv = vi.fn(() => ({ remove: vi.fn(), setAttribute: vi.fn(), setCssStyles: vi.fn() }));
 const element = { classList: { add() {}, remove() {} }, querySelectorAll: () => [], createDiv };
 const query = vi.fn(() => [element]); Object.assign(f.page, { div: { querySelectorAll: query } });
 const listeners = new Map<string, (event?: { pageNumber: number }) => void>();
 Object.assign(f.application, { eventBus: { _on: (name: string, fn: (event?: { pageNumber: number }) => void) => listeners.set(name, fn), _off: (name: string) => listeners.delete(name) } });
 const clear = f.view.markSelectedAnnotation!({ pageIndex: 0, objectNumber: 12, generationNumber: 0, sourceFingerprint: 'source' });
 const rendered = listeners.get('annotationlayerrendered')!; const scale = listeners.get('scalechanging')!;
 scale(); rendered({ pageNumber: 1 }); vi.advanceTimersByTime(100); scale(); rendered({ pageNumber: 1 });
 expect(createDiv).toHaveBeenCalledOnce(); vi.advanceTimersByTime(150); expect(createDiv).toHaveBeenCalledTimes(2);
 scale(); rendered({ pageNumber: 1 }); clear(); vi.runAllTimers(); rendered({ pageNumber: 1 }); scale();
 expect(createDiv).toHaveBeenCalledTimes(2); expect(listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
});

it('follows native page navigation across file changes in one pane and unregisters exact callbacks', () => {
	const f = makeViewer();
	const listeners = new Map<string, () => void>();
	Object.assign(f.application, { eventBus: {
		_on: (name: string, fn: () => void) => listeners.set(name, fn),
		_off: (name: string, fn: () => void) => { if (listeners.get(name) === fn) listeners.delete(name); },
	} });
	const changed = vi.fn();
	const stop = f.view.watchPagePosition!(changed);
	listeners.get('pagechanging')!(); expect(changed).toHaveBeenCalledOnce();
	f.rawView.file = { path: 'another.pdf' };
	listeners.get('pagechanging')!(); expect(changed).toHaveBeenCalledTimes(2);
	stop(); expect(listeners.size).toBe(0);
});

it('ignores page callbacks from a replaced native event bus', () => {
	const f = makeViewer(); let onChange!: () => void;
	Object.assign(f.application, { eventBus: { _on: (_name: string, fn: () => void) => { onChange = fn; }, _off() {} } });
	const changed = vi.fn(); const stop = f.view.watchPagePosition!(changed);
	Object.assign(f.application, { eventBus: { _on() {}, _off() {} } });
	onChange(); expect(changed).not.toHaveBeenCalled(); stop();
});

it('retires an old temporary worker after its last layer disappears without another annotation save', async () => {
	const f = makeViewer();
	const listeners = new Map<string, () => void>();
	Object.assign(f.application, { eventBus: {
		_on: (name: string, fn: () => void) => listeners.set(name, fn),
		_off: (name: string) => listeners.delete(name),
	} });
	const save = async (revision: number) => {
		const bytes = new Uint8Array([revision]);
		const token = await f.view.prepareInPlacePdfWrite(bytes);
		f.save(bytes);
		expect(await f.view.refreshAnnotationsInPlace(bytes, [0], token!)).toBe('refreshed');
	};
	await save(2);
	const retainedLayer = { pdfPage: f.page.pdfPage as typeof f.page.pdfPage | null };
	Object.assign(f.page, { textLayer: retainedLayer });
	await save(3);
	expect(f.tasks[0]!.destroy).not.toHaveBeenCalled();
	listeners.get('pagerendered')!();
	await new Promise((resolve) => setTimeout(resolve, 5));
	expect(f.tasks[0]!.destroy).not.toHaveBeenCalled();
	retainedLayer.pdfPage = null;
	listeners.get('textlayerrendered')!();
	await vi.waitFor(() => expect(f.tasks[0]!.destroy).toHaveBeenCalledOnce());
	expect(f.tasks[1]!.destroy).not.toHaveBeenCalled();
	expect(f.originalTask.destroy).not.toHaveBeenCalled();
	await f.rawView.onClose();
	expect(listeners.size).toBe(0);
});

it.each([
	['pdfThumbnailViewer', 'pdfDocument', 'thumbnailrendered'],
	['pdfLinkService', 'pdfDocument', 'pagerendered'],
	['findController', '_pdfDocument', 'textlayerrendered'],
	['printService', 'pdfDocument', 'afterprint'],
])('keeps an obsolete document while native %s still owns it', async (ownerName, documentKey, event) => {
	const f = makeViewer();
	const listeners = new Map<string, () => void>();
	const owner: Record<string, unknown> = { getThumbnail: () => undefined, [documentKey!]: f.pdfViewer.pdfDocument };
	Object.assign(f.application, { [ownerName!]: owner, eventBus: {
		_on: (name: string, fn: () => void) => listeners.set(name, fn),
		_off: (name: string) => listeners.delete(name),
	} });
	for (const revision of [2, 3]) {
		const bytes = new Uint8Array([revision]);
		const token = await f.view.prepareInPlacePdfWrite(bytes);
		f.save(bytes);
		expect(await f.view.refreshAnnotationsInPlace(bytes, [0], token!)).toBe('refreshed');
		if (revision === 2) owner[documentKey!] = f.documents.get(2);
	}
	expect(f.tasks[0]!.destroy).not.toHaveBeenCalled();
	owner[documentKey!] = null;
	listeners.get(event!)!();
	await vi.waitFor(() => expect(f.tasks[0]!.destroy).toHaveBeenCalledOnce());
	await f.rawView.onClose();
});

function makeNoteWatcherFixture() {
	const fixture = makeViewer();
	const listeners = new Map<string, (event: { source: { id: number } }) => void>();
	const bus = {
		_on: vi.fn((name: string, callback: (event: { source: { id: number } }) => void) => listeners.set(name, callback)),
		_off: vi.fn((name: string) => listeners.delete(name)),
	};
	const layer = { remove: vi.fn(), closest: () => ({ dataset: { pageNumber: '1' } }) };
	const getAnnotation = vi.fn((id: string) => ({ data: { subtype: 'Highlight', contentsObj: { str: `Note ${id}` } } }));
	Object.assign(fixture.page.annotationLayer!, { div: layer, annotationLayer: { getAnnotation } });
	Object.assign(fixture.application, { eventBus: bus });
	const querySelectorAll = vi.fn(() => [layer]);
	Object.assign(fixture.rawView.containerEl, { querySelectorAll, contains: (node: unknown) => node === fixture.page.annotationLayer?.div });
	return { ...fixture, bus, listeners, layer, querySelectorAll, getAnnotation };
}

describe('rendered note layer watchers', () => {
 it('coalesces native scale bursts using current layers but keeps explicit refresh immediate', () => {
  vi.useFakeTimers(); const f = makeNoteWatcherFixture(); const publish = vi.fn(); const watcher = f.view.watchNoteLayers!(publish);
  f.listeners.get('scalechanging')!({ source: { id: 1 } });
  f.listeners.get('annotationlayerrendered')!({ source: { id: 1 } });
  vi.advanceTimersByTime(100); f.listeners.get('scalechanging')!({ source: { id: 1 } });
  f.listeners.get('annotationlayerrendered')!({ source: { id: 1 } });
  expect(publish).toHaveBeenCalledOnce();
  watcher.refresh([0]); expect(publish).toHaveBeenCalledTimes(2);
  f.listeners.get('annotationlayerrendered')!({ source: { id: 1 } });
  Object.assign(f.page.viewport, { width: 1200 });
  const replacementLayer = { remove: vi.fn() }; Object.assign(f.page.annotationLayer!, { div: replacementLayer });
  vi.advanceTimersByTime(149); expect(publish).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(1); expect(publish).toHaveBeenCalledTimes(3); expect(publish.mock.lastCall![0].viewportWidth).toBe(1200); expect(publish.mock.lastCall![0].layer).toBe(replacementLayer);
  watcher.dispose(); expect(vi.getTimerCount()).toBe(0);
 });
 it('publishes each pending page once after scaling and removes explicitly refreshed pages from the queue', () => {
  vi.useFakeTimers(); const f = makeNoteWatcherFixture(); const publish = vi.fn(); const watcher = f.view.watchNoteLayers!(publish);
  f.listeners.get('scalechanging')!({ source: { id: 1 } });
  for (const id of [1, 2, 1, 2]) f.listeners.get('annotationlayerrendered')!({ source: { id } });
  watcher.refresh([0]); expect(publish).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(150); expect(publish).toHaveBeenCalledTimes(3); expect(publish.mock.lastCall![0].pageIndex).toBe(1);
  watcher.dispose();
 });
 it.each(['dispose', 'file', 'bus', 'viewer'])('ignores deferred scale callbacks after %s changes', (reason) => {
  vi.useFakeTimers(); const f = makeNoteWatcherFixture(); const publish = vi.fn(); const watcher = f.view.watchNoteLayers!(publish);
  const scale = f.listeners.get('scalechanging')!; const rendered = f.listeners.get('annotationlayerrendered')!;
  scale({ source: { id: 1 } }); rendered({ source: { id: 1 } });
  if (reason === 'dispose') watcher.dispose();
  if (reason === 'file') f.rawView.file = { path: 'other.pdf' };
  if (reason === 'bus') Object.assign(f.application, { eventBus: {} });
  if (reason === 'viewer') Object.assign(f.application, { pdfViewer: {} });
  vi.runAllTimers(); scale({ source: { id: 1 } }); rendered({ source: { id: 1 } });
  expect(publish).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0); watcher.dispose();
 });

	it.each([0, 90, 180, 270])('reports native layer dimensions correctly at %i degrees', (rotation) => {
		const f = makeNoteWatcherFixture(); const quarter = rotation % 180 === 90;
		Object.assign(f.page.viewport, { width: quarter ? 800 : 600, height: quarter ? 600 : 800, rotation });
		const publish = vi.fn(); const watcher = f.view.watchNoteLayers!(publish);
		expect(publish.mock.calls[0]![0].viewportWidth).toBe(600);
		expect(publish.mock.calls[0]![0].viewportHeight).toBe(800); watcher.dispose();
	});
	it('uses already-rendered data with no file reads, worker scans, or page loading', () => {
		const fixture = makeNoteWatcherFixture();
		const publish = vi.fn();
		const watcher = fixture.view.watchNoteLayers!(publish);
		expect(publish).toHaveBeenCalledOnce();
		expect(publish.mock.calls[0]![0].readAnnotation('12R').contentsObj.str).toBe('Note 12R');
		watcher.refresh([0]);
		fixture.listeners.get('annotationlayerrendered')!({ source: { id: 1 } });
		expect(publish).toHaveBeenCalledTimes(3);
		expect(fixture.querySelectorAll).toHaveBeenCalledOnce();
		expect(fixture.app.vault.readBinary).not.toHaveBeenCalled();
		expect(fixture.originalTask.destroy).not.toHaveBeenCalled();
		expect(fixture.tasks).toHaveLength(0);
		watcher.dispose();
		expect(fixture.bus._off).toHaveBeenCalledTimes(2);
		watcher.refresh([0]);
		expect(publish).toHaveBeenCalledTimes(3);
	});

	it('invalidates old layer data and follows only explicit refreshed pages', () => {
		const fixture = makeNoteWatcherFixture();
		const publish = vi.fn();
		const watcher = fixture.view.watchNoteLayers!(publish);
		const oldRead = publish.mock.calls[0]![0].readAnnotation;
		const replacementLookup = vi.fn(() => ({ data: { subtype: 'Highlight', contentsObj: { str: 'New note' } } }));
		Object.assign(fixture.page.annotationLayer!, { annotationLayer: { getAnnotation: replacementLookup } });
		expect(oldRead('12R')).toBeNull();
		watcher.refresh([0]);
		expect(publish.mock.calls[1]![0].readAnnotation('12R').contentsObj.str).toBe('New note');
		expect(fixture.querySelectorAll).toHaveBeenCalledOnce();
		watcher.dispose();
	});

	it('rejects a replaced event bus or reused PDF pane and unregisters cleanly', () => {
		const fixture = makeNoteWatcherFixture();
		const publish = vi.fn();
		const watcher = fixture.view.watchNoteLayers!(publish);
		expect(watcher.isCurrent()).toBe(true);
		Object.assign(fixture.application, { eventBus: { _on: vi.fn(), _off: vi.fn() } });
		expect(watcher.isCurrent()).toBe(false);
		watcher.refresh([0]);
		fixture.listeners.get('annotationlayerrendered')!({ source: { id: 1 } });
		expect(publish).toHaveBeenCalledOnce();
		watcher.dispose();
		expect(fixture.bus._off).toHaveBeenCalledTimes(2);
	});

	it('does not accept an unready or unsupported native event bus', () => {
		const fixture = makeNoteWatcherFixture();
		Object.assign(fixture.application, { eventBus: null });
		const publish = vi.fn();
		const watcher = fixture.view.watchNoteLayers!(publish);
		expect(watcher.isCurrent()).toBe(false);
		expect(publish).not.toHaveBeenCalled();
		watcher.dispose();
	});
});

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
