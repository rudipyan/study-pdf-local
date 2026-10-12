export const MAX_PDF_HISTORY_BYTES = 64 * 1024 * 1024;
export const MAX_PDF_HISTORY_STEPS = 30;

export type PdfHistoryDirection = 'undo' | 'redo';

export interface PdfHistoryStatus {
	canUndo: boolean;
	canRedo: boolean;
}

export interface PdfHistoryTransition {
	targetBytes: Uint8Array;
	pageIndexes: number[];
	commit(): boolean;
}

export type PdfHistoryResolution =
	| { status: 'empty' | 'mismatch' }
	| { status: 'ready'; transition: PdfHistoryTransition };

export type PdfHistoryRecordResult =
	| { status: 'recorded'; evictedHistories: number }
	| { status: 'too-large' };

interface PdfHistoryState {
	readonly bytes: Uint8Array;
}

interface PdfHistoryStep {
	readonly pageIndexes: readonly number[];
}

interface FileHistory<File extends { path: string }> {
	readonly file: File;
	readonly path: string;
	readonly states: PdfHistoryState[];
	readonly steps: PdfHistoryStep[];
	cursor: number;
	lastUsed: number;
}

/** Bounded, in-memory PDF snapshots. File bytes are never persisted. */
export class PdfAnnotationHistory<File extends { path: string }> {
	private readonly histories = new Map<string, FileHistory<File>>();
	private bytesUsed = 0;
	private useCounter = 0;

	status(file: File, path: string): PdfHistoryStatus {
		const history = this.getForFile(file, path);
		if (!history) return { canUndo: false, canRedo: false };
		history.lastUsed = ++this.useCounter;
		return { canUndo: history.cursor > 0, canRedo: history.cursor < history.steps.length };
	}

	record(
		file: File,
		path: string,
		beforeBytes: Uint8Array,
		afterBytes: Uint8Array,
		pageIndexes: readonly number[],
	): PdfHistoryRecordResult {
		if (bytesEqual(beforeBytes, afterBytes)) return { status: 'recorded', evictedHistories: 0 };
		if (beforeBytes.byteLength + afterBytes.byteLength > MAX_PDF_HISTORY_BYTES) {
			this.deleteHistory(path);
			return { status: 'too-large' };
		}

		let evictedHistories = 0;
		let history = this.getForFile(file, path);
		if (history && !bytesEqual(history.states[history.cursor]!.bytes, beforeBytes)) {
			this.deleteHistory(path);
			history = undefined;
		}

		if (!history) {
			const required = beforeBytes.byteLength + afterBytes.byteLength;
			evictedHistories += this.makeRoom(required, path);
			if (this.bytesUsed + required > MAX_PDF_HISTORY_BYTES) return { status: 'too-large' };
			history = {
				file,
				path,
				states: [{ bytes: Uint8Array.from(beforeBytes) }, { bytes: Uint8Array.from(afterBytes) }],
				steps: [{ pageIndexes: normalizePageIndexes(pageIndexes) }],
				cursor: 1,
				lastUsed: ++this.useCounter,
			};
			this.histories.set(path, history);
			this.bytesUsed += required;
			return { status: 'recorded', evictedHistories };
		}

		this.truncateRedo(history);
		while (this.bytesUsed + afterBytes.byteLength > MAX_PDF_HISTORY_BYTES) {
			const oldestOther = this.oldestOtherHistory(path);
			if (oldestOther) {
				this.deleteHistory(oldestOther.path);
				evictedHistories++;
				continue;
			}
			if (this.dropOldestStep(history)) continue;
			break;
		}
		if (this.bytesUsed + afterBytes.byteLength > MAX_PDF_HISTORY_BYTES) {
			this.deleteHistory(path);
			const required = beforeBytes.byteLength + afterBytes.byteLength;
			evictedHistories += this.makeRoom(required, path);
			if (this.bytesUsed + required > MAX_PDF_HISTORY_BYTES) return { status: 'too-large' };
			history = {
				file,
				path,
				states: [{ bytes: Uint8Array.from(beforeBytes) }, { bytes: Uint8Array.from(afterBytes) }],
				steps: [{ pageIndexes: normalizePageIndexes(pageIndexes) }],
				cursor: 1,
				lastUsed: ++this.useCounter,
			};
			this.histories.set(path, history);
			this.bytesUsed += required;
			return { status: 'recorded', evictedHistories };
		}

		history.states.push({ bytes: Uint8Array.from(afterBytes) });
		history.steps.push({ pageIndexes: normalizePageIndexes(pageIndexes) });
		history.cursor++;
		history.lastUsed = ++this.useCounter;
		this.bytesUsed += afterBytes.byteLength;
		while (history.steps.length > MAX_PDF_HISTORY_STEPS) this.dropOldestStep(history);
		return { status: 'recorded', evictedHistories };
	}

	resolve(
		file: File,
		path: string,
		currentBytes: Uint8Array,
		direction: PdfHistoryDirection,
	): PdfHistoryResolution {
		const history = this.histories.get(path);
		if (!history) return { status: 'empty' };
		if (history.file !== file) {
			this.deleteHistory(path);
			return { status: 'mismatch' };
		}
		history.lastUsed = ++this.useCounter;
		const sourceIndex = history.cursor;
		const stepIndex = direction === 'undo' ? history.cursor - 1 : history.cursor;
		const targetIndex = direction === 'undo' ? history.cursor - 1 : history.cursor + 1;
		if (stepIndex < 0 || stepIndex >= history.steps.length || targetIndex < 0 || targetIndex >= history.states.length) {
			return { status: 'empty' };
		}
		const source = history.states[sourceIndex];
		const target = history.states[targetIndex];
		if (!source || !target || !bytesEqual(source.bytes, currentBytes)) {
			this.deleteHistory(path);
			return { status: 'mismatch' };
		}
		const cursor = history.cursor;
		const step = history.steps[stepIndex]!;
		return {
			status: 'ready',
			transition: {
				targetBytes: Uint8Array.from(target.bytes),
				pageIndexes: [...step.pageIndexes],
				commit: () => {
					if (this.histories.get(path) !== history || history.file !== file || history.cursor !== cursor) return false;
					history.cursor += direction === 'undo' ? -1 : 1;
					history.lastUsed = ++this.useCounter;
					return true;
				},
			},
		};
	}

	clearPath(path: string): void {
		this.deleteHistory(path);
	}

	clearFile(file: File): void {
		for (const [path, history] of this.histories) {
			if (history.file === file) this.deleteHistory(path);
		}
	}

	clearAll(): void {
		this.histories.clear();
		this.bytesUsed = 0;
	}

	private getForFile(file: File, path: string): FileHistory<File> | undefined {
		const history = this.histories.get(path);
		if (!history || history.file === file) return history;
		this.deleteHistory(path);
		return undefined;
	}

	private truncateRedo(history: FileHistory<File>): void {
		if (history.cursor >= history.steps.length) return;
		const removedStates = history.states.splice(history.cursor + 1);
		history.steps.splice(history.cursor);
		this.bytesUsed -= removedStates.reduce((sum, state) => sum + state.bytes.byteLength, 0);
	}

	private dropOldestStep(history: FileHistory<File>): boolean {
		if (history.steps.length === 0 || history.cursor === 0) return false;
		const state = history.states.shift();
		history.steps.shift();
		if (state) this.bytesUsed -= state.bytes.byteLength;
		history.cursor--;
		return true;
	}

	private makeRoom(required: number, keepPath: string): number {
		let evicted = 0;
		while (this.bytesUsed + required > MAX_PDF_HISTORY_BYTES) {
			const oldest = this.oldestOtherHistory(keepPath);
			if (!oldest) break;
			this.deleteHistory(oldest.path);
			evicted++;
		}
		return evicted;
	}

	private oldestOtherHistory(keepPath: string): FileHistory<File> | undefined {
		let oldest: FileHistory<File> | undefined;
		for (const history of this.histories.values()) {
			if (history.path === keepPath) continue;
			if (!oldest || history.lastUsed < oldest.lastUsed) oldest = history;
		}
		return oldest;
	}

	private deleteHistory(path: string): void {
		const history = this.histories.get(path);
		if (!history) return;
		this.histories.delete(path);
		this.bytesUsed -= history.states.reduce((sum, state) => sum + state.bytes.byteLength, 0);
	}
}

function normalizePageIndexes(pageIndexes: readonly number[]): number[] {
	return [...new Set(pageIndexes.filter((pageIndex) => Number.isInteger(pageIndex) && pageIndex >= 0))].sort((a, b) => a - b);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}
