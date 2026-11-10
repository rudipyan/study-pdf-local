import { setIcon } from 'obsidian';
import type { NoteMarkerPosition } from '../note-marker-positions';
import { bindNoteMarkerDragging } from './note-marker-drag';
import { bindNoteHoverPreview } from './note-hover-preview';

export interface NoteMarkerAnnotation {
	subtype?: string;
	color?: ArrayLike<number> | null;
	rect?: number[];
	contentsObj?: { str?: string } | null;
}

export type ReadNoteMarkerAnnotation = (id: string) => NoteMarkerAnnotation | null;
export type OpenNoteMarker = (id: string, position: { x: number; y: number }) => void;

interface NoteMarkerEntry {
	color: string | null;
	ink: string | null;
	id: string;
	key: string;
	position?: NoteMarkerPosition;
	left?: string;
	anchorX?: number;
	top: string;
	note: string;
}

interface NoteMarkerRecord {
	key: string;
	button: HTMLButtonElement;
	disposeDrag(): void;
	top: string;
	note: string;
	refreshHover(): void;
	disposeHover(): void;
}

interface NoteMarkerLayerState {
	signature: string;
	markers: Map<string, NoteMarkerRecord>;
	onOpen: OpenNoteMarker;
	positions?: NoteMarkerPositionAccess;
}

const layerStates = new WeakMap<HTMLElement, NoteMarkerLayerState>();
const ANNOTATION_SELECTOR = '.highlightAnnotation[data-annotation-id]';
const MARKER_CLASS = 'clickable-icon study-pdf-note-marker';
const MARKER_HIT_AREA_PX = 44;
const PDF_REFERENCE_ID = /^\d+R\d*$/;

export interface NoteMarkerPositionAccess {
	get(key: string): NoteMarkerPosition | undefined;
	save(key: string, position: NoteMarkerPosition): void;
}

function stopMarkerEvent(event: Event): void {
	event.stopPropagation();
}

function adjacentMarker(section: HTMLElement, viewportWidth?: number): { left?: string; anchorX?: number } {
	if (!Number.isFinite(viewportWidth) || viewportWidth! < MARKER_HIT_AREA_PX) return {};
	const pixels = (length: string): number => {
		const match = /^(-?\d+(?:\.\d+)?)(px|%)$/.exec(length.trim());
		return match ? Number(match[1]) * (match[2] === '%' ? viewportWidth! / 100 : 1) : Number.NaN;
	};
	const left = pixels(section.style.left || '');
	const width = pixels(section.style.width || '');
	if (!Number.isFinite(left) || !Number.isFinite(width) || width <= 0) return {};
	// Keep the entire 44px touch target outside the highlight with a 4px gap.
	const offset = MARKER_HIT_AREA_PX / 2 + 4;
	const right = left + width + offset;
	const preferred = right <= viewportWidth! - MARKER_HIT_AREA_PX / 2 ? right : left - offset;
	const x = Math.max(MARKER_HIT_AREA_PX / 2, Math.min(viewportWidth! - MARKER_HIT_AREA_PX / 2, preferred));
	return { left: `${Math.round(x * 100) / 100}px`, anchorX: x };
}

function spaceAdjacentMarkers(entries: NoteMarkerEntry[], viewportHeight?: number): void {
	// Separate touch targets only when their horizontal lanes overlap. Notes in
	// different article columns should stay beside their own passages.
	const ordered = entries.filter((entry) => !entry.position).sort((a, b) => (a.anchorX ?? Infinity) - (b.anchorX ?? Infinity));
	let group: NoteMarkerEntry[] = [];
	let previousX = Number.NEGATIVE_INFINITY;
	for (const entry of ordered) {
		const x = entry.anchorX ?? Infinity;
		if (group.length && (Number.isFinite(x) !== Number.isFinite(previousX) ||
			Number.isFinite(x) && x - previousX >= MARKER_HIT_AREA_PX)) {
			spaceNoteMarkers(group, viewportHeight);
			group = [];
		}
		group.push(entry);
		previousX = x;
	}
	spaceNoteMarkers(group, viewportHeight);
}

function spaceNoteMarkers(entries: NoteMarkerEntry[], viewportHeight?: number): void {
	const positioned = entries.flatMap((entry, order) => {
		const match = /^(-?\d+(?:\.\d+)?)(px|%)$/.exec(entry.top.trim());
		if (!match) return [];
		const value = Number(match[1]);
		const y = match[2] === '%' ? (Number.isFinite(viewportHeight) ? value * viewportHeight! / 100 : Number.NaN) : value;
		return Number.isFinite(y) ? [{ entry, y, order }] : [];
	}).sort((a, b) => a.y - b.y || a.order - b.order);
	if (positioned.length === 0) return;

	const minCenter = MARKER_HIT_AREA_PX / 2;
	const maxCenter = Number.isFinite(viewportHeight) && viewportHeight! >= MARKER_HIT_AREA_PX
		? viewportHeight! - minCenter
		: Number.POSITIVE_INFINITY;
	const fittedValue = (sum: number, count: number, start: number, end: number): number => {
		const mean = sum / count;
		const lower = minCenter - start * MARKER_HIT_AREA_PX;
		const upper = maxCenter - (end - 1) * MARKER_HIT_AREA_PX;
		if (lower <= upper) return Math.max(lower, Math.min(upper, mean));
		// If more notes occupy one page than can fit at the target spacing, keep
		// the cluster centered in the layer and visible as far as the page allows.
		return (lower + upper) / 2;
	};

	// Separating the 44px touch targets with bounded isotonic spacing keeps
	// nearby buttons reachable while moving a colliding pair by half the gap.
	const blocks: { start: number; end: number; sum: number; count: number; value: number }[] = [];
	for (let index = 0; index < positioned.length; index++) {
		const sum = positioned[index]!.y - index * MARKER_HIT_AREA_PX;
		blocks.push({ start: index, end: index + 1, sum, count: 1, value: fittedValue(sum, 1, index, index + 1) });
		while (blocks.length > 1) {
			const right = blocks[blocks.length - 1]!;
			const left = blocks[blocks.length - 2]!;
			if (left.value <= right.value) break;
			const merged = {
				start: left.start,
				end: right.end,
				sum: left.sum + right.sum,
				count: left.count + right.count,
			};
			blocks.splice(-2, 2, { ...merged, value: fittedValue(merged.sum, merged.count, merged.start, merged.end) });
		}
	}
	const spaced = new Array<number>(positioned.length);
	for (const block of blocks) {
		for (let index = block.start; index < block.end; index++) {
			spaced[index] = block.value + index * MARKER_HIT_AREA_PX;
		}
	}

	for (let index = 0; index < positioned.length; index++) {
		positioned[index]!.entry.top = `${Math.round(spaced[index]! * 100) / 100}px`;
	}
}

/** PDF.js exposes RGB bytes (including typed arrays), not the palette index. */
function markerColors(color: ArrayLike<number> | null | undefined): { color: string | null; ink: string | null } {
	if (!color || color.length !== 3 || ![0, 1, 2].every((i) =>
		typeof color[i] === 'number' && Number.isFinite(color[i]) && color[i] >= 0 && color[i] <= 255,
	)) return { color: null, ink: null };
	const channels = [color[0]!, color[1]!, color[2]!].map(Math.round);
	const linear = channels.map((value) => { const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; });
	const luminance = 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
	return { color: `rgb(${channels.join(', ')})`, ink: luminance > 0.179 ? '#000000' : '#ffffff' };
}

function paintMarkerColor(button: HTMLButtonElement, entry: NoteMarkerEntry): void {
	if (entry.color && entry.ink) {
		button.style.setProperty('--study-pdf-note-color', entry.color);
		button.style.setProperty('--study-pdf-note-ink', entry.ink);
	} else {
		button.style.removeProperty('--study-pdf-note-color');
		button.style.removeProperty('--study-pdf-note-ink');
	}
}

function positionMarker(button: HTMLButtonElement, entry: NoteMarkerEntry): void {
	button.style.top = entry.position ? `clamp(22px, ${entry.position.y * 100}%, calc(100% - 22px))` : entry.top;
	button.style.left = entry.position ? `clamp(22px, ${entry.position.x * 100}%, calc(100% - 22px))` : entry.left ?? '';
	button.style.right = entry.position || entry.left ? 'auto' : '';
	button.style.transform = entry.position || entry.left ? 'translate(-50%, -50%)' : '';
}

function createMarker(layer: HTMLElement, entry: NoteMarkerEntry): NoteMarkerRecord {
	const button = layer.ownerDocument.createElement('button');
	button.type = 'button';
	button.className = MARKER_CLASS;
	button.dataset.studyPdfNoteMarker = 'true';
	button.dataset.annotationId = entry.id;
	positionMarker(button, entry);
	paintMarkerColor(button, entry);
	button.setAttribute('aria-label', 'Read highlight note. Hold and drag to move the comment icon.');
	setIcon(button, 'message-square');
	const dragging = bindNoteMarkerDragging(button, layer, (position) => {
		layerStates.get(layer)?.positions?.save(entry.key, position);
	});
	let hover: ReturnType<typeof bindNoteHoverPreview> | null = null;
	const marker: NoteMarkerRecord = {
		key: entry.key,
		button,
		top: entry.top,
		note: entry.note,
		disposeDrag: () => dragging.dispose(),
		refreshHover: () => hover?.refresh(),
		disposeHover: () => hover?.dispose(),
	};
	hover = bindNoteHoverPreview(button, layer, () => marker.note);
	for (const type of ['mousedown', 'mousemove', 'mouseup', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'keydown', 'keyup']) {
		button.addEventListener(type, stopMarkerEvent);
	}
	button.addEventListener('click', (event) => {
		stopMarkerEvent(event);
		hover?.cancel();
		if (dragging.consumeClick(event)) return;
		const rect = button.getBoundingClientRect();
		layerStates.get(layer)?.onOpen(entry.id, { x: rect.left, y: rect.bottom });
	});
	return marker;
}

/** Add or refresh note buttons for one already-rendered PDF.js annotation layer. */
export function updateNoteMarkers(
	layer: HTMLElement,
	readAnnotation: ReadNoteMarkerAnnotation,
	onOpen: OpenNoteMarker,
	viewportHeight?: number,
	positions?: NoteMarkerPositionAccess,
	viewportWidth?: number,
): void {
	const entries: NoteMarkerEntry[] = [];
	const seen = new Set<string>();
	for (const section of layer.querySelectorAll<HTMLElement>(ANNOTATION_SELECTOR)) {
		const id = section.getAttribute('data-annotation-id');
		if (!id || !PDF_REFERENCE_ID.test(id) || seen.has(id)) continue;
		seen.add(id);

		const annotation = readAnnotation(id);
		if (annotation?.subtype !== 'Highlight') continue;
		const note = annotation?.contentsObj?.str;
		if (typeof note !== 'string' || note.trim().length === 0) continue;
		const geometry = annotation.rect?.length === 4 && annotation.rect.every(Number.isFinite)
			? annotation.rect : [section.style.left, section.style.top, section.style.width, section.style.height];
		const key = JSON.stringify([id, geometry]);
		entries.push({ id, key, position: positions?.get(key), top: section.style.top || '0px', note,
			...adjacentMarker(section, viewportWidth), ...markerColors(annotation.color) });
	}

	spaceAdjacentMarkers(entries, viewportHeight);
	const signature = JSON.stringify(entries.map(({ id, key, top, left, note, position, color }) => [id, key, top, left, note, position, color]));
	let state = layerStates.get(layer);
	if (state) { state.onOpen = onOpen; state.positions = positions; }
	let allMarkersAttached = true;
	if (state) {
		for (const marker of state.markers.values()) {
			if (marker.button.parentElement !== layer) {
				allMarkersAttached = false;
				break;
			}
		}
	}
	if (state?.signature === signature && allMarkersAttached) {
		return;
	}
	if (state && !allMarkersAttached) {
		for (const marker of state.markers.values()) marker.refreshHover();
	}
	if (!state) {
		state = { signature: '', markers: new Map(), onOpen, positions };
		layerStates.set(layer, state);
	}

	const desiredIds = new Set(entries.map(({ id }) => id));
	for (const [id, marker] of state.markers) {
		if (desiredIds.has(id)) continue;
		marker.disposeDrag();
		marker.disposeHover();
		marker.button.remove();
		state.markers.delete(id);
	}

	for (const entry of entries) {
		let marker = state.markers.get(entry.id);
		if (marker && marker.key !== entry.key) {
			marker.disposeDrag();
			marker.disposeHover();
			marker.button.remove();
			marker = undefined;
		}
		if (!marker) {
			marker = createMarker(layer, entry);
			layer.appendChild(marker.button);
			state.markers.set(entry.id, marker);
		} else {
			positionMarker(marker.button, entry);
			paintMarkerColor(marker.button, entry);
			if (marker.top !== entry.top) {
				marker.top = entry.top;
			}
			if (marker.note !== entry.note) {
				marker.note = entry.note;
				marker.refreshHover();
			}
			if (marker.button.parentElement !== layer) layer.appendChild(marker.button);
		}
	}
	state.signature = signature;
}

/** Remove all buttons created for this annotation layer and release its cache. */
export function disposeNoteMarkers(layer: HTMLElement): void {
	const state = layerStates.get(layer);
	if (!state) return;
	for (const marker of state.markers.values()) { marker.disposeDrag(); marker.disposeHover(); marker.button.remove(); }
	layerStates.delete(layer);
}
