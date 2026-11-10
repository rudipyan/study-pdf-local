import { describe, expect, it, vi } from 'vitest';
import { startPdfUpdatePreview } from '../src/pdf-update-preview';
import type { PdfPageViewLike } from '../src/pdf-in-place';

function fixture() {
	let finish!: () => void;
	let started!: () => void;
	const didStart = new Promise<void>((resolve) => { started = resolve; });
	const render = { promise: new Promise<void>((resolve) => { finish = resolve; }), cancel: vi.fn() };
	const page = { rotate: 0, render: vi.fn(() => { started(); return render; }) };
	const overlay = {
		width: 600, height: 800, style: {}, classList: { add: vi.fn() }, setAttribute: vi.fn(),
		getContext: () => ({}), remove: vi.fn(),
	};
	const parent = { append: vi.fn() };
	const canvas = { width: 600, height: 800, parentElement: parent, isConnected: true, cloneNode: () => overlay };
	const sharedMap = new Map();
	const view = {
		canvas, viewport: { width: 600, height: 800 },
		_getRenderingContext: () => ({ annotationCanvasMap: sharedMap }),
	} as unknown as PdfPageViewLike;
	const task = { promise: Promise.resolve({ numPages: 1, getPage: async () => page }), destroy: vi.fn(async () => {}) };
	let ready!: () => void;
	const didShow = new Promise<void>((resolve) => { ready = resolve; });
	const onReady = vi.fn(ready);
	return { view, task, canvas, overlay, parent, render, page, sharedMap, finish: () => finish(), didStart, didShow, onReady };
}

describe('pending PDF update preview', () => {
	it('shows finished pixels before saving without replacing the real page or its annotation map', async () => {
		const f = fixture();
		const handle = startPdfUpdatePreview(() => f.task, () => f.view, [0], () => true, f.onReady);
		await f.didStart;
		expect(f.parent.append).not.toHaveBeenCalled();
		expect(f.page.render.mock.calls[0]![0].annotationCanvasMap).not.toBe(f.sharedMap);
		f.finish();
		await f.didShow;
		expect(f.parent.append).toHaveBeenCalledWith(f.overlay);
		expect(f.view.canvas).toBe(f.canvas);
		handle.dispose();
		await Promise.resolve();
		expect(f.overlay.remove).toHaveBeenCalledOnce();
		expect(f.task.destroy).toHaveBeenCalledOnce();
	});

	it('cancels rendering and never attaches a preview after the save has finished', async () => {
		const f = fixture();
		const handle = startPdfUpdatePreview(() => f.task, () => f.view, [0], () => true, f.onReady);
		await f.didStart;
		handle.dispose();
		f.finish();
		await f.render.promise;
		await Promise.resolve();
		expect(f.render.cancel).toHaveBeenCalledOnce();
		expect(f.parent.append).not.toHaveBeenCalled();
		expect(f.onReady).not.toHaveBeenCalled();
	});

	it('discards a completed preview when the PDF view changes during rendering', async () => {
		const f = fixture();
		let current = true;
		const handle = startPdfUpdatePreview(() => f.task, () => f.view, [0], () => current, f.onReady);
		await f.didStart;
		current = false;
		f.finish();
		await f.render.promise;
		await Promise.resolve();
		expect(f.parent.append).not.toHaveBeenCalled();
		handle.dispose();
	});

	it('removes an attached preview when zoom changes the live canvas style', async () => {
		const f = fixture();
		let notify!: () => void;
		const disconnect = vi.fn();
		class Observer {
			constructor(callback: () => void) { notify = callback; }
			observe() {}
			disconnect = disconnect;
		}
		Object.assign(f.canvas, { style: { cssText: '' }, ownerDocument: { defaultView: { MutationObserver: Observer } } });
		Object.assign(f.parent, { getAttribute: () => null });
		startPdfUpdatePreview(() => f.task, () => f.view, [0], () => true, f.onReady);
		await f.didStart;
		f.finish();
		await f.didShow;
		(f.canvas as unknown as { style: { cssText: string } }).style.cssText = 'width: 1200px';
		notify();
		expect(f.overlay.remove).toHaveBeenCalledOnce();
		expect(disconnect).toHaveBeenCalledOnce();
	});

	it('transfers the loaded document without waiting for preview rendering or destroying the adopted task', async () => {
		const f = fixture();
		const handle = startPdfUpdatePreview(() => f.task, () => f.view, [0], () => true);
		await f.didStart;
		expect(await handle.takeDocument!()).toBe(f.task);
		expect(await handle.takeDocument!()).toBeNull();
		handle.dispose();
		f.finish();
		await f.render.promise;
		await Promise.resolve();
		expect(f.task.destroy).not.toHaveBeenCalled();
		expect(f.parent.append).not.toHaveBeenCalled();
	});
	it('exposes only the completed overlay from the adopted page proxy', async () => {
		const f = fixture();
		const handle = startPdfUpdatePreview(() => f.task, () => f.view, [0], () => true, f.onReady);
		await f.didStart;
		f.finish();
		await f.didShow;
		expect(await handle.takeDocument!()).toBe(f.task);
		expect(handle.getRaster?.(0, f.view, f.page)).toBe(f.overlay);
		expect(handle.getRaster?.(0, f.view, { rotate: 0 })).toBeNull();
		handle.dispose();
	});
	it('declines raster reuse when the isolated preview annotation map has form canvases', async () => {
		const f = fixture();
		const handle = startPdfUpdatePreview(() => f.task, () => f.view, [0], () => true, f.onReady);
		await f.didStart;
		(f.page.render.mock.calls[0]![0].annotationCanvasMap as Map<unknown, unknown>).set('form-field', {});
		f.finish();
		await f.didShow;
		expect(await handle.takeDocument!()).toBe(f.task);
		expect(handle.getRaster?.(0, f.view, f.page)).toBeNull();
		handle.dispose();
	});
	it('cannot adopt a document after disposal while its loading promise is pending', async () => {
		let resolve!: (document: { numPages: number; getPage(): Promise<{ rotate: number }> }) => void;
		const task = { promise: new Promise<{ numPages: number; getPage(): Promise<{ rotate: number }> }>(r => { resolve = r; }), destroy: vi.fn(async () => {}) };
		const handle = startPdfUpdatePreview(() => task, () => null, [0], () => true);
		const claim = handle.takeDocument!();
		handle.dispose();
		resolve({ numPages: 1, getPage: async () => ({ rotate: 0 }) });
		expect(await claim).toBeNull();
		await Promise.resolve();
		expect(task.destroy).toHaveBeenCalledOnce();
	});
	it('does not destroy an adopted task if preview rendering later fails', async () => {
		const f = fixture();
		let reject!: (error: Error) => void;
		f.render.promise = new Promise<void>((_resolve, fail) => { reject = fail; });
		const handle = startPdfUpdatePreview(() => f.task, () => f.view, [0], () => true);
		await f.didStart;
		expect(await handle.takeDocument!()).toBe(f.task);
		reject(new Error('Preview failed'));
		await Promise.resolve(); await Promise.resolve();
		expect(f.task.destroy).not.toHaveBeenCalled();
		handle.dispose();
	});

});
