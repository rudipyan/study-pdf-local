import {
	caretPointInTextLayer,
	firstPencilTextContact,
	findRenderedTextLayer,
	isWithinTextLayer,
	pencilContactInTextLayer,
	pencilFocusPointInTextLayer,
	pencilGlyphPointInTextLayer,
} from './pencil-caret';
import type { PencilCaretPoint, PencilContact } from './pencil-caret';
import {
	clearPencilWordFocus,
	isPencilWordFocusReusable,
	rememberPencilWordFocus,
} from './pencil-word-focus';

export { caretPointInTextLayer, findRenderedTextLayer };
export type { PencilCaretPoint };

/** State for one Pencil drag. DOM selection is only changed after the drag
 * crosses the movement threshold, so a tap remains an annotation tap. */
export interface PencilTextSelection {
	textLayer: HTMLElement;
	pageIndex: number;
	startX: number;
	startY: number;
	anchor: PencilCaretPoint | null;
	/** Most recent blank contact until the anchor is found, then its position. */
	anchorContact: PencilContact;
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
	wordRangesByText: WeakMap<Text, { text: string; ranges: WordBoundary[] }>;
	anchorWord: WordBoundary | null;
	anchorText: string | null;
	segmenter: WordSegmenter | null;
}

const gestureSelectionCaches = new WeakMap<PencilTextSelection, GestureSelectionCache>();
const MAX_WORD_TEXT_NODE_LENGTH = 512;
const UNICODE_WORD_CHARACTER = /[\p{L}\p{M}\p{N}\p{Pc}]/u;

export const PENCIL_DRAG_THRESHOLD_PX = 4;

export function beginPencilTextSelection(
	document: Document,
	textLayer: HTMLElement,
	pageIndex: number,
	clientX: number,
	clientY: number,
): PencilTextSelection | null {
	const contact = { x: clientX, y: clientY };
	if (!pencilContactInTextLayer(textLayer, contact)) return null;
	const selectionState: PencilTextSelection = {
		textLayer,
		pageIndex,
		startX: clientX,
		startY: clientY,
		anchor: null,
		anchorContact: contact,
		appliedAnchor: null,
		moved: false,
		hasRange: false,
	};
	const anchor = pencilGlyphPointInTextLayer(document, textLayer, contact);
	if (anchor) setPencilAnchor(selectionState, anchor, contact);
	return selectionState;
}

function setPencilAnchor(state: PencilTextSelection, anchor: PencilCaretPoint, contact: PencilContact) {
	state.anchor = anchor;
	state.anchorContact = contact;
	const cache: GestureSelectionCache = {
		wordRangesByText: new WeakMap(),
		anchorWord: null,
		anchorText: anchor.node.nodeType === 3 ? (anchor.node as Text).data : null,
		segmenter: createWordSegmenter(),
	};
	cache.anchorWord = wordRangeAtPoint(anchor, cache, contact.x, contact.y);
	gestureSelectionCaches.set(state, cache);
}

export function hasPencilDragDistance(state: PencilTextSelection, clientX: number, clientY: number): boolean {
	return Math.hypot(clientX - state.startX, clientY - state.startY) >= PENCIL_DRAG_THRESHOLD_PX;
}

/** Extends the browser selection from the original Pencil contact point to a
 * caret on the same rendered text layer. Returns true when its preview geometry
 * or validity changed, including once when an owned range is cleared. The
 * state's `hasRange` remains the independent validity flag. */
export function extendPencilTextSelection(
	selectionState: PencilTextSelection,
	clientX: number,
	clientY: number,
): boolean {
	const hadRange = selectionState.hasRange;
	if (!selectionState.textLayer.isConnected) {
		selectionState.hasRange = false;
		clearPencilWordFocus(selectionState);
		clearPencilTextSelection(selectionState);
		return hadRange;
	}
	if (!hasPencilDragDistance(selectionState, clientX, clientY)) {
		selectionState.hasRange = false;
		clearPencilWordFocus(selectionState);
		clearPencilTextSelection(selectionState);
		return hadRange;
	}
	selectionState.moved = true;
	const document = selectionState.textLayer.ownerDocument;
	const current = document.defaultView?.getSelection();
	if (!current) {
		selectionState.hasRange = false;
		clearPencilWordFocus(selectionState);
		return hadRange;
	}
	if (hadRange && isPencilWordFocusReusable(
		selectionState,
		selectionState.textLayer,
		current,
		selectionState.hasRange,
		clientX,
		clientY,
	)) return false;
	clearPencilWordFocus(selectionState);
	let anchor = selectionState.anchor;
	let focus: PencilCaretPoint | null;
	if (anchor) {
		focus = pencilFocusPointInTextLayer(document, selectionState.textLayer, clientX, clientY, selectionState.anchorContact.y);
	} else {
		const contact = { x: clientX, y: clientY };
		focus = pencilGlyphPointInTextLayer(document, selectionState.textLayer, contact);
		if (focus) {
			const entry = firstPencilTextContact(document, selectionState.textLayer, selectionState.anchorContact, contact, focus);
			anchor = entry.point;
			setPencilAnchor(selectionState, anchor, entry.contact);
		} else {
			selectionState.anchorContact = contact;
		}
	}
	if (!anchor || !focus) {
		selectionState.hasRange = false;
		clearPencilTextSelection(selectionState);
		return hadRange;
	}
	const cache = gestureSelectionCaches.get(selectionState);
	if (cache) {
		const anchorText = anchor.node.nodeType === 3
			? (anchor.node as Text).data
			: null;
		if (cache.anchorText !== anchorText) {
			cache.anchorText = anchorText;
			cache.anchorWord = anchorText === null
				? null
				: wordRangeAtPoint(anchor, cache, selectionState.anchorContact.x, selectionState.anchorContact.y);
		}
	}
	const direction = compareCaretPoints(document, anchor, focus);
	const snappedAnchor = direction === null || !cache?.anchorWord
		? anchor
		: pointAtWordEdge(anchor, cache.anchorWord, direction <= 0 ? 'start' : 'end');
	const focusWord = cache ? wordRangeAtPoint(focus, cache, clientX, clientY) : null;
	const snappedFocus = direction === null || !focusWord
		? focus
		: pointAtWordEdge(focus, focusWord, direction <= 0 ? 'end' : 'start');
	if (current.anchorNode === snappedAnchor.node && current.anchorOffset === snappedAnchor.offset &&
		current.focusNode === snappedFocus.node && current.focusOffset === snappedFocus.offset) {
		selectionState.appliedAnchor = snappedAnchor;
		selectionState.hasRange = !current.isCollapsed && current.rangeCount > 0;
		if (selectionState.hasRange) {
			rememberPencilWordFocus(selectionState, selectionState.textLayer, anchor,
				snappedAnchor, snappedFocus, cache?.anchorWord ?? null, focusWord);
		} else clearPencilWordFocus(selectionState);
		return selectionState.hasRange !== hadRange;
	}
	try {
		if (current.anchorNode === snappedAnchor.node && current.anchorOffset === snappedAnchor.offset) {
			current.extend(snappedFocus.node, snappedFocus.offset);
		} else if (typeof current.setBaseAndExtent === 'function') {
			current.setBaseAndExtent(snappedAnchor.node, snappedAnchor.offset, snappedFocus.node, snappedFocus.offset);
		} else {
			current.removeAllRanges();
			current.collapse(snappedAnchor.node, snappedAnchor.offset);
			current.extend(snappedFocus.node, snappedFocus.offset);
		}
		const selectionMatchesPoints = current.anchorNode === snappedAnchor.node && current.anchorOffset === snappedAnchor.offset &&
			current.focusNode === snappedFocus.node && current.focusOffset === snappedFocus.offset;
		selectionState.hasRange = selectionMatchesPoints && !current.isCollapsed && current.rangeCount > 0;
		if (!selectionMatchesPoints) {
			clearPencilWordFocus(selectionState);
			return hadRange;
		}
		selectionState.appliedAnchor = snappedAnchor;
		if (selectionState.hasRange) {
			rememberPencilWordFocus(selectionState, selectionState.textLayer, anchor,
				snappedAnchor, snappedFocus, cache?.anchorWord ?? null, focusWord);
		} else clearPencilWordFocus(selectionState);
		return true;
	} catch {
		selectionState.hasRange = false;
		clearPencilWordFocus(selectionState);
		return hadRange;
	}
}

/** Clear only the selection created inside this gesture's text layer. */
export function clearPencilTextSelection(selectionState: PencilTextSelection): void {
	clearPencilWordFocus(selectionState);
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
	let cachedWords = cache.wordRangesByText.get(textNode);
	if (!cachedWords || cachedWords.text !== text) {
		cachedWords = { text, ranges: findWordRanges(text, cache.segmenter) };
		cache.wordRangesByText.set(textNode, cachedWords);
	}
	const wordRanges = cachedWords.ranges;
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
