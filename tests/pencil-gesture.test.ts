import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => {
	class Base {}
	return {
		Plugin: Base, Component: Base, Modal: Base, FileView: Base, PluginSettingTab: Base, Setting: Base,
		Scope: Base, TFile: Base, Notice: vi.fn(), Platform: { isIosApp: true }, setIcon: vi.fn(), setTooltip: vi.fn(),
	};
});
vi.mock('../src/obsidian-pdf-internals', async (importOriginal) => ({
	...await importOriginal<typeof import('../src/obsidian-pdf-internals')>(), getAllPdfViews: vi.fn(),
}));

import { getAllPdfViews } from '../src/obsidian-pdf-internals';
import StudyPdf from '../src/main';
import { beginPencilTextSelection, extendPencilTextSelection } from '../src/pencil-gesture';

afterEach(() => vi.restoreAllMocks());

function fixture(initialX = 1, initialOffset = 1, initialY = 0) {
	const containedNodes = new Set<unknown>();
	type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };
	const textRects = new Map<Node, Rect[]>();
	const rangeRectReads = new Map<Node, number>();
	const wordRectReads = new Map<Node, number>();
	const textLayer = {
		nodeType: 1,
		childNodes: [],
		className: 'textLayer',
		isConnected: true,
		ownerDocument: null as unknown as Document,
		contains: (node: unknown) => node === textLayer || containedNodes.has(node),
		closest: (selector: string) => selector === '.textLayer' ? textLayer : null,
		getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }),
	};
	const rectForText = { left: 0, right: 16, top: 0, bottom: 10, width: 16, height: 10 };
	let text: Text;
	const caretPoints = new Map<string, { node: Node; offset: number }>();
	let selection: any;
	let customCaret: ((x: number, y: number) => { node: Node; offset: number }) | null = null;
	let contactInsideWord = true;
	let caretReads = 0;
	const caretOffsets = new Map<number, number>([[1, 1], [5, 2], [6, 3], [10, 7], [11, 6], [initialX, initialOffset]]);
	const view = { innerWidth: 100, innerHeight: 100, getSelection: () => selection, getComputedStyle: () => ({ transform: 'none' }) };
	const document = {
		defaultView: view,
		caretPositionFromPoint: (x: number, y: number) => {
			caretReads++;
			const point = customCaret?.(x, y) ?? caretPoints.get(`${x},${y}`) ?? caretPoints.get(`${x},*`);
			return point ? { offsetNode: point.node, offset: point.offset } : { offsetNode: text, offset: caretOffsets.get(x) ?? Math.floor(x) };
		},
		createRange: () => {
			let startContainer: Node | null = null;
			let endContainer: Node | null = null;
			let startOffset = 0;
			let endOffset = 0;
			return {
				get startContainer() { return startContainer; },
				get endContainer() { return endContainer; },
				get startOffset() { return startOffset; },
				get endOffset() { return endOffset; },
				setStart: vi.fn((node: Node, offset: number) => { startContainer = node; endContainer ??= node; startOffset = offset; endOffset = offset; }),
				setEnd: vi.fn((node: Node, offset: number) => { endContainer = node; endOffset = offset; }),
				collapse: vi.fn((toStart: boolean) => {
					if (toStart) { endContainer = startContainer; endOffset = startOffset; }
					else { startContainer = endContainer; startOffset = endOffset; }
				}),
				compareBoundaryPoints: vi.fn(() => 0),
				getClientRects: vi.fn(() => {
					if (!startContainer || startContainer !== endContainer) return [];
					const node = startContainer as Text;
					const nodeRects = textRects.get(node) ?? [];
					const selectedText = (node.data ?? '').slice(startOffset, endOffset);
					if (!selectedText.trim()) return [];
					rangeRectReads.set(node, (rangeRectReads.get(node) ?? 0) + 1);
					const isWordRange = selectedText.trim() === selectedText && !/\s/.test(selectedText);
					if (isWordRange) {
						if (selectedText.length > 2) wordRectReads.set(node, (wordRectReads.get(node) ?? 0) + 1);
						if (node === text && startOffset === 0 && endOffset === 4 && !contactInsideWord) return [];
						const whole = nodeRects[0];
						if (!whole || node.data.length === 0) return [];
						const unit = whole.width / node.data.length;
						return [{
							left: whole.left + startOffset * unit,
							right: whole.left + endOffset * unit,
							top: whole.top,
							bottom: whole.bottom,
							width: (endOffset - startOffset) * unit,
							height: whole.height,
						}];
					}
					return nodeRects;
				}),
			};
		},
	} as unknown as Document;
	text = makeTextNode('word next', rectForText);
	function makeParent(className = '', role = '') {
		const parent = {
			nodeType: 1,
			childNodes: [],
			className,
			role,
			isConnected: true,
			parentElement: textLayer as unknown as Element,
			closest: (selector: string) => {
				if (selector === '.endOfContent' && className.split(/\s+/).includes('endOfContent')) return parent;
				if (selector === '[role="img"]' && role === 'img') return parent;
				return selector === '.textLayer' ? textLayer : null;
			},
		};
		containedNodes.add(parent);
		return parent;
	}
	function makeTextNode(data: string, rects: { left: number; right: number; top: number; bottom: number; width: number; height: number }, className = '', role = '', nested = false) {
		const parent = makeParent(className, role);
		if (nested) parent.parentElement = makeParent() as unknown as Element;
		const node = {
			nodeType: 3,
			data,
			textContent: data,
			parentElement: parent as unknown as Element,
			ownerDocument: document as Document,
			isConnected: true,
		};
		containedNodes.add(node);
		textRects.set(node as unknown as Node, [rects]);
		return node as unknown as Text;
	}
	text.ownerDocument = document;
	textLayer.ownerDocument = document;
	containedNodes.add(text);
	containedNodes.add(text.parentElement);
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
			this.focusNode = node;
			this.anchorOffset = offset;
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
	const state = beginPencilTextSelection(document, textLayer as unknown as HTMLElement, 0, initialX, initialY)!;
	const plugin = new StudyPdf() as any;
	plugin.applyPencilSelectionColor = vi.fn();
	plugin.refreshSelectionOverlay = vi.fn();
	const gesture = { selection: state };
	return {
		text, textLayer, document, selection, state, plugin, gesture,
		setContactInsideWord: (value: boolean) => { contactInsideWord = value; },
		setCaretResolver: (resolve: typeof customCaret) => { customCaret = resolve; },
		setCaretOffset: (x: number, offset: number) => caretOffsets.set(x, offset),
		setCaretPoint: (x: number, node: Node, offset: number, y?: number) => caretPoints.set(y === undefined ? `${x},*` : `${x},${y}`, { node, offset }),
		addTextNode: makeTextNode,
		createBoundaryElement: makeParent,
		getRangeRectReads: (node: Node) => rangeRectReads.get(node) ?? 0,
		getWordRectReads: (node: Node) => wordRectReads.get(node) ?? 0,
		getCaretReads: () => caretReads,
	};
}

describe('Pencil text-selection updates', () => {
	it.each([[5, 32, 0, 9], [40, 21, 9, 0]])('starts at the first word crossed from margin x=%i', (startX, endX, anchorOffset, focusOffset) => {
		const f = fixture();
		const layer = f.textLayer as unknown as HTMLElement;
		const body = f.addTextNode('word next', { left: 20, right: 38, top: 0, bottom: 10, width: 18, height: 10 });
		f.setCaretResolver((x) => x < 20 || x > 38
			? { node: layer, offset: 0 }
			: { node: body, offset: Math.round((x - 20) / 2) });
		const state = beginPencilTextSelection(f.document, layer, 0, startX, 5);
		expect(state).not.toBeNull();
		expect(f.selection.rangeCount).toBe(0);

		extendPencilTextSelection(state!, endX, 5);

		expect(state?.hasRange).toBe(true);
		expect(f.selection.anchorNode).toBe(body);
		expect(f.selection.anchorOffset).toBe(anchorOffset);
		expect(f.selection.focusOffset).toBe(focusOffset);
	});

	it('keeps a margin tap and a drag that stays blank from creating a selection', () => {
		const f = fixture();
		const layer = f.textLayer as unknown as HTMLElement;
		const remote = f.addTextNode('running header', { left: 0, right: 35, top: 0, bottom: 10, width: 35, height: 10 });
		f.setCaretResolver(() => ({ node: remote, offset: 0 }));
		const state = beginPencilTextSelection(f.document, layer, 0, 85, 5);
		expect(state).not.toBeNull();
		extendPencilTextSelection(state!, 87, 5);
		expect(state?.moved).toBe(false);

		extendPencilTextSelection(state!, 96, 5);
		expect(state?.moved).toBe(true);
		expect(state?.hasRange).toBe(false);
		expect(f.selection.rangeCount).toBe(0);
	});

	it.each(['drag', 'tap', 'link', 'finger'] as const)('routes a page-background Pencil %s through the touch handlers', async (mode) => {
		const f = fixture();
		const pageSelector = 'div.page[data-page-number]';
		const page = { nodeType: 1, closest: (selector: string) => selector === pageSelector ? page : null };
		const target = { nodeType: 1, closest: (selector: string) => selector === pageSelector || mode === 'link' ? page : null };
		const layer = Object.assign(f.textLayer, {
			matches: (selector: string) => selector === '.textLayer',
			closest: (selector: string) => selector === pageSelector ? page : selector === '.textLayer' ? f.textLayer : null,
			classList: { contains: () => false },
			style: { getPropertyValue: () => '', getPropertyPriority: () => '' },
		});
		const right = {};
		const pdfView = {
			file: { path: 'example.pdf' },
			containerEl: { ownerDocument: f.document, contains: (node: unknown) => node === target || node === layer },
			getToolbarRightElement: () => right,
			getPageElement: () => layer,
			getPageViewport: () => ({ convertToPdfPoint: (x: number, y: number) => [x, y] }),
			findPageIndexForNode: () => 0,
		};
		vi.mocked(getAllPdfViews).mockReturnValue([pdfView as never]);
		f.plugin.annotationToolbars.set(right, { highlighting: true, colorId: f.plugin.settings.colors[0].id, toolbar: { el: { contains: () => false } } });
		f.plugin.cancelPendingSelectionUpdate = vi.fn();
		f.plugin.scheduleSelectionUpdate = vi.fn();
		f.plugin.isCapturedPdfCurrent = () => true;
		f.plugin.performHighlight = vi.fn();
		const context = { capture: { file: pdfView.file }, pdfView, segments: [{ pageIndex: 0 }] };
		f.plugin.trySelectionContext = () => context;
		f.selection.toString = () => 'word next';
		const body = f.addTextNode('word next', { left: 20, right: 38, top: 0, bottom: 10, width: 18, height: 10 });
		f.setCaretResolver((x) => x < 20 || x > 38
			? { node: layer as unknown as Node, offset: 0 }
			: { node: body, offset: Math.round((x - 20) / 2) });
		const touch = { target, identifier: 1, touchType: mode === 'finger' ? 'direct' : 'stylus', clientX: 5, clientY: 5 };
		const start = { touches: [touch], changedTouches: [touch], cancelable: true, preventDefault: vi.fn() };

		f.plugin.handleStylusTouchStart(f.document, start);
		expect(start.preventDefault).not.toHaveBeenCalled();
		expect(Boolean(f.plugin.pencilGesture)).toBe(mode === 'drag' || mode === 'tap');
		const lift = { ...touch, clientX: mode === 'drag' ? 32 : 5 };
		await f.plugin.handleStylusTouchEnd(f.document, { touches: [], changedTouches: [lift] });

		expect(f.plugin.performHighlight).toHaveBeenCalledTimes(mode === 'drag' ? 1 : 0);
		if (mode === 'tap') expect(f.plugin.scheduleSelectionUpdate).toHaveBeenCalledWith(0);
		if (mode === 'drag') expect(f.plugin.performHighlight).toHaveBeenCalledWith(context, expect.anything());
	});

	it('writes selection and overlay geometry once while stylus moves inside the same snapped word', () => {
		const f = fixture();
		f.plugin.applyPencilGesturePoint(f.gesture, 11, 5);
		const nativeCaretReadsAfterPublication = f.getCaretReads();
		for (let index = 0; index < 100; index++) {
			f.plugin.applyPencilGesturePoint(f.gesture, index % 2 === 0 ? 11 : 12, 5);
		}

		expect(f.state.hasRange).toBe(true);
		expect(f.getCaretReads()).toBe(nativeCaretReadsAfterPublication);
		expect(f.getWordRectReads(f.text)).toBe(100);
		expect(f.selection.setBaseAndExtent).toHaveBeenCalledOnce();
		expect(f.selection.removeAllRanges).not.toHaveBeenCalled();
		expect(f.selection.extend).not.toHaveBeenCalled();
		expect(f.plugin.refreshSelectionOverlay).toHaveBeenCalledOnce();

		f.plugin.applyPencilGesturePoint(f.gesture, 5, 5);
		expect(f.getCaretReads()).toBe(nativeCaretReadsAfterPublication + 1);
		expect(f.selection.extend).toHaveBeenCalledOnce();
		expect(f.selection.removeAllRanges).not.toHaveBeenCalled();
		expect(f.plugin.refreshSelectionOverlay).toHaveBeenCalledTimes(2);
	});

	it('rejects layer-element and endOfContent-element caret boundaries when beginning', () => {
		const f = fixture();
		f.setCaretPoint(1, f.textLayer as unknown as Node, 0);
		expect(beginPencilTextSelection(f.document, f.textLayer as unknown as HTMLElement, 0, 1, 0)?.anchor).toBeNull();
	});

	it('rejects endOfContent-element caret boundaries when beginning', () => {
		const f = fixture();
		f.setCaretPoint(1, f.createBoundaryElement('endOfContent') as unknown as Node, 0);
		expect(beginPencilTextSelection(f.document, f.textLayer as unknown as HTMLElement, 0, 1, 0)?.anchor).toBeNull();
	});

	it('rejects whitespace-only Text caret candidates', () => {
		const f = fixture();
		const whitespace = f.addTextNode(' \t', { left: 0, right: 10, top: 0, bottom: 10, width: 10, height: 10 });
		f.setCaretPoint(1, whitespace, 0);
		expect(beginPencilTextSelection(f.document, f.textLayer as unknown as HTMLElement, 0, 1, 0)?.anchor).toBeNull();
	});

	it('rejects Text descendants of the endOfContent sentinel', () => {
		const f = fixture();
		const sentinelText = f.addTextNode('sentinel', { left: 0, right: 50, top: 0, bottom: 10, width: 50, height: 10 }, 'endOfContent');
		f.setCaretPoint(1, sentinelText, 0);
		expect(beginPencilTextSelection(f.document, f.textLayer as unknown as HTMLElement, 0, 1, 0)?.anchor).toBeNull();
	});

	it('rejects disconnected, foreign, and nonselectable Text candidates', () => {
		const disconnected = fixture();
		const detachedText = disconnected.addTextNode('detached', {
			left: 0, right: 50, top: 0, bottom: 10, width: 50, height: 10,
		});
		(detachedText as unknown as { isConnected: boolean }).isConnected = false;
		disconnected.setCaretPoint(1, detachedText, 0);
		expect(beginPencilTextSelection(disconnected.document, disconnected.textLayer as unknown as HTMLElement, 0, 1, 0)?.anchor).toBeNull();

		const foreign = fixture();
		const foreignLayer = { isConnected: true } as unknown as HTMLElement;
		const foreignParent = {
			nodeType: 1,
			isConnected: true,
			closest: (selector: string) => selector === '.textLayer' ? foreignLayer : null,
		};
		const foreignText = {
			nodeType: 3,
			data: 'foreign',
			textContent: 'foreign',
			isConnected: true,
			parentElement: foreignParent as unknown as Element,
			ownerDocument: foreign.document,
		} as unknown as Text;
		foreign.setCaretPoint(1, foreignText, 0);
		expect(beginPencilTextSelection(foreign.document, foreign.textLayer as unknown as HTMLElement, 0, 1, 0)?.anchor).toBeNull();

		const decorative = fixture();
		const imageText = decorative.addTextNode('image label', {
			left: 0, right: 50, top: 0, bottom: 10, width: 50, height: 10,
		}, '', 'img');
		decorative.setCaretPoint(1, imageText, 0);
		expect(beginPencilTextSelection(decorative.document, decorative.textLayer as unknown as HTMLElement, 0, 1, 0)?.anchor).toBeNull();
	});

	it('keeps a Unicode caret offset inside nested text spans', () => {
		const f = fixture();
		const unicodeText = f.addTextNode('Café 😀 archive', {
			left: 0, right: 50, top: 0, bottom: 10, width: 50, height: 10,
		}, '', '', true);
		f.setCaretPoint(20, unicodeText, 6);
		const state = beginPencilTextSelection(f.document, f.textLayer as unknown as HTMLElement, 0, 20, 0);

		expect(state?.anchor?.node).toBe(unicodeText);
		expect(state?.anchor?.offset).toBe(6);
	});

	it('rejects a valid Text offset whose glyphs are far from the Pencil contact', () => {
		const f = fixture();
		const remoteText = f.addTextNode('Header10 first line body text', {
			left: 12, right: 45, top: 0, bottom: 10, width: 33, height: 10,
		});
		f.setCaretPoint(95, remoteText, 0);
		f.plugin.applyPencilGesturePoint(f.gesture, 95, 0);

		expect(f.state.hasRange).toBe(false);
		expect(f.selection.isCollapsed).toBe(true);
		expect(f.plugin.refreshSelectionOverlay).not.toHaveBeenCalled();
		expect(f.getRangeRectReads(remoteText)).toBe(1);
		expect(f.getRangeRectReads(f.text)).toBe(1);
	});

	it('recovers nearby same-row Text when the direct native caret maps to remote glyphs', () => {
		const f = fixture();
		const remoteText = f.addTextNode('remote line text', {
			left: 12, right: 45, top: 0, bottom: 10, width: 33, height: 10,
		});
		f.setCaretPoint(5, remoteText, 0);
		f.setCaretPoint(5, f.text as unknown as Node, 2, 4);
		f.setCaretPoint(5, f.text as unknown as Node, 2, 8);
		f.setCaretPoint(5, f.text as unknown as Node, 2, 12);
		f.plugin.applyPencilGesturePoint(f.gesture, 5, 0);

		expect(f.state.hasRange).toBe(true);
		expect(f.selection.focusNode).toBe(f.text);
		expect(f.getRangeRectReads(remoteText)).toBe(1);
		expect(f.getRangeRectReads(f.text)).toBe(2);
		expect(f.getCaretReads()).toBeLessThanOrEqual(8);
	});

	it('clears a word preview when movement enters a same-page margin mapped to remote text', () => {
		const f = fixture();
		const headerAndNextLine = f.addTextNode('Header10 first line body text second line', {
			left: 12, right: 45, top: 0, bottom: 10, width: 33, height: 10,
		});
		f.plugin.applyPencilGesturePoint(f.gesture, 5, 0);
		expect(f.state.hasRange).toBe(true);

		f.setCaretPoint(95, headerAndNextLine, 21);
		f.plugin.applyPencilGesturePoint(f.gesture, 95, 0);

		expect(f.state.hasRange).toBe(false);
		expect(f.selection.isCollapsed).toBe(true);
		expect(f.plugin.refreshSelectionOverlay).toHaveBeenCalledTimes(2);
		expect(f.selection.focusNode).toBeNull();
		expect(f.getRangeRectReads(headerAndNextLine)).toBe(1);
	});

	it('keeps the current text range through a natural interline caret gap', () => {
		const f = fixture(1, 1, 5);
		f.plugin.applyPencilGesturePoint(f.gesture, 5, 8);
		expect(f.state.hasRange).toBe(true);

		f.setCaretPoint(5, f.textLayer as unknown as Node, 0, 15);
		f.setCaretPoint(5, f.text as unknown as Node, 6, 11);
		f.plugin.applyPencilGesturePoint(f.gesture, 5, 15);

		expect(f.state.hasRange).toBe(true);
		expect(f.selection.isCollapsed).toBe(false);
		expect(f.plugin.refreshSelectionOverlay).toHaveBeenCalledTimes(2);
		expect(f.selection.focusNode).toBe(f.text);
	});

	it('uses an endOfContent element only as the source for nearby line-gap Text probes', () => {
		const f = fixture(1, 1, 5);
		f.plugin.applyPencilGesturePoint(f.gesture, 5, 8);
		const sentinel = f.createBoundaryElement('endOfContent') as unknown as Node;
		f.setCaretPoint(5, sentinel, 0, 15);
		f.setCaretPoint(5, f.text as unknown as Node, 6, 11);
		f.plugin.applyPencilGesturePoint(f.gesture, 5, 15);

		expect(f.state.hasRange).toBe(true);
		expect(f.selection.focusNode).toBe(f.text);
		expect(f.plugin.refreshSelectionOverlay).toHaveBeenCalledTimes(2);
		expect(f.getCaretReads()).toBeLessThanOrEqual(9);
	});

	it('clears an off-layer preview once and repaints when the Pencil returns to text', () => {
		const f = fixture();
		f.plugin.applyPencilGesturePoint(f.gesture, 5, 0);
		f.plugin.applyPencilGesturePoint(f.gesture, 101, 0);
		expect(f.state.hasRange).toBe(false);
		expect(f.selection.isCollapsed).toBe(true);
		expect(f.plugin.refreshSelectionOverlay).toHaveBeenCalledTimes(2);

		f.plugin.applyPencilGesturePoint(f.gesture, 101, 0);
		expect(f.plugin.refreshSelectionOverlay).toHaveBeenCalledTimes(2);
		f.plugin.applyPencilGesturePoint(f.gesture, 11, 0);
		expect(f.state.hasRange).toBe(true);
		expect(f.plugin.refreshSelectionOverlay).toHaveBeenCalledTimes(3);
	});

	it('keeps word-end snapping dependent on contact geometry at the same caret offset', () => {
		const glyphContact = fixture();
		glyphContact.plugin.applyPencilGesturePoint(glyphContact.gesture, 5, 0);
		glyphContact.setCaretOffset(6, 4);
		glyphContact.plugin.applyPencilGesturePoint(glyphContact.gesture, 6, 0);
		expect(glyphContact.state.hasRange).toBe(true);

		const reversedGlyph = fixture(10, 6);
		reversedGlyph.setCaretOffset(6, 4);
		reversedGlyph.plugin.applyPencilGesturePoint(reversedGlyph.gesture, 6, 0);
		expect(reversedGlyph.selection.focusOffset).toBe(0);

		const whitespaceContact = fixture(10, 6);
		whitespaceContact.setCaretOffset(6, 4);
		whitespaceContact.setContactInsideWord(false);
		whitespaceContact.plugin.applyPencilGesturePoint(whitespaceContact.gesture, 6, 0);
		expect(whitespaceContact.selection.focusOffset).toBe(4);
	});
});
