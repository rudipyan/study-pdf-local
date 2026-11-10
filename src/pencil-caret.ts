/** A caret position inside a rendered PDF.js text layer. */
export interface PencilCaretPoint {
	node: Node;
	offset: number;
}

export interface PencilContact {
	x: number;
	y: number;
}

const CARET_RANGE_RADIUS = 8;
const CARET_CONTACT_SLOP_MIN_PX = 2;
const CARET_CONTACT_SLOP_MAX_PX = 12;
const CARET_VERTICAL_PROBES_PX = [4, 8, 12] as const;
const ENTRY_PROBE_STEPS = 6;
const ENTRY_REFINEMENT_STEPS = 4;
const INTERACTIVE_PAGE_TARGET = 'a, button, input, select, textarea, [role="link"], [role="button"], [contenteditable]:not([contenteditable="false"]), .annotationLayer section, .annotationEditorLayer, .study-pdf-note-marker, .study-pdf-link-return';

interface PencilCaretResolution {
	point: PencilCaretPoint;
	contactRect: DOMRect;
	distance: number;
}

/** A press on the page background may use its text layer. Interactive PDF
 * annotations and controls keep their own event handling. */
export function findRenderedTextLayer(
	target: EventTarget | null,
	pdfContainer: HTMLElement,
	pageElement: HTMLElement | null,
): HTMLElement | null {
	if (!target || typeof target !== 'object') return null;
	const nodeType = (target as { nodeType?: unknown }).nodeType;
	if (typeof nodeType !== 'number' || nodeType < 1 || nodeType > 12) return null;
	const node = target as Node;
	const element = node.nodeType === 1 ? node as Element : node.parentElement;
	const page = pageElement?.closest('div.page[data-page-number]');
	if (!pageElement?.matches('.textLayer') || !pageElement.isConnected || !pdfContainer.contains(pageElement) ||
		!element || !page || element.closest('div.page[data-page-number]') !== page ||
		element.closest(INTERACTIVE_PAGE_TARGET)) return null;
	return pageElement;
}

export function pencilContactInTextLayer(textLayer: HTMLElement, { x, y }: PencilContact): boolean {
	return textLayer.isConnected && pointInBounds(textLayer.getBoundingClientRect(), x, y);
}

/** Starting a selection requires contact with visible text. A WebKit caret
 * can otherwise point at the nearest line or across spaces in a wide span. */
export function pencilGlyphPointInTextLayer(
	document: Document,
	textLayer: HTMLElement,
	contact: PencilContact,
): PencilCaretPoint | null {
	return pencilContactInTextLayer(textLayer, contact) ? readGlyphPoint(document, textLayer, contact) : null;
}

/** A frame can arrive after the tip has passed the first word. Sample the
 * last blank-to-text segment once, refining the earliest confirmed hit. */
export function firstPencilTextContact(
	document: Document,
	textLayer: HTMLElement,
	from: PencilContact,
	to: PencilContact,
	focus: PencilCaretPoint,
): { contact: PencilContact; point: PencilCaretPoint } {
	const bounds = textLayer.getBoundingClientRect();
	const distance = Math.hypot(to.x - from.x, to.y - from.y);
	let blank = 0;
	let hit = 1;
	let entry = { contact: to, point: focus };
	const probe = (fraction: number) => {
		const contact = { x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction };
		const point = pointInBounds(bounds, contact.x, contact.y) ? readGlyphPoint(document, textLayer, contact) : null;
		return point ? { contact, point } : null;
	};
	for (let step = 1; step < ENTRY_PROBE_STEPS; step++) {
		const fraction = step / ENTRY_PROBE_STEPS;
		const result = probe(fraction);
		if (result) {
			entry = result;
			hit = fraction;
			break;
		}
		blank = fraction;
	}
	for (let step = 0; step < ENTRY_REFINEMENT_STEPS && distance * (hit - blank) > 1; step++) {
		const middle = (blank + hit) / 2;
		const result = probe(middle);
		if (result) {
			entry = result;
			hit = middle;
		} else {
			blank = middle;
		}
	}
	return entry;
}

function pointInBounds(bounds: DOMRect, x: number, y: number): boolean {
	return bounds.width > 0 && bounds.height > 0 && x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
}

function readGlyphPoint(document: Document, textLayer: HTMLElement, { x, y }: PencilContact): PencilCaretPoint | null {
	return resolveTextCaretCandidate(document, textLayer, readCaretPoint(document, x, y), x, y, true)?.point ?? null;
}

/** Resolve only a visible Text caret near the Pencil's actual contact point. */
export function caretPointInTextLayer(
	document: Document,
	textLayer: HTMLElement,
	clientX: number,
	clientY: number,
): PencilCaretPoint | null {
	return resolveCaretPointInTextLayer(document, textLayer, clientX, clientY)?.point ?? null;
}

/** Resolve an extending focus, probing nearby rows only when WebKit's direct
 * caret result is not valid Text at the original Pencil contact point. */
export function pencilFocusPointInTextLayer(
	document: Document,
	textLayer: HTMLElement,
	clientX: number,
	clientY: number,
	startY: number,
): PencilCaretPoint | null {
	return resolveCaretPointInTextLayer(document, textLayer, clientX, clientY, { startY })?.point ?? null;
}

function resolveCaretPointInTextLayer(
	document: Document,
	textLayer: HTMLElement,
	clientX: number,
	clientY: number,
	verticalProbe?: { startY: number },
): PencilCaretResolution | null {
	const bounds = textLayer.getBoundingClientRect();
	if (!textLayer.isConnected || clientX < bounds.left || clientX > bounds.right || clientY < bounds.top || clientY > bounds.bottom) return null;
	const point = readCaretPoint(document, clientX, clientY);
	const geometryByOffset = new WeakMap<Node, Map<number, PencilCaretResolution | null>>();
	const resolveCandidate = (candidate: PencilCaretPoint | null): PencilCaretResolution | null => {
		if (!candidate) return null;
		let byOffset = geometryByOffset.get(candidate.node);
		if (!byOffset) {
			byOffset = new Map();
			geometryByOffset.set(candidate.node, byOffset);
		}
		if (byOffset.has(candidate.offset)) return byOffset.get(candidate.offset) ?? null;
		const resolution = resolveTextCaretCandidate(document, textLayer, candidate, clientX, clientY);
		byOffset.set(candidate.offset, resolution);
		return resolution;
	};
	const directResolution = resolveCandidate(point);
	if (directResolution) return directResolution;
	if (!verticalProbe || !isSafeVerticalProbeSource(point, textLayer)) return null;

	const direction = Math.sign(clientY - verticalProbe.startY);
	const candidates: PencilCaretResolution[] = [];
	for (const distance of CARET_VERTICAL_PROBES_PX) {
		for (const sign of [-1, 1]) {
			const probeY = clientY + sign * distance;
			if (probeY < bounds.top || probeY > bounds.bottom) continue;
			const candidate = readCaretPoint(document, clientX, probeY);
			if (!candidate || candidate.node === textLayer) continue;
			const resolution = resolveCandidate(candidate);
			if (resolution && !candidates.includes(resolution)) candidates.push(resolution);
		}
	}
	if (candidates.length === 0) return null;
	candidates.sort((left, right) => {
		const distanceDifference = left.distance - right.distance;
		if (Math.abs(distanceDifference) > 0.01) return distanceDifference;
		if (direction === 0) return 0;
		return direction > 0
			? right.contactRect.top - left.contactRect.top
			: left.contactRect.top - right.contactRect.top;
	});
	return candidates[0] ?? null;
}

function isSafeVerticalProbeSource(point: PencilCaretPoint | null, textLayer: HTMLElement): boolean {
	if (!point || !point.node.isConnected || !isWithinTextLayer(point.node, textLayer)) return false;
	if (point.node.nodeType === 3) {
		if (!isValidOffset(point.node, point.offset)) return false;
		const textNode = point.node as Text;
		if (!textNode.data.trim()) return false;
		const parent = textNode.parentElement;
		return Boolean(parent && !parent.closest('.endOfContent') && !parent.closest('[role="img"]'));
	}
	if (point.node.nodeType !== 1 || !isValidOffset(point.node, point.offset)) return false;
	const element = point.node as Element;
	// PDF.js can return its active endOfContent element in a line gap. It may
	// start nearby Text probes, but it is never accepted as the focus itself.
	return !element.closest('[role="img"]');
}

function readCaretPoint(document: Document, clientX: number, clientY: number): PencilCaretPoint | null {
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
	return point;
}

function resolveTextCaretCandidate(
	document: Document,
	textLayer: HTMLElement,
	point: PencilCaretPoint | null,
	clientX: number,
	clientY: number,
	glyphOnly = false,
): PencilCaretResolution | null {
	if (!point || !isValidTextCaretPoint(point, textLayer)) return null;
	const textNode = point.node as Text;
	const text = textNode.data;

	const radius = glyphOnly ? 1 : CARET_RANGE_RADIUS;
	let rangeStart = Math.max(0, point.offset - radius);
	let rangeEnd = Math.min(text.length, point.offset + radius);
	if (rangeStart > 0 && isLowSurrogate(text.charCodeAt(rangeStart)) && isHighSurrogate(text.charCodeAt(rangeStart - 1))) rangeStart--;
	if (rangeEnd < text.length && isLowSurrogate(text.charCodeAt(rangeEnd)) && isHighSurrogate(text.charCodeAt(rangeEnd - 1))) rangeEnd++;
	if (rangeStart === rangeEnd) {
		if (rangeStart > 0) rangeStart--;
		else if (rangeEnd < text.length) rangeEnd++;
	}
	if (glyphOnly) {
		while (rangeStart < rangeEnd && !text[rangeStart]?.trim()) rangeStart++;
		while (rangeEnd > rangeStart && !text[rangeEnd - 1]?.trim()) rangeEnd--;
	}
	if (!text.slice(rangeStart, rangeEnd).trim()) return null;

	let rects: DOMRect[];
	try {
		const range = document.createRange();
		range.setStart(textNode, rangeStart);
		range.setEnd(textNode, rangeEnd);
		rects = Array.from(range.getClientRects());
	} catch {
		return null;
	}
	let closest: PencilCaretResolution | null = null;
	for (const rect of rects) {
		if (!Number.isFinite(rect.left) || !Number.isFinite(rect.right) ||
			!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom) || rect.height <= 0) continue;
		const horizontalGap = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
		const verticalGap = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
		if (glyphOnly && (horizontalGap !== 0 || verticalGap !== 0)) continue;
		const contactSlop = Math.min(CARET_CONTACT_SLOP_MAX_PX,
			Math.max(CARET_CONTACT_SLOP_MIN_PX, rect.height * 0.5));
		if (horizontalGap > contactSlop || verticalGap > contactSlop) continue;
		const distance = Math.hypot(horizontalGap, verticalGap);
		if (!closest || distance < closest.distance) closest = { point, contactRect: rect, distance };
	}
	return closest;
}

function isValidTextCaretPoint(point: PencilCaretPoint, textLayer: HTMLElement): boolean {
	if (point.node.nodeType !== 3 || !point.node.isConnected || !isWithinTextLayer(point.node, textLayer) ||
		!isValidOffset(point.node, point.offset)) return false;
	const textNode = point.node as Text;
	const parent = textNode.parentElement;
	return Boolean(textNode.data.trim() && parent &&
		!parent.closest('.endOfContent') && !parent.closest('[role="img"]'));
}

function isHighSurrogate(codeUnit: number): boolean {
	return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
	return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

export function isWithinTextLayer(node: Node, textLayer: HTMLElement): boolean {
	if (node === textLayer) return true;
	const element = node.nodeType === 1 ? node as Element : node.parentElement;
	return Boolean(element && textLayer.contains(element) && element.closest('.textLayer') === textLayer);
}

function isValidOffset(node: Node, offset: number): boolean {
	const length = node.nodeType === 3 ? node.textContent?.length ?? 0 : node.childNodes.length;
	return Number.isInteger(offset) && offset >= 0 && offset <= length;
}
