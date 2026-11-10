import { describe, expect, it, vi } from 'vitest';
vi.mock('obsidian', () => ({ setIcon: vi.fn() }));
import { updateNoteMarkers } from '../src/ui/note-markers';
import { addNativeHighlight, createNoteMarkerLayer, noteMarkerButtons } from './helpers/note-marker-fixture';

function fixture() {
	const { layer, document } = createNoteMarkerLayer();
	const original = document.createElement.bind(document);
	document.createElement = (tag) => {
		const node = original(tag);
		Object.assign(node.style, { setProperty() {}, removeProperty() {} });
		return node;
	};
	const add = (id: string, left: string, width: string, top = '100px') => {
		const section = addNativeHighlight(layer, { id, top }); Object.assign(section.style, { left, width }); return section;
	};
	const paint = (width = 1000, positions?: { get(key: string): { x: number; y: number } | undefined; save(): void }) =>
		updateNoteMarkers(layer as unknown as HTMLElement, () => ({ subtype: 'Highlight', contentsObj: { str: 'A note' } }), vi.fn(), 800, positions, width);
	const style = (id = '12R') => noteMarkerButtons(layer).find(node => node.dataset.annotationId === id)!.style as unknown as CSSStyleDeclaration;
	return { layer, document, add, paint, style };
}
describe('comment icons next to their passages', () => {
	it('places the complete touch target just outside the highlight instead of at the page edge', () => {
		const f = fixture(); f.add('12R', '10%', '25%'); f.paint();
		expect(f.style().left).toBe('376px'); expect(f.style().right).toBe('auto'); expect(f.style().top).toBe('100px');
		expect(f.layer.geometryReadCount).toBe(0);
	});
	it('flips to the passage’s left when the right side has insufficient space', () => {
		const f = fixture(); f.add('12R', '65%', '34%'); f.paint(); expect(f.style().left).toBe('624px');
	});
	it('leaves notes in separate article columns at their original vertical positions', () => {
		const f = fixture(); f.add('12R', '5%', '30%'); f.add('13R', '55%', '30%'); f.paint();
		expect(f.style('12R').top).toBe('100px'); expect(f.style('13R').top).toBe('100px');
	});
	it('keeps colliding nearby touch targets separated', () => {
		const f = fixture(); f.add('12R', '5%', '30%'); f.add('13R', '6%', '30%'); f.paint();
		expect(Math.abs(Number.parseFloat(f.style('12R').top) - Number.parseFloat(f.style('13R').top))).toBeGreaterThanOrEqual(44);
	});
	it('preserves a manually dragged position and writes nothing for automatic placement', () => {
		const f = fixture(); f.add('12R', '5%', '30%'); const save = vi.fn();
		f.paint(1000, { get: () => ({ x: 0.8, y: 0.6 }), save });
		expect(f.style().left).toBe('clamp(22px, 80%, calc(100% - 22px))'); expect(save).not.toHaveBeenCalled();
	});
	it('reuses markers on zoom while recomputing their passage-relative default placement', () => {
		const f = fixture(); f.add('12R', '10%', '25%'); f.paint();
		const button = noteMarkerButtons(f.layer)[0]; const count = f.document.createdElements.length;
		f.paint(2000); expect(f.style().left).toBe('726px'); expect(noteMarkerButtons(f.layer)[0]).toBe(button);
		expect(f.document.createdElements.length).toBe(count);
	});
});
