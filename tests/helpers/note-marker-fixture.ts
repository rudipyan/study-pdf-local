export class FakeNoteMarkerDocument extends EventTarget {
	createdElements: FakeNoteMarkerElement[] = [];
	readonly body: FakeNoteMarkerElement;
	activeElement: FakeNoteMarkerElement | null = null;
	defaultView?: FakeNoteMarkerWindow;
	constructor() {
		super();
		this.body = this.createElement('body');
	}
	createElement(tagName: string): FakeNoteMarkerElement {
		const element = new FakeNoteMarkerElement(this, tagName);
		this.createdElements.push(element);
		return element;
	}
	createTextNode(text: string): FakeNoteMarkerText { return new FakeNoteMarkerText(text); }
	querySelector(selector: string): FakeNoteMarkerElement | null {
		if (!selector.startsWith('.')) return null;
		const className = selector.slice(1);
		const visit = (element: FakeNoteMarkerElement): FakeNoteMarkerElement | null => {
			if (element.className.split(/\s+/).includes(className)) return element;
			for (const child of element.children) {
				if (!(child instanceof FakeNoteMarkerElement)) continue;
				const found = visit(child);
				if (found) return found;
			}
			return null;
		};
		return visit(this.body);
	}
	useWindow(): void { this.defaultView = new FakeNoteMarkerWindow(); }
}

export class FakeNoteMarkerText {
	constructor(readonly textContent: string) {}
}

export class FakeNoteMarkerWindow extends EventTarget {
	innerWidth = 800;
	innerHeight = 600;
	requestAnimationFrame(callback: FrameRequestCallback): number { return globalThis.setTimeout(() => callback(0), 0) as unknown as number; }
	cancelAnimationFrame(id: number): void { globalThis.clearTimeout(id); }
	setTimeout(callback: TimerHandler, delay?: number): number { return globalThis.setTimeout(callback, delay) as unknown as number; }
	clearTimeout(id: number): void { globalThis.clearTimeout(id); }
}

export class FakeNoteMarkerElement extends EventTarget {
	readonly children: Array<FakeNoteMarkerElement | FakeNoteMarkerText> = [];
	readonly attributes = new Map<string, string>();
	readonly dataset: Record<string, string> = {};
	readonly style: Record<string, string> & {
		setProperty(name: string, value: string): void;
		removeProperty(name: string): void;
	} = Object.assign({ top: '' }, {
		setProperty(name: string, value: string) { (this as Record<string, string>)[name] = value; },
		removeProperty(name: string) { delete (this as Record<string, string>)[name]; },
	});
	parentElement: FakeNoteMarkerElement | null = null;
	className = '';
	readonly classList = new FakeNoteMarkerClassList(this);
	title = '';
	type = '';
	nodeType = 1;
	queryCount = 0;
	geometryReadCount = 0;
	private readonly capturedPointers = new Set<number>();
	private textValue = '';

	constructor(readonly ownerDocument: FakeNoteMarkerDocument, readonly tagName: string) { super(); }
	get isConnected(): boolean {
		let current: FakeNoteMarkerElement = this;
		while (current.parentElement) current = current.parentElement;
		return current === this.ownerDocument.body;
	}
	get textContent(): string { return this.textValue + this.children.map((child) => child.textContent).join(''); }
	set textContent(value: string) { this.replaceChildren(); this.textValue = value; }

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
		if (name === 'data-annotation-id') this.dataset.annotationId = value;
		if (name === 'data-study-pdf-note-marker') this.dataset.studyPdfNoteMarker = value;
		if (name === 'aria-label') this.dataset.ariaLabel = value;
	}

	getAttribute(name: string): string | null {
		if (name === 'data-annotation-id') return this.dataset.annotationId ?? null;
		return this.attributes.get(name) ?? null;
	}

	appendChild<T extends FakeNoteMarkerElement | FakeNoteMarkerText>(child: T): T {
		if (child instanceof FakeNoteMarkerElement) {
			child.remove();
			this.children.push(child);
			child.parentElement = this;
		} else {
			this.children.push(child);
		}
		return child;
	}

	removeChild<T extends FakeNoteMarkerElement>(child: T): T {
		const index = this.children.indexOf(child);
		if (index >= 0) this.children.splice(index, 1);
		child.parentElement = null;
		return child;
	}

	remove(): void { this.parentElement?.removeChild(this); }
	createDiv(options: { cls?: string; text?: string } = {}): FakeNoteMarkerElement {
		return this.createElement('div', options);
	}
	createSpan(options: { cls?: string; text?: string } = {}): FakeNoteMarkerElement {
		return this.createElement('span', options);
	}
	createEl(tag: string, options: { cls?: string; text?: string } = {}): FakeNoteMarkerElement {
		return this.createElement(tag, options);
	}
	createElement(tag: string, options: { cls?: string; text?: string } = {}): FakeNoteMarkerElement {
		const child = this.ownerDocument.createElement(tag);
		child.className = options.cls ?? '';
		if (options.text) child.textContent = options.text;
		return this.appendChild(child);
	}
	replaceChildren(...children: FakeNoteMarkerElement[]): void {
		for (const child of this.children) if (child instanceof FakeNoteMarkerElement) child.parentElement = null;
		this.children.length = 0;
		for (const child of children) this.appendChild(child);
		this.textValue = '';
	}
	empty(): void { this.replaceChildren(); this.textValue = ''; }
	setText(text: string): void { this.textContent = text; }
	setCssStyles(styles: Record<string, string>): void { Object.assign(this.style, styles); }
	contains(target: FakeNoteMarkerElement | FakeNoteMarkerText | null): boolean {
		if (target === this) return true;
		return this.children.some((child) => child instanceof FakeNoteMarkerElement && child.contains(target));
	}
	focus(): void { this.ownerDocument.activeElement = this; }
	setPointerCapture(pointerId: number): void { this.capturedPointers.add(pointerId); }
	hasPointerCapture(pointerId: number): boolean { return this.capturedPointers.has(pointerId); }
	releasePointerCapture(pointerId: number): void { this.capturedPointers.delete(pointerId); }

	querySelectorAll<T extends HTMLElement>(selector: string): T[] {
		if (selector !== '.highlightAnnotation[data-annotation-id]') throw new Error(`Unexpected selector: ${selector}`);
		this.queryCount++;
		const matches: FakeNoteMarkerElement[] = [];
		const visit = (element: FakeNoteMarkerElement) => {
			for (const child of element.children) {
				if (!(child instanceof FakeNoteMarkerElement)) continue;
				if (child.className.split(/\s+/).includes('highlightAnnotation') && child.dataset.annotationId) matches.push(child);
				visit(child);
			}
		};
		visit(this);
		return matches as unknown as T[];
	}

	getBoundingClientRect(): DOMRect {
		this.geometryReadCount++;
		if (this.tagName === 'div' && this !== this.ownerDocument.body) {
			return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 } as DOMRect;
		}
		return { left: 40, top: 50, right: 60, bottom: 70, width: 20, height: 20 } as DOMRect;
	}
}

class FakeNoteMarkerClassList {
	constructor(private readonly element: FakeNoteMarkerElement) {}
	private names(): Set<string> { return new Set(this.element.className.split(/\s+/).filter(Boolean)); }
	add(value: string): void { const names = this.names(); names.add(value); this.element.className = [...names].join(' '); }
	remove(value: string): void { const names = this.names(); names.delete(value); this.element.className = [...names].join(' '); }
	contains(value: string): boolean { return this.names().has(value); }
	toggle(value: string, force?: boolean): boolean {
		const shouldAdd = force ?? !this.contains(value);
		if (shouldAdd) this.add(value);
		else this.remove(value);
		return shouldAdd;
	}
}

export interface FakeHighlightOptions {
	id: string;
	top?: string;
}

export function addNativeHighlight(layer: FakeNoteMarkerElement, { id, top = '0px' }: FakeHighlightOptions): FakeNoteMarkerElement {
	const section = layer.ownerDocument.createElement('section');
	section.className = 'highlightAnnotation';
	section.dataset.annotationId = id;
	section.style.top = top;
	layer.appendChild(section);
	return section;
}

export function createNoteMarkerLayer(options: { withWindow?: boolean } = {}): { document: FakeNoteMarkerDocument; layer: FakeNoteMarkerElement } {
	const document = new FakeNoteMarkerDocument();
	if (options.withWindow) document.useWindow();
	const layer = document.createElement('div');
	document.body.appendChild(layer);
	return { document, layer };
}

export function noteMarkerButtons(layer: FakeNoteMarkerElement): FakeNoteMarkerElement[] {
	return layer.children.filter((element) => element.className.split(/\s+/).includes('study-pdf-note-marker'));
}
