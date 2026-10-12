export interface PdfMutationTransform<T> {
	bytes: Uint8Array;
	value: T;
	changed?: boolean;
}

export interface PdfMutationDependencies<T> {
	read(): Promise<Uint8Array>;
	transform(originalBytes: Uint8Array): Promise<PdfMutationTransform<T>>;
	/** Optional legacy backup hook. Preview/write receive immutable output bytes. */
	backup?(originalBytes: Uint8Array): Promise<void>;
	write(bytes: Uint8Array, beforeBytes: Uint8Array, value: T): Promise<void>;
	/** Starts a disposable visual preview without changing the saved PDF. */
	preview?(bytes: Uint8Array): { dispose(): void };
}

export interface PdfMutationResult<T> {
	changed: boolean;
	bytes: Uint8Array;
	value: T;
}

export interface CapturedPdfTarget<
	File extends { path: string },
	View extends { file: File; containerEl: unknown },
> {
	readonly file: File;
	readonly path: string;
	readonly pdfView: View;
}

export interface CapturedPdfPress<File extends { path: string }, View extends { file: File; containerEl: unknown }> {
	readonly capture: CapturedPdfTarget<File, View>;
	readonly pageIndex: number;
	readonly clientX: number;
	readonly clientY: number;
	readonly pdfPoint: { readonly x: number; readonly y: number };
}

/**
 * Serializes this plugin instance's mutations by vault-relative path.
 * Obsidian exposes no atomic compare-and-swap for PDF writes; edits from another
 * device or process during this operation are unsupported and fail the byte checks.
 */
export class PdfMutationCoordinator {
	private readonly tails = new Map<string, Promise<void>>();

	async whenIdle(path: string): Promise<void> {
		const key = normalizeVaultRelativePath(path);
		while (this.tails.has(key)) await this.tails.get(key);
	}

	run<T>(path: string, dependencies: PdfMutationDependencies<T>): Promise<PdfMutationResult<T>> {
		const key = normalizeVaultRelativePath(path);
		const previous = this.tails.get(key) ?? Promise.resolve();
		const operation = previous.then(() => runPdfMutation(key, dependencies));
		this.trackTail(key, operation);
		return operation;
	}

	/** Runs a read/derived-note operation in the same per-file queue as PDF
	 * mutations. Mutations queued during a snapshot scan wait until its final
	 * source-revision check and note write have completed. */
	runExclusive<T>(path: string, action: () => Promise<T>): Promise<T> {
		const key = normalizeVaultRelativePath(path);
		const previous = this.tails.get(key) ?? Promise.resolve();
		const operation = previous.then(action);
		this.trackTail(key, operation);
		return operation;
	}

	private trackTail(key: string, operation: Promise<unknown>): void {
		const tail = operation.then(() => undefined, () => undefined);
		this.tails.set(key, tail);
		void tail.then(() => {
			if (this.tails.get(key) === tail) this.tails.delete(key);
		});
	}
}

export function normalizeVaultRelativePath(path: string): string {
	const slashed = path.replace(/\\/g, '/');
	if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) {
		throw new Error('PDF mutation path must be vault-relative.');
	}
	const segments: string[] = [];
	for (const segment of slashed.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') throw new Error('PDF mutation path cannot traverse outside the vault.');
		segments.push(segment);
	}
	if (segments.length === 0) throw new Error('PDF mutation path cannot be empty.');
	return segments.join('/');
}

export function capturePdfTarget<
	File extends { path: string },
	View extends { file: File; containerEl: unknown },
>(
	file: File,
	pdfView: View,
): CapturedPdfTarget<File, View> {
	if (pdfView.file !== file) throw new Error('Captured PDF view and file do not match.');
	return { file, path: normalizeVaultRelativePath(file.path), pdfView };
}

export function capturePdfPress<File extends { path: string }, View extends { file: File; containerEl: unknown }>(
	capture: CapturedPdfTarget<File, View>,
	press: { pageIndex: number; clientX: number; clientY: number; pdfPoint: { x: number; y: number } },
): CapturedPdfPress<File, View> {
	if (!Number.isInteger(press.pageIndex) || !Number.isFinite(press.clientX) || !Number.isFinite(press.clientY) ||
		!Number.isFinite(press.pdfPoint.x) || !Number.isFinite(press.pdfPoint.y)) {
		throw new Error('Captured PDF press coordinates must be finite.');
	}
	return { capture, ...press, pdfPoint: { ...press.pdfPoint } };
}

export function resolveCapturedPdfPress<File extends { path: string }, View extends { file: File; containerEl: unknown }>(
	press: CapturedPdfPress<File, View>,
): { pageIndex: number; point: { x: number; y: number } } {
	return { pageIndex: press.pageIndex, point: { ...press.pdfPoint } };
}

/** Finds the PDF pane that actually owns an event target, including nodes from
 * popout windows whose Node constructor differs from the main window's. */
export function findPdfViewForNode<
	View extends {
		containerEl: { contains(node: Node): boolean };
		findPageIndexForNode(node: Node): number | null;
	},
>(views: readonly View[], target: unknown): { view: View; pageIndex: number } | null {
	if (!isDomNode(target)) return null;
	for (const view of views) {
		if (!view.containerEl.contains(target)) continue;
		const pageIndex = view.findPageIndexForNode(target);
		if (pageIndex !== null) return { view, pageIndex };
	}
	return null;
}

function isDomNode(value: unknown): value is Node {
	if (typeof value !== 'object' || value === null) return false;
	const nodeType = (value as { nodeType?: unknown }).nodeType;
	return typeof nodeType === 'number' && Number.isInteger(nodeType) && nodeType >= 1 && nodeType <= 12;
}

export function isCapturedPdfCurrent<
	File extends { path: string },
	View extends { file: File; containerEl: unknown },
>(
	captured: CapturedPdfTarget<File, View>,
	getFileAtPath: (path: string) => unknown,
): boolean {
	return captured.file.path === captured.path && getFileAtPath(captured.path) === captured.file;
}

export function isCapturedPdfViewLive<
	File extends { path: string },
	View extends { file: File; containerEl: unknown },
>(captured: CapturedPdfTarget<File, View>, liveViews: readonly View[]): boolean {
	return liveViews.some(
		(view) => view.containerEl === captured.pdfView.containerEl && view.file === captured.file,
	);
}

async function runPdfMutation<T>(
	path: string,
	dependencies: PdfMutationDependencies<T>,
): Promise<PdfMutationResult<T>> {
	const originalBytes = copyBytes(await dependencies.read());
	const transformed = await dependencies.transform(copyBytes(originalBytes));
	const outputBytes = transformed.bytes;
	if (transformed.changed === false || bytesEqual(originalBytes, outputBytes)) {
		return { changed: false, bytes: originalBytes, value: transformed.value };
	}

	if (dependencies.backup) await assertBytesUnchanged(path, originalBytes, () => dependencies.read());
	let preview: { dispose(): void } | undefined;
	try {
		preview = dependencies.preview?.(outputBytes);
	} catch {
		// A preview is optional; failure must not change the save transaction.
	}
	try {
		if (dependencies.backup) await dependencies.backup(copyBytes(originalBytes));
		await assertBytesUnchanged(path, originalBytes, () => dependencies.read());
		await dependencies.write(outputBytes, originalBytes, transformed.value);
		return { changed: true, bytes: outputBytes, value: transformed.value };
	} finally {
		try { preview?.dispose(); } catch { /* Preview cleanup cannot undo a successful save. */ }
	}
}

async function assertBytesUnchanged(
	path: string,
	original: Uint8Array,
	read: () => Promise<Uint8Array>,
): Promise<void> {
	const current = await read();
	if (!bytesEqual(original, current)) {
		throw new Error(`PDF changed since this operation began: ${path}`);
	}
}

function copyBytes(bytes: Uint8Array): Uint8Array {
	return Uint8Array.from(bytes);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let i = 0; i < left.byteLength; i++) {
		if (left[i] !== right[i]) return false;
	}
	return true;
}
