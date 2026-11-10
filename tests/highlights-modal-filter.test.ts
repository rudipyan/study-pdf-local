import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => {
	class FakeElement extends EventTarget {
		children: FakeElement[] = [];
		attributes = new Map<string, string>();
		style: Record<string, string> = {};
		className = '';
		type = '';
		disabled = false;
		checked = false;
		parentElement: FakeElement | null = null;
		private value = '';
		constructor(readonly ownerDocument: any, readonly tagName: string, options: any = {}) {
			super();
			this.className = options.cls ?? '';
			this.value = options.text ?? '';
		}
		get textContent(): string { return this.value + this.children.map((child) => child.textContent).join(''); }
		set textContent(text: string) { this.empty(); this.value = text; }
		createDiv(options: any = {}) { return this.createEl('div', options); }
		createSpan(options: any = {}) { return this.createEl('span', options); }
		createEl(tagName: string, options: any = {}) {
			const child = new FakeElement(this.ownerDocument, tagName, options);
			child.parentElement = this;
			this.children.push(child);
			return child;
		}
		createTextNode(text: string) { return new FakeText(text); }
		appendChild<T extends FakeElement | FakeText>(child: T): T {
			if (child instanceof FakeElement) {
				child.remove();
				child.parentElement = this;
			}
			this.children.push(child as any);
			return child;
		}
		replaceChildren(): void { this.empty(); }
		empty(): void { this.children.length = 0; this.value = ''; }
		remove(): void {
			if (!this.parentElement) return;
			const index = this.parentElement.children.indexOf(this);
			if (index >= 0) this.parentElement.children.splice(index, 1);
			this.parentElement = null;
		}
		setText(text: string): void { this.textContent = text; }
		setCssStyles(styles: Record<string, string>): void { Object.assign(this.style, styles); }
		setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
		getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
		removeAttribute(name: string): void { this.attributes.delete(name); }
		focus(): void { this.ownerDocument.activeElement = this; }
		click(): void { if (!this.disabled) this.dispatchEvent(new Event('click', { bubbles: true, cancelable: true })); }
	}
	class FakeText {
		constructor(readonly textContent: string) {}
	}
	class Modal {
		contentEl: FakeElement;
		titleEl: FakeElement;
		closed = false;
		constructor(readonly app: any) {
			this.contentEl = new FakeElement(app.__doc, 'div');
			this.titleEl = new FakeElement(app.__doc, 'div');
		}
		close() {
			this.closed = true;
			(this as any).onClose?.();
		}
	}
	return { Modal, Notice: vi.fn(), setIcon: vi.fn(), setTooltip: vi.fn() };
});

import { HighlightListModal } from '../src/ui/highlights-modal';
import type { HighlightEntry } from '../src/pdf-highlights';

function allNodes(root: any): any[] {
	return [root, ...(root.children ?? []).filter((child: any) => Array.isArray(child.children)).flatMap((child: any) => allNodes(child))];
}

function makeDocument(): any {
	const doc: any = new EventTarget();
	class Element extends EventTarget {
		children: any[] = [];
		attributes = new Map<string, string>();
		style: Record<string, string> = {};
		className = '';
		type = '';
		disabled = false;
		checked = false;
		parentElement: Element | null = null;
		private value = '';
		constructor(readonly ownerDocument: any, readonly tagName: string, options: any = {}) {
			super();
			this.className = options.cls ?? '';
			this.value = options.text ?? '';
		}
		get textContent(): string { return this.value + this.children.map((child) => child.textContent).join(''); }
		set textContent(text: string) { this.empty(); this.value = text; }
		createDiv(options: any = {}) { return this.createEl('div', options); }
		createSpan(options: any = {}) { return this.createEl('span', options); }
		createEl(tagName: string, options: any = {}) {
			const child = new Element(this.ownerDocument, tagName, options);
			child.parentElement = this;
			this.children.push(child);
			return child;
		}
		createTextNode(text: string) { return { textContent: text }; }
		appendChild<T extends Element | { textContent: string }>(child: T): T {
			if (child instanceof Element) {
				child.remove();
				child.parentElement = this;
			}
			this.children.push(child);
			return child;
		}
		replaceChildren(): void { this.empty(); }
		empty(): void { this.children.length = 0; this.value = ''; }
		remove(): void {
			if (!this.parentElement) return;
			const index = this.parentElement.children.indexOf(this);
			if (index >= 0) this.parentElement.children.splice(index, 1);
			this.parentElement = null;
		}
		setText(text: string): void { this.textContent = text; }
		setCssStyles(styles: Record<string, string>): void { Object.assign(this.style, styles); }
		setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
		getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
		removeAttribute(name: string): void { this.attributes.delete(name); }
		focus(): void { doc.activeElement = this; }
		click(): void { if (!this.disabled) this.dispatchEvent(new Event('click', { bubbles: true, cancelable: true })); }
	}
	Object.assign(doc, {
		activeElement: null,
		defaultView: { innerWidth: 900, innerHeight: 700, getSelection: () => ({ isCollapsed: true }) },
		createElement(tagName: string) { return new Element(doc, tagName); },
		createTextNode(text: string) { return { textContent: text }; },
	});
	doc.body = doc.createElement('body');
	return doc;
}

function entry(colorCss: string, quote: string, pageNumber: number, note: string | null = null): HighlightEntry {
	return { pageNumber, top: pageNumber, colorCss, quote, note, annotationId: pageNumber + 'R' };
}

function setup(entries: HighlightEntry[]) {
	const doc = makeDocument();
	const file = { path: 'book.pdf' };
	const view = {
		file,
		containerEl: { ownerDocument: doc },
		viewer: { child: { pdfViewer: { pdfViewer: { getPageView: () => null } } } },
		goToPage: vi.fn(),
	};
	const app = {
		__doc: doc,
		vault: { getAbstractFileByPath: vi.fn(() => file), readBinary: vi.fn() },
		workspace: { getLeavesOfType: vi.fn(() => [{ view }]) },
		fileManager: { generateMarkdownLink: vi.fn() },
	};
	const onExport = vi.fn(async () => undefined);
	const onExportSelection = vi.fn(async () => undefined);
	const modal = new HighlightListModal(app as never, view as never, {} as never, onExport, onExportSelection) as any;
	modal.scannedSnapshotFingerprint = 'original-snapshot-fingerprint';
	modal.render(entries);
	return { app, doc, modal, onExport, onExportSelection };
}

function button(root: any, text: string): any {
	return allNodes(root).find((node) => node.tagName === 'button' && node.textContent === text);
}

function filterButton(root: any, color: string): any {
	return allNodes(root).find((node) => node.tagName === 'button' && node.className.includes('study-pdf-list-filter') &&
		node.getAttribute('aria-label')?.includes(color));
}

function rows(root: any): any[] {
	return allNodes(root).filter((node) => node.className === 'study-pdf-list-row');
}

function actionButtons(root: any): any[] {
	const toolbar = allNodes(root).find((node) => node.className === 'study-pdf-list-toolbar');
	return toolbar?.children.filter((node: any) => node.tagName === 'button') ?? [];
}

afterEach(() => vi.unstubAllGlobals());

describe('Highlights & notes color filtering', () => {
	it('keeps exactly two bulk actions, filters in reading order, and copies visible text and notes only', async () => {
		const entries = [
			entry('rgb(1, 2, 3)', 'first red', 1),
			entry('legacy-blue', 'second blue', 2, '**blue note**'),
			entry('rgb(1, 2, 3)', 'third red', 3),
		];
		const { doc, modal, app } = setup(entries);
		const clipboardWrite = vi.fn(async () => undefined);
		vi.stubGlobal('navigator', { clipboard: { writeText: clipboardWrite } });
		const red = filterButton(modal.contentEl, 'rgb(1, 2, 3)');
		const blue = filterButton(modal.contentEl, 'legacy-blue');
		expect(red.getAttribute('aria-label')).toContain('2 highlights');
		red.focus();
		red.click();
		blue.click();
		expect(doc.activeElement).toBe(red);
		expect(rows(modal.contentEl).map((row) => row.textContent)).toEqual(['first redp. 1', 'second blueblue notep. 2', 'third redp. 3']);
		expect(actionButtons(modal.contentEl).map((node) => node.textContent)).toEqual(['Copy annotations', 'Export annotations']);
		expect(allNodes(modal.contentEl).some((node) => node.tagName === 'input')).toBe(false);
		expect(rows(modal.contentEl).every((row) => !row.children.some((child: any) => child.tagName === 'button'))).toBe(true);

		red.click();
		expect(rows(modal.contentEl).map((row) => row.textContent)).toEqual(['second blueblue notep. 2']);
		button(modal.contentEl, 'Copy annotations').click();
		await Promise.resolve();
		expect(clipboardWrite).toHaveBeenCalledExactlyOnceWith('> second blue\n\n**blue note**');
		expect(app.vault.readBinary).not.toHaveBeenCalled();
		expect(app.fileManager.generateMarkdownLink).not.toHaveBeenCalled();
		button(modal.contentEl, 'All colors').click();
		expect(rows(modal.contentEl)).toHaveLength(3);
		expect(actionButtons(modal.contentEl).map((node) => node.textContent)).toEqual(['Copy annotations', 'Export annotations']);
	});

	it('exports only the filtered visible entries with the original fingerprint', () => {
		const entries = [entry('red', 'red quote', 1), entry('blue', 'blue quote', 2)];
		const { modal, onExportSelection, onExport } = setup(entries);
		const red = filterButton(modal.contentEl, 'red');
		red.click();
		button(modal.contentEl, 'Export annotations').click();
		expect(onExportSelection).toHaveBeenCalledExactlyOnceWith([entries[0]], 'original-snapshot-fingerprint');
		expect(onExport).not.toHaveBeenCalled();
	});

	it('combines With notes with colors and copies the remaining annotations in reading order', async () => {
		const entries = [
			entry('red', 'red quote', 1),
			entry('red', 'red with note', 2, '**red note**'),
			entry('blue', 'blue with note', 3, 'blue note'),
			entry('blue', 'blank note', 4, '  \n '),
		];
		const { modal } = setup(entries);
		const clipboardWrite = vi.fn(async () => undefined);
		vi.stubGlobal('navigator', { clipboard: { writeText: clipboardWrite } });
		const notesFilter = button(modal.contentEl, 'With notes');
		expect(notesFilter.getAttribute('aria-pressed')).toBe('false');
		notesFilter.click();
		expect(notesFilter.getAttribute('aria-pressed')).toBe('true');
		expect(rows(modal.contentEl).map((row) => row.textContent)).toEqual(['red with notered notep. 2', 'blue with noteblue notep. 3']);

		filterButton(modal.contentEl, 'blue').click();
		expect(rows(modal.contentEl).map((row) => row.textContent)).toEqual(['blue with noteblue notep. 3']);
		button(modal.contentEl, 'Copy annotations').click();
		await Promise.resolve();
		expect(clipboardWrite).toHaveBeenCalledExactlyOnceWith('> blue with note\n\nblue note');

		button(modal.contentEl, 'All colors').click();
		expect(notesFilter.getAttribute('aria-pressed')).toBe('true');
		expect(rows(modal.contentEl)).toHaveLength(2);
	});

	it('exports only annotations with notes when no color is selected', () => {
		const entries = [entry('red', 'without note', 1), entry('blue', 'with note', 2, 'my note')];
		const { modal, onExportSelection, onExport } = setup(entries);
		button(modal.contentEl, 'With notes').click();
		button(modal.contentEl, 'Export annotations').click();
		expect(onExportSelection).toHaveBeenCalledExactlyOnceWith([entries[1]], 'original-snapshot-fingerprint');
		expect(onExport).not.toHaveBeenCalled();
	});

	it('disables copy and export until the filters match an annotation', () => {
		const { modal } = setup([entry('red', 'no note', 1), entry('blue', 'with note', 2, 'my note')]);
		filterButton(modal.contentEl, 'red').click();
		const notesFilter = button(modal.contentEl, 'With notes');
		notesFilter.click();
		expect(rows(modal.contentEl)).toHaveLength(0);
		expect(actionButtons(modal.contentEl).every((action) => action.disabled)).toBe(true);
		notesFilter.click();
		expect(actionButtons(modal.contentEl).every((action) => !action.disabled)).toBe(true);
	});

	it('shows standalone notes without a quote and excludes them from highlight color filters', async () => {
		const entries = [
			entry('red', 'highlight', 1),
			{ ...entry('red', '', 2, '**standalone note**'), standaloneNote: true },
		];
		const { modal } = setup(entries);
		const clipboardWrite = vi.fn(async () => undefined);
		vi.stubGlobal('navigator', { clipboard: { writeText: clipboardWrite } });
		const red = filterButton(modal.contentEl, 'red');
		expect(red.getAttribute('aria-label')).toContain('1 highlight');
		red.click();
		expect(rows(modal.contentEl).map((row) => row.textContent)).toEqual(['highlightp. 1']);
		button(modal.contentEl, 'All colors').click();
		button(modal.contentEl, 'With notes').click();
		expect(rows(modal.contentEl).map((row) => row.textContent)).toEqual(['standalone notep. 2']);
		button(modal.contentEl, 'Copy annotations').click();
		await Promise.resolve();
		expect(clipboardWrite).toHaveBeenCalledExactlyOnceWith('**standalone note**');
	});

	it('keeps the unfiltered export path and omits bulk controls for an empty list', () => {
		const entries = [entry('red', 'first', 1), entry('blue', 'second', 2), entry('red', 'third', 3)];
		const all = setup(entries);
		button(all.modal.contentEl, 'Export annotations').click();
		expect(all.onExport).toHaveBeenCalledOnce();
		expect(all.onExportSelection).not.toHaveBeenCalled();
		const empty = setup([]);
		expect(actionButtons(empty.modal.contentEl)).toHaveLength(0);
		expect(empty.modal.contentEl.textContent).toContain('No highlights or notes in this PDF.');
	});
});
