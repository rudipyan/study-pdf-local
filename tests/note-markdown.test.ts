import { describe, expect, it } from 'vitest';
import type { HighlightEntry } from '../src/pdf-highlights';
import { collectHighlightColors, filterHighlightsByColor } from '../src/ui/highlight-color-filter';
import { formatNoteSelection } from '../src/ui/note-markdown-formatting';
import { renderNoteMarkdown } from '../src/ui/note-markdown';

type FakeChild = FakeElement | FakeText;

class FakeText {
	constructor(readonly textContent: string) {}
}

class FakeDocument {
	createElement(tagName: string): FakeElement { return new FakeElement(this, tagName); }
	createTextNode(text: string): FakeText { return new FakeText(text); }
}

class FakeElement {
	readonly children: FakeChild[] = [];
	readonly attributes = new Map<string, string>();
	constructor(readonly ownerDocument: FakeDocument, readonly tagName: string) {}
	appendChild<T extends FakeChild>(child: T): T { this.children.push(child); return child; }
	setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
	getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
	replaceChildren(): void { this.children.length = 0; }
	get textContent(): string { return this.children.map((child) => child.textContent).join(''); }
}

function element(document: FakeDocument): FakeElement {
	return document.createElement('div');
}

function tags(node: FakeElement): string[] {
	return [node.tagName, ...node.children.flatMap((child) => child instanceof FakeElement ? tags(child) : [])];
}

function entry(colorCss: string, quote: string): HighlightEntry {
	return { pageNumber: 1, top: 1, colorCss, quote, note: null, annotationId: null };
}

describe('highlight color filters', () => {
	it('counts each scanned custom or legacy color once in first-seen order', () => {
		const entries = [entry('rgb(1, 2, 3)', 'a'), entry('#abc', 'b'), entry('rgb(1, 2, 3)', 'c'), entry('legacy-blue', 'd')];
		expect(collectHighlightColors(entries)).toEqual([
			{ colorCss: 'rgb(1, 2, 3)', count: 2 },
			{ colorCss: '#abc', count: 1 },
			{ colorCss: 'legacy-blue', count: 1 },
		]);
	});

	it('keeps reading order for OR filters and returns every entry when reset', () => {
		const entries = [entry('a', 'first'), entry('b', 'second'), entry('c', 'third'), entry('b', 'fourth')];
		expect(filterHighlightsByColor(entries, new Set(['b', 'a'])).map(({ quote }) => quote)).toEqual(['first', 'second', 'fourth']);
		expect(filterHighlightsByColor(entries, new Set()).map(({ quote }) => quote)).toEqual(['first', 'second', 'third', 'fourth']);
	});
});

describe('note formatting selections', () => {
	it('wraps selected Unicode text and inserts an empty pair at the caret', () => {
		expect(formatNoteSelection('A😀B', 1, 3, 'bold')).toEqual({
			value: 'A**😀**B', selectionStart: 3, selectionEnd: 5,
		});
		expect(formatNoteSelection('ab', 1, 1, 'italic')).toEqual({
			value: 'a**b',
			selectionStart: 2, selectionEnd: 2,
		});
	});

	it('formats multiline selections line by line without unmatched delimiters', () => {
		const bold = formatNoteSelection('first\nsecond', 0, 12, 'bold');
		expect(bold.value).toBe('**first**\n**second**');
		expect(bold.selectionStart).toBe(2);
		expect(bold.selectionEnd).toBe(18);
		const short = formatNoteSelection('a\nb', 0, 3, 'bold');
		expect(short).toEqual({ value: '**a**\n**b**', selectionStart: 2, selectionEnd: 9 });
		expect(formatNoteSelection('- a\n- b', 0, 7, 'bold').value).toBe('- **a**\n- **b**');
		const newline = formatNoteSelection('a\nb', 0, 2, 'bold');
		expect(newline).toEqual({ value: '**a**\nb', selectionStart: 2, selectionEnd: 6 });
		const boldText = formatNoteSelection('text', 0, 4, 'bold');
		const both = formatNoteSelection(boldText.value, boldText.selectionStart, boldText.selectionEnd, 'italic');
		expect(both.value).toBe('***text***');
	});

	it('inserts round bullets or numbering at blank-line carets without spilling to adjacent lines', () => {
		expect(formatNoteSelection('', 0, 0, 'bullets')).toEqual({ value: '• ', selectionStart: 2, selectionEnd: 2 });
		expect(formatNoteSelection('', 0, 0, 'numbered')).toEqual({ value: '1. ', selectionStart: 3, selectionEnd: 3 });
		expect(formatNoteSelection('\nsecond line', 0, 0, 'bullets')).toEqual({
			value: '• \nsecond line', selectionStart: 2, selectionEnd: 2,
		});
		expect(formatNoteSelection('\nsecond line', 1, 1, 'bullets')).toEqual({
			value: '\n• second line', selectionStart: 3, selectionEnd: 3,
		});
	});

	it('converts and toggles list kinds while preserving indentation, blank lines, and unselected lines', () => {
		const source = 'first\nsecond';
		const bullet = formatNoteSelection(source, 0, source.length, 'bullets');
		expect(bullet.value).toBe('• first\n• second');
		const numbered = formatNoteSelection(bullet.value, bullet.selectionStart, bullet.selectionEnd, 'numbered');
		expect(numbered.value).toBe('1. first\n2. second');
		const plain = formatNoteSelection(numbered.value, numbered.selectionStart, numbered.selectionEnd, 'numbered');
		expect(plain.value).toBe(source);
		expect(formatNoteSelection('  - one\n  3. two', 0, 16, 'numbered').value).toBe('  1. one\n  2. two');
		expect(formatNoteSelection('first\n\nthird\nuntouched', 0, 12, 'numbered').value).toBe('1. first\n\n1. third\nuntouched');
		expect(formatNoteSelection('first\nsecond', 0, 6, 'bullets').value).toBe('• first\nsecond');
		expect(formatNoteSelection('  first', 4, 4, 'numbered')).toEqual({
			value: '  1. first', selectionStart: 7, selectionEnd: 7,
		});
	});

	it('protects every supported list prefix when applying emphasis', () => {
		const source = '- first\n* second\n• third\n  4. fourth';
		expect(formatNoteSelection(source, 0, source.length, 'bold').value)
			.toBe('- **first**\n* **second**\n• **third**\n  4. **fourth**');
	});

	it('converts and toggles empty prefixed list items while keeping the caret at the new prefix', () => {
		expect(formatNoteSelection('• ', 2, 2, 'numbered')).toEqual({ value: '1. ', selectionStart: 3, selectionEnd: 3 });
		expect(formatNoteSelection('• ', 2, 2, 'bullets')).toEqual({ value: '', selectionStart: 0, selectionEnd: 0 });
		expect(formatNoteSelection('1. ', 3, 3, 'numbered')).toEqual({ value: '', selectionStart: 0, selectionEnd: 0 });
		expect(formatNoteSelection('1. ', 3, 3, 'bullets')).toEqual({ value: '• ', selectionStart: 2, selectionEnd: 2 });
	});
});

describe('safe note Markdown preview', () => {
	it('renders combined and nested emphasis with structural elements', () => {
		const doc = new FakeDocument();
		const root = element(doc);
		renderNoteMarkdown(root as unknown as HTMLElement, '***Both*** and **bold *inside* text**');
		expect(tags(root)).toEqual(['div', 'p', 'strong', 'em', 'strong', 'em']);
		expect(root.textContent).toBe('Both and bold inside text');
	});

	it('keeps HTML, links, and images inert while showing escaped and unmatched delimiters as text', () => {
		const doc = new FakeDocument();
		const root = element(doc);
		const source = '<img src=x onerror=alert(1)> [x](javascript:alert(1)) ![x](https://example.test) literal \\*star\\* and **unfinished';
		renderNoteMarkdown(root as unknown as HTMLElement, source);
		expect(tags(root)).toEqual(['div', 'p']);
		expect(root.children.every((child) => child instanceof FakeText || child instanceof FakeElement)).toBe(true);
		expect(root.textContent).toBe('<img src=x onerror=alert(1)> [x](javascript:alert(1)) ![x](https://example.test) literal *star* and **unfinished');
	});

	it('preserves paragraph line breaks and groups consecutive bullets', () => {
		const doc = new FakeDocument();
		const root = element(doc);
		renderNoteMarkdown(root as unknown as HTMLElement, 'first line\nsecond line\n\n- one **bold**\n- two\n\nlast');
		expect(tags(root)).toEqual(['div', 'p', 'br', 'ul', 'li', 'strong', 'li', 'p']);
		expect(root.textContent).toBe('first linesecond lineone boldtwolast');
	});

	it('renders round bullets, ordered numbering starts, and explicit sequence changes safely', () => {
		const doc = new FakeDocument();
		const root = element(doc);
		renderNoteMarkdown(root as unknown as HTMLElement, '• round one\n• round two\n\n3. third\n5. fifth');
		expect(tags(root)).toEqual(['div', 'ul', 'li', 'li', 'ol', 'li', 'li']);
		expect(root.children[1]?.getAttribute('start')).toBe('3');
		expect(root.children[1]?.children[1]?.getAttribute('value')).toBe('5');
		expect(root.textContent).toBe('round oneround twothirdfifth');
	});
});
