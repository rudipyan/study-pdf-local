import type { ActivePdfView } from './obsidian-pdf-internals';
import { createPdfJsDocumentSnapshot } from './obsidian-pdf-internals';
import type { PdfMutationCoordinator } from './pdf-mutation';
import type { HighlightEntry, PdfJsDocument } from './pdf-highlights';
import { collectHighlights } from './pdf-highlights';
import { getStoredQuotes } from './annotate';
import { fingerprintPdfBytes } from './pdf-in-place';

export interface PdfHighlightSnapshotOptions {
	path: string;
	pdfView: ActivePdfView;
	coordinator: PdfMutationCoordinator;
	read(): Promise<Uint8Array | ArrayBuffer>;
	assertCurrent(): void;
	signal?: AbortSignal;
	onProgress?: (pageNumber: number, pageCount: number) => void;
}

const MAX_CACHED_SCANS = 4;
const MAX_CACHED_RETAINED_BYTES = 1024 * 1024;
const MAX_CACHED_ENTRIES = 2048;
const CACHED_ENTRY_OVERHEAD_BYTES = 256;
const completedScans = new Map<string, { entries: HighlightEntry[]; retainedBytes: number; entryCount: number }>();

/** Keeps a read-only highlight scan and its optional note write behind the
 * same per-PDF mutation queue. Both annotation references and text come from
 * the exact byte snapshot read at the start. */
export async function withPdfHighlightSnapshot<T>(
	options: PdfHighlightSnapshotOptions,
	action: (entries: HighlightEntry[], snapshotFingerprint: string, assertUnchanged: () => Promise<void>) => Promise<T>,
): Promise<T> {
	return options.coordinator.runExclusive(options.path, async () => {
		assertNotAborted(options.signal);
		options.assertCurrent();
		const snapshot = new Uint8Array(await options.read());
		assertNotAborted(options.signal);
		options.assertCurrent();
		const snapshotFingerprint = await fingerprintPdfBytes(snapshot);
		assertNotAborted(options.signal);
		options.assertCurrent();
		const cacheKey = `${options.path}\u0000${snapshotFingerprint}`;
		const assertUnchanged = async () => {
			assertNotAborted(options.signal);
			options.assertCurrent();
			const current = new Uint8Array(await options.read());
			assertNotAborted(options.signal);
			options.assertCurrent();
			if (!bytesEqual(snapshot, current)) {
				throw new Error('The PDF changed while its highlights were being collected. Open the highlights list again.');
			}
		};
		const cached = completedScans.get(cacheKey);
		if (cached) {
			completedScans.delete(cacheKey);
			completedScans.set(cacheKey, cached);
			await assertUnchanged();
			assertNotAborted(options.signal);
			options.assertCurrent();
			return await action(cached.entries.map((entry) => ({ ...entry })), snapshotFingerprint, assertUnchanged);
		}
		const documentSnapshot = createPdfJsDocumentSnapshot(options.pdfView, snapshot);
		const scanController = new AbortController();
		const cancelSnapshot = () => {
			scanController.abort();
			documentSnapshot.cancel();
		};
		options.signal?.addEventListener('abort', cancelSnapshot, { once: true });
		if (options.signal?.aborted) cancelSnapshot();
		try {
			assertNotAborted(options.signal);
			options.assertCurrent();
			const documentPromise = (documentSnapshot.document as Promise<PdfJsDocument>).catch((error) => {
				scanController.abort();
				throw error;
			});
			const storedQuotesPromise = getStoredQuotes(snapshot, { signal: scanController.signal }).catch((error) => {
				documentSnapshot.cancel();
				throw error;
			});
			const [documentResult, storedQuotesResult] = await Promise.allSettled([documentPromise, storedQuotesPromise]);
			if (documentResult.status === 'rejected') throw documentResult.reason;
			if (storedQuotesResult.status === 'rejected') throw storedQuotesResult.reason;
			assertNotAborted(options.signal);
			const pdfjsDoc = documentResult.value;
			const storedQuotes = storedQuotesResult.value;
			options.assertCurrent();
			const entries = await collectHighlights(pdfjsDoc, storedQuotes, {
				signal: scanController.signal,
				onProgress: options.onProgress,
			});
			await assertUnchanged();
			assertNotAborted(options.signal);
			options.assertCurrent();
			cacheCompletedScan(cacheKey, entries);
			assertNotAborted(options.signal);
			options.assertCurrent();
			return await action(entries, snapshotFingerprint, assertUnchanged);
		} finally {
			options.signal?.removeEventListener('abort', cancelSnapshot);
			if (options.signal?.aborted) scanController.abort();
			await documentSnapshot.dispose();
		}
	});
}

function cacheCompletedScan(cacheKey: string, entries: HighlightEntry[]): void {
	const retainedBytes = entries.reduce((total, entry) => total + CACHED_ENTRY_OVERHEAD_BYTES + 2 * (
		entry.quote.length + (entry.note?.length ?? 0) + entry.colorCss.length + (entry.annotationId?.length ?? 0)
	), 0);
	if (entries.length > MAX_CACHED_ENTRIES || retainedBytes > MAX_CACHED_RETAINED_BYTES) return;
	completedScans.delete(cacheKey);
	completedScans.set(cacheKey, { entries: entries.map((entry) => ({ ...entry })), retainedBytes, entryCount: entries.length });
	let totalRetainedBytes = Array.from(completedScans.values()).reduce((total, item) => total + item.retainedBytes, 0);
	let totalEntries = Array.from(completedScans.values()).reduce((total, item) => total + item.entryCount, 0);
	while (completedScans.size > MAX_CACHED_SCANS || totalRetainedBytes > MAX_CACHED_RETAINED_BYTES || totalEntries > MAX_CACHED_ENTRIES) {
		const oldestKey = completedScans.keys().next().value;
		if (!oldestKey) break;
		const oldest = completedScans.get(oldestKey);
		completedScans.delete(oldestKey);
		totalRetainedBytes -= oldest?.retainedBytes ?? 0;
		totalEntries -= oldest?.entryCount ?? 0;
	}
}

function assertNotAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const error = new Error('The highlights scan was cancelled.');
	error.name = 'AbortError';
	throw error;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}
