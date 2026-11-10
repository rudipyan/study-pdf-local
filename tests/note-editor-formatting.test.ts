import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({
	Scope: class { register() {} },
	setIcon: vi.fn(),
	setTooltip: vi.fn(),
}));
vi.mock('../src/ui/popup-drag', () => ({ bindPopupDragging: vi.fn(() => () => undefined) }));

import { showNoteEditorPopup } from '../src/ui/icon-popup';

type FakeChild = FakeElement | FakeText;
type ElementOptions = { cls?: string; text?: string; placeholder?: string };

class FakeText {
	constructor(readonly textContent: string) {}
}

class FakeClassList {
	private readonly values = new Set<string>();
	constructor(private readonly element: FakeElement) {}
	add(value: string): void { this.values.add(value); this.element.className = [...this.values].join(' '); }
	remove(value: string): void { this.values.delete(value); this.element.className = [...this.values].join(' '); }
	contains(value: string): boolean { return this.values.has(value); }
	toggle(value: string, force?: boolean): boolean {
		const shouldAdd = force ?? !this.values.has(value);
		if (shouldAdd) this.add(value);
		else this.remove(value);
		return shouldAdd;
	}
}

class FakeElement extends EventTarget {
	readonly children: FakeChild[] = [];
	readonly attributes = new Map<string, string>();
	readonly classList = new FakeClassList(this);
	readonly style: Record<string, string> = {};
	parentElement: FakeElement | null = null;
	className = '';
	disabled = false;
	hidden = false;
	type = '';
	value = '';
	checked = false;
	selectionStart = 0;
	selectionEnd = 0;
	scrollHeight = 120;
	offsetHeight = 60;
	clientHeight = 0;
	private textValue = '';

	constructor(readonly ownerDocument: FakeDocument, readonly tagName: string, options: ElementOptions = {}) {
		super();
		this.className = options.cls ?? '';
		if (options.text) this.textValue = options.text;
		if (options.placeholder) this.setAttribute('placeholder', options.placeholder);
		for (const name of this.className.split(/\s+/).filter(Boolean)) this.classList.add(name);
	}

	get isConnected(): boolean {
		let current: FakeElement | null = this;
		while (current?.parentElement) current = current.parentElement;
		return current === this.ownerDocument.body;
	}
	get textContent(): string { return this.textValue + this.children.map((child) => child.textContent).join(''); }
	set textContent(value: string) { this.empty(); this.textValue = value; }
	getBoundingClientRect() { return { left: 20, top: 30, right: 220, bottom: 90, width: 200, height: 60 } as DOMRect; }
	getBoundingClientRectHeight() { return 60; }
	createDiv(options: ElementOptions = {}) { return this.createEl('div', options); }
	createSpan(options: ElementOptions = {}) { return this.createEl('span', options); }
	createEl(tagName: string, options: ElementOptions = {}) {
		const child = new FakeElement(this.ownerDocument, tagName, options);
		this.appendChild(child);
		return child;
	}
	createTextNode(text: string) { return new FakeText(text); }
	appendChild<T extends FakeChild>(child: T): T {
		if (child instanceof FakeElement) {
			child.remove();
			child.parentElement = this;
		}
		this.children.push(child);
		return child;
	}
	replaceChildren(): void { this.empty(); }
	empty(): void {
		for (const child of this.children) if (child instanceof FakeElement) child.parentElement = null;
		this.children.length = 0;
		this.textValue = '';
	}
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
	setSelectionRange(start: number, end: number): void { this.selectionStart = start; this.selectionEnd = end; }
	setRangeText(text: string, start: number, end: number, mode: string): void {
		this.value = this.value.slice(0, start) + text + this.value.slice(end);
		if (mode === 'end') this.setSelectionRange(start + text.length, start + text.length);
	}
	focus(): void { this.ownerDocument.activeElement = this; }
	click(): void { if (!this.disabled) this.dispatchEvent(new Event('click', { bubbles: true, cancelable: true })); }
}

class FakeDocument extends EventTarget {
	readonly body = new FakeElement(this, 'body');
	activeElement: FakeElement | null = null;
	readonly defaultView: FakeWindow;
	constructor() {
		super();
		this.defaultView = new FakeWindow();
	}
	createElement(tagName: string): FakeElement { return new FakeElement(this, tagName); }
	createTextNode(text: string): FakeText { return new FakeText(text); }
	querySelector(selector: string): FakeElement | null {
		const className = selector.slice(1);
		const visit = (element: FakeElement): FakeElement | null => {
			if (element.className.split(/\s+/).includes(className)) return element;
			for (const child of element.children) {
				if (child instanceof FakeElement) {
					const found = visit(child);
					if (found) return found;
				}
			}
			return null;
		};
		return visit(this.body);
	}
}

class FakeWindow extends EventTarget {
	SpeechRecognition?: new () => FakeSpeechRecognition;
	webkitSpeechRecognition?: new () => FakeSpeechRecognition;
	innerWidth = 900;
	innerHeight = 700;
	requestAnimationFrame = vi.fn(() => 1);
	cancelAnimationFrame = vi.fn();
	private nextTimerId = 0;
	private readonly timers = new Map<number, () => void>();
	setTimeout = vi.fn((callback: TimerHandler) => {
		const id = ++this.nextTimerId;
		this.timers.set(id, callback as () => void);
		return id;
	});
	clearTimeout = vi.fn((id: number) => { this.timers.delete(id); });
	runTimers(): void {
		const callbacks = [...this.timers.values()];
		this.timers.clear();
		for (const callback of callbacks) callback();
	}
	getSelection = () => ({ isCollapsed: true });
}

class FakeSpeechRecognition extends EventTarget {
	start = vi.fn();
	stop = vi.fn();
	abort = vi.fn();
	result(resultIndex: number, ...items: Array<[transcript: string, isFinal: boolean]>) {
		const results = items.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal }));
		this.dispatchEvent(Object.assign(new Event('result'), { resultIndex, results }));
	}
	fail(error: string) {
		this.dispatchEvent(Object.assign(new Event('error'), { error }));
	}
}

function descendants(element: FakeElement): FakeElement[] {
	return element.children.flatMap((child) => child instanceof FakeElement ? [child, ...descendants(child)] : []);
}

function keyEvent(key: string, options: Record<string, unknown> = {}): Event {
	const event = new Event('keydown', { bubbles: true, cancelable: true });
	Object.defineProperty(event, 'key', { value: key });
	for (const [name, value] of Object.entries(options)) Object.defineProperty(event, name, { value });
	return event;
}

function openEditor(initial: string, onSave: (note: string) => Promise<boolean | void> = async () => undefined, doc = new FakeDocument()) {
	const app = { keymap: { pushScope: vi.fn(), popScope: vi.fn() } };
	const onCancel = vi.fn();
	const popup = showNoteEditorPopup(app as never, doc as unknown as Document, { x: 10, y: 10 }, {
		initial, onSave, onCancel,
	});
	const card = popup.el as unknown as FakeElement;
	const nodes = descendants(card);
	const input = nodes.find((node) => node.tagName === 'textarea')!;
	const button = (label: string) => nodes.find((node) => node.tagName === 'button' && node.getAttribute('aria-label') === label)!;
	return { app, card, doc, input, nodes, onCancel, popup, button };
}

afterEach(() => vi.clearAllMocks());

describe('note editor formatting controls', () => {
	it('formats the selected text with toolbar buttons and Cmd/Ctrl shortcuts, preserving Unicode and caret', () => {
		const f = openEditor('Tähendus');
		f.input.setSelectionRange(0, f.input.value.length);
		f.button('Bold').click();
		expect(f.input.value).toBe('**Tähendus**');
		expect([f.input.selectionStart, f.input.selectionEnd]).toEqual([2, 10]);
		f.button('Italic').click();
		expect(f.input.value).toBe('***Tähendus***');

		f.input.value = 'café';
		f.input.setSelectionRange(0, 4);
		const shortcut = keyEvent('b', { ctrlKey: true });
		f.input.dispatchEvent(shortcut);
		expect(shortcut.defaultPrevented).toBe(true);
		expect(f.input.value).toBe('**café**');
		f.popup.hide();
	});

	it('formats multiline notes line by line and restores the caret after preview', () => {
		const f = openEditor('first\nsecond');
		f.input.setSelectionRange(0, f.input.value.length);
		f.button('Bullet list').click();
		expect(f.input.value).toBe('• first\n• second');
		f.input.setSelectionRange(2, 7);
		f.button('Bold').click();
		expect(f.input.value).toBe('• **first**\n• second');
		const position = [f.input.selectionStart, f.input.selectionEnd];
		f.button('Preview note').click();
		expect(f.button('Edit note').getAttribute('aria-pressed')).toBe('true');
		expect(f.button('Bold').disabled).toBe(true);
		expect(descendants(f.card).some((node) => node.tagName === 'strong')).toBe(true);
		f.button('Edit note').click();
		expect([f.input.selectionStart, f.input.selectionEnd]).toEqual(position);
		f.input.setSelectionRange(0, f.input.value.length);
		f.button('Numbered list').click();
		expect(f.input.value).toBe('1. **first**\n2. second');
		f.input.setSelectionRange(0, f.input.value.length);
		f.button('Numbered list').click();
		expect(f.input.value).toBe('**first**\nsecond');
		f.popup.hide();
	});

	it('blocks formatting and preview during IME composition, then restores controls', () => {
		const f = openEditor('compose');
		f.input.setSelectionRange(0, f.input.value.length);
		f.input.dispatchEvent(new Event('compositionstart'));
		expect(f.button('Bold').disabled).toBe(true);
		expect(f.button('Preview note').disabled).toBe(true);
		const shortcut = keyEvent('b', { metaKey: true });
		f.input.dispatchEvent(shortcut);
		expect(shortcut.defaultPrevented).toBe(false);
		expect(f.input.value).toBe('compose');
		f.input.dispatchEvent(new Event('compositionend'));
		expect(f.button('Bold').disabled).toBe(false);
		f.popup.hide();
	});

	it('retains a failed draft, disables controls while saving, and saves Markdown source verbatim on retry', async () => {
		let attempts = 0;
		const onSave = vi.fn(async (note: string) => {
			attempts++;
			return attempts === 1 ? false : undefined;
		});
		const f = openEditor('Review this passage', onSave);
		f.input.setSelectionRange(0, 6);
		f.button('Bold').click();
		const source = '**Review** this passage';
		expect(f.input.value).toBe(source);

		f.button('Save note').click();
		expect(f.input.disabled).toBe(true);
		expect(f.button('Bold').disabled).toBe(true);
		await Promise.resolve();
		await Promise.resolve();
		expect(f.button('Save note').disabled).toBe(false);
		expect(f.input.value).toBe(source);

		f.input.value = `${source}!`;
		f.input.dispatchEvent(new Event('input', { bubbles: true }));
		expect(f.nodes.find((node) => node.className === 'study-pdf-note-status')?.getAttribute('data-state')).toBeNull();
		f.button('Save note').click();
		await Promise.resolve();
		await Promise.resolve();
		expect(onSave).toHaveBeenNthCalledWith(1, source);
		expect(onSave).toHaveBeenNthCalledWith(2, `${source}!`);
		expect(f.nodes.find((node) => node.className === 'study-pdf-note-status')?.getAttribute('data-state')).toBe('saved');
		f.popup.hide();
	});

	it('saves an unchanged draft only once, even when Enter is pressed again before close', async () => {
		const onSave = vi.fn(async () => undefined);
		const f = openEditor('Keep this note', onSave);
		const enter = () => f.input.dispatchEvent(keyEvent('Enter'));

		enter();
		await Promise.resolve();
		await Promise.resolve();
		expect(f.nodes.find((node) => node.className === 'study-pdf-note-status')?.getAttribute('data-state')).toBe('saved');
		enter();
		await Promise.resolve();

		expect(onSave).toHaveBeenCalledOnce();
		expect(f.popup.el.isConnected).toBe(true);
		f.popup.hide();
	});

	it('cancels the saved close when the draft changes and permits the edited note to be saved again', async () => {
		const onSave = vi.fn(async () => undefined);
		const onSaved = vi.fn();
		const f = openEditor('Original note', onSave);
		const status = f.nodes.find((node) => node.className === 'study-pdf-note-status')!;

		f.button('Save note').click();
		await Promise.resolve();
		await Promise.resolve();
		expect(f.doc.defaultView.setTimeout).toHaveBeenCalledOnce();

		f.input.value = 'Edited note';
		f.input.dispatchEvent(new Event('input', { bubbles: true }));
		expect(f.doc.defaultView.clearTimeout).toHaveBeenCalledOnce();
		expect(status.getAttribute('data-state')).toBeNull();
		f.button('Save note').click();
		await Promise.resolve();
		await Promise.resolve();
		expect(onSave).toHaveBeenNthCalledWith(2, 'Edited note');

		f.doc.defaultView.runTimers();
		expect(onSaved).not.toHaveBeenCalled();
		f.popup.hide();
	});
});

describe('note dictation', () => {
	function dictationEditor(initial = 'before draft after', onSave = vi.fn(async () => undefined)) {
		const doc = new FakeDocument();
		const recognition = new FakeSpeechRecognition();
		doc.defaultView.webkitSpeechRecognition = class extends FakeSpeechRecognition { constructor() { super(); return recognition; } };
		const f = openEditor(initial, onSave, doc);
		const mic = f.button('Dictate note');
		const status = f.nodes.find((node) => node.getAttribute('role') === 'status')!;
		return { ...f, mic, status, recognition, onSave };
	}

	it('asks before starting, inserts each final result at the selection and leaves the draft unsaved', () => {
		const f = dictationEditor();
		f.input.setSelectionRange(7, 12);
		expect(f.popup.preserveOnBlur).toBe(false);
		expect(f.recognition.start).not.toHaveBeenCalled();
		f.mic.click();
		expect(f.status.textContent).toContain('process audio online');
		expect(f.recognition.start).not.toHaveBeenCalled();
		f.mic.click();
		expect(f.recognition.start).toHaveBeenCalledOnce();
		expect(f.popup.preserveOnBlur).toBe(true);
		f.recognition.dispatchEvent(new Event('start'));
		expect(f.mic.getAttribute('aria-pressed')).toBe('true');
		f.recognition.result(0, ['interim', false]);
		expect(f.input.value).toBe('before draft after');
		f.recognition.result(0, ['new idea', true]);
		f.mic.click();
		expect(f.recognition.stop).toHaveBeenCalledOnce();
		f.recognition.result(1, ['new idea', true], ['today', true]);
		f.recognition.dispatchEvent(new Event('end'));
		expect(f.input.value).toBe('before new idea today after');
		expect([f.input.selectionStart, f.input.selectionEnd]).toEqual([21, 21]);
		expect(f.nodes.find((node) => node.className === 'study-pdf-note-word-count')?.textContent).toMatch(/^5 \/ /);
		expect(f.mic.getAttribute('aria-pressed')).toBe('false');
		expect(f.popup.preserveOnBlur).toBe(false);
		expect(f.onSave).not.toHaveBeenCalled();
		f.popup.hide();
	});

	it('aborts on close and rejects late results without altering the draft', () => {
		const f = dictationEditor();
		f.mic.click();
		f.mic.click();
		f.popup.hide();
		f.recognition.result(0, ['late result', true]);
		expect(f.recognition.abort).toHaveBeenCalledOnce();
		expect(f.input.value).toBe('before draft after');
		expect(f.onSave).not.toHaveBeenCalled();
	});

	it('aborts before saving so late dictation cannot change the saved draft', () => {
		const f = dictationEditor('original draft');
		f.mic.click();
		f.mic.click();
		f.button('Save note').click();
		f.recognition.result(0, ['late result', true]);
		expect(f.recognition.abort).toHaveBeenCalledOnce();
		expect(f.onSave).toHaveBeenCalledExactlyOnceWith('original draft');
		expect(f.input.value).toBe('original draft');
		f.popup.hide();
	});

	it('offers keyboard Dictation when built-in recognition is unavailable', () => {
		const f = openEditor('draft');
		f.button('Dictate note').click();
		expect(f.nodes.find((node) => node.getAttribute('role') === 'status')?.textContent).toContain('keyboard Dictation');
		expect(f.input.value).toBe('draft');
		f.popup.hide();
	});

	it('offers keyboard Dictation if the app stops recognition without a transcript', () => {
		const f = dictationEditor();
		f.mic.click();
		f.mic.click();
		f.recognition.dispatchEvent(new Event('end'));
		expect(f.status.textContent).toContain('No speech was transcribed');
		expect(f.status.textContent).toContain('keyboard Dictation');
		f.popup.hide();
	});

	it.each([
		['not-allowed', 'Microphone access was denied'],
		['network', 'Speech recognition service is unavailable'],
	])('reports %s and leaves the draft editable with keyboard Dictation as a fallback', (error, message) => {
		const f = dictationEditor();
		f.mic.click();
		f.mic.click();
		f.recognition.fail(error);
		f.recognition.dispatchEvent(new Event('end'));
		expect(f.status.textContent).toContain(message);
		expect(f.status.textContent).toContain('keyboard Dictation');
		expect(f.mic.getAttribute('aria-pressed')).toBe('false');
		expect(f.button('Bold').disabled).toBe(false);
		expect(f.input.value).toBe('before draft after');
		f.popup.hide();
	});
});
