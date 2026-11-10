import type { PencilCaretPoint } from './pencil-caret';

interface TextBoundary {
	start: number;
	end: number;
}

interface WholeWordFocus {
	textLayer: HTMLElement;
	selectionAnchor: PencilCaretPoint;
	selectionFocus: PencilCaretPoint;
	anchorText: Text;
	anchorTextSnapshot: string;
	focusText: Text;
	focusTextSnapshot: string;
	wordStart: number;
	wordEnd: number;
	range: Range;
}

const acceptedWholeWordFocus = new WeakMap<object, WholeWordFocus>();
const WORD_EDGE_INSET_PX = 1;

/** Remember one resolved, non-anchor whole-word focus after a normal update. */
export function rememberPencilWordFocus(
	gesture: object,
	textLayer: HTMLElement,
	originalAnchor: PencilCaretPoint,
	selectionAnchor: PencilCaretPoint,
	selectionFocus: PencilCaretPoint,
	anchorWord: TextBoundary | null,
	focusWord: TextBoundary | null,
): void {
	acceptedWholeWordFocus.delete(gesture);
	if (!focusWord || originalAnchor.node.nodeType !== 3 || selectionFocus.node.nodeType !== 3) return;
	if (selectionFocus.offset !== focusWord.start && selectionFocus.offset !== focusWord.end) return;
	const anchorText = originalAnchor.node as Text;
	const focusText = selectionFocus.node as Text;
	if (anchorWord && anchorText === focusText && focusWord.start < anchorWord.end && anchorWord.start < focusWord.end) return;
	if (!isOwnedText(anchorText, textLayer) || !isOwnedText(focusText, textLayer)) return;
	if (!isValidBoundary(focusWord, focusText.data.length)) return;

	try {
		const range = textLayer.ownerDocument.createRange();
		range.setStart(focusText, focusWord.start);
		range.setEnd(focusText, focusWord.end);
		if (range.startContainer !== focusText || range.startOffset !== focusWord.start ||
			range.endContainer !== focusText || range.endOffset !== focusWord.end) return;
		acceptedWholeWordFocus.set(gesture, {
			textLayer,
			selectionAnchor,
			selectionFocus,
			anchorText,
			anchorTextSnapshot: anchorText.data,
			focusText,
			focusTextSnapshot: focusText.data,
			wordStart: focusWord.start,
			wordEnd: focusWord.end,
			range,
		});
	} catch {
		acceptedWholeWordFocus.delete(gesture);
	}
}

/** Reuse only while the exact accepted selection and fresh word geometry agree. */
export function isPencilWordFocusReusable(
	gesture: object,
	textLayer: HTMLElement,
	selection: Selection | null,
	hasRange: boolean,
	clientX: number,
	clientY: number,
): boolean {
	const cached = acceptedWholeWordFocus.get(gesture);
	if (!cached) return false;
	if (!hasRange || !selection || selection.isCollapsed || selection.rangeCount === 0 ||
		cached.textLayer !== textLayer || !textLayer.isConnected ||
		selection.anchorNode !== cached.selectionAnchor.node || selection.anchorOffset !== cached.selectionAnchor.offset ||
		selection.focusNode !== cached.selectionFocus.node || selection.focusOffset !== cached.selectionFocus.offset ||
		cached.anchorText.data !== cached.anchorTextSnapshot || cached.focusText.data !== cached.focusTextSnapshot ||
		!isOwnedText(cached.anchorText, textLayer) || !isOwnedText(cached.focusText, textLayer) ||
		!isValidBoundary({ start: cached.wordStart, end: cached.wordEnd }, cached.focusText.data.length) ||
		cached.range.startContainer !== cached.focusText || cached.range.startOffset !== cached.wordStart ||
		cached.range.endContainer !== cached.focusText || cached.range.endOffset !== cached.wordEnd) {
		acceptedWholeWordFocus.delete(gesture);
		return false;
	}

	try {
		const view = textLayer.ownerDocument.defaultView;
		if (!view || !Number.isFinite(view.innerWidth) || !Number.isFinite(view.innerHeight) ||
			clientX < 0 || clientX > view.innerWidth || clientY < 0 || clientY > view.innerHeight) {
			acceptedWholeWordFocus.delete(gesture);
			return false;
		}
		const layerBounds = textLayer.getBoundingClientRect();
		if (!isFiniteRect(layerBounds) || clientX <= layerBounds.left || clientX >= layerBounds.right ||
			clientY <= layerBounds.top || clientY >= layerBounds.bottom) {
			acceptedWholeWordFocus.delete(gesture);
			return false;
		}
		const wordRects = Array.from(cached.range.getClientRects());
		const insideWord = wordRects.some((rect) => isFiniteRect(rect) && rect.right > rect.left && rect.bottom > rect.top &&
			clientX > rect.left + WORD_EDGE_INSET_PX && clientX < rect.right - WORD_EDGE_INSET_PX &&
			clientY > rect.top + WORD_EDGE_INSET_PX && clientY < rect.bottom - WORD_EDGE_INSET_PX);
		if (!insideWord || !hasAxisAlignedTransformPath(cached.focusText, textLayer, view)) {
			acceptedWholeWordFocus.delete(gesture);
			return false;
		}
		return true;
	} catch {
		// A stale or detached native Range falls back to normal caret resolution.
	}
	acceptedWholeWordFocus.delete(gesture);
	return false;
}

export function clearPencilWordFocus(gesture: object): void {
	acceptedWholeWordFocus.delete(gesture);
}

function isOwnedText(node: Text, textLayer: HTMLElement): boolean {
	const parent = node.parentElement;
	return node.isConnected && node.ownerDocument === textLayer.ownerDocument && textLayer.contains(node) &&
		Boolean(parent && parent.closest('.textLayer') === textLayer &&
			!parent.closest('.endOfContent') && !parent.closest('[role="img"]'));
}

function isValidBoundary(boundary: TextBoundary, textLength: number): boolean {
	return Number.isInteger(boundary.start) && Number.isInteger(boundary.end) &&
		boundary.start >= 0 && boundary.end > boundary.start && boundary.end <= textLength;
}

function isFiniteRect(rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>): boolean {
	return Number.isFinite(rect.left) && Number.isFinite(rect.right) &&
		Number.isFinite(rect.top) && Number.isFinite(rect.bottom);
}

function hasAxisAlignedTransformPath(text: Text, textLayer: HTMLElement, view: Window): boolean {
	if (typeof view.getComputedStyle !== 'function') return false;
	let element = text.parentElement;
	let foundTextLayer = false;
	while (element) {
		const style = view.getComputedStyle(element) as CSSStyleDeclaration & { rotate?: string };
		if (!isAxisAlignedTransform(style.transform) || !isAxisAlignedRotate(style.rotate) ||
			(style.perspective && style.perspective !== 'none')) return false;
		if (element === textLayer) foundTextLayer = true;
		element = element.parentElement;
	}
	return foundTextLayer;
}

function isAxisAlignedRotate(rotate: string | undefined): boolean {
	if (!rotate || rotate === 'none') return true;
	const angle = /^(-?\d+(?:\.\d+)?)deg$/.exec(rotate);
	if (!angle) return false;
	const degrees = Number(angle[1]);
	return Number.isFinite(degrees) && Math.abs(degrees / 180 - Math.round(degrees / 180)) < 0.001;
}

function isAxisAlignedTransform(transform: string): boolean {
	if (!transform || transform === 'none') return true;
	const matrix = /^matrix\(([^)]+)\)$/.exec(transform);
	if (matrix) {
		const values = (matrix[1] ?? '').split(',').map(Number);
		if (values.length !== 6 || !values.every(Number.isFinite)) return false;
		return Math.abs(matrixValue(values, 1)) < 0.001 && Math.abs(matrixValue(values, 2)) < 0.001 &&
			Math.abs(matrixValue(values, 0)) > 0.001 && Math.abs(matrixValue(values, 3)) > 0.001;
	}
	const matrix3d = /^matrix3d\(([^)]+)\)$/.exec(transform);
	if (!matrix3d) return false;
	const values = (matrix3d[1] ?? '').split(',').map(Number);
	if (values.length !== 16 || !values.every(Number.isFinite)) return false;
	const offAxis = [1, 2, 3, 4, 6, 7, 8, 9, 11, 14];
	return offAxis.every((index) => Math.abs(matrixValue(values, index)) < 0.001) &&
		Math.abs(matrixValue(values, 0)) > 0.001 && Math.abs(matrixValue(values, 5)) > 0.001 &&
		Math.abs(matrixValue(values, 10) - 1) < 0.001 && Math.abs(matrixValue(values, 15) - 1) < 0.001;
}

function matrixValue(values: number[], index: number): number {
	return values[index] ?? Number.NaN;
}
