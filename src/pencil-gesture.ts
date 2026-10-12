/** A caret position inside a rendered PDF.js text layer. */
export interface PencilCaretPoint {
	node: Node;
	offset: number;
}

/** State for one Pencil drag. DOM selection is only changed after the drag
 * crosses the movement threshold, so a tap remains an annotation tap. */
export interface PencilTextSelection {
	textLayer: HTMLElement;
	pageIndex: number;
	startX: number;
	startY: number;
	anchor: PencilCaretPoint;
	/** The anchor actually applied to the DOM selection, which may be a word edge. */
	appliedAnchor: PencilCaretPoint | null;
	moved: boolean;
	hasRange: boolean;
}

interface WordBoundary {
	start: number;
	end: number;
}

interface WordSegment {
	segment: string;
	index: number;
	isWordLike?: boolean;
}

interface WordSegmenter {
	segment(input: string): Iterable<WordSegment>;
}

interface GestureSelectionCache {
	wordRangesByText: WeakMap<Text, WordBoundary[]>;
	anchorWord: WordBoundary | null;
	segmenter: WordSegmenter | null;
}

const gestureSelectionCaches = new WeakMap<PencilTextSelection, GestureSelectionCache>();
const MAX_WORD_TEXT_NODE_LENGTH = 512;
const UNICODE_WORD_CHARACTER = /[\p{L}\p{M}\p{N}\p{Pc}]/u;

export const PENCIL_DRAG_THRESHOLD_PX = 4;

/** Resolve a press to a real, rendered PDF.js text layer. Annotation layers,
 * canvases, margins, and other panes are deliberately excluded. */
export function findRenderedTextLayer(target: EventTarget | null, pdfContainer: HTMLElement): HTMLElement | null {
	if (!target || typeof target !== 'object') return null;
	const nodeType = (target as { nodeType?: unknown }).nodeType;
	if (typeof nodeType !== 'number' || nodeType < 1 || nodeType > 12) return null;
	const node = target as Node;
	const element = node.nodeType === 1 ? node as Element : node.parentElement;
	const layer = element?.closest<HTMLElement>('.textLayer');
	if (!layer || element === layer || !pdfContainer.contains(layer) || !layer.isConnected) return null;
	const rect = layer.getBoundingClientRect();
	return rect.width > 0 && rect.height > 0 ? layer : null;
}

/** Read the nearest text caret supported by this WebView, and reject positions
 * that resolve through an annotation overlay or outside the owned text layer. */
export function caretPointInTextLayer(
	document: Document,
	textLayer: HTMLElement,
	clientX: number,
	clientY: number,
): PencilCaretPoint | null {
	const bounds = textLayer.getBoundingClientRect();
	if (clientX < bounds.left || clientX > bounds.right || clientY < bounds.top || clientY > bounds.bottom) return null;
	const caretDocument = document as Document & {
		caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
		caretRangeFromPoint?: (x: number, y: number) => Range | null;
	};
	let point: PencilCaretPoint | null = null;
	try {
		const caret = caretDocument.caretPositionFromPoint?.(clientX, clientY);
		if (caret) point = { node: caret.offsetNode, offset: caret.offset };
		else {
			const range = caretDocument.caretRangeFromPoint?.(clientX, clientY);
			if (range) point = { node: range.startContainer, offset: range.startOffset };
		}
	} catch {
		return null;
	}
	if (!point || !isWithinTextLayer(point.node, textLayer) || !isValidOffset(point.node, point.offset)) return null;
	return point;
}

export function beginPencilTextSelection(
	document: Document,
	textLayer: HTMLElement,
	pageIndex: number,
	clientX: number,
	clientY: number,
): PencilTextSelection | null {
	const anchor = caretPointInTextLayer(document, textLayer, clientX, clientY);
	if (!anchor) return null;
	const selectionState: PencilTextSelection = {
		textLayer,
		pageIndex,
		startX: clientX,
		startY: clientY,
		anchor,
		appliedAnchor: null,
		moved: false,
		hasRange: false,
	};
	const cache: GestureSelectionCache = {
		wordRangesByText: new WeakMap(),
		anchorWord: null,
		segmenter: createWordSegmenter(),
	};
	cache.anchorWord = wordRangeAtPoint(anchor, cache, clientX, clientY);
	gestureSelectionCaches.set(selectionState, cache);
	return selectionState;
}

/** Extends the browser selection from the original Pencil contact point to a
 * caret on the same rendered text layer. Invalid/off-page points are ignored. */
export function extendPencilTextSelection(
	selectionState: PencilTextSelection,
	clientX: number,
	clientY: number,
): boolean {
	if (!selectionState.textLayer.isConnected) return false;
	const passedThreshold = Math.hypot(clientX - selectionState.startX, clientY - selectionState.startY) >= PENCIL_DRAG_THRESHOLD_PX;
	if (!passedThreshold) {
		selectionState.hasRange = false;
		clearPencilTextSelection(selectionState);
		return false;
	}
	selectionState.moved = true;
	const document = selectionState.textLayer.ownerDocument;
	const focus = caretPointInTextLayer(document, selectionState.textLayer, clientX, clientY);
	if (!focus) {
		selectionState.hasRange = false;
		clearPencilTextSelection(selectionState);
		return false;
	}
	const current = document.defaultView?.getSelection();
	if (!current) {
		selectionState.hasRange = false;
		return false;
	}
	const cache = gestureSelectionCaches.get(selectionState);
	const direction = compareCaretPoints(document, selectionState.anchor, focus);
	const snappedAnchor = direction === null || !cache?.anchorWord
		? selectionState.anchor
		: pointAtWordEdge(selectionState.anchor, cache.anchorWord, direction <= 0 ? 'start' : 'end');
	const focusWord = cache ? wordRangeAtPoint(focus, cache, clientX, clientY) : null;
	const snappedFocus = direction === null || !focusWord
		? focus
		: pointAtWordEdge(focus, focusWord, direction <= 0 ? 'end' : 'start');
	try {
		current.removeAllRanges();
		selectionState.appliedAnchor = snappedAnchor;
		current.collapse(snappedAnchor.node, snappedAnchor.offset);
		current.extend(snappedFocus.node, snappedFocus.offset);
		selectionState.hasRange = !current.isCollapsed;
		return selectionState.hasRange;
	} catch {
		selectionState.hasRange = false;
		return false;
	}
}

/** Clear only the selection created inside this gesture's text layer. */
export function clearPencilTextSelection(selectionState: PencilTextSelection): void {
	const selection = selectionState.textLayer.ownerDocument.defaultView?.getSelection();
	const appliedAnchor = selectionState.appliedAnchor;
	if (!appliedAnchor || !selection || selection.isCollapsed || selection.rangeCount === 0) return;
	if (selection.anchorNode === appliedAnchor.node && selection.anchorOffset === appliedAnchor.offset &&
		selection.focusNode && isWithinTextLayer(selection.focusNode, selectionState.textLayer)) {
		selection.removeAllRanges();
	}
}

function pointAtWordEdge(point: PencilCaretPoint, word: WordBoundary, edge: 'start' | 'end'): PencilCaretPoint {
	return { node: point.node, offset: edge === 'start' ? word.start : word.end };
}

function compareCaretPoints(document: Document, left: PencilCaretPoint, right: PencilCaretPoint): number | null {
	if (left.node === right.node) return left.offset - right.offset;
	try {
		const leftRange = document.createRange();
		leftRange.setStart(left.node, left.offset);
		leftRange.collapse(true);
		const rightRange = document.createRange();
		rightRange.setStart(right.node, right.offset);
		rightRange.collapse(true);
		return leftRange.compareBoundaryPoints(Range.START_TO_START, rightRange);
	} catch {
		return null;
	}
}

function wordRangeAtPoint(
	point: PencilCaretPoint,
	cache: GestureSelectionCache,
	clientX: number,
	clientY: number,
): WordBoundary | null {
	if (point.node.nodeType !== 3 || point.offset < 0) return null;
	const textNode = point.node as Text;
	const text = textNode.data;
	if (text.length > MAX_WORD_TEXT_NODE_LENGTH || point.offset > text.length) return null;
	let wordRanges = cache.wordRangesByText.get(textNode);
	if (!wordRanges) {
		wordRanges = findWordRanges(text, cache.segmenter);
		cache.wordRangesByText.set(textNode, wordRanges);
	}
	const containingWord = wordRanges.find((word) => point.offset >= word.start && point.offset < word.end);
	if (containingWord) return containingWord;
	const endingWord = wordRanges.find((word) => word.end === point.offset);
	return endingWord && contactInsideWord(textNode, endingWord, clientX, clientY) ? endingWord : null;
}

/** A caret at a word's end is ambiguous. Snap it only when the stylus contact
 * still lies over that word's glyphs, rather than over following whitespace. */
function contactInsideWord(textNode: Text, word: WordBoundary, clientX: number, clientY: number): boolean {
	try {
		const range = textNode.ownerDocument.createRange();
		range.setStart(textNode, word.start);
		range.setEnd(textNode, word.end);
		return Array.from(range.getClientRects()).some((rect) =>
			clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom,
		);
	} catch {
		return false;
	}
}

function findWordRanges(text: string, segmenter: WordSegmenter | null): WordBoundary[] {
	if (segmenter) {
		try {
			return Array.from(segmenter.segment(text))
				.filter((segment) => segment.isWordLike === true)
				.map((segment) => ({ start: segment.index, end: segment.index + segment.segment.length }));
		} catch {
			// Some WebViews expose Intl.Segmenter but do not implement word granularity.
		}
	}
	return findUnicodeWordRanges(text);
}

function createWordSegmenter(): WordSegmenter | null {
	const Segmenter = (Intl as typeof Intl & {
		Segmenter?: new (locales?: string | string[], options?: { granularity: 'word' }) => WordSegmenter;
	}).Segmenter;
	if (!Segmenter) return null;
	try {
		return new Segmenter(undefined, { granularity: 'word' });
	} catch {
		return null;
	}
}

/** Fallback for WebViews without word segmentation. Iterating code points keeps
 * supplementary characters and combining marks intact while returning UTF-16
 * offsets for the DOM APIs. */
function findUnicodeWordRanges(text: string): WordBoundary[] {
	const ranges: WordBoundary[] = [];
	let offset = 0;
	let start: number | null = null;
	for (const character of text) {
		const nextOffset = offset + character.length;
		if (UNICODE_WORD_CHARACTER.test(character)) {
			start ??= offset;
		} else if (start !== null) {
			ranges.push({ start, end: offset });
			start = null;
		}
		offset = nextOffset;
	}
	if (start !== null) ranges.push({ start, end: offset });
	return ranges;
}

function isWithinTextLayer(node: Node, textLayer: HTMLElement): boolean {
	if (node === textLayer) return true;
	const element = node.nodeType === 1 ? node as Element : node.parentElement;
	return Boolean(element && textLayer.contains(element) && element.closest('.textLayer') === textLayer);
}

function isValidOffset(node: Node, offset: number): boolean {
	const length = node.nodeType === 3 ? node.textContent?.length ?? 0 : node.childNodes.length;
	return Number.isInteger(offset) && offset >= 0 && offset <= length;
}
