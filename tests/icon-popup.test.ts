import { describe, expect, it, vi } from 'vitest';
vi.mock('obsidian', () => ({ Scope: class {}, setIcon: vi.fn(), setTooltip: vi.fn() }));
import { showIconPopup } from '../src/ui/icon-popup';
import { showColorPaletteModal, type CandidateChoice } from '../src/ui/color-palette-modal';

type Options = { cls?: string; text?: string };
class Element extends EventTarget {
	constructor(readonly tag = 'div', readonly options: Options = {}) { super(); }
	children: Element[] = [];
	attributes = new Map<string, string>();
	style: Record<string, string> = {};
	focus = vi.fn();
	remove = vi.fn();
	createDiv(options: Options = {}) { return this.createEl('div', options); }
	createEl(tag: string, options: Options = {}) { const child = new Element(tag, options); this.children.push(child); return child; }
	createSpan(options: Options = {}) { return this.createEl('span', options); }
	get textContent() { return [this.options.text ?? '', ...this.children.map((child) => child.textContent)].join(''); }
	disabled = false;
	type = '';
	tabIndex = -1;
	click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
	setCssStyles() {}
	setAttribute(name: string, value: string) { this.attributes.set(name, value); }
	getAttribute(name: string) { return this.attributes.get(name) ?? null; }
	getBoundingClientRect() { return { width: 100, height: 30 }; }
}
function documentFixture() {
	return Object.assign(new EventTarget(), {
		body: new Element(), defaultView: Object.assign(new EventTarget(), {
			innerWidth: 800, innerHeight: 600,
			requestAnimationFrame: vi.fn(() => 1), cancelAnimationFrame: vi.fn(),
		}),
	}) as unknown as Document;
}
describe('selection color popup', () => {
	it('never focuses the popup and preserves the text selection when pressing a color', () => {
		const doc = documentFixture();
		const popup = showIconPopup(doc, { x: 10, y: 10 }, [{ type: 'color', name: 'Custom blue', hex: '#123456', onClick() {} }]);
		const el = popup.el as unknown as Element;
		expect(el.focus).not.toHaveBeenCalled();
		const event = new Event('mousedown', { cancelable: true });
		el.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(el.children[0]!.children[0]!.attributes.get('aria-label')).toBe('Custom blue');
		popup.hide();
	});
	it('handles Escape without taking focus and removes its listener on dismiss', () => {
		const doc = documentFixture();
		const onDismiss = vi.fn();
		const popup = showIconPopup(doc, { x: 10, y: 10 }, [], { onDismiss });
		const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
		doc.dispatchEvent(escape);
		expect(escape.defaultPrevented).toBe(true);
		expect(onDismiss).toHaveBeenCalledOnce();
		const later = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
		doc.dispatchEvent(later);
		expect(later.defaultPrevented).toBe(false);
		popup.hide();
		expect(onDismiss).toHaveBeenCalledOnce();
	});
});

const colors = [
	{ id: 'yellow', name: 'Yellow', hex: '#ffff00' },
	{ id: 'blue', name: 'Custom blue', hex: '#123456' },
];
const candidate: CandidateChoice = {
	pageIndex: 0, target: { pageIndex: 0, objectNumber: 10, generationNumber: 0, sourceFingerprint: 'a'.repeat(64) },
	quote: 'Quoted passage must not appear in this popup', note: null, currentColor: { r: 1, g: 1, b: 0 }, unsupportedReason: null,
};
function descendants(element: Element): Element[] {
	return element.children.flatMap(child => [child, ...descendants(child)]);
}
function annotationPopup(candidates: CandidateChoice[] = [candidate]) {
	const doc = documentFixture();
	const actions = { onRecolor: vi.fn(), onEditNote: vi.fn(), onCopy: vi.fn(), onRemove: vi.fn() };
	const popup = showColorPaletteModal(doc, { x: 10, y: 10 }, candidates, colors, 'blue', actions);
	const el = popup.el as unknown as Element;
	return { doc, popup, el, nodes: descendants(el), actions };
}
describe('compact annotation actions', () => {
	it('exposes icon-only note and copy actions, colors, and a remove circle without a text preview', () => {
		const f = annotationPopup();
		expect(f.nodes.some(node => ['details', 'summary'].includes(node.tag))).toBe(false);
		const buttons = f.nodes.filter(node => node.tag === 'button');
		expect(buttons).toHaveLength(5);
		expect(buttons.map(node => node.getAttribute('aria-label'))).toEqual([
			'Add note for highlight 1 of 1, page 1: “Quoted passage must not appear in this popup”',
			'Copy highlighted text for highlight 1 of 1, page 1: “Quoted passage must not appear in this popup”',
			'Change highlight 1 of 1, page 1: “Quoted passage must not appear in this popup” to Custom blue, default color',
			'Change highlight 1 of 1, page 1: “Quoted passage must not appear in this popup” to Yellow, current color',
			'Remove annotation (highlight 1 of 1, page 1: “Quoted passage must not appear in this popup”)',
		]);
		expect(buttons.every(node => node.textContent === '')).toBe(true);
		expect(f.nodes.some(node => node.options.text?.includes(candidate.quote!))).toBe(false);
		expect(f.nodes.some(node => node.options.text === 'Highlight')).toBe(false);
		expect(f.nodes.filter(node => node.options.cls === 'study-pdf-annotation-color')).toHaveLength(2);
		expect(f.el.focus).not.toHaveBeenCalled();
		f.popup.hide();
	});
	it('recolors the exact clicked annotation with a single click and marks its current color', () => {
		const second = { ...candidate, target: { ...candidate.target!, objectNumber: 20 } };
		const f = annotationPopup([candidate, second]);
		const dots = f.nodes.filter(node => node.options.cls === 'study-pdf-annotation-color');
		expect(dots[0]!.attributes.get('aria-pressed')).toBe('false'); // default blue first
		expect(dots[1]!.attributes.get('aria-pressed')).toBe('true');
		dots[2]!.click();
		expect(f.actions.onRecolor).toHaveBeenCalledExactlyOnceWith(second.target, { r: 0x12 / 255, g: 0x34 / 255, b: 0x56 / 255 });
		expect(f.nodes.filter(node => node.options.cls === 'study-pdf-candidate-label').map(node => node.options.text)).toEqual(['Annotation 1', 'Annotation 2']);
		f.popup.hide();
	});
	it('opens an existing comment for editing without displaying it in the toolbar', () => {
		const withNote = { ...candidate, note: 'Existing comment' };
		const f = annotationPopup([withNote]);
		const edit = f.nodes.find(node => node.getAttribute('aria-label')?.startsWith('Edit note for '))!;
		edit.click();
		expect(f.actions.onEditNote).toHaveBeenCalledExactlyOnceWith(withNote);
		expect(f.nodes.some(node => node.options.text === withNote.note)).toBe(false);
		f.popup.hide();
	});
	it('copies only the exact annotation selected by its accessible action', () => {
		const second = { ...candidate, target: { ...candidate.target!, objectNumber: 20 }, quote: 'Second annotation quote' };
		const f = annotationPopup([candidate, second]);
		const copy = f.nodes.find(node => node.getAttribute('aria-label')?.startsWith('Copy highlighted text for highlight 2 of 2'))!;
		expect(copy.textContent).toBe('');
		copy.click();
		expect(f.actions.onCopy).toHaveBeenCalledExactlyOnceWith(second);
		f.popup.hide();
	});
	it('offers copy for an imported highlight with text quads and no saved quote', () => {
		const imported = { ...candidate, quote: null, quoteRects: [{ left: 10, right: 20, bottom: 30, top: 40 }] };
		const f = annotationPopup([imported]);
		const copy = f.nodes.find(node => node.getAttribute('aria-label')?.startsWith('Copy highlighted text for '))!;
		expect(copy.disabled).toBe(false);
		copy.click();
		expect(f.actions.onCopy).toHaveBeenCalledExactlyOnceWith(imported);
		f.popup.hide();
	});
	it('keeps note editing available but disables unsupported recoloring', () => {
		const unsupported = { ...candidate, unsupportedReason: 'Unsupported appearance' };
		const f = annotationPopup([unsupported]);
		const dots = f.nodes.filter(node => node.options.cls === 'study-pdf-annotation-color');
		expect(dots.every(node => node.disabled)).toBe(true);
		dots[0]!.click();
		expect(f.actions.onRecolor).not.toHaveBeenCalled();
		f.nodes.find(node => node.getAttribute('aria-label')?.startsWith('Add note for '))!.click();
		expect(f.actions.onEditNote).toHaveBeenCalledOnce();
		f.popup.hide();
	});
	it('removes an annotation directly from its slash circle without recoloring it', () => {
		const f = annotationPopup();
		const remove = f.nodes.find(node => node.options.cls?.includes('study-pdf-annotation-remove'))!;
		expect(remove.children[0]!.options.cls).toContain('study-pdf-remove-dot');
		expect(remove.attributes.get('aria-label')).toContain('Remove annotation');
		remove.click();
		expect(f.actions.onRecolor).not.toHaveBeenCalled();
		expect(f.actions.onRemove).toHaveBeenCalledExactlyOnceWith(candidate);
		f.popup.hide();
	});
	it('removes only the chosen annotation when highlights overlap', () => {
		const second = { ...candidate, target: { ...candidate.target!, objectNumber: 20 } };
		const f = annotationPopup([candidate, second]);
		const remove = f.nodes.filter(node => node.options.cls?.includes('study-pdf-annotation-remove'));
		remove[1]!.click();
		expect(f.actions.onRemove).toHaveBeenCalledExactlyOnceWith(second);
		f.popup.hide();
	});
	it('allows removal with unsupported recoloring but disables it without an exact target', () => {
		const f = annotationPopup([{ ...candidate, unsupportedReason: 'Unsupported appearance' }, { ...candidate, target: null }]);
		const remove = f.nodes.filter(node => node.options.cls?.includes('study-pdf-annotation-remove'));
		expect(remove[0]!.disabled).toBe(false);
		expect(remove[1]!.disabled).toBe(true);
		remove[1]!.click();
		expect(f.actions.onRemove).not.toHaveBeenCalled();
		f.popup.hide();
	});
	it('closes with Escape without focusing the toolbar and cleans up the listener', () => {
		const f = annotationPopup();
		f.doc.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' }));
		expect(f.el.remove).toHaveBeenCalledOnce();
		const later = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
		f.doc.dispatchEvent(later);
		expect(later.defaultPrevented).toBe(false);
	});
});
