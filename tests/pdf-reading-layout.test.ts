import { expect, it, vi } from 'vitest';
import { createPdfReadingLayout, type PdfReadingLayoutView } from '../src/pdf-reading-layout';

function fixture() {
	const frames = new Map<number, FrameRequestCallback>();
	let nextFrame = 0;
	const windowListeners = new Map<string, () => void>();
	const resizeObservers: FakeObserver[] = [];
	const mutationObservers: FakeObserver[] = [];
	class FakeObserver {
		observed = new Set<unknown>();
		constructor(readonly callback: () => void) {}
		observe(element: unknown) { this.observed.add(element); }
		unobserve(element: unknown) { this.observed.delete(element); }
		disconnect() { this.observed.clear(); }
	}
	const style = vi.fn((element: { overflowX: string }) => ({ overflowX: element.overflowX }));
	const win = {
		innerWidth: 500, getComputedStyle: style,
		ResizeObserver: class extends FakeObserver {
			constructor(callback: () => void) { super(callback); resizeObservers.push(this); }
		},
		MutationObserver: class extends FakeObserver {
			constructor(callback: () => void) { super(callback); mutationObservers.push(this); }
		},
		requestAnimationFrame: (fn: FrameRequestCallback) => { frames.set(++nextFrame, fn); return nextFrame; },
		cancelAnimationFrame: (id: number) => frames.delete(id),
		addEventListener: (name: string, fn: () => void) => windowListeners.set(name, fn),
		removeEventListener: (name: string) => windowListeners.delete(name),
	};
	const document = { defaultView: win, documentElement: {} };
	const outer = {
		parentElement: document.documentElement, overflowX: 'visible', clientLeft: 0, clientWidth: 500,
		getBoundingClientRect: vi.fn(() => ({ left: 0, right: outer.clientWidth })),
	};
	const ancestor = {
		parentElement: outer, overflowX: 'hidden', clientLeft: 0, clientWidth: 500,
		getBoundingClientRect: vi.fn(() => ({ left: 0, right: ancestor.clientWidth })),
	};
	let width = 480;
	const page = { getBoundingClientRect: vi.fn(() => ({ left: 0, right: width, top: 0, bottom: 800 })) };
	const makeScroll = () => {
		const listeners = new Map<string, (event: unknown) => void>();
		const classes = new Set<string>();
		const element = {
			ownerDocument: document, parentElement: ancestor, clientLeft: 0, clientTop: 0,
			clientWidth: 500, clientHeight: 600, scrollLeft: 0,
			getBoundingClientRect: vi.fn(() => ({ left: 0, right: element.clientWidth, top: 0, bottom: 600 })),
			classList: {
				contains: (s: string) => classes.has(s),
				toggle: (s: string, on: boolean) => on ? classes.add(s) : classes.delete(s),
				remove: (s: string) => classes.delete(s),
			},
			addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn),
			removeEventListener: (name: string) => listeners.delete(name),
		};
		return { element, listeners, classes };
	};
	const initial = makeScroll();
	let currentScroll = initial.element;
	const view = {
		containerEl: { ownerDocument: document }, getPdfScrollElement: () => currentScroll,
		getPdfScrollHostElement: () => ancestor, getCurrentPageNumber: () => 1, getPageCount: () => 1,
		getRenderedPageElement: () => page, getPageIndexAtPoint: () => 0, getPageContainerElement: () => null,
	} as unknown as PdfReadingLayoutView;
	const flush = () => { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(0); };
	const controller = createPdfReadingLayout(view);
	return {
		controller, classes: initial.classes, style, scroll: initial.element, page, listeners: initial.listeners,
		frames, flush, outer, ancestor, windowListeners, resizeObservers, mutationObservers, win,
		widen: () => { width = 800; },
		replaceScroll: () => { const next = makeScroll(); currentScroll = next.element; controller.updateView(view); return next; },
	};
}

it('bypasses every geometry/style read throughout pinch and rechecks after it ends', () => {
 const f = fixture(); f.flush(); f.page.getBoundingClientRect.mockClear(); f.scroll.getBoundingClientRect.mockClear(); f.style.mockClear();
 f.listeners.get('touchstart')!({ touches: [{}, {}] });
 f.listeners.get('scroll')!({}); f.flush();
 expect(f.page.getBoundingClientRect).not.toHaveBeenCalled(); expect(f.scroll.getBoundingClientRect).not.toHaveBeenCalled(); expect(f.style).not.toHaveBeenCalled();
 expect(f.classes.size).toBe(0);
 f.listeners.get('touchend')!({ touches: [] }); f.flush(); f.flush(); f.flush();
 expect(f.classes.size).toBe(1); f.controller.dispose();
});

it('reuses clipping classifications on scroll, reads page rectangles once, and preserves zoomed panning', () => {
 const f = fixture(); f.flush(); const styles = f.style.mock.calls.length;
 f.page.getBoundingClientRect.mockClear(); f.listeners.get('scroll')!({}); f.flush();
 expect(f.style).toHaveBeenCalledTimes(styles); expect(f.page.getBoundingClientRect).toHaveBeenCalledOnce();
 f.widen(); f.controller.refresh(); f.flush(); expect(f.classes.size).toBe(0);
 f.scroll.scrollLeft = 80; f.listeners.get('scroll')!({}); f.flush(); expect(f.scroll.scrollLeft).toBe(80);
 f.controller.refresh(); f.controller.dispose(); f.flush(); expect(f.frames.size).toBe(0);
});

it('invalidates clipping classification on explicit refresh and keeps pointer pinch unlocked', () => {
 const f = fixture(); f.flush(); const styles = f.style.mock.calls.length;
 f.controller.refresh(); f.flush(); expect(f.style).toHaveBeenCalledTimes(styles + 2);
 f.page.getBoundingClientRect.mockClear();
 for (const pointerId of [1, 2]) f.listeners.get('pointerdown')!({ pointerType: 'touch', pointerId });
 f.listeners.get('scroll')!({}); f.flush(); expect(f.page.getBoundingClientRect).not.toHaveBeenCalled(); expect(f.classes.size).toBe(0);
 f.listeners.get('pointerup')!({ pointerType: 'touch', pointerId: 2 }); f.flush(); f.flush(); f.flush();
 expect(f.classes.size).toBe(1); f.controller.dispose();
});

it('rechecks landscape dimensions and clipping classification when the window resizes', () => {
	const f = fixture(); f.flush(); expect(f.classes.size).toBe(1);
	const styles = f.style.mock.calls.length;
	// Rotation changes both the viewport dimensions and which wrapper clips it.
	f.win.innerWidth = 850; f.scroll.clientWidth = 850; f.ancestor.clientWidth = 850;
	f.outer.clientWidth = 450; f.outer.overflowX = 'hidden';
	f.windowListeners.get('resize')!(); f.flush();
	expect(f.style).toHaveBeenCalledTimes(styles + 2);
	expect(f.outer.getBoundingClientRect).toHaveBeenCalledOnce();
	expect(f.classes.size).toBe(0);
	f.outer.clientWidth = 850;
	f.windowListeners.get('resize')!(); f.flush(); expect(f.classes.size).toBe(1);
	f.controller.dispose();
});

it('honors nested clipping tighter than the viewport and refreshes its classification after observed resizing', () => {
	const f = fixture(); f.flush(); expect(f.classes.size).toBe(1);
	f.outer.overflowX = 'hidden'; f.outer.clientWidth = 400;
	const observer = f.resizeObservers[0]!;
	expect(observer.observed.has(f.outer)).toBe(true);
	observer.callback(); f.flush(); expect(f.classes.size).toBe(0);
	const styles = f.style.mock.calls.length;
	// Live rectangle changes remain visible even while classification is cached.
	f.outer.clientWidth = 500;
	f.listeners.get('scroll')!({}); f.flush();
	expect(f.classes.size).toBe(1); expect(f.style).toHaveBeenCalledTimes(styles);
	f.controller.dispose();
});

it('moves listeners and observations to a replacement scroller and releases everything on disposal', () => {
	const f = fixture(); f.flush();
	expect(f.resizeObservers[0]!.observed.has(f.scroll)).toBe(true);
	const oldScrollCallback = f.listeners.get('scroll')!;
	const next = f.replaceScroll();
	expect(f.listeners.size).toBe(0); expect(f.classes.size).toBe(0);
	expect(f.resizeObservers[0]!.observed.has(f.scroll)).toBe(false);
	expect(f.resizeObservers[0]!.observed.has(next.element)).toBe(true);
	expect([...next.listeners.keys()].sort()).toEqual(['scroll', 'pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'touchcancel'].sort());
	f.flush(); expect(next.classes.size).toBe(1);
	f.page.getBoundingClientRect.mockClear();
	f.controller.refresh(); f.controller.dispose();
	oldScrollCallback({});
	for (const observer of [...f.resizeObservers, ...f.mutationObservers]) observer.callback();
	f.flush();
	expect(f.page.getBoundingClientRect).not.toHaveBeenCalled();
	expect(next.listeners.size).toBe(0); expect(next.classes.size).toBe(0);
	expect(f.windowListeners.size).toBe(0); expect(f.frames.size).toBe(0);
	for (const observer of [...f.resizeObservers, ...f.mutationObservers]) expect(observer.observed.size).toBe(0);
});
