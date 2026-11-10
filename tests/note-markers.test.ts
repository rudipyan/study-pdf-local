import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({ setIcon: vi.fn() }));

import { setIcon } from 'obsidian';
import { disposeNoteMarkers, updateNoteMarkers, type NoteMarkerAnnotation } from '../src/ui/note-markers';
import {
	addNativeHighlight,
	createNoteMarkerLayer,
	noteMarkerButtons,
	type FakeNoteMarkerElement,
} from './helpers/note-marker-fixture';

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

function markerLayer(layer: FakeNoteMarkerElement): HTMLElement {
	return layer as unknown as HTMLElement;
}

function domEvent(type: string, properties: Record<string, unknown> = {}): Event {
	const event = new Event(type, { bubbles: true, cancelable: true });
	for (const [name, value] of Object.entries(properties)) {
		Object.defineProperty(event, name, { configurable: true, value });
	}
	return event;
}

function noteButton(layer: FakeNoteMarkerElement, id: string): FakeNoteMarkerElement {
	return noteMarkerButtons(layer).find((button) => button.dataset.annotationId === id)!;
}

describe('PDF note markers', () => {
	it('adds a safe, accessible button only for non-empty highlight notes', () => {
		const { layer } = createNoteMarkerLayer();
		const note = '<img src=x onerror=alert(1)>';
		addNativeHighlight(layer, { id: '101R', top: '84px' });
		addNativeHighlight(layer, { id: '102R', top: '120px' });
		addNativeHighlight(layer, { id: '103R', top: '150px' });
		addNativeHighlight(layer, { id: '104R', top: '180px' });
		addNativeHighlight(layer, { id: 'not-a-ref', top: '210px' });
		const annotations = new Map<string, NoteMarkerAnnotation>([
			['101R', { subtype: 'Highlight', contentsObj: { str: note } }],
			['102R', { subtype: 'Highlight', contentsObj: { str: '' } }],
			['103R', { subtype: 'Highlight', contentsObj: { str: ' \n ' } }],
			['104R', { subtype: 'Text', contentsObj: { str: 'Not a highlight note' } }],
			['not-a-ref', { subtype: 'Highlight', contentsObj: { str: 'Cannot be opened by the parent resolver' } }],
		]);

		updateNoteMarkers(markerLayer(layer), (id) => annotations.get(id) ?? null, vi.fn());

		const buttons = noteMarkerButtons(layer);
		expect(buttons).toHaveLength(1);
		expect(buttons[0]!.tagName).toBe('button');
		expect(buttons[0]!.type).toBe('button');
		expect(buttons[0]!.dataset.annotationId).toBe('101R');
		expect(buttons[0]!.dataset.studyPdfNoteMarker).toBe('true');
		expect(buttons[0]!.style.top).toBe('84px');
		expect(buttons[0]!.getAttribute('aria-label')).toBe('Read highlight note. Hold and drag to move the comment icon.');
		expect(buttons[0]!.title).toBe('');
		expect(buttons[0]!.textContent).toBe('');
		expect(buttons[0]!.children).toHaveLength(0);
		expect(vi.mocked(setIcon)).toHaveBeenCalledExactlyOnceWith(buttons[0], 'message-square');
	});

	it('reuses unchanged buttons and updates only changed note and position data', () => {
		const { layer } = createNoteMarkerLayer();
		addNativeHighlight(layer, { id: '201R', top: '20px' });
		addNativeHighlight(layer, { id: '202R', top: '60px' });
		const annotations = new Map<string, NoteMarkerAnnotation>([
			['201R', { subtype: 'Highlight', rect: [0, 0, 100, 20], contentsObj: { str: 'First note' } }],
			['202R', { subtype: 'Highlight', rect: [0, 40, 100, 60], contentsObj: { str: 'Second note' } }],
		]);
		const read = vi.fn((id: string) => annotations.get(id) ?? null);
		const open = vi.fn();
		const el = markerLayer(layer);

		updateNoteMarkers(el, read, open);
		const first = noteButton(layer, '201R');
		const second = noteButton(layer, '202R');
		const iconCalls = vi.mocked(setIcon).mock.calls.length;
		updateNoteMarkers(el, read, open);
		expect(noteButton(layer, '201R')).toBe(first);
		expect(noteButton(layer, '202R')).toBe(second);
		expect(vi.mocked(setIcon)).toHaveBeenCalledTimes(iconCalls);
		expect(first.geometryReadCount).toBe(0);
		expect(read).toHaveBeenCalledTimes(4);

		annotations.set('201R', { subtype: 'Highlight', rect: [0, 0, 100, 20], contentsObj: { str: 'Updated <b>note</b>' } });
		layer.children.find((element) => element.dataset.annotationId === '202R')!.style.top = '92px';
		updateNoteMarkers(el, read, open);
		expect(noteButton(layer, '201R')).toBe(first);
		expect(noteButton(layer, '202R')).toBe(second);
		expect(first.getAttribute('aria-label')).toBe('Read highlight note. Hold and drag to move the comment icon.');
		expect(first.title).toBe('');
		expect(first.textContent).toBe('');
		expect(second.style.top).toBe('92px');
		expect(vi.mocked(setIcon)).toHaveBeenCalledTimes(iconCalls);

		const refreshedOpen = vi.fn();
		updateNoteMarkers(el, read, refreshedOpen);
		first.dispatchEvent(domEvent('click'));
		expect(open).not.toHaveBeenCalled();
		expect(refreshedOpen).toHaveBeenCalledExactlyOnceWith('201R', { x: 40, y: 70 });
	});

	it('recreates and disposes a marker when its PDF annotation rectangle changes', async () => {
		vi.useFakeTimers();
		const { document, layer } = createNoteMarkerLayer({ withWindow: true });
		addNativeHighlight(layer, { id: '251R', top: '40px' });
		const annotations = new Map<string, NoteMarkerAnnotation>([
			['251R', { subtype: 'Highlight', rect: [10, 10, 30, 30], contentsObj: { str: 'Stable note' } }],
		]);
		const read = (id: string) => annotations.get(id) ?? null;
		updateNoteMarkers(markerLayer(layer), read, vi.fn());
		const previous = noteButton(layer, '251R');
		previous.dispatchEvent(domEvent('pointerdown', {
			isPrimary: true, pointerType: 'mouse', button: 0, pointerId: 25, clientX: 10, clientY: 10,
		}));
		previous.dispatchEvent(domEvent('pointerenter', { pointerType: 'mouse', buttons: 0 }));
		expect(previous.hasPointerCapture(25)).toBe(true);
		expect(vi.getTimerCount()).toBe(1);

		annotations.set('251R', { subtype: 'Highlight', rect: [11, 10, 30, 30], contentsObj: { str: 'Stable note' } });
		updateNoteMarkers(markerLayer(layer), read, vi.fn());
		const current = noteButton(layer, '251R');
		expect(current).not.toBe(previous);
		expect(previous.parentElement).toBeNull();
		expect(previous.hasPointerCapture(25)).toBe(false);
		expect(vi.getTimerCount()).toBe(0);

		await vi.advanceTimersByTimeAsync(150);
		expect(document.querySelector('.study-pdf-note-hover-preview')).toBeNull();
	});

	it('reconciles cleared, removed, detached, and disposed markers without duplicates', () => {
		const { layer } = createNoteMarkerLayer();
		const section = addNativeHighlight(layer, { id: '301R', top: '12px' });
		const annotations = new Map<string, NoteMarkerAnnotation>([
			['301R', { subtype: 'Highlight', contentsObj: { str: 'A note' } }],
		]);
		const el = markerLayer(layer);
		const read = (id: string) => annotations.get(id) ?? null;

		updateNoteMarkers(el, read, vi.fn());
		const original = noteButton(layer, '301R');
		annotations.set('301R', { subtype: 'Highlight', contentsObj: { str: '  ' } });
		updateNoteMarkers(el, read, vi.fn());
		expect(noteMarkerButtons(layer)).toHaveLength(0);

		annotations.set('301R', { subtype: 'Highlight', contentsObj: { str: 'A note again' } });
		updateNoteMarkers(el, read, vi.fn());
		const restored = noteButton(layer, '301R');
		expect(restored).not.toBe(original);
		restored.remove(); // PDF.js can replace children within a rendered layer.
		updateNoteMarkers(el, read, vi.fn());
		expect(noteButton(layer, '301R')).toBe(restored);
		expect(noteMarkerButtons(layer)).toHaveLength(1);

		section.remove();
		updateNoteMarkers(el, read, vi.fn());
		expect(noteMarkerButtons(layer)).toHaveLength(0);
		disposeNoteMarkers(el);
		disposeNoteMarkers(el);
		updateNoteMarkers(el, read, vi.fn());
		expect(noteMarkerButtons(layer)).toHaveLength(0);
	});

	it('stops marker gestures and ignores moved, cancelled, and long taps while keeping keyboard clicks', () => {
		vi.useFakeTimers();
		const { layer } = createNoteMarkerLayer({ withWindow: true });
		addNativeHighlight(layer, { id: '401R', top: '30px' });
		const open = vi.fn();
		updateNoteMarkers(markerLayer(layer), () => ({ subtype: 'Highlight', contentsObj: { str: 'A note' } }), open);
		const button = noteButton(layer, '401R');

		const down = domEvent('pointerdown', { isPrimary: true, pointerType: 'mouse', button: 0, pointerId: 1, clientX: 10, clientY: 10 });
		button.dispatchEvent(down);
		expect(button.hasPointerCapture(1)).toBe(true);
		const up = domEvent('pointerup', { pointerType: 'mouse', pointerId: 1, clientX: 10, clientY: 10 });
		button.dispatchEvent(up);
		const click = domEvent('click', { detail: 1 });
		button.dispatchEvent(click);
		expect(down.cancelBubble).toBe(true);
		expect(up.cancelBubble).toBe(true);
		expect(click.cancelBubble).toBe(true);
		expect(down.defaultPrevented).toBe(false);
		expect(open).toHaveBeenCalledExactlyOnceWith('401R', { x: 40, y: 70 });
		expect(button.geometryReadCount).toBe(2); // One read arms pointer capture; the other anchors the popup.
		expect(button.hasPointerCapture(1)).toBe(false);

		button.dispatchEvent(domEvent('pointerdown', { isPrimary: true, pointerType: 'touch', button: 0, pointerId: 2, clientX: 10, clientY: 10 }));
		button.dispatchEvent(domEvent('pointermove', { pointerType: 'touch', pointerId: 2, clientX: 30, clientY: 10 }));
		button.dispatchEvent(domEvent('pointerup', { pointerType: 'touch', pointerId: 2, clientX: 30, clientY: 10 }));
		button.dispatchEvent(domEvent('click', { detail: 1 }));
		expect(open).toHaveBeenCalledOnce();

		button.dispatchEvent(domEvent('pointerdown', { isPrimary: true, pointerType: 'touch', button: 0, pointerId: 3, clientX: 10, clientY: 10 }));
		button.dispatchEvent(domEvent('pointercancel', { pointerType: 'touch', pointerId: 3, clientX: 10, clientY: 10 }));
		button.dispatchEvent(domEvent('click', { detail: 1 }));
		expect(open).toHaveBeenCalledOnce();

		button.dispatchEvent(domEvent('click', { detail: 0 }));
		expect(open).toHaveBeenCalledTimes(2);

		button.dispatchEvent(domEvent('pointerdown', { isPrimary: true, pointerType: 'touch', button: 0, pointerId: 4, clientX: 10, clientY: 10 }));
		vi.advanceTimersByTime(350);
		expect(button.classList.contains('study-pdf-note-marker-held')).toBe(true);
		button.dispatchEvent(domEvent('pointerup', { pointerType: 'touch', pointerId: 4, clientX: 10, clientY: 10 }));
		button.dispatchEvent(domEvent('click', { detail: 1 }));
		expect(open).toHaveBeenCalledTimes(2);
		expect(button.classList.contains('study-pdf-note-marker-held')).toBe(false);

		button.dispatchEvent(domEvent('mousedown', { button: 0, clientX: 10, clientY: 10 }));
		button.dispatchEvent(domEvent('mouseup', { clientX: 10, clientY: 10 }));
		button.dispatchEvent(domEvent('click', { detail: 1 }));
		expect(open).toHaveBeenCalledTimes(3);
	});

	it('keeps note text out of the marker title while suppressing a touch-scroll click', () => {
		vi.useFakeTimers();
		const { layer } = createNoteMarkerLayer({ withWindow: true });
		addNativeHighlight(layer, { id: '501R' });
		const note = 'A'.repeat(240);
		const open = vi.fn();
		updateNoteMarkers(markerLayer(layer), () => ({ subtype: 'Highlight', contentsObj: { str: note } }), open);
		const button = noteButton(layer, '501R');
		expect(button.title).toBe('');
		expect(button.getAttribute('aria-label')).toBe('Read highlight note. Hold and drag to move the comment icon.');

		button.dispatchEvent(domEvent('pointerdown', {
			isPrimary: true, pointerType: 'touch', button: 0, pointerId: 51, clientX: 10, clientY: 10,
		}));
		button.dispatchEvent(domEvent('pointermove', { pointerType: 'touch', pointerId: 51, clientX: 10, clientY: 40 }));
		button.dispatchEvent(domEvent('pointerup', { pointerType: 'touch', pointerId: 51, clientX: 10, clientY: 40 }));
		button.dispatchEvent(domEvent('click', { detail: 1 }));
		expect(open).not.toHaveBeenCalled();
	});

	it('stacks same-height and near-edge notes with separate targets inside the page', () => {
		const { layer } = createNoteMarkerLayer();
		addNativeHighlight(layer, { id: '601R', top: '50%' });
		addNativeHighlight(layer, { id: '602R', top: '50%' });
		addNativeHighlight(layer, { id: '603R', top: '0%' });
		addNativeHighlight(layer, { id: '604R', top: '0.5%' });
		const annotations = new Map<string, NoteMarkerAnnotation>([
			['601R', { subtype: 'Highlight', contentsObj: { str: 'Middle note 1' } }],
			['602R', { subtype: 'Highlight', contentsObj: { str: 'Middle note 2' } }],
			['603R', { subtype: 'Highlight', contentsObj: { str: 'Top note 1' } }],
			['604R', { subtype: 'Highlight', contentsObj: { str: 'Top note 2' } }],
		]);
		updateNoteMarkers(markerLayer(layer), (id) => annotations.get(id) ?? null, vi.fn(), 600);

		const middleTop = Number.parseFloat(noteButton(layer, '601R').style.top);
		const middleBottom = Number.parseFloat(noteButton(layer, '602R').style.top);
		const edgeTop = Number.parseFloat(noteButton(layer, '603R').style.top);
		const edgeBottom = Number.parseFloat(noteButton(layer, '604R').style.top);
		expect(Math.abs(middleBottom - middleTop)).toBeGreaterThanOrEqual(44);
		expect(Math.abs(edgeBottom - edgeTop)).toBeGreaterThanOrEqual(44);
		expect([middleTop, middleBottom, edgeTop, edgeBottom].every((top) => top >= 22 && top <= 578)).toBe(true);
	});

	it.each([100, 1000])('keeps DOM creation bounded for %i visible annotations', (count) => {
		const { layer, document } = createNoteMarkerLayer();
		const annotations = new Map<string, NoteMarkerAnnotation>();
		const noteCount = count / 10;
		for (let index = 0; index < count; index++) {
			const id = `${index + 1}R`;
			addNativeHighlight(layer, { id, top: `${index * 4}px` });
			annotations.set(id, {
				subtype: 'Highlight',
				contentsObj: { str: index % 10 === 0 ? `Note ${index}` : '' },
			});
		}
		const read = vi.fn((id: string) => annotations.get(id) ?? null);
		const el = markerLayer(layer);

		updateNoteMarkers(el, read, vi.fn(), count * 6);
		const markerCountAfterRender = noteMarkerButtons(layer).length;
		const createdCountAfterRender = document.createdElements.length;
		updateNoteMarkers(el, read, vi.fn(), count * 6);

		expect(markerCountAfterRender).toBe(noteCount);
		expect(noteMarkerButtons(layer)).toHaveLength(noteCount);
		expect(document.createdElements).toHaveLength(createdCountAfterRender);
		expect(read).toHaveBeenCalledTimes(count * 2);
		expect(layer.queryCount).toBe(2);
		expect(noteMarkerButtons(layer).every((button) => button.geometryReadCount === 0)).toBe(true);
	});
});
