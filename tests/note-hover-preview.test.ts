import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('obsidian', () => ({ setIcon: vi.fn() }));

import { disposeNoteMarkers, updateNoteMarkers, type NoteMarkerAnnotation } from '../src/ui/note-markers';
import { ANNOTATION_ACTIONS_OPEN_EVENT } from '../src/ui/note-hover-preview';
import {
	addNativeHighlight,
	createNoteMarkerLayer,
	noteMarkerButtons,
	type FakeNoteMarkerDocument,
	type FakeNoteMarkerElement,
} from './helpers/note-marker-fixture';

function event(type: string, properties: Record<string, unknown> = {}): Event {
	const result = new Event(type, { bubbles: true, cancelable: true });
	for (const [name, value] of Object.entries(properties)) Object.defineProperty(result, name, { configurable: true, value });
	return result;
}

function setup(initialNote = 'Initial **note**') {
	const { document, layer } = createNoteMarkerLayer({ withWindow: true });
	document.body.appendChild(layer);
	addNativeHighlight(layer, { id: '701R', top: '30px' });
	const annotations = new Map<string, NoteMarkerAnnotation>([
		['701R', { subtype: 'Highlight', contentsObj: { str: initialNote } }],
	]);
	const read = vi.fn((id: string) => annotations.get(id) ?? null);
	const onOpen = vi.fn();
	updateNoteMarkers(layer as unknown as HTMLElement, read, onOpen);
	return {
		document,
		layer,
		annotations,
		read,
		onOpen,
		button: noteMarkerButtons(layer)[0]!,
	};
}

function preview(document: FakeNoteMarkerDocument): FakeNoteMarkerElement | null {
	return document.querySelector('.study-pdf-note-hover-preview');
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('note marker hover preview', () => {
	it('opens after the mouse delay, stays open through the grace area, and closes after leaving', () => {
		const f = setup();
		f.button.dispatchEvent(event('pointerenter', { pointerType: 'touch', buttons: 0 }));
		f.button.dispatchEvent(event('pointerenter', { pointerType: 'mouse', buttons: 1 }));
		vi.advanceTimersByTime(200);
		expect(preview(f.document)).toBeNull();

		f.button.dispatchEvent(event('pointerenter', { pointerType: 'mouse', buttons: 0 }));
		vi.advanceTimersByTime(149);
		expect(preview(f.document)).toBeNull();
		vi.advanceTimersByTime(1);
		const card = preview(f.document)!;
		expect(card.textContent).toBe('Initial note');
		expect(f.document.activeElement).toBeNull();
		expect(f.onOpen).not.toHaveBeenCalled();

		f.button.dispatchEvent(event('pointerleave', { pointerType: 'mouse', relatedTarget: card }));
		card.dispatchEvent(event('pointerenter', { pointerType: 'mouse', buttons: 0 }));
		vi.advanceTimersByTime(150);
		expect(preview(f.document)).toBe(card);
		card.dispatchEvent(event('pointerleave', { pointerType: 'mouse', relatedTarget: null }));
		vi.advanceTimersByTime(119);
		expect(preview(f.document)).toBe(card);
		vi.advanceTimersByTime(1);
		expect(preview(f.document)).toBeNull();
	});

	it('reuses an open card on anchor re-entry and dismisses it when the editor opens', () => {
		const f = setup();
		f.button.dispatchEvent(event('pointerenter', { pointerType: 'mouse', buttons: 0 }));
		vi.advanceTimersByTime(150);
		const card = preview(f.document)!;
		f.button.dispatchEvent(event('pointerenter', { pointerType: 'mouse', buttons: 0 }));
		vi.advanceTimersByTime(150);
		expect(preview(f.document)).toBe(card);
		f.document.dispatchEvent(new Event('study-pdf-note-editor-open'));
		expect(preview(f.document)).toBeNull();
	});

	it('uses the refreshed marker note without rescanning during hover and closes on invalidation', () => {
		const f = setup('Before');
		f.annotations.set('701R', { subtype: 'Highlight', contentsObj: { str: 'After **refresh**' } });
		updateNoteMarkers(f.layer as unknown as HTMLElement, f.read, f.onOpen);
		const readCount = f.read.mock.calls.length;
		f.button.dispatchEvent(event('pointerenter', { pointerType: 'mouse', buttons: 0 }));
		vi.advanceTimersByTime(150);
		expect(preview(f.document)?.textContent).toBe('After refresh');
		expect(f.read).toHaveBeenCalledTimes(readCount);
		f.document.dispatchEvent(new Event('scroll'));
		expect(preview(f.document)).toBeNull();
		f.button.dispatchEvent(event('pointerenter', { pointerType: 'mouse', buttons: 0 }));
		f.document.defaultView!.dispatchEvent(new Event('blur'));
		vi.advanceTimersByTime(150);
		expect(preview(f.document)).toBeNull();
	});

	it('dismisses the hover card and keeps it closed while annotation actions are open', () => {
		const f = setup();
		const hover = () => {
			f.button.dispatchEvent(event('pointerenter', { pointerType: 'mouse', buttons: 0 }));
			vi.advanceTimersByTime(150);
		};
		hover();
		expect(preview(f.document)).not.toBeNull();
		const menu = f.document.body.createDiv({ cls: 'study-pdf-candidate-modal' });
		f.document.dispatchEvent(new Event(ANNOTATION_ACTIONS_OPEN_EVENT));
		expect(preview(f.document)).toBeNull();
		hover();
		expect(preview(f.document)).toBeNull();
		menu.remove();
		hover();
		expect(preview(f.document)).not.toBeNull();
	});

	it('keeps click and drag behavior independent from hover and disposes the preview', () => {
		const f = setup();
		f.button.dispatchEvent(event('pointerenter', { pointerType: 'mouse', buttons: 0 }));
		vi.advanceTimersByTime(150);
		expect(preview(f.document)).not.toBeNull();
		f.button.dispatchEvent(event('pointerdown', { isPrimary: true, button: 0, pointerId: 4, clientX: 10, clientY: 10 }));
		expect(preview(f.document)).toBeNull();
		f.button.dispatchEvent(event('pointermove', { pointerId: 4, clientX: 30, clientY: 10 }));
		f.button.dispatchEvent(event('pointerup', { pointerId: 4, clientX: 30, clientY: 10 }));
		f.button.dispatchEvent(event('click', { detail: 1 }));
		expect(f.onOpen).not.toHaveBeenCalled();

		f.button.dispatchEvent(event('click', { detail: 0 }));
		expect(f.onOpen).toHaveBeenCalledOnce();
		f.button.dispatchEvent(event('pointerenter', { pointerType: 'mouse', buttons: 0 }));
		vi.advanceTimersByTime(150);
		disposeNoteMarkers(f.layer as unknown as HTMLElement);
		expect(preview(f.document)).toBeNull();
	});
});
