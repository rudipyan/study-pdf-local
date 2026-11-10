import { describe, expect, it, vi } from 'vitest';
vi.mock('obsidian', () => ({ Scope: class { register = vi.fn(); }, setIcon: vi.fn() }));
vi.mock('../src/ui/icon-popup', () => ({
	positionPopup: vi.fn(),
	trackPopupPosition: () => ({ schedule: vi.fn(), reposition: vi.fn(), dispose: vi.fn() }),
}));
import { createPageNavigation } from '../src/ui/page-navigation';

class Node extends EventTarget {
	children: Node[] = [];
	parent: Node | null = null;
	value = ''; type = 'text'; min = ''; max = ''; hidden = false;
	dataset: Record<string, string> = {};
	textContent = ''; isConnected = true;
	attributes = new Map<string, string>();
	select = vi.fn();
	constructor(readonly doc: FixtureDocument, readonly tag = 'div', readonly cls = '') { super(); }
	get ownerDocument() { return this.doc; }
	createEl(tag: string, options: { cls?: string; text?: string } = {}) {
		const node = new Node(this.doc, tag, options.cls);
		node.textContent = options.text ?? ''; this.append(node); return node;
	}
	createDiv(options = {}) { return this.createEl('div', options); }
	createSpan(options = {}) { return this.createEl('span', options); }
	append(node: Node) { node.remove(); node.parent = this; node.isConnected = true; this.children.push(node); }
	remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
	setAttribute(key: string, value: string) { this.attributes.set(key, value); }
	contains(node: Node | null): boolean { return node === this || this.children.some(child => child.contains(node)); }
	find(predicate: (node: Node) => boolean): Node | undefined {
		for (const child of this.children) { if (predicate(child)) return child; const found = child.find(predicate); if (found) return found; }
		return undefined;
	}
	querySelector(selector: string) { return this.find(node => selector === `${node.tag}.${node.cls}`) ?? null; }
	getBoundingClientRect() { return { right: 200, bottom: 32 }; }
	focus() { this.doc.activeElement = this; }
	checkValidity() { return true; }
}
interface FixtureDocument extends EventTarget {
	body: Node;
	activeElement: Node | null;
	defaultView: { Event: typeof Event; MutationObserver: typeof Observer };
}
class Observer {
	static last: Observer;
	disconnect = vi.fn();
	observe = vi.fn();
	constructor(readonly notify: () => void) { Observer.last = this; }
}
function fixture(type = 'text') {
	const doc = new EventTarget() as FixtureDocument;
	doc.defaultView = { Event, MutationObserver: Observer }; doc.activeElement = null; doc.body = new Node(doc);
	const group = doc.body.createDiv();
	const input = group.createEl('input', { cls: 'pdf-page-input' }); input.value = '3'; input.type = type; input.max = '15';
	const count = group.createEl('span', { cls: 'pdf-page-numbers' }); count.textContent = '(4 of 15)';
	const changes = vi.fn(); input.addEventListener('change', changes);
	let pageChanged!: () => void;
	const stopWatching = vi.fn();
	const position = { page: 4, total: 15 };
	const actions = {
		getPagePosition: () => position,
		goToPage: vi.fn((page: number) => { position.page = page; return true; }),
		watchPagePosition: (change: () => void) => { pageChanged = change; return stopWatching; },
		pageKeymap: { pushScope: vi.fn(), popScope: vi.fn() },
		onPagePopupOpen: vi.fn(), onPagePopupClose: vi.fn(),
	};
	const control = createPageNavigation(group as unknown as HTMLElement, actions)!;
	const trigger = group.find(node => node.cls === 'study-pdf-page-trigger')!;
	const open = () => {
		trigger.dispatchEvent(new Event('click'));
		const panel = doc.body.find(node => node.cls.includes('study-pdf-page-popup'))!;
		return { panel, form: panel.find(node => node.tag === 'form')!, draft: panel.find(node => node.tag === 'input')! };
	};
	return { doc, group, input, count, trigger, changes, actions, control, open, position, pageChanged: () => pageChanged(), stopWatching };
}

describe('position-first page navigation', () => {
	it('starts at 1 even when the document prints 0 on its first page', async () => {
		const f = fixture();
		f.position.page = 1; f.input.value = '0'; f.pageChanged(); await Promise.resolve();
		expect(f.trigger.attributes.get('aria-label')).toBe('PDF page 1 of 15. Jump to page');
		expect(f.open().draft.value).toBe('1');
		f.control.destroy();
	});

	it.each(['0', '-1', '16', '1.5', '', 'A-12'])('rejects invalid physical position %s', (value) => {
		const f = fixture(); const { form, draft } = f.open();
		draft.value = value; form.dispatchEvent(new Event('submit', { cancelable: true }));
		expect(f.actions.goToPage).not.toHaveBeenCalled();
		expect(f.changes).not.toHaveBeenCalled(); f.control.destroy();
	});

	it('uses an unavailable state instead of inventing page 0 while the viewer loads', async () => {
		const f = fixture();
		f.position.page = 0; f.position.total = 0; f.pageChanged(); await Promise.resolve();
		expect(f.trigger.attributes.get('aria-label')).toBe('PDF page position unavailable');
		expect((f.trigger as unknown as { disabled: boolean }).disabled).toBe(true);
		f.trigger.dispatchEvent(new Event('click'));
		expect(f.actions.onPagePopupOpen).not.toHaveBeenCalled(); f.control.destroy();
	});
	it('distinguishes printed label from physical position and keeps native nodes in the toolbar', () => {
		const f = fixture(); const { panel, draft } = f.open();
		expect(f.trigger.attributes.get('aria-label')).toBe('PDF page 4 of 15. Jump to page');
		expect(panel.find(node => node.cls === 'study-pdf-page-position')?.textContent).toBe('Printed page label: 3');
		expect(draft).not.toBe(f.input); expect(f.group.contains(f.input)).toBe(true);
		f.control.destroy();
	});

	it('jumps to a physical page once without resolving it as a printed label', () => {
		const f = fixture(); const { form, draft } = f.open();
		draft.value = '1'; form.dispatchEvent(new Event('submit', { cancelable: true }));
		expect(f.actions.goToPage).toHaveBeenCalledExactlyOnceWith(1);
		expect(f.input.value).toBe('3'); expect(f.changes).not.toHaveBeenCalled();
		expect(f.actions.onPagePopupClose).toHaveBeenCalledOnce();
		expect(f.doc.activeElement).toBe(f.trigger);
		f.control.destroy();
	});

	it('Escape cancels the draft without changing the page and returns focus', () => {
		const f = fixture(); f.open().draft.value = 'A-12';
		const key = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
		f.doc.dispatchEvent(key);
		expect(key.defaultPrevented).toBe(true); expect(f.input.value).toBe('3');
		expect(f.changes).not.toHaveBeenCalled(); expect(f.doc.activeElement).toBe(f.trigger);
		f.control.destroy();
	});

	it('updates from native page events and restores original nodes when destroyed with the panel open', async () => {
		const f = fixture(); const observer = Observer.last;
		const { draft } = f.open();
		f.position.page = 8; f.input.value = 'iv'; observer.notify(); await Promise.resolve(); expect(draft.value).toBe('8');
		f.control.destroy();
		expect(f.input.parent).toBe(f.group); expect(f.count.parent).toBe(f.group);
		expect(observer.disconnect).toHaveBeenCalledOnce();
		expect(f.stopWatching).toHaveBeenCalledOnce();
		expect(f.actions.pageKeymap.popScope).toHaveBeenCalledOnce();
		expect(f.doc.body.find(node => node.cls.includes('study-pdf-page-popup'))).toBeUndefined();
	});

	it('tracks ordinary scrolling when the native total text never changes', async () => {
		const f = fixture('number');
		f.position.page = 8; f.pageChanged(); await Promise.resolve();
		expect(f.trigger.attributes.get('aria-label')).toContain('PDF page 8 of 15');
		f.control.destroy();
		f.position.page = 9; f.pageChanged(); await Promise.resolve();
		expect(f.trigger.attributes.get('aria-label')).toContain('PDF page 8 of 15');
	});

	it('protects Left/Right editing from the PDF keymap and removes that scope on cancel', () => {
		const f = fixture(); f.open();
		const scope = f.actions.pageKeymap.pushScope.mock.calls[0]![0] as { register: ReturnType<typeof vi.fn> };
		expect(scope.register.mock.calls.map(call => call[1])).toEqual(['ArrowLeft', 'ArrowRight']);
		f.doc.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' }));
		expect(f.actions.pageKeymap.popScope).toHaveBeenCalledExactlyOnceWith(scope);
		f.control.destroy();
	});

	it('cancels on outside press without stealing focus and preserves numeric input bounds', () => {
		const f = fixture('number'); const { draft } = f.open();
		expect(draft.type).toBe('number'); expect(draft.max).toBe('15');
		const other = f.doc.body.createEl('button'); other.focus();
		f.doc.dispatchEvent(new Event('pointerdown'));
		expect(f.doc.activeElement).toBe(other); expect(f.changes).not.toHaveBeenCalled();
		f.control.destroy();
	});
});
