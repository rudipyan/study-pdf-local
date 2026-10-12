// The ONLY module that touches undocumented Obsidian/PDF.js internals. If an
// Obsidian update breaks this, it breaks here -- one file, typed surface, loud
// failure (throws with a clear message) rather than a silent wrong-position
// highlight. The property path below was confirmed empirically against a real
// running Obsidian instance (spike script preserved in git history under spike/):
//   view.viewer.child.pdfViewer.pdfViewer  ->  the live PDF.js PDFViewer instance
// (verified: getPageView(0).viewport.scale exactly matched the DOM's
// --scale-factor, and .convertToPdfPoint exists on that viewport.)
import { FileView } from 'obsidian';
import { startPdfUpdatePreview, type PdfUpdatePreview } from './pdf-update-preview';
import type { App, TFile, WorkspaceLeaf } from 'obsidian';
import type { PdfViewportLike } from './geometry';
import { retainPdfDocument, type PdfPageConsumers } from './pdf-document-lifetime';
import {
	fingerprintPdfBytes,
	refreshPageCanvas,
	refreshPageAnnotationLayer,
	shouldSuppressPdfViewReload,
	type InPlacePdfWriteToken,
	type InPlaceRefreshResult,
	type PdfPageProxyLike,
	type PdfPageViewLike,
} from './pdf-in-place';

export interface ActivePdfView {
	file: TFile;
	containerEl: HTMLElement;
	/** 0-based page index. */
	getPageViewport(pageIndex: number): PdfViewportLike;
	/** 0-based page index. Returns the element whose getBoundingClientRect() gives
	 * the "page origin" for mapping a client rect to page-local coordinates, or
	 * null if that page isn't currently rendered (PDF.js virtualizes pages -- an
	 * off-screen page may not have a live element).
	 *
	 * This is the page's .textLayer div, NOT the outer .page container -- found
	 * live: the .page div has a decorative border (pdf.js viewer.css convention)
	 * that getBoundingClientRect() includes, silently offsetting every highlight
	 * by the border width. .textLayer has no border and is exactly the coordinate
	 * space text selections (and viewport.convertToPdfPoint) actually live in. */
	getPageElement(pageIndex: number): HTMLElement | null;
	/** 0-based page index. Returns the rendered outer PDF.js page element using
	 * its bounded page-view lookup, without searching the document's page DOM. */
	getRenderedPageElement(pageIndex: number): HTMLElement | null;
	/** Maps a viewport point to its rendered page index without searching page DOM. */
	getPageIndexAtPoint(clientX: number, clientY: number): number | null;
	/** Immediate PDF.js page-list container for bounded page replacement observation. */
	getPageContainerElement(): HTMLElement | null;
	/** Walks up from a DOM node to find which rendered page contains it. Returns
	 * the 0-based page index, or null if the node isn't inside any page. Used to
	 * group a (possibly multi-page) selection's client rects by page. */
	findPageIndexForNode(node: Node): number | null;
	/** True once the page's canvas is fully painted (PDF.js renderingState
	 * FINISHED). Used by the reload curtain to know when it's safe to reveal the
	 * freshly reloaded document. Errs on true if the internal field is missing,
	 * so a PDF.js update can only make the curtain lift early, never hang. */
	isPageRenderFinished(pageIndex: number): boolean;
	/** The live PDF.js PDFDocumentProxy of the open viewer. Lets features read
	 * annotations/text without re-parsing the file (and without bundling our own
	 * copy of pdf.js). */
	getPdfJsDocument(): unknown;
	/** Scrolls the viewer to the given 1-based page number. */
	goToPage(pageNumber: number): void;
	/** The 1-based page the viewer is currently showing, or 0 if it can't be
	 * read. Captured before a write so the reading position survives Obsidian's
	 * full view reload -- see preserve-reading-position.ts. */
	getCurrentPageNumber(): number;
	/** Total pages in the loaded document, or 0 while none is loaded. A reloaded
	 * viewer reports 0 until the new document is laid out, which is what makes it
	 * usable as a "is the new document ready to be scrolled?" signal. */
	getPageCount(): number;
	/** The (otherwise empty) right-hand section of this PDF view's own toolbar
	 * (`div.pdf-toolbar-right`, sits after the page-number field) -- confirmed
	 * from Obsidian's shipped app.js as an intentionally bare container the
	 * toolbar class creates and never populates itself, i.e. the natural slot
	 * for a plugin-added button. Returns null if that structure has changed. */
	getToolbarRightElement(): HTMLElement | null;
	/** The native PDF.js scroll viewport for this view, or null if Obsidian's
	 * viewer DOM changed. Kept here so layout helpers don't guess at internal
	 * viewer paths. */
	getPdfScrollElement(): HTMLElement | null;
	/** Stable immediate host of the PDF scroller, including while it reloads. */
	getPdfScrollHostElement(): HTMLElement | null;
	/** Applies PDF.js's native page-width scale for this view. This is an
	 * explicit user action; subsequent manual zoom and pinch remain untouched. */
	fitToWidth(): boolean;
	/** Recomputes native page-width only if the user is still in that mode. */
	refreshPageWidthIfActive(): boolean;
	/** Whether this viewer exposes the guarded PDF.js pieces needed to refresh
	 * PDF annotations in place. Unsupported versions use the normal reload path. */
	/** Arm the file-change guard immediately before a plugin-owned write. */
	previewPdfUpdate(bytes: Uint8Array, pageIndexes: number[], onReady?: () => void): PdfUpdatePreview;
	prepareInPlacePdfWrite(bytes: Uint8Array, outputFingerprint?: string): Promise<InPlacePdfWriteToken | null>;
	/** Refresh changed page images and annotation layers while retaining the
	 * existing page DOM and reading position. */
	refreshAnnotationsInPlace(
		bytes: Uint8Array,
		pageIndexes: number[],
		token: InPlacePdfWriteToken,
		preview?: PdfUpdatePreview,
	): Promise<InPlaceRefreshResult>;
	cancelInPlacePdfWrite(token: InPlacePdfWriteToken): void;
	/** Full reload for compatibility fallback after an in-place refresh fails. */
	forceReload(): Promise<void>;
	/** Restore the original view method and release temporary PDF.js documents. */
	disposeInPlaceUpdates(): Promise<void>;
}

const INTERNALS_ERROR =
	'Study PDF: could not find the PDF viewer internals on this version of Obsidian. ' +
	'This plugin relies on an undocumented internal API that may have changed -- please report this issue.';

// Minimal local shapes for the live, untyped pdf.js objects reached through
// Obsidian's internals -- same approach as PdfViewportLike in geometry.ts:
// capture only the properties/methods actually used, rather than depending on
// pdfjs-dist's real (and version-specific) types, or on `any` (which is what
// used to be here -- replaced so property access on these objects is type-
// checked instead of unsafely flowing through `any`). Each is still a
// best-effort description of an object we don't control; every call site that
// depends on one still runtime-checks it before trusting it (see
// INTERNALS_ERROR), because a wrong TYPE declaration wouldn't be caught by
// the compiler the way a wrong runtime shape is.
interface PdfJsPageView {
	div?: HTMLElement;
	viewport?: PdfViewportLike;
	renderingState?: number;
}

interface PdfJsDocumentLike {
	numPages: number;
	getPage: (pageNumber: number) => Promise<PdfPageProxyLike>;
}

interface PdfJsPdfViewer {
	getPageView: (pageIndex: number) => (PdfJsPageView & PdfPageConsumers) | undefined;
	pdfDocument?: PdfJsDocumentLike;
	currentPageNumber: number;
	currentScaleValue?: string;
	pagesCount?: number;
	forceRendering?: () => boolean;
}

interface PdfJsAnnotationData {
	data?: { subtype?: string };
}

type RenderAnnotationPopupFn = (annotation: PdfJsAnnotationData) => unknown;

interface PdfJsViewerApplicationLike {
	pdfViewer?: PdfJsPdfViewer;
	pdfThumbnailViewer?: { getThumbnail(pageIndex: number): PdfPageConsumers | undefined } | null;
	pdfDocument?: PdfJsDocumentLike | null;
	pdfLoadingTask?: PdfJsLoadingTaskLike;
	close?: (...args: unknown[]) => unknown;
}

interface PdfViewerChild {
	renderAnnotationPopup?: RenderAnnotationPopupFn;
	pdfViewer?: PdfJsViewerApplicationLike;
	pdfjsLib?: PdfJsLibraryLike;
}

interface PdfJsLoadingTaskLike {
	promise: Promise<PdfJsDocumentLike>;
	destroy(): Promise<void> | void;
}

interface PdfJsLibraryLike {
	getDocument(options: { data: Uint8Array }): PdfJsLoadingTaskLike;
}

type LoadPdfFile = (this: RawPdfView, file: TFile) => unknown;
type ClosePdfView = (this: RawPdfView, ...args: unknown[]) => unknown;

interface RawPdfView {
	file: TFile | null;
	containerEl: HTMLElement;
	onLoadFile?: LoadPdfFile;
	onClose?: ClosePdfView;
	viewer?: {
		child?: PdfViewerChild;
	};
}

interface InPlaceWriteExpectation {
	writeId: number;
	fingerprint: string;
	startedAt: number;
	writePending: boolean;
}

interface InPlacePdfViewState {
	app: App;
	rawView: RawPdfView;
	originalOnLoadFile: LoadPdfFile;
	writeRequestId: number;
	latestWriteId: number | null;
	latestExpectation: InPlaceWriteExpectation | null;
	needsNotificationRecheck: boolean;
	notificationRecheckScheduled: boolean;
	reloadGeneration: number;
	currentDocument: PdfJsDocumentLike | null;
	temporaryTasks: Set<PdfJsLoadingTaskLike>;
	displacedLoadingTask: PdfJsLoadingTaskLike | null;
	guardedOnLoadFile: LoadPdfFile | null;
	originalOnClose: ClosePdfView | null;
	guardedOnClose: ClosePdfView | null;
	disposed: boolean;
}

const IN_PLACE_EVENT_WINDOW_MS = 2500;
let inPlaceWriteId = 0;
const inPlacePdfViewStates = new WeakMap<RawPdfView, InPlacePdfViewState>();
const loadingTaskLeases = new WeakMap<PdfJsLoadingTaskLike, ReturnType<typeof retainPdfDocument>>();

function getPdfJsLibrary(view: RawPdfView): PdfJsLibraryLike | null {
	const childLibrary = view.viewer?.child?.pdfjsLib;
	if (childLibrary && typeof childLibrary.getDocument === 'function') return childLibrary;
	const win = view.containerEl.ownerDocument.defaultView as (Window & { pdfjsLib?: PdfJsLibraryLike }) | null;
	const library = win?.pdfjsLib;
	return library && typeof library.getDocument === 'function' ? library : null;
}

export interface PdfJsDocumentSnapshot {
	document: Promise<unknown>;
	/** Interrupts pending PDF.js page reads when their owning UI closes. */
	cancel(): void;
	/** Releases the temporary PDF.js worker after the scan completes. */
	dispose(): Promise<void>;
}

/** Parses an immutable copy of a vault byte snapshot with Obsidian's own
 * PDF.js runtime. The returned document is independent of the live viewer, so
 * its annotations and custom pdf-lib metadata always describe the same bytes. */
export function createPdfJsDocumentSnapshot(view: ActivePdfView, bytes: Uint8Array): PdfJsDocumentSnapshot {
	const library = getPdfJsLibrary(view);
	if (!library) throw new Error(INTERNALS_ERROR);
	const task = library.getDocument({ data: bytes.slice() });
	let releasePromise: Promise<void> | null = null;
	const release = () => {
		if (!releasePromise) releasePromise = destroyLoadingTask(task);
		return releasePromise;
	};
	return {
		document: task.promise,
		cancel: () => { void release(); },
		dispose: release,
	};
}

function getPdfPageView(view: RawPdfView, pageIndex: number): PdfPageViewLike | null {
	const pdfViewer = view.viewer?.child?.pdfViewer?.pdfViewer;
	const pageView = pdfViewer?.getPageView(pageIndex) as (PdfJsPageView & Partial<PdfPageViewLike>) | undefined;
	if (!pageView || !('pdfPage' in pageView) || !('annotationLayer' in pageView)) return null;
	return pageView as PdfPageViewLike;
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
	return !!value && typeof (value as { then?: unknown }).then === 'function';
}

async function destroyLoadingTask(task: PdfJsLoadingTaskLike | null): Promise<void> {
	if (!task) return;
	loadingTaskLeases.get(task)?.detach();
	loadingTaskLeases.delete(task);
	try {
		await task.destroy();
	} catch {
		// The viewer may already have closed the document while the task was being
		// replaced. Cleanup is best effort and must not interrupt the file reload.
	}
}

async function releaseTemporaryDocuments(state: InPlacePdfViewState): Promise<void> {
	const tasks = new Set(state.temporaryTasks);
	if (state.displacedLoadingTask) tasks.add(state.displacedLoadingTask);
	state.temporaryTasks.clear();
	state.displacedLoadingTask = null;
	state.currentDocument = null;
	await Promise.all(Array.from(tasks, destroyLoadingTask));
}

function invokeOriginalLoad(state: InPlacePdfViewState, file: TFile): unknown {
	return state.originalOnLoadFile.call(state.rawView, file);
}

function scheduleNotificationRecheck(state: InPlacePdfViewState): void {
	if (!state.needsNotificationRecheck || state.notificationRecheckScheduled || state.disposed ||
		inPlacePdfViewStates.get(state.rawView) !== state || state.latestExpectation?.writePending) return;
	if (!state.rawView.file) {
		state.needsNotificationRecheck = false;
		return;
	}
	state.notificationRecheckScheduled = true;
	queueMicrotask(() => {
		state.notificationRecheckScheduled = false;
		if (!state.needsNotificationRecheck || state.disposed || inPlacePdfViewStates.get(state.rawView) !== state) return;
		// A newer save may have begun after this recheck was queued. Keep the
		// notification pending until that write settles so we do not reload its
		// old on-disk bytes or invalidate its generation mid-write.
		if (state.latestExpectation?.writePending) return;
		const file = state.rawView.file;
		if (!file) {
			state.needsNotificationRecheck = false;
			return;
		}
		state.needsNotificationRecheck = false;
		try {
			const result = state.guardedOnLoadFile?.call(state.rawView, file);
			void Promise.resolve(result).catch((error) => {
				console.warn('Study PDF: could not recheck a PDF reload notification', error);
			});
		} catch (error) {
			console.warn('Study PDF: could not recheck a PDF reload notification', error);
		}
	});
}

function markNotificationForRecheck(state: InPlacePdfViewState): void {
	state.needsNotificationRecheck = true;
	scheduleNotificationRecheck(state);
}

function installInPlaceReloadGuard(view: RawPdfView, app: App): InPlacePdfViewState | null {
	const existing = inPlacePdfViewStates.get(view);
	if (existing && !existing.disposed) return existing;
	const originalOnLoadFile = view.onLoadFile;
	const originalOnClose = view.onClose;
	if (typeof originalOnLoadFile !== 'function' || typeof originalOnClose !== 'function') return null;

	const state: InPlacePdfViewState = {
		app,
		rawView: view,
		originalOnLoadFile,
		writeRequestId: 0,
		latestWriteId: null,
		latestExpectation: null,
		needsNotificationRecheck: false,
		notificationRecheckScheduled: false,
		reloadGeneration: 0,
		currentDocument: null,
		temporaryTasks: new Set(),
		displacedLoadingTask: null,
		guardedOnLoadFile: null,
		originalOnClose,
		guardedOnClose: null,
		disposed: false,
	};
	inPlacePdfViewStates.set(view, state);

	const guardedOnLoadFile: LoadPdfFile = function (this: RawPdfView, file: TFile): unknown {
		const activeState = inPlacePdfViewStates.get(this);
		if (!activeState || activeState.disposed) return originalOnLoadFile.call(this, file);

		const eventAt = Date.now();
		const expectation = activeState.latestExpectation;
		if (file !== this.file || !expectation || expectation.writeId !== activeState.latestWriteId ||
			(!expectation.writePending && (eventAt < expectation.startedAt || eventAt - expectation.startedAt > IN_PLACE_EVENT_WINDOW_MS))) {
			return continueWithNormalReload(activeState, file);
		}

		// Notifications can outlive navigation, a normal reload, or plugin unload.
		// A stale callback must neither reload its old file nor suppress a newer write.
		const generation = activeState.reloadGeneration;
		const isCurrent = () => !activeState.disposed &&
			inPlacePdfViewStates.get(this) === activeState &&
			this.file === file && activeState.reloadGeneration === generation;
		const isExpectationCurrent = () => isCurrent() &&
			activeState.latestWriteId === expectation.writeId && activeState.latestExpectation === expectation;
		return (async () => {
			let currentFingerprint: string | null = null;
			try {
				const currentBytes = new Uint8Array(await activeState.app.vault.readBinary(file));
				if (!isCurrent()) return;
				if (!isExpectationCurrent()) {
					markNotificationForRecheck(activeState);
					return;
				}
				currentFingerprint = await fingerprintPdfBytes(currentBytes);
				if (!isCurrent()) return;
				if (!isExpectationCurrent()) {
					markNotificationForRecheck(activeState);
					return;
				}
			} catch {
				// If exact byte verification is unavailable, preserve Obsidian's normal
				// reload behavior rather than risk leaving stale annotations visible.
				if (!isCurrent()) return;
				if (!isExpectationCurrent()) {
					markNotificationForRecheck(activeState);
					return;
				}
				return continueWithNormalReload(activeState, file);
			}
			if (!isCurrent()) return;
			if (!isExpectationCurrent()) {
				markNotificationForRecheck(activeState);
				return;
			}
			if (currentFingerprint && shouldSuppressPdfViewReload({
				expectedFingerprint: expectation.fingerprint,
				currentFingerprint,
				// A notification may start during the write and finish hashing
				// after the completion timestamp has been recorded.
				startedAt: expectation.writePending ? eventAt : Math.min(eventAt, expectation.startedAt),
				now: eventAt,
				windowMs: IN_PLACE_EVENT_WINDOW_MS,
			})) return;
			return continueWithNormalReload(activeState, file);
		})();
	};
	state.guardedOnLoadFile = guardedOnLoadFile;
	view.onLoadFile = guardedOnLoadFile;

	const guardedOnClose: ClosePdfView = function (this: RawPdfView, ...args: unknown[]): unknown {
		state.reloadGeneration++;
		state.latestExpectation = null;
		state.needsNotificationRecheck = false;
		let result: unknown;
		try {
			result = originalOnClose.apply(this, args);
		} catch (error) {
			void releaseTemporaryDocuments(state);
			throw error;
		}
		if (isPromiseLike(result)) return result.finally(() => releaseTemporaryDocuments(state));
		void releaseTemporaryDocuments(state);
		return result;
	};
	state.guardedOnClose = guardedOnClose;
	view.onClose = guardedOnClose;

	return state;
}

function continueWithNormalReload(state: InPlacePdfViewState, file: TFile, preserveExpectations = false): unknown {
	state.reloadGeneration++;
	state.needsNotificationRecheck = false;
	if (!preserveExpectations) state.latestExpectation = null;
	const temporaryTasks = Array.from(state.temporaryTasks);
	if (state.displacedLoadingTask) temporaryTasks.push(state.displacedLoadingTask);
	state.temporaryTasks.clear();
	state.displacedLoadingTask = null;
	state.currentDocument = null;
	let result: unknown;
	try {
		result = invokeOriginalLoad(state, file);
	} catch (error) {
		void Promise.all(temporaryTasks.map(destroyLoadingTask));
		throw error;
	}
	const cleanup = async () => {
		await Promise.all(temporaryTasks.map(destroyLoadingTask));
		if (state.disposed && state.guardedOnClose && state.rawView.onClose === state.guardedOnClose && state.originalOnClose) {
			state.rawView.onClose = state.originalOnClose;
		}
	};
	if (isPromiseLike(result)) return result.finally(cleanup);
	void Promise.all(temporaryTasks.map(destroyLoadingTask));
	if (state.disposed && state.guardedOnClose && state.rawView.onClose === state.guardedOnClose && state.originalOnClose) {
		state.rawView.onClose = state.originalOnClose;
	}
	return result;
}

function canRefreshInPlace(view: RawPdfView): boolean {
	const rawPdfViewer = view.viewer?.child?.pdfViewer?.pdfViewer;
	return !!getPdfJsLibrary(view) && typeof view.onLoadFile === 'function' &&
		typeof view.onClose === 'function' &&
		!!rawPdfViewer && typeof rawPdfViewer.getPageView === 'function' &&
		typeof rawPdfViewer.pagesCount === 'number' && rawPdfViewer.pagesCount > 0 &&
		Object.getOwnPropertyDescriptor(rawPdfViewer, 'pdfDocument')?.writable === true &&
		!!rawPdfViewer.pdfDocument &&
		typeof rawPdfViewer.pdfDocument.getPage === 'function' &&
		!!view.viewer?.child?.pdfViewer &&
		typeof view.viewer.child.pdfViewer.pdfLoadingTask?.destroy === 'function';
}

function getLivePdfViewer(view: RawPdfView): PdfJsPdfViewer {
	const pdfViewer = view.viewer?.child?.pdfViewer?.pdfViewer;
	if (!pdfViewer || typeof pdfViewer.getPageView !== 'function') {
		throw new Error(INTERNALS_ERROR);
	}
	return pdfViewer;
}

/** Obsidian's built-in PDF viewer shows its own popup (`div.popupWrapper`) when
 * an annotation is clicked -- created by `renderAnnotationPopup` on the viewer
 * child object (confirmed by reading Obsidian's shipped app.js: its
 * `onAnnotationPointerDown` handler calls it on pointerup for every non-Widget,
 * non-Link annotation). Since our own "Remove highlight" menu appears on that
 * same click, the two overlap. Event-level suppression was tried and failed
 * (the handler runs on `window` before ours, and blocking events broke our own
 * menus), so instead we patch the method itself on the shared prototype: skip
 * the native popup for /Highlight annotations -- our popup owns that
 * interaction entirely (it shows the highlight's note and the note/remove
 * actions) -- and keep it for every other annotation type (text notes, stamps).
 *
 * Returns an undo function, or null if no PDF view exists yet to patch through
 * (callers should retry on layout changes). Patching the prototype covers all
 * current and future PDF views at once. */
export function patchNativeAnnotationPopup(app: App): (() => void) | null {
	for (const leaf of app.workspace.getLeavesOfType('pdf')) {
		const child = (leaf.view as unknown as RawPdfView).viewer?.child;
		if (!child || typeof child.renderAnnotationPopup !== 'function') continue;

		// Object.getPrototypeOf's own lib.es5.d.ts signature returns `any` --
		// this cast is what turns that implicit any into a checked type instead
		// of letting it flow through unsafely.
		const proto = Object.getPrototypeOf(child) as PdfViewerChild;
		if (typeof proto.renderAnnotationPopup !== 'function') continue;

		const original = proto.renderAnnotationPopup;
		proto.renderAnnotationPopup = function (this: unknown, annotation: PdfJsAnnotationData) {
			if (annotation?.data?.subtype === 'Highlight') return;
			return original.call(this, annotation);
		};
		return () => {
			proto.renderAnnotationPopup = original;
		};
	}
	return null;
}

/** Builds the typed view surface for one PDF leaf, or null if it has no file
 * open yet (e.g. still loading). Shared by getActivePdfView (one leaf) and
 * getAllPdfViews (every open PDF leaf, for features like the toolbar button
 * that must apply to every PDF tab, not just the focused one). */
function buildPdfView(leaf: WorkspaceLeaf, app: App): ActivePdfView | null {
	const view = leaf.view as unknown as RawPdfView;
	const file = view.file;
	if (!file) return null;

	const pdfViewer = getLivePdfViewer(view);
	const getInPlaceState = () => inPlacePdfViewStates.get(view);

	const getPageElement = (pageIndex: number): HTMLElement | null => {
		const pageEl = view.containerEl.querySelector<HTMLElement>(`div.page[data-page-number="${pageIndex + 1}"]`);
		return pageEl?.querySelector<HTMLElement>('.textLayer') ?? pageEl;
	};

	return {
		file,
		containerEl: view.containerEl,

		getPageViewport(pageIndex: number): PdfViewportLike {
			const pageView = pdfViewer.getPageView(pageIndex);
			const viewport = pageView?.viewport;
			if (!viewport || typeof viewport.convertToPdfPoint !== 'function') {
				throw new Error(INTERNALS_ERROR);
			}
			return viewport;
		},

		getPageElement,

		getRenderedPageElement(pageIndex: number): HTMLElement | null {
			try {
				const livePdfViewer = getLivePdfViewer(view);
				if (view.file !== file || !Number.isInteger(pageIndex) || pageIndex < 0) return null;
				const pageElement = livePdfViewer.getPageView(pageIndex)?.div;
				if (!pageElement || pageElement.ownerDocument !== view.containerEl.ownerDocument ||
					!view.containerEl.contains(pageElement)) return null;
				return pageElement;
			} catch {
				return null;
			}
		},

		getPageIndexAtPoint(clientX: number, clientY: number): number | null {
			const node = view.containerEl.ownerDocument.elementFromPoint(clientX, clientY);
			return node ? this.findPageIndexForNode(node) : null;
		},

		getPageContainerElement(): HTMLElement | null {
			const pageContainer = this.getPdfScrollElement()?.querySelector<HTMLElement>('.pdfViewer') ?? null;
			return pageContainer && pageContainer.ownerDocument === view.containerEl.ownerDocument &&
				view.containerEl.contains(pageContainer) ? pageContainer : null;
		},

		isPageRenderFinished(pageIndex: number): boolean {
			const pageView = pdfViewer.getPageView(pageIndex);
			if (!pageView) return false;
			// PDF.js RenderingStates.FINISHED === 3 (stable across versions).
			return typeof pageView.renderingState !== 'number' || pageView.renderingState === 3;
		},

		getPdfJsDocument(): unknown {
			const pdfDocument = getInPlaceState()?.currentDocument ?? pdfViewer.pdfDocument;
			if (!pdfDocument || typeof pdfDocument.getPage !== 'function') {
				throw new Error(INTERNALS_ERROR);
			}
			return pdfDocument;
		},

		goToPage(pageNumber: number): void {
			pdfViewer.currentPageNumber = pageNumber;
		},

		getCurrentPageNumber(): number {
			try {
				const n = getLivePdfViewer(view).currentPageNumber;
				return typeof n === 'number' && n > 0 ? n : 0;
			} catch {
				return 0;
			}
		},

		getPageCount(): number {
			try {
				const n = getLivePdfViewer(view).pagesCount;
				return typeof n === 'number' && n > 0 ? n : 0;
			} catch {
				return 0;
			}
		},

		getToolbarRightElement(): HTMLElement | null {
			return view.containerEl.querySelector<HTMLElement>('.pdf-toolbar-right');
		},

		getPdfScrollElement(): HTMLElement | null {
			return view.containerEl.querySelector<HTMLElement>('.pdf-viewer-container');
		},

		getPdfScrollHostElement(): HTMLElement | null {
			const scrollElement = this.getPdfScrollElement();
			if (scrollElement?.parentElement) return scrollElement.parentElement;
			const host = view.containerEl.querySelector<HTMLElement>('.pdf-container');
			return host && host.ownerDocument === view.containerEl.ownerDocument &&
				view.containerEl.contains(host) ? host : null;
		},

		fitToWidth(): boolean {
			try {
				const livePdfViewer = getLivePdfViewer(view);
				if (view.file !== file || livePdfViewer !== pdfViewer ||
					typeof livePdfViewer.currentScaleValue !== 'string') return false;
				livePdfViewer.currentScaleValue = 'page-width';
				return livePdfViewer.currentScaleValue === 'page-width';
			} catch {
				return false;
			}
		},

		refreshPageWidthIfActive(): boolean {
			try {
				const livePdfViewer = getLivePdfViewer(view);
				if (view.file !== file || livePdfViewer !== pdfViewer ||
					livePdfViewer.currentScaleValue !== 'page-width') return false;
				livePdfViewer.currentScaleValue = 'page-width';
				return livePdfViewer.currentScaleValue === 'page-width';
			} catch {
				return false;
			}
		},

		previewPdfUpdate(bytes: Uint8Array, pageIndexes: number[], onReady?: () => void): PdfUpdatePreview {
			const library = getPdfJsLibrary(view);
			const document = pdfViewer.pdfDocument;
			if (!library || !document) return { dispose() {} };
			const preview = startPdfUpdatePreview(
				() => library.getDocument({ data: bytes.slice() }),
				(index) => getPdfPageView(view, index),
				pageIndexes,
				() => {
					try { return view.file === file && getLivePdfViewer(view).pdfDocument === document; }
					catch { return false; }
				},
				onReady,
			);
			preview.sourceBytes = bytes;
			return preview;
		},

		async prepareInPlacePdfWrite(bytes: Uint8Array, outputFingerprint?: string): Promise<InPlacePdfWriteToken | null> {
			if (!canRefreshInPlace(view)) {
				console.warn('Study PDF: this viewer does not expose the required in-place refresh APIs.');
				return null;
			}
			const state = installInPlaceReloadGuard(view, app);
			if (!state || state.disposed) return null;
			const generation = state.reloadGeneration;
			const requestId = ++state.writeRequestId;
			const writeId = ++inPlaceWriteId;
			try {
				const fingerprint = outputFingerprint ?? await fingerprintPdfBytes(bytes);
				if (state.disposed || inPlacePdfViewStates.get(view) !== state ||
					state.reloadGeneration !== generation || state.writeRequestId !== requestId || view.file !== file) return null;
				state.latestWriteId = writeId;
				state.latestExpectation = { writeId, fingerprint, startedAt: Date.now(), writePending: true };
				return { fingerprint, generation, writeId };
			} catch (error) {
				console.warn('Study PDF: could not prepare an in-place PDF update', error);
				return null;
			}
		},

		async refreshAnnotationsInPlace(
			bytes: Uint8Array,
			pageIndexes: number[],
			token: InPlacePdfWriteToken,
			preview?: PdfUpdatePreview,
		): Promise<InPlaceRefreshResult> {
			const state = getInPlaceState();
			// modifyBinary has completed. Keep exact-byte suppression armed for its
			// whole duration, then allow a short window for duplicate file events.
		const expectation = state?.latestExpectation;
		if (!state || state.disposed || inPlacePdfViewStates.get(view) !== state ||
				state.reloadGeneration !== token.generation || view.file !== file ||
				state.latestWriteId !== token.writeId || expectation?.writeId !== token.writeId) return 'superseded';
		expectation.writePending = false;
		expectation.startedAt = Date.now();
		scheduleNotificationRecheck(state);
			const library = getPdfJsLibrary(view);
		if (!library || !canRefreshInPlace(view)) return 'unavailable';
		const isCurrent = () => !state.disposed && inPlacePdfViewStates.get(view) === state &&
			state.reloadGeneration === token.generation && view.file === file &&
			state.latestWriteId === token.writeId && state.latestExpectation?.writeId === token.writeId;
			if (!isCurrent()) return 'superseded';

			let task: PdfJsLoadingTaskLike;
			try {
				// PDF.js may transfer the input buffer to its worker; give it a private
				// copy because the same bytes are also used by other open PDF tabs.
				const prepared = preview?.sourceBytes === bytes ? await preview.takeDocument?.() : null;
				if (!isCurrent()) {
					if (prepared) await destroyLoadingTask(prepared);
					return 'superseded';
				}
				task = prepared ?? library.getDocument({ data: bytes.slice() });
			} catch {
				return 'unavailable';
			}

			let updatedDocument: PdfJsDocumentLike;
			try {
				updatedDocument = await task.promise;
			} catch {
				await destroyLoadingTask(task);
				return !isCurrent() ? 'superseded' : 'unavailable';
			}
			if (!isCurrent()) {
				await destroyLoadingTask(task);
				return 'superseded';
			}
			state.temporaryTasks.add(task);
			const documentLease = retainPdfDocument(updatedDocument);
			loadingTaskLeases.set(task, documentLease);
			state.currentDocument = updatedDocument;

			let livePdfViewer: PdfJsPdfViewer;
			try {
				livePdfViewer = getLivePdfViewer(view);
			} catch {
				return !isCurrent() ? 'superseded' : 'unavailable';
			}
			if (updatedDocument.numPages !== livePdfViewer.pagesCount) return 'unavailable';

			// Only the pages changed by this write need new canvases and annotation
			// layers. Unchanged pages can continue using their current proxies; the
			// lease scan below keeps that older worker alive while any page/layer or
			// thumbnail still references it.
			const refreshIndexes = new Set(pageIndexes);
			for (const pageIndex of refreshIndexes) {
				if (!isCurrent()) return 'superseded';
				if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= updatedDocument.numPages) {
					return 'unavailable';
				}
				const pageView = getPdfPageView(view, pageIndex);
				if (!pageView) return 'unavailable';
				try {
					const updatedPage = await documentLease.getPage(pageIndex + 1);
					if (!isCurrent()) return 'superseded';
					if (pageIndexes.includes(pageIndex)) {
						await refreshPageCanvas(pageView, updatedPage, isCurrent);
						if (!isCurrent()) return 'superseded';
					}
					await refreshPageAnnotationLayer(pageView, updatedPage);
					if (!isCurrent()) return 'superseded';
					if (pageIndexes.includes(pageIndex) && pageView.detailView) {
						if (typeof pageView.detailView.update !== 'function' || typeof livePdfViewer.forceRendering !== 'function') {
							return 'unavailable';
						}
						pageView.detailView.update({ underlyingViewUpdated: true });
					}
				} catch (error) {
					console.warn('Study PDF: could not refresh the page annotation layer', error);
					return !isCurrent() ? 'superseded' : 'unavailable';
				}
			}

			const viewerApplication = view.viewer?.child?.pdfViewer;
			if (!viewerApplication || !viewerApplication.pdfLoadingTask) return 'unavailable';
			if (!isCurrent()) return 'superseded';
			if (!state.displacedLoadingTask) state.displacedLoadingTask = viewerApplication.pdfLoadingTask;
			// Obsidian's PDF.js 5.3 viewer stores this as a writable own property.
			// setDocument() resets every page; assigning the checked data property
			// keeps canvases and scroll intact while future requests use current bytes.
			livePdfViewer.pdfDocument = updatedDocument;
			viewerApplication.pdfDocument = updatedDocument;
			viewerApplication.pdfLoadingTask = task;
			livePdfViewer.forceRendering?.();
			const pageConsumers: PdfPageConsumers[] = [];
			for (let index = 0; index < updatedDocument.numPages; index++) {
				const pageView = livePdfViewer.getPageView(index);
				if (pageView) pageConsumers.push(pageView);
				const thumbnail = viewerApplication.pdfThumbnailViewer?.getThumbnail(index);
				if (thumbnail) pageConsumers.push(thumbnail);
			}
			const obsoleteTasks = Array.from(state.temporaryTasks).filter((candidate) =>
				candidate !== task && loadingTaskLeases.get(candidate)?.canRelease(pageConsumers) === true,
			);
			for (const obsoleteTask of obsoleteTasks) {
				state.temporaryTasks.delete(obsoleteTask);
			}
			await Promise.all(obsoleteTasks.map(destroyLoadingTask));
			return isCurrent() ? 'refreshed' : 'superseded';
		},

		cancelInPlacePdfWrite(token: InPlacePdfWriteToken): void {
			const state = getInPlaceState();
			if (!state) return;
			if (state.latestWriteId === token.writeId && state.latestExpectation?.writeId === token.writeId) {
				state.latestExpectation = null;
				scheduleNotificationRecheck(state);
			}
		},

		async forceReload(): Promise<void> {
			const state = getInPlaceState();
			if (!state || state.disposed) return;
			const file = view.file;
			if (!file) return;
			await Promise.resolve(continueWithNormalReload(state, file, true));
		},

		async disposeInPlaceUpdates(): Promise<void> {
			const state = getInPlaceState();
			if (!state || state.disposed) return;
			state.disposed = true;
			state.latestExpectation = null;
			state.needsNotificationRecheck = false;
			if (view.onLoadFile === state.guardedOnLoadFile) view.onLoadFile = state.originalOnLoadFile;
			if (view.onClose === state.guardedOnClose && state.originalOnClose) view.onClose = state.originalOnClose;
			inPlacePdfViewStates.delete(view);
			const file = view.file;
			if (!file) {
				await releaseTemporaryDocuments(state);
				return;
			}
			await Promise.resolve(continueWithNormalReload(state, file));
		},

		findPageIndexForNode(node: Node): number | null {
			// .instanceOf, not instanceof: Obsidian supports popout windows with
			// their own separate HTMLElement realm, so a plain `instanceof`
			// against the main window's class can wrongly return false for a
			// node that lives in one.
			const el = node.instanceOf(HTMLElement) ? node : node.parentElement;
			const pageEl = el?.closest('div.page[data-page-number]');
			if (!pageEl) return null;
			const pageNumber = pageEl.getAttribute('data-page-number');
			if (!pageNumber) return null;
			return parseInt(pageNumber, 10) - 1;
		},
	};
}

/** Returns the active PDF view, or null if no PDF is open (not an error --
 * callers should just no-op, e.g. disable the highlight command). Throws
 * INTERNALS_ERROR if a PDF view exists but its internal shape doesn't match what
 * we expect (loud failure, per design -- see module header).
 *
 * `workspace.activeLeaf` is deprecated; Obsidian's own doc comment on it points
 * to `getActiveViewOfType` for exactly this "what's the active view" case. PDF
 * views are a `FileView` subclass (confirmed: `getViewType()` returns 'pdf'),
 * so passing the public `FileView` base class catches the active view whenever
 * it's any kind of file view, and the getViewType() check narrows to PDF
 * specifically. Preserves the previous fallback too: if focus isn't currently
 * on a PDF tab (e.g. the sidebar has focus) but one is still open in the
 * background, fall back to the first open PDF leaf rather than returning null. */
export function getActivePdfView(app: App): ActivePdfView | null {
	const activeView = app.workspace.getActiveViewOfType(FileView);
	if (activeView && activeView.getViewType() === 'pdf') {
		return buildPdfView(activeView.leaf, app);
	}

	const leaves = app.workspace.getLeavesOfType('pdf');
	return leaves.length > 0 ? buildPdfView(leaves[0]!, app) : null;
}

/** Every currently open PDF view (one per tab/pane), regardless of focus.
 * Used to keep a toolbar button present on every open PDF, not just whichever
 * one is currently active. */
export function getAllPdfViews(app: App): ActivePdfView[] {
	const views: ActivePdfView[] = [];
	for (const leaf of app.workspace.getLeavesOfType('pdf')) {
		const view = buildPdfView(leaf, app);
		if (view) views.push(view);
	}
	return views;
}
