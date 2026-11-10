import { describe, expect, it, vi } from 'vitest';
import { beginPencilTextSelection, clearPencilTextSelection, extendPencilTextSelection } from '../src/pencil-gesture';

function fixture(initialX = 1, initialOffset = 1) {
	type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };
	const contained = new Set<unknown>();
	const ranges: any[] = [];
	const wordRects = new Map<string, Rect[]>([
		['0:4', [{ left: 0, right: 7, top: 0, bottom: 10, width: 7, height: 10 }]],
		['5:9', [{ left: 8, right: 16, top: 0, bottom: 10, width: 8, height: 10 }]],
	]);
	let layerBounds: Rect = { left: 0, right: 100, top: 0, bottom: 20, width: 100, height: 20 };
	let ownershipValid = true;
	let rotate = 'none';
	let detachAfterFocusGeometry = false;
	let caretReads = 0;
	let wordRangeReads = 0;
	let selection: any;
	const points = new Map<number, number>([[1, 1], [5, 2], [6, 3], [11, 6], [12, 7]]);
	const viewer = { parentElement: null as unknown as Element | null };
	const getComputedStyle = vi.fn(() => ({ transform: 'none', rotate, perspective: 'none' }));
	const textLayer = {
		nodeType: 1,
		className: 'textLayer',
		childNodes: [],
		isConnected: true,
		ownerDocument: null as unknown as Document,
		parentElement: viewer as unknown as Element,
		contains: (node: unknown) => contained.has(node),
		getBoundingClientRect: () => layerBounds,
	};
	let text: Text;
	const view: any = {
		innerWidth: 100,
		innerHeight: 100,
		getSelection: () => selection,
		getComputedStyle,
	};
	const document = {
		defaultView: view,
		caretPositionFromPoint: (x: number) => {
			caretReads++;
			return { offsetNode: text, offset: points.get(x) ?? Math.floor(x) };
		},
		createRange: () => {
			let startContainer: Node | null = null;
			let endContainer: Node | null = null;
			let startOffset = 0;
			let endOffset = 0;
			const range = {
				get startContainer() { return startContainer; },
				get endContainer() { return endContainer; },
				get startOffset() { return startOffset; },
				get endOffset() { return endOffset; },
				setStart: vi.fn((node: Node, offset: number) => {
					startContainer = node;
					endContainer ??= node;
					startOffset = offset;
					endOffset = offset;
				}),
				setEnd: vi.fn((node: Node, offset: number) => { endContainer = node; endOffset = offset; }),
				collapse: vi.fn((toStart: boolean) => {
					if (toStart) { endContainer = startContainer; endOffset = startOffset; }
					else { startContainer = endContainer; startOffset = endOffset; }
				}),
				compareBoundaryPoints: vi.fn(() => 0),
				getClientRects: vi.fn(() => {
					if (startContainer !== text || endContainer !== text) return [];
					const selectedText = text.data.slice(startOffset, endOffset);
					if (!selectedText.trim()) return [];
					if (selectedText.length <= 2 && !/\s/.test(selectedText)) {
						const secondWord = startOffset >= 5;
						const unit = secondWord ? 2 : 1.75;
						const origin = secondWord ? 8 - 5 * unit : 0;
						return [{ left: origin + startOffset * unit, right: origin + endOffset * unit, top: 0, bottom: 10 }];
					}
					if (!/\s/.test(selectedText)) {
						wordRangeReads++;
						return wordRects.get(`${startOffset}:${endOffset}`) ?? [];
					}
					if (detachAfterFocusGeometry) {
						(text as unknown as { isConnected: boolean }).isConnected = false;
						detachAfterFocusGeometry = false;
					}
					return [{ left: 0, right: 16, top: 0, bottom: 10, width: 16, height: 10 }];
				}),
			};
			ranges.push(range);
			return range;
		},
	} as unknown as Document;
	const anchorParent = {
		nodeType: 1,
		childNodes: [],
		parentElement: textLayer as unknown as Element,
		closest: (selector: string) => selector === '.textLayer' && ownershipValid ? textLayer : null,
	};
	text = {
		nodeType: 3,
		data: 'word next',
		textContent: 'word next',
		parentElement: anchorParent as unknown as Element,
		ownerDocument: document,
		isConnected: true,
	} as unknown as Text;
	contained.add(text);
	contained.add(anchorParent);
	contained.add(textLayer);
	selection = {
		anchorNode: null as Node | null,
		anchorOffset: 0,
		focusNode: null as Node | null,
		focusOffset: 0,
		isCollapsed: true,
		rangeCount: 0,
		removeAllRanges: vi.fn(function (this: any) {
			this.anchorNode = null;
			this.focusNode = null;
			this.anchorOffset = 0;
			this.focusOffset = 0;
			this.isCollapsed = true;
			this.rangeCount = 0;
		}),
		setBaseAndExtent: vi.fn(function (this: any, anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number) {
			this.anchorNode = anchorNode;
			this.anchorOffset = anchorOffset;
			this.focusNode = focusNode;
			this.focusOffset = focusOffset;
			this.isCollapsed = anchorNode === focusNode && anchorOffset === focusOffset;
			this.rangeCount = 1;
		}),
		collapse: vi.fn(function (this: any, node: Node, offset: number) {
			this.anchorNode = node;
			this.anchorOffset = offset;
			this.focusNode = node;
			this.focusOffset = offset;
			this.isCollapsed = true;
			this.rangeCount = 1;
		}),
		extend: vi.fn(function (this: any, node: Node, offset: number) {
			this.focusNode = node;
			this.focusOffset = offset;
			this.isCollapsed = this.anchorNode === node && this.anchorOffset === offset;
			this.rangeCount = 1;
		}),
	};
	textLayer.ownerDocument = document;
	const state = beginPencilTextSelection(document, textLayer as unknown as HTMLElement, 0, initialX, 5)!;
	return {
		text, textLayer, document, selection, state, ranges,
		move: (x: number, y = 5) => extendPencilTextSelection(state, x, y),
		caretReads: () => caretReads,
		wordRangeReads: () => wordRangeReads,
		transformStyleReads: () => getComputedStyle.mock.calls.length,
		setWordRect: (key: string, rects: Rect[]) => wordRects.set(key, rects),
		setCaretOffset: (x: number, offset: number) => points.set(x, offset),
		setLayerBounds: (bounds: Rect) => { layerBounds = bounds; },
		setOwnership: (value: boolean) => { ownershipValid = value; },
		setRotate: (value: string) => { rotate = value; },
		detachDuringNextFocusGeometry: () => { detachAfterFocusGeometry = true; },
	};
}

function publishWordFocus(f: ReturnType<typeof fixture>) {
	expect(f.move(11)).toBe(true);
	expect(f.state.hasRange).toBe(true);
}

describe('Pencil whole-word focus reuse', () => {
	it('uses fresh word geometry and falls back to the native caret when geometry moves', () => {
		const f = fixture();
		publishWordFocus(f);
		const nativeReads = f.caretReads();
		f.move(12);
		expect(f.caretReads()).toBe(nativeReads);
		expect(f.wordRangeReads()).toBe(1);

		f.setWordRect('5:9', [{ left: 30, right: 40, top: 0, bottom: 10, width: 10, height: 10 }]);
		f.move(12);
		expect(f.caretReads()).toBe(nativeReads + 1);
		expect(f.state.hasRange).toBe(true);
	});

	it('checks transforms only after fresh geometry confirms the pointer is still over the word', () => {
		const f = fixture();
		publishWordFocus(f);
		f.move(12);
		const transformReads = f.transformStyleReads();
		f.move(5);
		expect(f.transformStyleReads()).toBe(transformReads);
		expect(f.caretReads()).toBe(3);
	});

	it('rejects word edges, whitespace, and out-of-layer points', () => {
		const edge = fixture();
		publishWordFocus(edge);
		edge.setCaretOffset(9, 6);
		edge.move(9);
		expect(edge.caretReads()).toBe(3);

		const whitespace = fixture();
		publishWordFocus(whitespace);
		whitespace.setCaretOffset(7.5, 4);
		whitespace.move(7.5);
		expect(whitespace.caretReads()).toBe(3);
		expect(whitespace.selection.focusOffset).toBe(4);

		const offLayer = fixture();
		publishWordFocus(offLayer);
		offLayer.setLayerBounds({ left: 0, right: 10, top: 0, bottom: 20, width: 10, height: 20 });
		offLayer.move(11);
		expect(offLayer.caretReads()).toBe(2);
		expect(offLayer.state.hasRange).toBe(false);
	});

	it('invalidates reuse after text, range endpoints, ownership, connectivity, or selection changes', () => {
		const data = fixture();
		publishWordFocus(data);
		data.text.data = 'word news';
		data.setCaretOffset(12, 7);
		const dataReads = data.caretReads();
		data.move(12);
		expect(data.caretReads()).toBe(dataReads + 1);

		const endpoints = fixture();
		publishWordFocus(endpoints);
		const cachedRange = endpoints.ranges.at(-1);
		cachedRange.setStart(endpoints.text, 4);
		const endpointReads = endpoints.caretReads();
		endpoints.move(12);
		expect(endpoints.caretReads()).toBe(endpointReads + 1);

		const ownership = fixture();
		publishWordFocus(ownership);
		ownership.setOwnership(false);
		const ownershipReads = ownership.caretReads();
		ownership.move(12);
		expect(ownership.caretReads()).toBe(ownershipReads + 1);
		expect(ownership.state.hasRange).toBe(false);

		const detached = fixture();
		publishWordFocus(detached);
		(detached.text as unknown as { isConnected: boolean }).isConnected = false;
		const detachedReads = detached.caretReads();
		detached.move(12);
		expect(detached.caretReads()).toBe(detachedReads + 1);

		const external = fixture();
		publishWordFocus(external);
		external.selection.focusOffset = 8;
		const externalReads = external.caretReads();
		external.move(12);
		expect(external.caretReads()).toBe(externalReads + 1);
	});

	it('fails closed for an unknown viewport and rotated viewer ancestors', () => {
		const viewport = fixture();
		publishWordFocus(viewport);
		delete (viewport.document.defaultView as unknown as { innerWidth?: number }).innerWidth;
		const viewportReads = viewport.caretReads();
		viewport.move(12);
		expect(viewport.caretReads()).toBe(viewportReads + 1);

		const rotated = fixture();
		publishWordFocus(rotated);
		rotated.setRotate('45deg');
		const rotateReads = rotated.caretReads();
		rotated.move(12);
		expect(rotated.caretReads()).toBe(rotateReads + 1);

		const outsideViewport = fixture();
		publishWordFocus(outsideViewport);
		outsideViewport.document.defaultView.innerWidth = 10;
		const outsideReads = outsideViewport.caretReads();
		outsideViewport.move(12);
		expect(outsideViewport.caretReads()).toBe(outsideReads + 1);
	});

	it('does not cache the anchor word and keeps reverse selections directional', () => {
		const anchorWord = fixture();
		publishWordFocus(anchorWord);
		anchorWord.setCaretOffset(5, 2);
		const anchorReads = anchorWord.caretReads();
		anchorWord.move(5);
		expect(anchorWord.caretReads()).toBe(anchorReads + 1);
		const secondAnchorReads = anchorWord.caretReads();
		anchorWord.setCaretOffset(6, 3);
		anchorWord.move(6);
		expect(anchorWord.caretReads()).toBe(secondAnchorReads + 1);

		const reverse = fixture(11, 6);
		expect(reverse.move(5)).toBe(true);
		const reverseReads = reverse.caretReads();
		reverse.setCaretOffset(5.5, 3);
		reverse.move(5.5);
		expect(reverse.caretReads()).toBe(reverseReads);
		expect(reverse.selection.anchorOffset).toBe(9);
		expect(reverse.selection.focusOffset).toBe(0);
	});

	it('does not publish a cache when native writes throw or silently miss the requested endpoints', () => {
		const thrown = fixture();
		thrown.selection.setBaseAndExtent = vi.fn(() => { throw new Error('native write failed'); });
		thrown.move(11);
		expect(thrown.state.hasRange).toBe(false);
		expect(thrown.selection.removeAllRanges).not.toHaveBeenCalled();
		const throwReads = thrown.caretReads();
		thrown.move(12);
		expect(thrown.caretReads()).toBe(throwReads + 1);

		const noOp = fixture();
		noOp.selection.anchorNode = noOp.text;
		noOp.selection.anchorOffset = 7;
		noOp.selection.focusNode = noOp.text;
		noOp.selection.focusOffset = 8;
		noOp.selection.isCollapsed = false;
		noOp.selection.rangeCount = 1;
		noOp.selection.setBaseAndExtent = vi.fn();
		noOp.move(11);
		expect(noOp.state.hasRange).toBe(false);
		expect(noOp.state.appliedAnchor).toBeNull();
		expect(noOp.selection.anchorOffset).toBe(7);
		expect(noOp.selection.focusOffset).toBe(8);
		const noOpReads = noOp.caretReads();
		noOp.move(12);
		expect(noOp.caretReads()).toBe(noOpReads + 1);

		const detachedAnchor = fixture();
		detachedAnchor.selection.anchorNode = detachedAnchor.text;
		detachedAnchor.selection.anchorOffset = 7;
		detachedAnchor.selection.focusNode = detachedAnchor.text;
		detachedAnchor.selection.focusOffset = 8;
		detachedAnchor.selection.isCollapsed = false;
		detachedAnchor.selection.rangeCount = 1;
		detachedAnchor.selection.setBaseAndExtent = vi.fn();
		detachedAnchor.detachDuringNextFocusGeometry();
		detachedAnchor.move(11);
		expect(detachedAnchor.text.isConnected).toBe(false);
		expect(detachedAnchor.state.hasRange).toBe(false);
		expect(detachedAnchor.state.appliedAnchor).toBeNull();
		expect(detachedAnchor.selection.anchorOffset).toBe(7);
		expect(detachedAnchor.selection.focusOffset).toBe(8);
	});

	it('clears focus on threshold, detach, and clear paths', () => {
		const threshold = fixture();
		publishWordFocus(threshold);
		const thresholdReads = threshold.caretReads();
		threshold.move(3, 5);
		threshold.move(11);
		expect(threshold.caretReads()).toBe(thresholdReads + 1);

		const detached = fixture();
		publishWordFocus(detached);
		const detachReads = detached.caretReads();
		(detached.textLayer as unknown as { isConnected: boolean }).isConnected = false;
		detached.move(12);
		(detached.textLayer as unknown as { isConnected: boolean }).isConnected = true;
		detached.move(11);
		expect(detached.caretReads()).toBe(detachReads + 1);

		const cleared = fixture();
		publishWordFocus(cleared);
		clearPencilTextSelection(cleared.state);
		const clearReads = cleared.caretReads();
		cleared.move(11);
		expect(cleared.caretReads()).toBe(clearReads + 1);
	});

	it('extends an unchanged anchor with one native write and retains the fallback path', () => {
		const stable = fixture();
		publishWordFocus(stable);
		stable.setCaretOffset(5, 2);
		stable.move(5);
		expect(stable.selection.extend).toHaveBeenCalledOnce();
		expect(stable.selection.removeAllRanges).not.toHaveBeenCalled();

		const fallback = fixture();
		delete fallback.selection.setBaseAndExtent;
		fallback.selection.extend = vi.fn(function (this: any, node: Node, offset: number) {
			this.focusNode = node;
			this.focusOffset = offset;
			this.isCollapsed = this.anchorNode === node && this.anchorOffset === offset;
			this.rangeCount = 1;
		});
		fallback.move(11);
		expect(fallback.state.hasRange).toBe(true);
		expect(fallback.selection.removeAllRanges).toHaveBeenCalledOnce();

		const fallbackThrow = fixture();
		delete fallbackThrow.selection.setBaseAndExtent;
		fallbackThrow.selection.extend = vi.fn(() => { throw new Error('fallback write failed'); });
		fallbackThrow.move(11);
		expect(fallbackThrow.state.hasRange).toBe(false);
		expect(fallbackThrow.selection.removeAllRanges).toHaveBeenCalledOnce();
		const fallbackThrowReads = fallbackThrow.caretReads();
		fallbackThrow.move(12);
		expect(fallbackThrow.caretReads()).toBe(fallbackThrowReads + 1);
	});
});
