export type NoteListKind = 'bullet' | 'numbered';

export interface NoteListPrefix {
	kind: NoteListKind;
	indent: string;
	length: number;
	number?: number;
}

/** Read only the supported list prefixes from one Markdown source line. */
export function readNoteListPrefix(line: string): NoteListPrefix | null {
	const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
	const marker = line.slice(indent.length);
	if (/^[-*•][ \t]+/.test(marker)) {
		const prefix = /^[-*•][ \t]+/.exec(marker)![0];
		return { kind: 'bullet', indent, length: indent.length + prefix.length };
	}
	const numbered = /^(\d+)\.[ \t]+/.exec(marker);
	if (numbered) return { kind: 'numbered', indent, length: indent.length + numbered[0].length, number: Number(numbered[1]) };
	return null;
}
