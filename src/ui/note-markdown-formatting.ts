import { readNoteListPrefix, type NoteListKind } from './note-markdown-list-prefix';

export type NoteFormattingAction = 'bold' | 'italic' | 'bullets' | 'numbered';

export interface FormattedNoteSelection {
	value: string;
	selectionStart: number;
	selectionEnd: number;
}

interface TextEdit {
	from: number;
	to: number;
	text: string;
	kind?: 'open' | 'close';
}

/** Apply a compact Markdown edit without touching the textarea or persistence. */
export function formatNoteSelection(
	value: string,
	selectionStart: number,
	selectionEnd: number,
	action: NoteFormattingAction,
): FormattedNoteSelection {
	const start = Math.max(0, Math.min(value.length, selectionStart));
	const end = Math.max(start, Math.min(value.length, selectionEnd));
	if (action === 'bullets' || action === 'numbered') return formatList(value, start, end, action === 'bullets' ? 'bullet' : 'numbered');

	const marker = action === 'bold' ? '**' : '*';
	if (start === end) {
		const replacement = marker + marker;
		return { value: value.slice(0, start) + replacement + value.slice(end), selectionStart: start + marker.length, selectionEnd: start + marker.length };
	}
	const insertions: Array<{ position: number; text: string; kind: 'open' | 'close' }> = [];
	let lineStart = 0;
	while (lineStart < value.length) {
		const lineBreak = value.indexOf('\n', lineStart);
		const lineEnd = lineBreak < 0 ? value.length : lineBreak;
		const selectedStart = Math.max(start, lineStart);
		const selectedEnd = Math.min(end, lineEnd);
		if (selectedStart < selectedEnd) {
			const line = value.slice(lineStart, lineEnd);
			const prefix = readNoteListPrefix(line);
			const contentStart = Math.max(selectedStart, lineStart + (prefix?.length ?? 0));
			const content = value.slice(contentStart, selectedEnd);
			if (contentStart < selectedEnd && content.trim().length > 0) {
				insertions.push({ position: contentStart, text: marker, kind: 'open' });
				insertions.push({ position: selectedEnd, text: marker, kind: 'close' });
			}
		}
		if (lineBreak < 0) break;
		lineStart = lineBreak + 1;
	}
	const edits = insertions.map(({ position, text, kind }) => ({ from: position, to: position, text, kind }));
	return {
		value: applyEdits(value, edits),
		selectionStart: mapBoundary(start, edits, 'start'),
		selectionEnd: mapBoundary(end, edits, 'end'),
	};
}

function formatList(value: string, start: number, end: number, requestedKind: NoteListKind): FormattedNoteSelection {
	const firstLineStart = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
	const selectedEnd = end > start && value[end - 1] === '\n' ? end - 1 : end;
	const lastLineStart = selectedEnd === 0 ? 0 : value.lastIndexOf('\n', selectedEnd - 1) + 1;
	const lineStarts: number[] = [];
	for (let lineStart = firstLineStart; lineStart <= lastLineStart;) {
		lineStarts.push(lineStart);
		const lineBreak = value.indexOf('\n', lineStart);
		if (lineBreak < 0 || lineBreak >= lastLineStart) break;
		lineStart = lineBreak + 1;
	}
	const lines = lineStarts.map((lineStart) => {
		const lineEnd = value.indexOf('\n', lineStart);
		const endAt = lineEnd < 0 ? value.length : lineEnd;
		return { start: lineStart, end: endAt, text: value.slice(lineStart, endAt), prefix: readNoteListPrefix(value.slice(lineStart, endAt)) };
	});
	const nonBlank = lines.filter(({ text, prefix }) => prefix !== null || text.trim().length > 0);
	const removeRequested = nonBlank.length > 0 && nonBlank.every(({ prefix }) => prefix?.kind === requestedKind);
	const edits: TextEdit[] = [];
	let nextNumber = 1;
	for (const line of lines) {
		const prefix = line.prefix;
		const content = line.text.slice(prefix?.length ?? 0);
		if (content.trim().length === 0 && !prefix) {
			if (requestedKind === 'numbered') nextNumber = 1;
			continue;
		}
		const indentLength = prefix?.indent.length ?? (/^[ \t]*/.exec(line.text)?.[0].length ?? 0);
		const from = line.start + indentLength;
		const to = line.start + (prefix?.length ?? indentLength);
		let text = '';
		if (!removeRequested) {
			text = requestedKind === 'bullet' ? '• ' : `${nextNumber}. `;
			nextNumber++;
		}
		edits.push({ from, to, text });
	}
	const blankCaretLine = start === end && lines.length === 1 && lines[0]!.text.trim().length === 0;
	if (blankCaretLine && edits.length === 0) {
		const line = lines[0]!;
		const indent = /^[ \t]*/.exec(line.text)?.[0] ?? '';
		edits.push({ from: line.start + indent.length, to: line.start + indent.length, text: requestedKind === 'bullet' ? '• ' : '1. ' });
	}
	return {
		value: applyEdits(value, edits),
		selectionStart: mapBoundary(start, edits, 'list'),
		selectionEnd: mapBoundary(end, edits, 'list'),
	};
}

function applyEdits(value: string, edits: TextEdit[]): string {
	if (edits.length === 0) return value;
	let result = '';
	let cursor = 0;
	for (const edit of edits) {
		result += value.slice(cursor, edit.from) + edit.text;
		cursor = edit.to;
	}
	return result + value.slice(cursor);
}

/** Map a source caret through edits; an insertion at the caret follows its new prefix. */
function mapBoundary(position: number, edits: TextEdit[], boundary: 'start' | 'end' | 'list'): number {
	let delta = 0;
	for (const edit of edits) {
		if (position < edit.from) break;
		if (edit.from === edit.to && position === edit.from) {
			if (boundary === 'end' && edit.kind === 'close') return position + delta;
			delta += edit.text.length;
			continue;
		}
		if (position < edit.to) return edit.from + delta + edit.text.length;
		delta += edit.text.length - (edit.to - edit.from);
	}
	return position + delta;
}
