import { bench, describe, vi } from 'vitest';

vi.mock('obsidian', () => ({ setIcon: vi.fn() }));

import { disposeNoteMarkers, updateNoteMarkers, type NoteMarkerAnnotation } from '../src/ui/note-markers';
import { addNativeHighlight, createNoteMarkerLayer } from './helpers/note-marker-fixture';

function fixtureFor(count: number) {
	const { layer } = createNoteMarkerLayer();
	const annotations = new Map<string, NoteMarkerAnnotation>();
	for (let index = 0; index < count; index++) {
		const id = `${index + 1}R`;
		addNativeHighlight(layer, { id, top: `${index * 4}px` });
		annotations.set(id, {
			subtype: 'Highlight',
			contentsObj: { str: index % 10 === 0 ? `Note ${index}` : '' },
		});
	}
	return {
		layer: layer as unknown as HTMLElement,
		read: (id: string) => annotations.get(id) ?? null,
		viewportHeight: count * 6,
	};
}

for (const count of [100, 1000]) {
	describe(`note marker update with ${count} visible annotations`, () => {
		const fixture = fixtureFor(count);
		updateNoteMarkers(fixture.layer, fixture.read, () => {}, fixture.viewportHeight);

		bench('cached refresh without DOM changes', () => {
			updateNoteMarkers(fixture.layer, fixture.read, () => {}, fixture.viewportHeight);
		});

		bench('dispose and render note markers', () => {
			disposeNoteMarkers(fixture.layer);
			updateNoteMarkers(fixture.layer, fixture.read, () => {}, fixture.viewportHeight);
		});
	});
}
