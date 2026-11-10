import { readNoteListPrefix, type NoteListKind } from './note-markdown-list-prefix';

type InlineTag = 'strong' | 'em' | 'strong-em';
interface Delimiter {
	marker: string;
	tag: InlineTag;
}

const DELIMITERS: Delimiter[] = [
	{ marker: '***', tag: 'strong-em' },
	{ marker: '___', tag: 'strong-em' },
	{ marker: '**', tag: 'strong' },
	{ marker: '__', tag: 'strong' },
	{ marker: '*', tag: 'em' },
	{ marker: '_', tag: 'em' },
];
const MAX_NESTING = 8;

/** Render the small note subset using only text nodes and safe structural tags. */
export function renderNoteMarkdown(container: HTMLElement, markdown: string): void {
	container.replaceChildren();
	const doc = container.ownerDocument;
	let paragraph: HTMLElement | null = null;
	let list: HTMLElement | null = null;
	let listKind: NoteListKind | null = null;
	let nextNumber = 1;
	for (const line of markdown.split('\n')) {
		if (line.trim().length === 0) {
			paragraph = null;
			list = null;
			listKind = null;
			nextNumber = 1;
			continue;
		}
		const prefix = readNoteListPrefix(line);
		if (prefix) {
			paragraph = null;
			if (listKind !== prefix.kind) {
				listKind = prefix.kind;
				list = appendElement(container, doc, prefix.kind === 'bullet' ? 'ul' : 'ol');
				nextNumber = prefix.number ?? 1;
				if (prefix.kind === 'numbered' && nextNumber !== 1) list.setAttribute('start', String(nextNumber));
			}
			const item = appendElement(list!, doc, 'li');
			if (prefix.kind === 'numbered') {
				const number = prefix.number ?? nextNumber;
				if (number !== nextNumber) item.setAttribute('value', String(number));
				nextNumber = number + 1;
			}
			renderInline(item, line.slice(prefix.length), 0);
			continue;
		}
		list = null;
		listKind = null;
		if (!paragraph) paragraph = appendElement(container, doc, 'p');
		else paragraph.appendChild(doc.createElement('br'));
		renderInline(paragraph, line, 0);
	}
}

function appendElement(parent: HTMLElement, doc: Document, tag: 'p' | 'ul' | 'ol' | 'li' | 'strong' | 'em' | 'strong-em'): HTMLElement {
	const element = doc.createElement(tag === 'strong-em' ? 'strong' : tag);
	parent.appendChild(element);
	if (tag !== 'strong-em') return element;
	const emphasis = doc.createElement('em');
	element.appendChild(emphasis);
	return emphasis;
}

function isEscaped(text: string, index: number): boolean {
	let slashes = 0;
	for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) slashes++;
	return slashes % 2 === 1;
}

function closingDelimiter(text: string, marker: string, from: number): number {
	for (let cursor = from; cursor < text.length;) {
		if (text[cursor] === '\\' && cursor + 1 < text.length) {
			cursor += 2;
			continue;
		}
		if (marker.length === 1 && text[cursor] === marker && text[cursor + 1] === marker) {
			cursor += 2;
			continue;
		}
		if (text.startsWith(marker, cursor) && !isEscaped(text, cursor)) return cursor;
		cursor++;
	}
	return -1;
}

function renderInline(parent: HTMLElement, text: string, depth: number): void {
	const doc = parent.ownerDocument;
	let plain = '';
	const flush = () => {
		if (!plain) return;
		parent.appendChild(doc.createTextNode(plain));
		plain = '';
	};

	for (let cursor = 0; cursor < text.length;) {
		if (text[cursor] === '\\' && cursor + 1 < text.length && /[*_\\]/.test(text[cursor + 1]!)) {
			plain += text[cursor + 1]!;
			cursor += 2;
			continue;
		}
		const delimiter = DELIMITERS.find((candidate) =>
			text.startsWith(candidate.marker, cursor) && !isEscaped(text, cursor));
		if (!delimiter) {
			plain += text[cursor]!;
			cursor++;
			continue;
		}
		const closing = closingDelimiter(text, delimiter.marker, cursor + delimiter.marker.length);
		if (closing < 0 || depth >= MAX_NESTING) {
			plain += delimiter.marker;
			cursor += delimiter.marker.length;
			continue;
		}
		flush();
		const element = appendElement(parent, doc, delimiter.tag);
		renderInline(element, text.slice(cursor + delimiter.marker.length, closing), depth + 1);
		cursor = closing + delimiter.marker.length;
	}
	flush();
}
