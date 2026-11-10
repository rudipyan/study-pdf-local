import { Component, FileView, Notice, Platform, Plugin, TFile } from 'obsidian';
import {
	getActivePdfView,
	getAllPdfViews,
	patchNativeAnnotationPopup,
	type ActivePdfView,
	type PdfNoteLayerWatcher,
} from './obsidian-pdf-internals';
import { fingerprintPdfBytes, type InPlacePdfWriteToken } from './pdf-in-place';
import type { PdfUpdatePreview } from './pdf-update-preview';
import { showNoteEditorPopup, type IconPopup, type PopupAnchor } from './ui/icon-popup';
import { PomodoroTimer } from './pomodoro';
import { PomodoroChime } from './pomodoro-chime';
import { showPomodoroPopup } from './ui/pomodoro';
import { createAnnotationToolbar, restoreNativePdfToolbarControls, type AnnotationToolbar } from './ui/annotation-toolbar';
import { showReloadCurtain, type CurtainPaint } from './ui/reload-curtain';
import { preserveReadingPosition } from './preserve-reading-position';
import { createSelectionOverlay, liveSelectionOverlayRects, type SelectionOverlay } from './ui/selection-overlay';
import { NoteMarkerPositions } from './note-marker-positions';
import { updateNoteMarkers, disposeNoteMarkers } from './ui/note-markers';
import { createRegionSelection, type RegionSelectionController, type SelectedPdfRegion } from './ui/region-selection';
import { copyPdfRegionImage } from './pdf-region-copy';
import { canCopyHighlight, copyPdfHighlightText } from './pdf-highlight-copy';
import { createPdfLinkReturn, type PdfLinkReturnController } from './pdf-link-return';
import { showHighlightPreview, letPreviewPaint } from './ui/highlight-preview';
import { shouldKeepPressForGesture } from './tap-gesture';
import {
	beginPencilTextSelection,
	clearPencilTextSelection,
	extendPencilTextSelection,
	findRenderedTextLayer,
	hasPencilDragDistance,
	type PencilTextSelection,
} from './pencil-gesture';
import { HighlightListModal } from './ui/highlights-modal';
import {
	clientRectToPageLocal,
	dropDegenerateRects,
	selectionRectsToQuadPoints,
	HIGHLIGHT_EXPAND_TOP,
	HIGHLIGHT_EXPAND_BOTTOM,
	type PageLocalRect,
	pointWithinRects,
	type PdfViewportLike,
} from './geometry';
import {
	replaceOverlappingHighlightAnnotations,
	addHighlightAnnotations,
	addPageNote,
	buildHighlightIndex,
	getVerifiedHighlightState,
	findHighlightsInIndexAtPoint,
	removeHighlightForTarget,
	setHighlightColorAt,
	setHighlightNoteForTarget,
	reinspectHighlightTarget,
	configurePdfWorkScheduling,
	type HighlightIndex,
	type HighlightTarget,
	type RgbColor,
} from './annotate';
import { showColorPaletteModal, type CandidateChoice } from './ui/color-palette-modal';
import type { HighlightEntry } from './pdf-highlights';
import { withPdfHighlightSnapshot } from './pdf-highlight-snapshot';
import {
	annotationSubpath,
	buildEntryLink,
	exportNotePath,
	formatExportBody,
	mergeExportedNote,
	selectionExportNotePath,
	siblingNotePath,
} from './highlight-export';
import { buildFlashcardBlocks, mergeFlashcardNote } from './flashcards';
import { normalizeQuote } from './pdf-text-extraction';
import {
	capturePdfPress,
	capturePdfTarget,
	findPdfViewForNode,
	isCapturedPdfCurrent,
	isCapturedPdfViewLive,
	PdfMutationCoordinator,
	resolveCapturedPdfPress,
	type CapturedPdfTarget,
	type CapturedPdfPress,
	type PdfMutationTransform,
} from './pdf-mutation';
import {
	DEFAULT_SETTINGS,
	PdfHighlighterSettingTab,
	getDefaultColor,
	hexToRgbColor,
	normalizePdfHighlighterSettings,
	normalizePdfHighlighterSettingsForLoad,
	persistPdfHighlighterSettingsIfNeeded,
	type PdfHighlighterSettings,
} from './settings';
import { inspectStudyPdfPluginConflict } from './plugin-conflict';
import {
	PdfAnnotationHistory,
	type PdfHistoryDirection,
	type PdfHistoryTransition,
} from './pdf-annotation-history';
import { classifyPdfKeyboardShortcut, isPotentialPdfKeyboardShortcut } from './pdf-keyboard-shortcuts';
import { createPdfReadingLayout, type PdfReadingLayoutController } from './pdf-reading-layout';
import {
	clearPdfReadingAppearance,
	setPdfReadingAppearance,
	type PdfReadingAppearance,
} from './pdf-reading-appearance';
import { showReadingAppearancePopup } from './ui/reading-appearance-popup';

/** How far from the selection a touch may land and still count as "on" it --
 * covers the leading between line boxes and releasing a drag a hair past the
 * last glyph. */
const SELECTION_HIT_SLOP_PX = 6;

interface SelectionContext {
	capture: CapturedPdfTarget<TFile, ActivePdfView>;
	pdfView: ActivePdfView;
	range?: Range;
	segments: SelectionPageSegment[];
	/** The exact selected text, captured while the DOM selection is still live
	 * -- stored with the highlight so the list/copy features can show precisely
	 * what was highlighted instead of reconstructing it from PDF geometry (see
	 * pdf-text-extraction.ts's extractQuote for why that's only a fallback). */
	text: string;
	isRegion?: boolean;
}

interface SelectionSnapshot {
	anchorNode: Node | null;
	anchorOffset: number;
	focusNode: Node | null;
	focusOffset: number;
}

interface OwnedNativeSelection {
	pdfView: ActivePdfView;
	selection: Selection;
	range: Range;
}

interface SelectionPageSegment {
	pageIndex: number;
	textLayer: HTMLElement;
	pageLocalRects: PageLocalRect[];
	viewport: PdfViewportLike;
	text: string;
}

type PencilInput = { kind: 'pointer'; id: number } | { kind: 'touch'; id: number };

interface ActivePencilGesture {
	input: PencilInput;
	selection: PencilTextSelection;
	capture: CapturedPdfTarget<TFile, ActivePdfView>;
	pdfView: ActivePdfView;
	pageElement: HTMLElement;
	textLayer: HTMLElement;
	colorId: string;
	colorHex: string;
	color: RgbColor;
	generation: number;
	selectionStyleApplied: boolean;
	hadSelectionStyleClass: boolean;
	previousSelectionColor: string;
	previousSelectionPriority: string;
	frameRequestId: number | null;
	pendingCoordinates: { clientX: number; clientY: number } | null;
}

interface AnnotationToolbarState {
	regionSelection: RegionSelectionController | null;
	toolbar: AnnotationToolbar;
	colorId: string;
	highlighting: boolean;
	appearance: PdfReadingAppearance;
	appearanceContainer: HTMLElement | null;
	file: TFile | null;
}

interface PendingStylusTouch {
	id: number;
	x: number;
	y: number;
	at: number;
	ownerDocument: Document;
	insideToolbar: boolean;
}

interface PdfFocusModeState {
	containerEl: HTMLElement;
	file: TFile;
	leafEl: HTMLElement;
	toolbar: AnnotationToolbar;
	toolbarObserver: MutationObserver | null;
	returnFocusEl: HTMLElement | null;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	// .buffer alone could include extra bytes if the array were a view over a
	// larger buffer; slice to exactly what pdf-lib actually returned.
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isDomNode(value: unknown): value is Node {
	if (typeof value !== 'object' || value === null) return false;
	const nodeType = (value as { nodeType?: unknown }).nodeType;
	return typeof nodeType === 'number' && Number.isInteger(nodeType) && nodeType >= 1 && nodeType <= 12;
}

function exactBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function createMutationAbortError(message: string): Error {
	const error = new Error(message);
	error.name = 'AbortError';
	return error;
}

function eventElements(event: Event): Element[] {
	const elements: Element[] = [];
	for (const target of event.composedPath()) {
		if (!isDomNode(target)) continue;
		const node = target;
		const element = node.nodeType === 1 ? node as Element : node.parentElement;
		if (element && !elements.includes(element)) elements.push(element);
	}
	return elements;
}

function isEditableElement(element: Element | null): boolean {
	return Boolean(element?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'));
}

function hasIgnoredShortcutContext(document: Document, elements: readonly Element[], activeElement: Element | null): boolean {
	const selector = '.modal, .modal-container, .prompt, .suggestion-container, .suggestion-item, .search-input-container, .search-suggest-container, .menu, .study-pdf-note-marker, .study-pdf-link-return';
	return document.querySelector('.modal-container, [aria-modal="true"], dialog[open], .prompt') !== null ||
		elements.some((element) => Boolean(element.closest(selector))) || Boolean(activeElement?.closest(selector));
}

function selectionSegmentsForRange(pdfView: ActivePdfView, range: Range): SelectionPageSegment[] | null {
	const doc = pdfView.containerEl.ownerDocument;
	const view = doc.defaultView;
	const showText = view?.NodeFilter.SHOW_TEXT ?? 4;
	const startToStart = view?.Range.START_TO_START ?? 0;
	const endToEnd = view?.Range.END_TO_END ?? 2;
	const groups = new Map<number, { text: string[]; rects: DOMRect[]; viewport: PdfViewportLike; textLayer: HTMLElement }>();
	const startPageIndex = pdfView.findPageIndexForNode(range.startContainer);
	const endPageIndex = pdfView.findPageIndexForNode(range.endContainer);
	if (!pdfView.containerEl.contains(range.startContainer) || !pdfView.containerEl.contains(range.endContainer)) return null;
	const containingTextLayer = (node: Node) => {
		const element = node.nodeType === 1 ? node as Element : node.parentElement;
		return element?.closest<HTMLElement>('.textLayer') ?? null;
	};
	const startTextLayer = containingTextLayer(range.startContainer);
	const endTextLayer = containingTextLayer(range.endContainer);
	const needsPaneFallback = !startTextLayer || !endTextLayer;
	if (needsPaneFallback) {
		if ((!startTextLayer && range.startContainer.nodeType !== 1) ||
			(!endTextLayer && range.endContainer.nodeType !== 1)) return null;
	} else {
		if (startPageIndex === null || endPageIndex === null || startPageIndex > endPageIndex ||
			pdfView.findPageIndexForNode(startTextLayer) !== startPageIndex ||
			pdfView.findPageIndexForNode(endTextLayer) !== endPageIndex) return null;
		if (startPageIndex === endPageIndex && startTextLayer !== endTextLayer) return null;
	}

	const buildSegments = (verifyRenderedPages = false): SelectionPageSegment[] | null => {
		const segments: SelectionPageSegment[] = [];
		for (const [pageIndex, group] of Array.from(groups).sort(([left], [right]) => left - right)) {
			if (verifyRenderedPages && !pdfView.getPageElement(pageIndex)) return null;
			const origin = group.textLayer.getBoundingClientRect();
			const rects = dropDegenerateRects(group.rects.map((rect) => clientRectToPageLocal(rect, { x: origin.left, y: origin.top })));
			const text = group.text.join('');
			if (rects.length === 0 || !normalizeQuote(text)) return null;
			segments.push({ pageIndex, textLayer: group.textLayer, pageLocalRects: rects, viewport: group.viewport, text });
		}
		for (let index = 1; index < segments.length; index++) {
			if (segments[index]!.pageIndex !== segments[index - 1]!.pageIndex + 1) return null;
		}
		if (normalizeQuote(segments.map((segment) => segment.text).join('')) !== normalizeQuote(range.toString())) return null;
		return segments.length > 0 ? segments : null;
	};

	if (needsPaneFallback) {
		// Preserve valid parent-boundary ranges inside this PDF pane, including
		// boundaries on the page-list container that have no page index of their own.
		const pageElements = new Map<number, HTMLElement | null>();
		const pageViewports = new Map<number, PdfViewportLike>();
		const paneWalker = doc.createTreeWalker(pdfView.containerEl, showText);
		let current = paneWalker.nextNode();
		while (current) {
			const textNode = current as Text;
			let intersects = false;
			try { intersects = range.intersectsNode(textNode); } catch { /* Ignore a detached text node. */ }
			if (intersects && textNode.data.length > 0) {
				const pageIndex = pdfView.findPageIndexForNode(textNode);
				if (pageIndex !== null) {
					let pageElement = pageElements.get(pageIndex);
					if (pageElement === undefined) {
						pageElement = pdfView.getPageElement(pageIndex);
						pageElements.set(pageIndex, pageElement);
					}
					const textLayer = containingTextLayer(textNode);
					// Keep annotation popups and other page UI out of quotations.
					if (pageElement?.contains(textLayer) && textLayer?.contains(textNode)) {
						let viewport = pageViewports.get(pageIndex);
						if (!viewport) {
							try { viewport = pdfView.getPageViewport(pageIndex); } catch { return null; }
							pageViewports.set(pageIndex, viewport);
						}
						if (typeof viewport.convertToPdfPoint !== 'function') return null;
						try {
							const nodeRange = doc.createRange();
							nodeRange.selectNodeContents(textNode);
							const startOffset = range.compareBoundaryPoints(startToStart, nodeRange) <= 0
								? 0
								: range.startContainer === textNode ? range.startOffset : 0;
							const endOffset = range.compareBoundaryPoints(endToEnd, nodeRange) >= 0
								? textNode.data.length
								: range.endContainer === textNode ? range.endOffset : textNode.data.length;
							if (endOffset > startOffset) {
								nodeRange.setStart(textNode, startOffset);
								nodeRange.setEnd(textNode, endOffset);
								const group = groups.get(pageIndex) ?? { text: [], rects: [], viewport, textLayer };
								if (group.textLayer !== textLayer) return null;
								group.text.push(textNode.data.slice(startOffset, endOffset));
								group.rects.push(...Array.from(nodeRange.getClientRects()));
								groups.set(pageIndex, group);
							}
						} catch { return null; }
					}
				}
			}
			current = paneWalker.nextNode();
		}
		return buildSegments(true);
	}

	if (!startTextLayer || !endTextLayer || startPageIndex === null || endPageIndex === null || startPageIndex > endPageIndex) return null;

	for (let pageIndex = startPageIndex; pageIndex <= endPageIndex; pageIndex++) {
		const pageElement = pdfView.getPageElement(pageIndex);
		const textLayer = pageElement?.matches('.textLayer') ? pageElement : pageElement?.querySelector<HTMLElement>('.textLayer') ?? null;
		if (!pageElement || !textLayer || (pageIndex === startPageIndex && !pageElement.contains(startTextLayer)) ||
			(pageIndex === endPageIndex && !pageElement.contains(endTextLayer))) return null;
		let viewport: PdfViewportLike;
		try { viewport = pdfView.getPageViewport(pageIndex); } catch { return null; }
		if (typeof viewport.convertToPdfPoint !== 'function') return null;

		const collectTextNode = (textNode: Text): boolean => {
			let intersects = false;
			try { intersects = range.intersectsNode(textNode); } catch { /* Ignore a detached text node. */ }
			if (!intersects || textNode.data.length === 0) return true;
			const nodeTextLayer = containingTextLayer(textNode);
			// Only PDF.js's selectable text layer belongs in a quotation; annotation
			// popups and other page UI can also contain text nodes.
			if (pdfView.findPageIndexForNode(textNode) !== pageIndex || nodeTextLayer !== textLayer || !textLayer.contains(textNode)) return true;
			try {
				const nodeRange = doc.createRange();
				nodeRange.selectNodeContents(textNode);
				const startOffset = range.compareBoundaryPoints(startToStart, nodeRange) <= 0
					? 0
					: range.startContainer === textNode ? range.startOffset : 0;
				const endOffset = range.compareBoundaryPoints(endToEnd, nodeRange) >= 0
					? textNode.data.length
					: range.endContainer === textNode ? range.endOffset : textNode.data.length;
				if (endOffset > startOffset) {
					nodeRange.setStart(textNode, startOffset);
					nodeRange.setEnd(textNode, endOffset);
					const group = groups.get(pageIndex) ?? { text: [], rects: [], viewport, textLayer };
					if (group.textLayer !== textLayer) return false;
					group.text.push(textNode.data.slice(startOffset, endOffset));
					group.rects.push(...Array.from(nodeRange.getClientRects()));
					groups.set(pageIndex, group);
				}
			} catch { return false; }
			return true;
		};

		// Range traversal excludes its root node. Handle a same-node selection
		// directly. For ordinary text endpoints, seed the first page at the start
		// Text and stop the last page at the end Text; only middle pages need a full
		// text-layer walk. Element-boundary selections keep the broader fallback.
		if (range.startContainer === range.endContainer && range.startContainer.nodeType === 3) {
			if (!collectTextNode(range.startContainer as Text)) return null;
			continue;
		}
		const walker = doc.createTreeWalker(textLayer, showText);
		const hasTextEndpoints = range.startContainer.nodeType === 3 && range.endContainer.nodeType === 3;
		const startTextNode = hasTextEndpoints && pageIndex === startPageIndex ? range.startContainer as Text : null;
		const endTextNode = hasTextEndpoints && pageIndex === endPageIndex ? range.endContainer as Text : null;
		if (startTextNode) {
			walker.currentNode = startTextNode;
			if (!collectTextNode(startTextNode)) return null;
		}
		let current = walker.nextNode();
		while (current) {
			if (!collectTextNode(current as Text)) return null;
			if (current === endTextNode) break;
			current = walker.nextNode();
		}
	}

	return buildSegments();
}

export default class PdfHighlighterPlugin extends Plugin {
	settings: PdfHighlighterSettings = normalizePdfHighlighterSettings(DEFAULT_SETTINGS);
	/** Last press position inside a rendered PDF page (mousedown, or pointerdown
	 * for touch/pen -- see the pointerdown listener). Used both by "Remove
	 * highlight at selection" and the click-to-highlight chooser, instead of
	 * window.getSelection(): clicking directly on an existing highlight is
	 * consumed by PDF.js's own annotation layer (it shows its own popup,
	 * confirmed live) before a text selection ever forms there, so we track raw
	 * click coordinates ourselves instead. */
	private lastPdfClick: CapturedPdfPress<TFile, ActivePdfView> | null = null;

	/** Tracks whichever of our popups is currently open, so they can be dismissed
	 * or repositioned together and so we never show two at once. */
	private activePopup: IconPopup | null = null;
	private pomodoro: PomodoroTimer | null = null;
	private readonly pomodoroChime = new PomodoroChime();
	/** Exact annotation belonging to the currently open, unambiguous chooser. */
	private selectedAnnotation: {
		capture: CapturedPdfTarget<TFile, ActivePdfView>;
		target: HighlightTarget;
		popup: IconPopup;
		copy: (() => void) | null;
		clearOutline(): void;
	} | null = null;
	private menuGeneration = 0;
	private readonly annotationToolbars = new Map<HTMLElement, AnnotationToolbarState>();
	private readonly pdfReadingLayouts = new Map<HTMLElement, {
		file: TFile;
		controller: PdfReadingLayoutController;
	}>();
	private readonly pdfFocusModes = new Map<Document, PdfFocusModeState>();
	private readonly noteMarkerViews = new Map<HTMLElement, {
		file: TFile;
		watcher?: PdfNoteLayerWatcher;
		layers: Set<HTMLElement>;
	}>();
	private noteMarkerRetryTimer = 0;
	private toolbarRetryTimer = 0;
	private noteMarkerPositions: NoteMarkerPositions | null = null;
	private readonly pdfLinkReturns = new Map<HTMLElement, { file: TFile; controller: PdfLinkReturnController }>();
	private readonly annotationHistory = new PdfAnnotationHistory<TFile>();
	private readonly pendingPreviews = new Set<{ dispose(): void }>();
	private readonly activeHighlightActions = new Set<AbortController>();
	private isUnloading = false;

	/** Coalesces duplicate press/release checks so a normal desktop drag commits
	 * once instead of scheduling a second pass after the mouseup. */
	private selectionUpdateTimer = 0;
	private mouseSelectionDown = false;
	private lastNonMousePointerAt = -Infinity;
	private selectionGestureGeneration = 0;
	private selectionAtPress: SelectionSnapshot | null = null;
	private readonly interactionDocuments = new Set<Document>();

	/** Non-null only on iOS, where WKWebView ignores every ::selection property
	 * in the PDF text layer and paints a barely-visible system tint instead, so
	 * the selection has to be drawn as real elements (see selection-overlay.ts).
	 * Everywhere else ::selection works and this stays null -- painting both
	 * would double-tint the selection. */
	private selectionOverlay: SelectionOverlay | null = null;
	private selectionOverlayDocument: Document | null = null;
	private selectionOverlayFrame: { id: number; ownerWindow: Window } | null = null;

	/** Where and when the current touch/pen press started, so pointerup can be
	 * classified and pointercancel can invalidate its captured PDF target. */
	private pendingPress: { x: number; y: number; at: number } | null = null;
	private pencilGesture: ActivePencilGesture | null = null;
	private pendingStylusTouch: PendingStylusTouch | null = null;
	private cancelledPencilPointerIds = new Set<number>();

	/** Pointer ids currently down. A pinch is two of them, and each one still
	 * ends with its own pointerup -- without this every zoom gesture would be
	 * read as a tap and trigger a full check, which re-reads and re-parses the
	 * whole PDF. On a large document that is a long main-thread block landing
	 * exactly while pdf.js is re-rasterising and re-anchoring scroll position. */
	private activePointers = new Set<number>();
	/** Touch identifiers are tracked separately because iOS Pencil is read from
	 * Touch Events while its compatibility Pointer Events are intentionally
	 * ignored. This keeps a second finger latched until every contact is up. */
	private activeTouchContacts = new Map<Document, Set<number>>();

	/** Latched once a second finger lands, and only released when every finger
	 * is up: the tail of a pinch must not be treated as a tap either. */
	private isMultiTouchGesture = false;

	/** Where the last touch/pen press landed, in viewport coordinates. Unlike
	 * lastPdfClick this is kept even for presses outside the pages -- tapping the
	 * grey margin is still the user saying "dismiss this".
	 *
	 * One-shot: consumed by the next 'full' check and cleared. A point left lying
	 * around outlives the gesture that produced it and would later be read as a
	 * press outside some unrelated selection, silently throwing that one away.
	 *
	 * Set from pointerdown when there is one, and otherwise from pointerup --
	 * while a native iOS selection is up, WKWebView swallows the pointerdown of a
	 * tap and delivers only the pointerup (confirmed from an on-device log), so
	 * insisting on pointerdown means the dismissing tap is never measured at all.
	 * pointerdown still wins where both arrive: a long-press that creates a
	 * selection releases well away from where it started, and the release point
	 * can fall outside the very selection it just made. */
	private lastTouchPressPoint: { x: number; y: number } | null = null;

	/** Parsed highlight positions for one file version, so tapping around a
	 * document doesn't re-read and re-parse the whole PDF on every tap -- a real
	 * stall on a large one, right on the touch path.
	 *
	 * Keyed by TFile identity and path + mtime + size as passive cache hints. It
	 * only feeds the "is there a highlight here?" lookup; every mutation verifies
	 * the captured file and reads its bytes fresh before writing. */
	private highlightIndex: { key: string; file: TFile; index: HighlightIndex } | null = null;
	private readonly pdfMutationCoordinator = new PdfMutationCoordinator();
	private highlightIndexGeneration = 0;
	private highlightIndexBuild: { key: string; file: TFile; generation: number; promise: Promise<HighlightIndex> } | null = null;

	async onload() {
		const pluginConflict = await inspectStudyPdfPluginConflict(this.app.vault.configDir, {
			read: (path) => this.app.vault.adapter.read(path),
		});
		if (pluginConflict) {
			new Notice(`Rudi's Study PDF: ${pluginConflict}`, 0);
			return;
		}
		configurePdfWorkScheduling(Platform.isIosApp);
		await this.loadSettings();
		this.noteMarkerPositions = new NoteMarkerPositions(this.app.vault.adapter,
			`${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/note-marker-positions.json`,
			() => new Notice('Comment icon positions could not be saved or loaded. Your PDF notes are unchanged.'),
		);
		await this.noteMarkerPositions.load();
		this.pomodoro = new PomodoroTimer(window, this.app.vault.adapter,
			`${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/pomodoro.json`,
			(phase, caughtUp) => {
				const state = this.pomodoro?.snapshot();
				if (state) this.pomodoroChime.play(state.volume, state.muted);
				new Notice(caughtUp ? (state?.running ? `Study timer caught up. ${phase === 'study' ? 'Study' : 'Break'} is running.` : 'Study session and break finished.')
					: phase === 'break' ? 'Study session complete. Time for a break.'
					: state?.running ? 'Break finished. Your next study round has started.' : 'Break finished. Ready for your next study round.');
			},
			() => new Notice('Study timer settings could not be saved or loaded.'),
		);
		await this.pomodoro.load();
		this.addSettingTab(new PdfHighlighterSettingTab(this.app, this, this));
		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (file.path.toLowerCase().endsWith('.pdf')) this.invalidateHighlightIndex();
		}));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (!(file instanceof TFile)) return;
			this.annotationHistory.clearPath(oldPath);
			this.annotationHistory.clearFile(file);
			this.refreshAnnotationToolbars();
		}));
		this.registerEvent(this.app.vault.on('delete', (file) => {
			if (!(file instanceof TFile)) return;
			this.annotationHistory.clearPath(file.path);
			this.annotationHistory.clearFile(file);
			this.refreshAnnotationToolbars();
		}));

		// Keep Obsidian's own annotation popup from overlapping our click-to-remove
		// menu (see patchNativeAnnotationPopup). Patching needs an existing PDF view
		// to reach the prototype through, so retry on layout changes until one shows up.
		let unpatchNativePopup: (() => void) | null = null;
		const tryPatchNativePopup = () => {
			if (!unpatchNativePopup) unpatchNativePopup = patchNativeAnnotationPopup(this.app);
		};
		this.app.workspace.onLayoutReady(tryPatchNativePopup);
		this.registerEvent(this.app.workspace.on('layout-change', tryPatchNativePopup));
		this.register(() => unpatchNativePopup?.());

		// A ribbon icon would show up globally (even with a .txt file open); a
		// button in the PDF view's own toolbar only appears while viewing a PDF.
		// New PDF tabs need this re-run, hence the same layout-change hook.
		this.app.workspace.onLayoutReady(() => this.ensureToolbarButtons());
		this.registerEvent(this.app.workspace.on('layout-change', () => this.ensureToolbarButtons()));
		this.registerEvent(this.app.workspace.on('file-open', (file) => {
			if (file?.extension.toLowerCase() === 'pdf') this.ensureToolbarButtons(0, true);
		}));
		// Keep marker discovery off ensureToolbarButtons' selection hot path.
		this.app.workspace.onLayoutReady(() => this.syncPdfNoteMarkers());
		this.registerEvent(this.app.workspace.on('layout-change', () => this.syncPdfNoteMarkers()));
		this.registerEvent(this.app.workspace.on('file-open', () => this.syncPdfNoteMarkers()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
			const activeLeafEl = leaf?.view.containerEl.closest<HTMLElement>('.workspace-leaf') ?? null;
			for (const [ownerDocument, state] of this.pdfFocusModes) {
				if (state.leafEl !== activeLeafEl) this.exitPdfFocusMode(ownerDocument, false);
			}
		}));

		this.bindPdfDocumentInteractions(document);

		this.addCommand({
			id: 'highlight-selection',
			name: 'Highlight selection',
			checkCallback: (checking) => {
				if (!getActivePdfView(this.app)) return false;
				if (!checking) {
					const color = getDefaultColor(this.settings);
					void this.highlightCurrentSelection(hexToRgbColor(color.hex));
				}
				return true;
			},
		});

		this.addCommand({
			id: 'list-highlights',
			name: 'Show all highlights and notes',
			checkCallback: (checking) => {
				const pdfView = getActivePdfView(this.app);
				if (!pdfView) return false;
				if (!checking) {
					new HighlightListModal(
						this.app,
						pdfView,
						this.pdfMutationCoordinator,
						() => this.exportHighlightsToNote(pdfView),
						(entries, snapshotFingerprint) => this.exportSelectedHighlightsToNote(pdfView, entries, snapshotFingerprint),
					).open();
				}
				return true;
			},
		});

		this.addCommand({
			id: 'export-highlights',
			name: 'Export highlights to note',
			checkCallback: (checking) => {
				const pdfView = getActivePdfView(this.app);
				if (!pdfView) return false;
				if (!checking) void this.exportHighlightsToNote(pdfView);
				return true;
			},
		});

		this.addCommand({
			id: 'sync-flashcards',
			name: 'Sync flashcards from notes',
			checkCallback: (checking) => {
				const pdfView = getActivePdfView(this.app);
				if (!pdfView) return false;
				if (!checking) void this.syncFlashcards(pdfView);
				return true;
			},
		});

		this.addCommand({
			id: 'remove-highlight-at-selection',
			name: 'Remove highlight at selection',
			checkCallback: (checking) => {
				if (!getActivePdfView(this.app)) return false;
				if (!checking) void this.removeHighlightAtLastClick();
				return true;
			},
		});

		this.addCommand({
			id: 'undo-pdf-annotation',
			name: 'Undo PDF annotation',
			checkCallback: (checking) => {
				const pdfView = this.getActivePdfViewOnly();
				if (!pdfView || !this.annotationHistory.status(pdfView.file, pdfView.file.path).canUndo) return false;
				if (!checking) void this.applyPdfHistory(pdfView, 'undo');
				return true;
			},
		});

		this.addCommand({
			id: 'redo-pdf-annotation',
			name: 'Redo PDF annotation',
			checkCallback: (checking) => {
				const pdfView = this.getActivePdfViewOnly();
				if (!pdfView || !this.annotationHistory.status(pdfView.file, pdfView.file.path).canRedo) return false;
				if (!checking) void this.applyPdfHistory(pdfView, 'redo');
				return true;
			},
		});

	}

	private bindPdfDocumentInteractions(ownerDocument: Document) {
		if (this.interactionDocuments.has(ownerDocument) || this.isUnloading) return;
		const ownerWindow = ownerDocument.defaultView;
		if (!ownerWindow) return;
		this.interactionDocuments.add(ownerDocument);
		const binding = this.addChild(new Component());
		binding.register(() => this.interactionDocuments.delete(ownerDocument));
		binding.registerDomEvent(ownerWindow, 'unload', () => {
			this.exitPdfFocusMode(ownerDocument, false);
			this.disposePdfReadingLayoutsFor(ownerDocument);
			for (const container of this.noteMarkerViews.keys()) {
				if (container.ownerDocument === ownerDocument) this.disposeNoteMarkersForView(container);
			}
			for (const [container, state] of this.pdfLinkReturns) {
				if (container.ownerDocument !== ownerDocument) continue;
				state.controller.dispose();
				this.pdfLinkReturns.delete(container);
			}
			if (this.pencilGesture?.pdfView.containerEl.ownerDocument === ownerDocument) this.cancelPencilGesture(true);
			if (this.pendingStylusTouch?.ownerDocument === ownerDocument) this.pendingStylusTouch = null;
			this.activeTouchContacts.delete(ownerDocument);
			this.selectionGestureGeneration++;
			window.clearTimeout(this.selectionUpdateTimer);
			this.mouseSelectionDown = false;
			if (this.lastPdfClick?.capture.pdfView.containerEl.ownerDocument === ownerDocument) this.lastPdfClick = null;
			if (this.selectionAtPress?.anchorNode?.ownerDocument === ownerDocument || this.selectionAtPress?.focusNode?.ownerDocument === ownerDocument) this.selectionAtPress = null;
			if (this.activePopup?.el.ownerDocument === ownerDocument) this.hideActiveMenu();
			for (const [right, state] of this.annotationToolbars) {
				if (right.ownerDocument !== ownerDocument) continue;
				this.clearAnnotationToolbarAppearance(state);
				state.regionSelection?.dispose();
				state.toolbar.destroy();
				this.annotationToolbars.delete(right);
			}
			this.removeChild(binding);
		});
		binding.registerDomEvent(ownerDocument, 'mousedown', (evt) => {
			if (performance.now() - this.lastNonMousePointerAt < 500 || evt.button !== 0) return;
			if (!this.isInsideActivePopup(evt.target) && evt.button === 0) {
				this.mouseSelectionDown = true;
				window.clearTimeout(this.selectionUpdateTimer);
				this.hideActiveMenu();
			}
			// A mouse press means we are not mid-touch; drop any remembered touch
			// point so it can't be read as "this click landed outside the selection".
			this.lastTouchPressPoint = null;
			this.recordPdfPress(evt);
		});

		binding.registerDomEvent(ownerDocument, 'mouseup', (evt) => {
			if (performance.now() - this.lastNonMousePointerAt < 500 || evt.button !== 0) return;
			this.mouseSelectionDown = false;
			// Interacting with the popup itself must not re-run the show/hide logic,
			// or the popup would vanish before its button's click event fires.
			if (this.isInsideActivePopup(evt.target)) return;
			// A selection isn't final the instant mouseup fires in every browser;
			// yielding a tick first avoids reading a stale/incomplete selection.
			const click = this.lastPdfClick;
			const editNote = evt.detail === 2 && !evt.defaultPrevented && !evt.altKey && !evt.ctrlKey && !evt.metaKey && !evt.shiftKey &&
				click !== null && Math.hypot(evt.clientX - click.clientX, evt.clientY - click.clientY) <= 4 &&
				isDomNode(evt.target) && click.capture.pdfView.containerEl.contains(evt.target) &&
				!eventElements(evt).some((element) => element.matches('a, button') || isEditableElement(element));
			this.scheduleSelectionUpdate(0, click?.capture ?? null, editNote);
		});

		binding.registerDomEvent(ownerWindow, 'blur', () => {
			if (this.pencilGesture?.input.kind === 'pointer') this.cancelledPencilPointerIds.add(this.pencilGesture.input.id);
			this.cancelPencilGesture(true);
			this.pendingStylusTouch = null;
			this.activeTouchContacts.clear();
			this.activePointers.clear();
			this.isMultiTouchGesture = false;
			this.selectionGestureGeneration++;
			this.mouseSelectionDown = false;
			window.clearTimeout(this.selectionUpdateTimer);
			if (!this.activePopup?.preserveOnBlur) this.hideActiveMenu();
		});
		binding.registerDomEvent(ownerDocument, 'keydown', (evt) => {
			this.handlePdfKeyboardShortcut(ownerDocument, evt);
		}, true);
		binding.registerDomEvent(ownerDocument, 'contextmenu', (evt) => this.openPageNoteAtClick(ownerDocument, evt), true);

		// Touch taps reach the two listeners above only as *compatibility* mouse
		// events, which the engine synthesizes after touchend and suppresses
		// whenever it decides the gesture wasn't a clean tap -- a few pixels of
		// thumb travel, a long-press promoted to a selection gesture, or a
		// preventDefault anywhere in the touch sequence is enough. That is why
		// tapping a highlight on a phone shows the note/trash popup only
		// sometimes. Pointer events are dispatched for the real gesture rather
		// than reconstructed from it, so they don't have that failure mode.
		//
		// Finger and mouse gestures keep their existing event paths. On iPad,
		// Apple Pencil is owned through stylus-only Touch Events so a claimed move
		// can prevent WebKit from turning the stroke into PDF scrolling. Other pen
		// devices use Pointer Events. Neither path changes freehand ink behavior.
		binding.registerDomEvent(ownerDocument, 'pointerdown', (evt) => {
			if (evt.pointerType === 'mouse') return;
			if (Platform.isIosApp && evt.pointerType === 'pen') return;
			this.cancelledPencilPointerIds.delete(evt.pointerId);
			this.lastNonMousePointerAt = performance.now();
			this.activePointers.add(evt.pointerId);
			if (this.activePointers.size > 1 || this.pencilGesture || (Platform.isIosApp && this.pendingStylusTouch)) {
				this.selectionGestureGeneration++;
				this.selectionAtPress = null;
				this.cancelPencilGesture(true);
				this.pendingStylusTouch = null;
				this.isMultiTouchGesture = true;
				this.pendingPress = null;
				this.lastPdfClick = null;
				this.lastTouchPressPoint = null;
				return;
			}
			this.pendingPress = { x: evt.clientX, y: evt.clientY, at: performance.now() };
			if (!this.isInsideActivePopup(evt.target)) {
				this.lastTouchPressPoint = { x: evt.clientX, y: evt.clientY };
			}
			this.recordPdfPress(evt);
			if (evt.pointerType === 'pen' && evt.button === 0 && evt.isPrimary) {
				this.startPencilGesture(evt.target, evt.clientX, evt.clientY, { kind: 'pointer', id: evt.pointerId });
			}
		});
		binding.registerDomEvent(ownerDocument, 'pointermove', (evt) => {
			if (evt.pointerType !== 'pen' || Platform.isIosApp) return;
			const gesture = this.pencilGesture;
			if (!gesture || gesture.input.kind !== 'pointer' || gesture.input.id !== evt.pointerId) return;
			gesture.selection.moved ||= hasPencilDragDistance(gesture.selection, evt.clientX, evt.clientY);
			evt.preventDefault();
			this.queuePencilGestureUpdate(gesture, evt.clientX, evt.clientY);
		});

		binding.registerDomEvent(ownerDocument, 'pointerup', async (evt) => {
			if (evt.pointerType === 'mouse') return;
			if (Platform.isIosApp && evt.pointerType === 'pen') return;
			this.lastNonMousePointerAt = performance.now();
			if (this.cancelledPencilPointerIds.delete(evt.pointerId)) {
				this.pendingPress = null;
				this.releasePointer(evt.pointerId);
				this.lastPdfClick = null;
				this.lastTouchPressPoint = null;
				return;
			}
			const press = this.pendingPress;
			const selectionCapture = this.lastPdfClick?.capture ?? null;
			const selection = !press && Platform.isIosApp ? ownerDocument.defaultView?.getSelection() : null;
			const baseline = this.selectionAtPress;
			const selectionPdfView = this.lastPdfClick?.capture.pdfView;
			const nativeHandleSelectionChanged = Boolean(
				selection && !selection.isCollapsed && selection.anchorNode && selection.focusNode && baseline &&
				baseline.anchorNode?.ownerDocument === ownerDocument && baseline.focusNode?.ownerDocument === ownerDocument &&
				selectionPdfView?.containerEl.ownerDocument === ownerDocument &&
				selectionPdfView.containerEl.contains(selection.anchorNode) && selectionPdfView.containerEl.contains(selection.focusNode) &&
				(baseline.anchorNode !== selection.anchorNode || baseline.anchorOffset !== selection.anchorOffset ||
					baseline.focusNode !== selection.focusNode || baseline.focusOffset !== selection.focusOffset),
			);
			this.pendingPress = null;
			if (this.releasePointer(evt.pointerId)) {
				this.cancelPencilGesture(true);
				this.pendingStylusTouch = null;
				this.lastPdfClick = null;
				this.lastTouchPressPoint = null;
				return;
			}
			const gesture = this.pencilGesture;
			if (gesture?.input.kind === 'pointer' && gesture.input.id === evt.pointerId) {
				const outcome = await this.finishPencilGesture(gesture, evt.clientX, evt.clientY);
				if (outcome !== 'tap') return;
			}
			if (this.isInsideActivePopup(evt.target)) return;
			if (press && !shouldKeepPressForGesture({
				downX: press.x,
				downY: press.y,
				endX: evt.clientX,
				endY: evt.clientY,
				durationMs: performance.now() - press.at,
			})) {
				this.lastPdfClick = null;
				this.lastTouchPressPoint = null;
				this.scheduleSelectionUpdate(0, selectionCapture);
				return;
			}
			if (nativeHandleSelectionChanged) {
				// WKWebView can swallow pointerdown while the native selection handles
				// move. Keep that release from being mistaken for a tap away from the
				// selection. Commit only at this actual release, using its original
				// capture/baseline and the usual tool/current-view validation.
				this.lastTouchPressPoint = null;
				this.scheduleSelectionUpdate(0, selectionCapture);
				return;
			}
			// ??=, not =: keep the pointerdown point when one arrived.
			this.lastTouchPressPoint ??= { x: evt.clientX, y: evt.clientY };
			// iOS may swallow pointerdown while a native selection is open. Record
			// that tap at pointerup rather than reusing a previous press.
			if (!press) this.recordPdfPress(evt);
			// Reaching here means this pointerup passed the tap threshold (or came
			// from an iOS path that swallowed pointerdown).
			this.scheduleSelectionUpdate(0, this.lastPdfClick?.capture ?? selectionCapture);
		});

		// iOS also cancels brief thumb taps. Keep only a short, low-travel sequence;
		// scrolling and native-selection gestures clear the captured press.
		binding.registerDomEvent(ownerDocument, 'pointercancel', (evt) => {
			if (evt.pointerType === 'mouse') return;
			if (Platform.isIosApp && evt.pointerType === 'pen') return;
			this.cancelledPencilPointerIds.delete(evt.pointerId);
			this.selectionGestureGeneration++;
			this.selectionAtPress = null;
			this.lastNonMousePointerAt = performance.now();
			if (evt.pointerType === 'pen') {
				this.cancelPencilGesture(true);
				this.pendingPress = null;
				this.releasePointer(evt.pointerId);
				this.lastPdfClick = null;
				this.lastTouchPressPoint = null;
				return;
			}
			if (this.pencilGesture) {
				this.cancelPencilGesture(true);
				this.pendingStylusTouch = null;
				this.isMultiTouchGesture = true;
			}
			const press = this.pendingPress;
			this.pendingPress = null;
			if (this.releasePointer(evt.pointerId)) {
				this.lastPdfClick = null;
				this.lastTouchPressPoint = null;
				return;
			}
			if (this.isInsideActivePopup(evt.target)) return;
			if (!press) {
				this.lastPdfClick = null;
				this.lastTouchPressPoint = null;
				return;
			}
			const keepPress = shouldKeepPressForGesture({
				downX: press.x,
				downY: press.y,
				endX: evt.clientX,
				endY: evt.clientY,
				durationMs: performance.now() - press.at,
			});
			if (!keepPress) {
				this.lastPdfClick = null;
				this.lastTouchPressPoint = null;
				return;
			}
			this.lastTouchPressPoint ??= { x: evt.clientX, y: evt.clientY };
			this.scheduleSelectionUpdate(0);
		});
		if (Platform.isIosApp) {
			binding.registerDomEvent(ownerDocument, 'touchstart', (evt) => this.handleStylusTouchStart(ownerDocument, evt), { passive: false });
			binding.registerDomEvent(ownerDocument, 'touchmove', (evt) => this.handleStylusTouchMove(ownerDocument, evt), { passive: false });
			binding.registerDomEvent(ownerDocument, 'touchend', (evt) => { void this.handleStylusTouchEnd(ownerDocument, evt); }, { passive: false });
			binding.registerDomEvent(ownerDocument, 'touchcancel', (evt) => this.handleStylusTouchCancel(ownerDocument, evt), { passive: false });
		}
		// Repositions the popup as the viewport moves. A focused note editor and
		// the candidate chooser stay available through scrolling.
		// On mobile, focusing that textarea makes the OS scroll the page to lift
		// it above the on-screen keyboard, firing a real 'scroll' event that's
		// otherwise indistinguishable from the user scrolling the PDF away; without
		// this guard the note editor closed itself the instant it was focused.
		binding.registerDomEvent(
			ownerDocument,
			'scroll',
			() => {
				// The overlay is positioned in viewport coordinates, so it has to
				// follow the page even when the popup is being left alone.
				this.scheduleSelectionOverlayRefresh(ownerDocument);
				if (this.activePopup?.preserveOnScroll) {
					return;
				}
				if (this.isInsideActivePopup(ownerDocument.activeElement)) {
					return;
				}
				this.hideActiveMenu();
			},
			true,
		);

		// Native selection handles do not dispatch page-level pointermove events.
		// selectionchange keeps the iOS overlay painted during those adjustments;
		// the menu check runs once the completed selection is released.
		if (Platform.isIosApp) {
			this.cancelSelectionOverlayRefresh();
			this.selectionOverlay?.destroy();
			const overlay = createSelectionOverlay(ownerDocument);
			this.selectionOverlay = overlay;
			this.selectionOverlayDocument = ownerDocument;
			binding.register(() => {
				if (this.selectionOverlay !== overlay) return;
				this.cancelSelectionOverlayRefresh();
				overlay.destroy();
				this.selectionOverlay = null;
				this.selectionOverlayDocument = null;
			});
		}

		binding.registerDomEvent(ownerDocument, 'selectionchange', () => {
			// Pencil-owned selection changes are painted once by its rAF batch.
			// Other native selection and scroll events share one visual frame.
			if (!this.pencilGesture) this.scheduleSelectionOverlayRefresh(ownerDocument);
		});
		binding.register(() => {
			window.clearTimeout(this.selectionUpdateTimer);
		});

	}

	onunload() {
		this.isUnloading = true;
		configurePdfWorkScheduling(false);
		this.cancelSelectionOverlayRefresh();
		this.pomodoro?.dispose();
		this.pomodoroChime.dispose();
		window.clearTimeout(this.noteMarkerRetryTimer);
		window.clearTimeout(this.toolbarRetryTimer);
		for (const container of this.noteMarkerViews.keys()) this.disposeNoteMarkersForView(container);
		for (const state of this.pdfLinkReturns.values()) state.controller.dispose();
		this.pdfLinkReturns.clear();
		this.cancelPencilGesture(true);
		this.pendingStylusTouch = null;
		this.activeTouchContacts.clear();
		this.activePointers.clear();
		this.cancelledPencilPointerIds.clear();
		this.isMultiTouchGesture = false;
		for (const action of this.activeHighlightActions) action.abort();
		this.activeHighlightActions.clear();
		this.annotationHistory.clearAll();
		this.interactionDocuments.clear();
		window.clearTimeout(this.selectionUpdateTimer);
		this.lastPdfClick = null;
		this.invalidateHighlightIndex();
		this.hideActiveMenu();
		for (const ownerDocument of [...this.pdfFocusModes.keys()]) this.exitPdfFocusMode(ownerDocument, false);
		for (const { controller } of this.pdfReadingLayouts.values()) controller.dispose();
		this.pdfReadingLayouts.clear();
		for (const state of this.annotationToolbars.values()) {
			this.clearAnnotationToolbarAppearance(state);
			state.regionSelection?.dispose();
			state.toolbar.destroy();
		}
		this.annotationToolbars.clear();
		for (const preview of this.pendingPreviews) {
			try { preview.dispose(); } catch { /* Continue releasing the remaining views. */ }
		}
		this.pendingPreviews.clear();
		try {
			for (const pdfView of getAllPdfViews(this.app)) {
				void pdfView.disposeInPlaceUpdates().catch((error) => {
					console.error('Study PDF: could not release the in-place PDF view state', error);
				});
			}
		} catch {
			// A malformed/closing PDF view should not prevent the plugin unloading.
		}
	}

	async loadSettings() {
		const loaded = (await this.loadData()) as unknown;
		const result = normalizePdfHighlighterSettingsForLoad(loaded);
		this.settings = result.settings;
		// Persist a migration or repair once so generated IDs remain attached to
		// their colors through future edits and reordering.
		const persisted = await persistPdfHighlighterSettingsIfNeeded(result, (settings) =>
			this.saveData(settings),
		);
		if (!persisted) {
			new Notice(
				'Rudi\'s Study PDF repaired its settings for this session but could not save the repair. Choose the default color again in settings to retry.',
			);
		}
	}

	async saveSettings(settings = this.settings): Promise<PdfHighlighterSettings> {
		const normalized = normalizePdfHighlighterSettings(settings);
		await this.saveData(normalized);
		this.settings = normalized;
		this.ensureToolbarButtons();
		return normalized;
	}

	/** Install one toolbar per live PDF view. Callbacks resolve the current view
	 * at click time so a reused pane always acts on its open file. */
	private ensureToolbarButtons(attempt = 0, retryIfEmpty = false) {
		if (this.isUnloading) return;
		window.clearTimeout(this.toolbarRetryTimer);
		let views: ActivePdfView[];
		try { views = getAllPdfViews(this.app); }
		catch {
			if (attempt < 3) this.toolbarRetryTimer = window.setTimeout(() => this.ensureToolbarButtons(attempt + 1, retryIfEmpty), 500);
			return;
		}
		if (views.length === 0 && retryIfEmpty && attempt < 3) {
			this.toolbarRetryTimer = window.setTimeout(() => this.ensureToolbarButtons(attempt + 1, retryIfEmpty), 500);
			return;
		}
		this.prunePdfFocusModes(views);
		this.syncPdfReadingLayouts(views);
		const liveToolbars = new Set(views.map((view) => view.getToolbarRightElement()));
		for (const [right, state] of this.annotationToolbars) {
			if (liveToolbars.has(right) && state.toolbar.el.isConnected) continue;
			this.clearAnnotationToolbarAppearance(state);
			state.regionSelection?.dispose();
			state.toolbar.destroy();
			this.annotationToolbars.delete(right);
		}
		let toolbarMissing = false;
		for (const pdfView of views) {
			this.bindPdfDocumentInteractions(pdfView.containerEl.ownerDocument);
			const toolbarRight = pdfView.getToolbarRightElement();
			if (!toolbarRight) { toolbarMissing = true; continue; }
			this.ensureAnnotationToolbar(pdfView, toolbarRight);
			toolbarRight.querySelector<HTMLElement>(':scope > .study-pdf-toolbar-button')?.remove();
		}
		if (toolbarMissing && attempt < 3) {
			this.toolbarRetryTimer = window.setTimeout(() => this.ensureToolbarButtons(attempt + 1, retryIfEmpty), 500);
		}
	}

	private syncPdfReadingLayouts(views: ActivePdfView[]) {
		const liveViews = new Map(views.map((view) => [view.containerEl, view] as const));
		for (const [containerEl, state] of this.pdfReadingLayouts) {
			const liveView = liveViews.get(containerEl);
			if (liveView?.file === state.file) continue;
			state.controller.dispose();
			this.pdfReadingLayouts.delete(containerEl);
		}
		for (const view of views) {
			const existing = this.pdfReadingLayouts.get(view.containerEl);
			if (existing?.file === view.file) {
				existing.controller.updateView(view);
				continue;
			}
			this.pdfReadingLayouts.set(view.containerEl, {
				file: view.file,
				controller: createPdfReadingLayout(view),
			});
		}
	}

	private disposeNoteMarkersForView(container: HTMLElement) {
		const state = this.noteMarkerViews.get(container);
		if (!state) return;
		state.watcher?.dispose();
		for (const layer of state.layers) disposeNoteMarkers(layer);
		this.noteMarkerViews.delete(container);
	}

	private syncPdfNoteMarkers(attempt = 0) {
		if (this.isUnloading) return;
		window.clearTimeout(this.noteMarkerRetryTimer);
		const retryWhenReady = () => {
			if (attempt >= 3) return;
			// A bounded readiness retry at file-open only; never selection/scroll polling.
			this.noteMarkerRetryTimer = window.setTimeout(() => this.syncPdfNoteMarkers(attempt + 1), 500);
		};
		let views: ActivePdfView[];
		try { views = getAllPdfViews(this.app); } catch { retryWhenReady(); return; }
		const liveViews = new Map(views.map((view) => [view.containerEl, view]));
		for (const [container, state] of this.pdfLinkReturns) {
			if (liveViews.get(container)?.file === state.file && state.controller.isCurrent()) continue;
			state.controller.dispose();
			this.pdfLinkReturns.delete(container);
		}
		for (const view of views) {
			if (this.pdfLinkReturns.has(view.containerEl)) continue;
			this.pdfLinkReturns.set(view.containerEl, { file: view.file, controller: createPdfLinkReturn(view) });
		}
		for (const [container, state] of this.noteMarkerViews) {
			if (liveViews.get(container)?.file !== state.file || !state.watcher?.isCurrent()) this.disposeNoteMarkersForView(container);
		}
		for (const view of views) {
			if (this.noteMarkerViews.has(view.containerEl) || !view.watchNoteLayers) continue;
			const state = { file: view.file, layers: new Set<HTMLElement>(), watcher: undefined as PdfNoteLayerWatcher | undefined };
			this.noteMarkerViews.set(view.containerEl, state);
			state.watcher = view.watchNoteLayers((page) => {
				if (this.isUnloading || this.noteMarkerViews.get(view.containerEl) !== state) return;
				for (const oldLayer of state.layers) {
					if (oldLayer === page.layer || view.containerEl.contains(oldLayer)) continue;
					disposeNoteMarkers(oldLayer);
					state.layers.delete(oldLayer);
				}
				state.layers.add(page.layer);
				updateNoteMarkers(page.layer, (id) => page.readAnnotation(id), (id, position) => {
					void this.openNoteMarker(view, page.pageIndex, id, position);
				}, page.viewportHeight, {
					get: (key) => {
						const stored = this.noteMarkerPositions?.get(view.file.path, page.pageIndex, key);
						if (!stored || !page.fromPdfPoint) return undefined;
						const position = page.fromPdfPoint(stored);
						if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return undefined;
						return { x: Math.max(0, Math.min(1, position.x)), y: Math.max(0, Math.min(1, position.y)) };
					},
					save: (key, position) => {
						if (this.isUnloading || this.noteMarkerViews.get(view.containerEl) !== state) return;
						if (!page.toPdfPoint) return;
						this.noteMarkerPositions?.set(view.file.path, page.pageIndex, key, { ...page.toPdfPoint(position), space: 'pdf' });
						for (const other of this.noteMarkerViews.values()) if (other.file === view.file) other.watcher?.refresh([page.pageIndex]);
					},
				}, page.viewportWidth);
			});
		}
		if ([...this.noteMarkerViews.values()].some((state) => !state.watcher?.isCurrent()) ||
			[...this.pdfLinkReturns.values()].some((state) => !state.controller.isCurrent())) retryWhenReady();
	}

	private async openNoteMarker(view: ActivePdfView, pageIndex: number, id: string, position: { x: number; y: number }) {
		if (this.isUnloading) return;
		const match = /^(\d+)R(\d*)$/.exec(id);
		if (!match) return;
		const capture = capturePdfTarget(view.file, view);
		if (!this.isCapturedPdfCurrent(capture)) return;
		window.clearTimeout(this.selectionUpdateTimer);
		this.lastPdfClick = null;
		this.lastTouchPressPoint = null;
		this.hideActiveMenu();
		const generation = this.menuGeneration;
		try {
			const index = await this.getHighlightIndexForCapture(capture);
			if (this.isUnloading || this.menuGeneration !== generation || !this.isCapturedPdfCurrent(capture)) return;
			const matches = (index.get(pageIndex) ?? []).filter((entry) =>
				entry.target?.objectNumber === Number(match[1]) && entry.target.generationNumber === Number(match[2] || 0),
			);
			const entry = matches.length === 1 ? matches[0] : null;
			if (!entry?.target) return;
			this.openAnnotationNote(capture, entry.target, entry.note, position);
		} catch (error) {
			if (!this.isUnloading && this.menuGeneration === generation) new Notice(`Study PDF: could not open note -- ${(error as Error).message}`);
		}
	}

	private openAnnotationNote(
		capture: CapturedPdfTarget<TFile, ActivePdfView>,
		target: HighlightTarget,
		note: string | null,
		position: { x: number; y: number },
	) {
		if (this.isUnloading || !this.isCapturedPdfCurrent(capture)) return;
		this.openPdfNoteEditor(capture.pdfView.containerEl.ownerDocument, position, note ?? '',
			(text) => this.performSetNoteForTarget(capture, target, text));
	}

	private openPdfNoteEditor(doc: Document, position: { x: number; y: number }, initial: string,
		onSave: (note: string) => Promise<boolean>, inputLabel?: string) {
		this.hideActiveMenu();
		let popup: IconPopup;
		const close = () => { if (this.activePopup === popup) this.hideActiveMenu(); };
		popup = showNoteEditorPopup(this.app, doc, { x: position.x, y: position.y }, {
			initial,
			onSave,
			inputLabel,
			onSaved: close,
			onCancel: close,
		});
		this.activePopup = popup;
	}

	private openPageNoteAtClick(doc: Document, event: MouseEvent) {
		if (this.isUnloading || event.defaultPrevented || event.shiftKey ||
			(event.button !== 2 && !(event.button === 0 && event.ctrlKey)) || this.isInsideActivePopup(event.target) ||
			this.activePopup?.el.classList.contains('study-pdf-note-editor')) return;
		if (!isDomNode(event.target) || eventElements(event).some((el) =>
			el.matches('a, button, .textAnnotation, .study-pdf-region-selector') || isEditableElement(el))) return;
		let owner: ReturnType<typeof findPdfViewForNode<ActivePdfView>>;
		try { owner = findPdfViewForNode(getAllPdfViews(this.app), event.target); } catch { return; }
		if (!owner || owner.view.containerEl.ownerDocument !== doc || this.getOwnedNativeSelection(owner.view)) return;
		const { view, pageIndex } = owner;
		const point = this.pdfPointAtPress(view, pageIndex, event.clientX, event.clientY);
		if (!point) return;
		const capture = capturePdfTarget(view.file, view);
		const revision = this.pdfRevisionKey(view.file);
		event.preventDefault();
		event.stopPropagation();
		this.cancelPendingSelectionUpdate();
		this.lastPdfClick = null;
		this.openPdfNoteEditor(doc, { x: event.clientX, y: event.clientY }, '', async (note) => {
			if (!note.trim()) {
				new Notice('Write a note before saving.');
				return false;
			}
			try {
				const result = await this.mutateCapturedPdf(capture, [pageIndex], async (bytes) => {
					if (this.pdfRevisionKey(capture.file) !== revision) {
						throw new Error('The PDF changed after this location was selected. Copy your draft and reopen the note at the current location.');
					}
					return { bytes: await addPageNote(bytes, { pageIndex, point, note }), value: undefined };
				});
				return result.changed;
			} catch (error) {
				if (!this.isUnloading) new Notice(`Study PDF: could not save page note — ${(error as Error).message}`);
				return false;
			}
		}, 'Page note');
	}

	private prunePdfFocusModes(views: ActivePdfView[]) {
		for (const [ownerDocument, state] of this.pdfFocusModes) {
			const liveView = views.find((view) => view.containerEl === state.containerEl && view.file === state.file);
			const liveLeaf = liveView?.containerEl.closest<HTMLElement>('.workspace-leaf') ?? null;
			if (!liveView || liveLeaf !== state.leafEl || !state.leafEl.isConnected ||
				!state.toolbar.el.isConnected || !state.toolbar.focusButton.isConnected) {
				this.exitPdfFocusMode(ownerDocument, false);
			}
		}
	}

	/** Watch only the toolbar's direct parent and its parent so a native view
	 * replacement cannot strand touch users without the pinned Exit control. */
	private watchPdfFocusToolbar(ownerDocument: Document, state: PdfFocusModeState) {
		const MutationObserverConstructor = ownerDocument.defaultView?.MutationObserver;
		const toolbarParent = state.toolbar.el.parentElement;
		if (!MutationObserverConstructor || !toolbarParent) return;
		const observer = new MutationObserverConstructor(() => {
			if (this.pdfFocusModes.get(ownerDocument) !== state) {
				observer.disconnect();
				return;
			}
			if (!state.toolbar.el.isConnected || !state.leafEl.contains(state.toolbar.el) ||
				!state.toolbar.focusButton.isConnected) {
				this.exitPdfFocusMode(ownerDocument, false);
			}
		});
		observer.observe(toolbarParent, { childList: true });
		if (toolbarParent.parentElement) observer.observe(toolbarParent.parentElement, { childList: true });
		state.toolbarObserver = observer;
	}

	private disposePdfReadingLayoutsFor(ownerDocument: Document) {
		for (const [containerEl, state] of this.pdfReadingLayouts) {
			if (containerEl.ownerDocument !== ownerDocument) continue;
			state.controller.dispose();
			this.pdfReadingLayouts.delete(containerEl);
		}
	}

	private clearPdfOwnedSelection(containerEl: HTMLElement, ownerDocument: Document) {
		const selection = ownerDocument.defaultView?.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
		const isInPdf = (node: Node | null) => Boolean(node && (containerEl === node || containerEl.contains(node)));
		if (!isInPdf(selection.anchorNode) && !isInPdf(selection.focusNode)) return false;
		selection.removeAllRanges();
		return true;
	}

	/** Cancels selection work before a layout change so no stale range can be
	 * committed after PDF.js has moved or resized the page. */
	private preparePdfForLayoutChange(pdfView: ActivePdfView) {
		if (this.pencilGesture?.pdfView.containerEl === pdfView.containerEl) {
			if (this.pencilGesture.input.kind === 'pointer') this.cancelledPencilPointerIds.add(this.pencilGesture.input.id);
			this.cancelPencilGesture(true);
		}
		if (this.pendingStylusTouch?.ownerDocument === pdfView.containerEl.ownerDocument) this.pendingStylusTouch = null;
		if (this.lastPdfClick?.capture.pdfView.containerEl === pdfView.containerEl) this.lastPdfClick = null;
		this.pendingPress = null;
		this.lastTouchPressPoint = null;
		this.selectionAtPress = null;
		this.mouseSelectionDown = false;
		this.cancelPendingSelectionUpdate();
		if (this.activePopup?.el.ownerDocument === pdfView.containerEl.ownerDocument) this.hideActiveMenu();
		if (this.clearPdfOwnedSelection(pdfView.containerEl, pdfView.containerEl.ownerDocument)) this.refreshSelectionOverlay();
	}

	private refreshNativePageWidthAfterLayout(containerEl: HTMLElement, file: TFile) {
		const ownerWindow = containerEl.ownerDocument.defaultView;
		ownerWindow?.requestAnimationFrame(() => {
			if (this.isUnloading) return;
			try {
				const currentView = getAllPdfViews(this.app).find((view) =>
					view.containerEl === containerEl && view.file === file,
				);
				if (!currentView) return;
				// PDF.js tracks its container size for rendering, but page-width is a
				// scale preset. Reapply it after this pane-only layout change only
				// while that preset is still active; manual zoom is left untouched.
				currentView.refreshPageWidthIfActive();
				this.pdfReadingLayouts.get(containerEl)?.controller.refresh();
			} catch {
				// A closing/reloading PDF pane can disappear before its next frame.
			}
		});
	}

	private verifyPdfFocusGeometry(ownerDocument: Document, containerEl: HTMLElement, file: TFile) {
		const ownerWindow = ownerDocument.defaultView;
		if (!ownerWindow) return;
		ownerWindow.requestAnimationFrame(() => {
			const state = this.pdfFocusModes.get(ownerDocument);
			if (!state || state.containerEl !== containerEl || state.file !== file || !state.leafEl.isConnected) return;
			const liveView = getAllPdfViews(this.app).find((view) =>
				view.containerEl === containerEl && view.file === file,
			);
			if (!liveView || liveView.containerEl.closest<HTMLElement>('.workspace-leaf') !== state.leafEl) {
				this.exitPdfFocusMode(ownerDocument, false);
				return;
			}
			const width = ownerWindow.innerWidth;
			const height = ownerWindow.innerHeight;
			const rect = state.leafEl.getBoundingClientRect();
			const exitButton = state.toolbar.focusButton;
			const toolbarRect = state.toolbar.el.getBoundingClientRect();
			const exitRect = exitButton.getBoundingClientRect();
			const exitCenterX = exitRect.left + exitRect.width / 2;
			const exitCenterY = exitRect.top + exitRect.height / 2;
			const exitHitTarget = ownerDocument.elementFromPoint(exitCenterX, exitCenterY);
			const toolbarIsVisible = state.toolbar.el.isConnected && toolbarRect.width > 0 && toolbarRect.height > 0;
			const exitIsReachable = toolbarIsVisible && exitButton.isConnected && exitRect.width > 0 && exitRect.height > 0 &&
				exitCenterX >= 0 && exitCenterY >= 0 && exitCenterX < width && exitCenterY < height &&
				Boolean(exitHitTarget && (exitHitTarget === exitButton || exitButton.contains(exitHitTarget)));
			const tolerance = 8;
			if (rect.left > tolerance || rect.top > tolerance ||
				rect.right < width - tolerance || rect.bottom < height - tolerance || !exitIsReachable) {
				this.exitPdfFocusMode(ownerDocument, false);
				new Notice('Full-screen reading mode could not cover this window, so it was closed.');
			}
		});
	}

	private togglePdfFocusMode(pdfView: ActivePdfView, toolbar: AnnotationToolbar) {
		const ownerDocument = pdfView.containerEl.ownerDocument;
		const current = this.pdfFocusModes.get(ownerDocument);
		if (current?.containerEl === pdfView.containerEl && current.file === pdfView.file) {
			this.exitPdfFocusMode(ownerDocument, true);
			return;
		}
		this.preparePdfForLayoutChange(pdfView);
		if (current) this.exitPdfFocusMode(ownerDocument, false);
		const leafEl = pdfView.containerEl.closest<HTMLElement>('.workspace-leaf');
		if (!leafEl) {
			new Notice('Full-screen reading mode is unavailable for this PDF pane.');
			return;
		}
		const returnFocusEl = ownerDocument.activeElement?.instanceOf(HTMLElement)
			? ownerDocument.activeElement
			: null;
		const state: PdfFocusModeState = {
			containerEl: pdfView.containerEl,
			file: pdfView.file,
			leafEl,
			toolbar,
			toolbarObserver: null,
			returnFocusEl,
		};
		leafEl.classList.add('study-pdf-focus');
		ownerDocument.body?.classList.add('study-pdf-focus-active');
		this.pdfFocusModes.set(ownerDocument, state);
		this.watchPdfFocusToolbar(ownerDocument, state);
		this.refreshNativePageWidthAfterLayout(pdfView.containerEl, pdfView.file);
		this.verifyPdfFocusGeometry(ownerDocument, pdfView.containerEl, pdfView.file);
		this.refreshAnnotationToolbars();
	}

	private exitPdfFocusMode(ownerDocument: Document, restoreFocus: boolean) {
		const state = this.pdfFocusModes.get(ownerDocument);
		if (!state) return;
		this.pdfFocusModes.delete(ownerDocument);
		try {
			const pdfView = getAllPdfViews(this.app).find((view) =>
				view.containerEl === state.containerEl && view.file === state.file,
			);
			if (pdfView) this.preparePdfForLayoutChange(pdfView);
			else if (this.pencilGesture?.pdfView.containerEl === state.containerEl) this.cancelPencilGesture(true);
		} catch {
			if (this.pencilGesture?.pdfView.containerEl === state.containerEl) this.cancelPencilGesture(true);
		}
		state.toolbarObserver?.disconnect();
		state.leafEl.classList.remove('study-pdf-focus');
		if (!Array.from(this.pdfFocusModes.keys()).some((document) => document === ownerDocument)) {
			ownerDocument.body?.classList.remove('study-pdf-focus-active');
		}
		this.pdfReadingLayouts.get(state.containerEl)?.controller.refresh();
		this.refreshNativePageWidthAfterLayout(state.containerEl, state.file);
		this.refreshAnnotationToolbars();
		if (restoreFocus && state.returnFocusEl?.isConnected) state.returnFocusEl.focus({ preventScroll: true });
	}

	private ensureAnnotationToolbar(knownView: ActivePdfView, toolbarRight: HTMLElement) {
		const nativeToolbar = toolbarRight.closest<HTMLElement>('.pdf-toolbar') ?? toolbarRight.parentElement;
		if (!nativeToolbar) return;
		const currentView = () => this.isUnloading ? undefined : getAllPdfViews(this.app).find(
			(view) => view.getToolbarRightElement() === toolbarRight,
		);
		let state = this.annotationToolbars.get(toolbarRight);
		if (!state) {
			// A reload may leave an old instance's row attached to the native toolbar.
			for (const sibling of [nativeToolbar.previousElementSibling, nativeToolbar.nextElementSibling]) {
				if (!sibling?.classList.contains('study-pdf-annotation-toolbar')) continue;
				restoreNativePdfToolbarControls(sibling as HTMLElement);
				sibling.remove();
			}
			let pendingSelection: SelectionContext | null = null;
			const toolbar = createAnnotationToolbar(nativeToolbar, {
				pageKeymap: this.app.keymap,
				watchPagePosition: (onChange) => currentView()?.watchPagePosition?.(onChange) ?? (() => {}),
				getPagePosition: () => {
					const view = currentView();
					return view ? { page: view.getCurrentPageNumber(), total: view.getPageCount() } : null;
				},
				goToPage: (page) => {
					const view = currentView();
					if (!view || !Number.isInteger(page) || page < 1 || page > view.getPageCount()) return false;
					view.goToPage(page);
					return true;
				},
				onPagePopupOpen: (popup) => {
					this.cancelPendingSelectionUpdate();
					this.hideActiveMenu();
					this.activePopup = popup;
				},
				onPagePopupClose: (popup) => {
					if (this.activePopup === popup) { this.activePopup = null; this.menuGeneration++; }
				},
				pomodoro: this.pomodoro ?? undefined,
				onPomodoro: (anchor) => {
					if (!this.pomodoro) return null;
					this.cancelPendingSelectionUpdate();
					this.hideActiveMenu();
					let popup: IconPopup;
					popup = showPomodoroPopup(this.app, anchor.ownerDocument, anchor, this.pomodoro, this.pomodoroChime, () => {
						if (this.activePopup === popup) { this.activePopup = null; this.menuGeneration++; }
					});
					this.activePopup = popup;
					return popup;
				},
				onPress: (event) => {
					const target = event.target as Element | null;
					if (target && typeof target.closest === 'function' && target.closest('.pdf-page-input')) {
						pendingSelection = null;
						return;
					}
					const view = currentView();
					const colorButton = target && typeof target.closest === 'function'
						? target.closest('.study-pdf-annotation-color')
						: null;
					pendingSelection = view && colorButton ? this.trySelectionContext(view) : null;
				},
				onCancel: () => { pendingSelection = null; },
				onMode: (highlighting) => {
					const view = currentView();
					const live = this.annotationToolbars.get(toolbarRight);
					if (!view || !live) return;
					pendingSelection = null;
					this.setAnnotationMode(view, live, highlighting);
				},
				onArea: () => {
					pendingSelection = null;
					const view = currentView();
					const live = this.annotationToolbars.get(toolbarRight);
					if (!view || !live) return;
					if (live.regionSelection) { this.setAnnotationMode(view, live, false); return; }
					this.setAnnotationMode(view, live, false);
					const capture = capturePdfTarget(view.file, view);
					view.containerEl.ownerDocument.defaultView?.getSelection()?.removeAllRanges();
					try {
						live.regionSelection = createRegionSelection(view, {
							isCurrent: () => !this.isUnloading && this.isCapturedPdfCurrent(capture),
							colors: () => this.settings.colors,
							onHighlight: (region, color) => this.highlightRegion(view, region, color.hex),
							onInteractionStart: () => {
								this.cancelPendingSelectionUpdate();
								this.lastPdfClick = null;
								this.lastTouchPressPoint = null;
								this.hideActiveMenu();
							},
							onTapAnnotation: (tap, isCurrent) => {
								const press = capturePdfPress(capture, { pageIndex: tap.pageIndex,
									clientX: tap.position.x, clientY: tap.position.y, pdfPoint: tap.pdfPoint });
								void this.showCandidatesForClick(press, false, { isCurrent, regionsOnly: true });
							},
							hasOpenPopup: () => this.activePopup?.el.ownerDocument === view.containerEl.ownerDocument,
							canHandleEscape: (event) => {
								const ownerDocument = view.containerEl.ownerDocument;
								const focusedView = this.getFocusedPdfViewForKeyEvent(ownerDocument, event);
								if (!focusedView || focusedView.containerEl !== view.containerEl || focusedView.file !== capture.file) return false;
								const elements = eventElements(event);
								const activeElement = ownerDocument.activeElement;
								return !elements.some(isEditableElement) && !isEditableElement(activeElement) &&
									!hasIgnoredShortcutContext(ownerDocument, elements, activeElement);
							},
							onExit: () => this.setAnnotationMode(view, live, false),
						});
						this.updateAnnotationToolbar(live);
					} catch (error) { new Notice((error as Error).message); }
				},
				onColor: (colorId, event) => {
					const view = currentView();
					if (!view) return;
					const selection = (event.detail > 0 ? pendingSelection : null) ?? this.trySelectionContext(view);
					pendingSelection = null;
					this.selectAnnotationColor(view, colorId, selection);
				},
				onUndo: () => {
					const view = currentView();
					if (view) void this.applyPdfHistory(view, 'undo');
				},
				onRedo: () => {
					const view = currentView();
					if (view) void this.applyPdfHistory(view, 'redo');
				},
				onShowHighlights: () => {
					pendingSelection = null;
					const view = currentView();
					if (!view) return;
					new HighlightListModal(
						this.app,
						view,
						this.pdfMutationCoordinator,
						() => this.exportHighlightsToNote(view),
						(entries, snapshotFingerprint) => this.exportSelectedHighlightsToNote(view, entries, snapshotFingerprint),
					).open();
				},
				onFocus: () => {
					pendingSelection = null;
					const view = currentView();
					if (view) this.togglePdfFocusMode(view, toolbar);
				},
				onAppearance: (anchor) => {
					const view = currentView();
					const live = this.annotationToolbars.get(toolbarRight);
					if (!view || !live) return null;
					this.hideActiveMenu();
					let popup: IconPopup;
					popup = showReadingAppearancePopup(view.containerEl.ownerDocument, anchor, live.appearance, (appearance) => {
						const current = currentView();
						const currentState = this.annotationToolbars.get(toolbarRight);
						if (!current || current.containerEl !== view.containerEl || currentState !== live) return;
						currentState.appearance = appearance;
						this.setAnnotationToolbarAppearance(currentState, current.containerEl);
						this.updateAnnotationToolbar(currentState);
					}, () => {
						if (this.activePopup === popup) { this.activePopup = null; this.menuGeneration++; }
					});
					this.activePopup = popup;
					return popup;
				},
			});
			state = {
				toolbar,
				regionSelection: null,
				colorId: getDefaultColor(this.settings).id,
				highlighting: false,
				appearance: 'original',
				appearanceContainer: null,
				file: null,
			};
			this.annotationToolbars.set(toolbarRight, state);
		}
		const view = knownView;
		if (state.regionSelection && (state.file !== view?.file || !view?.containerEl.getClientRects().length)) {
			state.regionSelection.dispose();
			state.regionSelection = null;
		}
		state.file = view?.file ?? null;
		if (view) this.setAnnotationToolbarAppearance(state, view.containerEl);
		else this.clearAnnotationToolbarAppearance(state);
		this.updateAnnotationToolbar(state);
	}

	private setAnnotationToolbarAppearance(state: AnnotationToolbarState, containerEl: HTMLElement) {
		if (state.appearanceContainer && state.appearanceContainer !== containerEl) {
			clearPdfReadingAppearance(state.appearanceContainer);
		}
		state.appearanceContainer = containerEl;
		setPdfReadingAppearance(containerEl, state.appearance);
	}

	private clearAnnotationToolbarAppearance(state: AnnotationToolbarState) {
		if (state.appearanceContainer) clearPdfReadingAppearance(state.appearanceContainer);
		state.appearanceContainer = null;
	}

	private updateAnnotationToolbar(state: AnnotationToolbarState) {
		if (!this.settings.colors.some((color) => color.id === state.colorId)) state.colorId = getDefaultColor(this.settings).id;
		const history = state.file
			? this.annotationHistory.status(state.file, state.file.path)
			: { canUndo: false, canRedo: false };
		const focus = Array.from(this.pdfFocusModes.values()).find((candidate) => candidate.toolbar === state.toolbar);
		state.toolbar.update(
			this.settings.colors,
			state.colorId,
			state.highlighting,
			history,
			Boolean(focus),
			state.appearance,
			Boolean(state.regionSelection),
		);
	}

	private setAnnotationMode(
		pdfView: ActivePdfView,
		state: AnnotationToolbarState,
		highlighting: boolean,
	) {
		state.regionSelection?.dispose();
		state.regionSelection = null;
		if (this.pencilGesture?.pdfView.containerEl === pdfView.containerEl) {
			if (this.pencilGesture.input.kind === 'pointer') this.cancelledPencilPointerIds.add(this.pencilGesture.input.id);
			this.cancelPencilGesture(true);
			if (this.pendingStylusTouch?.ownerDocument === pdfView.containerEl.ownerDocument) this.pendingStylusTouch = null;
			this.pendingPress = null;
			this.lastPdfClick = null;
			this.lastTouchPressPoint = null;
		}
		state.file = pdfView.file;
		state.highlighting = highlighting;
		this.cancelPendingSelectionUpdate();
		this.hideActiveMenu();
		this.updateAnnotationToolbar(state);
	}

	private selectAnnotationColor(pdfView: ActivePdfView, colorId: string, selection: SelectionContext | null): boolean {
		let selectedText = selection;
		if (this.pencilGesture?.pdfView.containerEl === pdfView.containerEl) {
			if (this.pencilGesture.input.kind === 'pointer') this.cancelledPencilPointerIds.add(this.pencilGesture.input.id);
			this.cancelPencilGesture(true);
			if (this.pendingStylusTouch?.ownerDocument === pdfView.containerEl.ownerDocument) this.pendingStylusTouch = null;
			this.pendingPress = null;
			this.lastPdfClick = null;
			this.lastTouchPressPoint = null;
			selectedText = null;
		}
		const toolbarRight = pdfView.getToolbarRightElement();
		const state = toolbarRight ? this.annotationToolbars.get(toolbarRight) : undefined;
		const color = this.settings.colors.find((option) => option.id === colorId);
		if (!state || !color) return false;
		state.regionSelection?.dispose();
		state.regionSelection = null;
		this.cancelPendingSelectionUpdate();
		state.file = pdfView.file;
		state.colorId = colorId;
		state.highlighting = true;
		this.hideActiveMenu();
		this.updateAnnotationToolbar(state);
		if (selectedText?.capture.file === pdfView.file && selectedText.pdfView.containerEl === pdfView.containerEl) {
			void this.performHighlight(selectedText, hexToRgbColor(color.hex));
		}
		return true;
	}

	private refreshAnnotationToolbars() {
		for (const state of this.annotationToolbars.values()) {
			try { this.updateAnnotationToolbar(state); } catch { /* A closing toolbar cannot invalidate saved history. */ }
		}
	}

	private getActivePdfViewOnly(): ActivePdfView | null {
		const activeView = this.app.workspace.getActiveViewOfType(FileView);
		if (!activeView || activeView.getViewType() !== 'pdf' || !(activeView.file instanceof TFile)) return null;
		return getAllPdfViews(this.app).find((view) => view.containerEl === activeView.containerEl && view.file === activeView.file) ?? null;
	}

	private getFocusedPdfViewForKeyEvent(ownerDocument: Document, event: KeyboardEvent): ActivePdfView | null {
		try {
			if (typeof ownerDocument.hasFocus !== 'function' || !ownerDocument.hasFocus()) return null;
			const pdfView = this.getActivePdfViewOnly();
			if (!pdfView || pdfView.containerEl.ownerDocument !== ownerDocument) return null;
			const toolbar = pdfView.getToolbarRightElement();
			const toolbarRoot = toolbar?.closest<HTMLElement>('.pdf-toolbar') ?? toolbar;
			const focusState = this.pdfFocusModes.get(ownerDocument);
			const focusLeaf = focusState?.containerEl === pdfView.containerEl && focusState.file === pdfView.file
				? focusState.leafEl
				: null;
			const inActivePdf = event.composedPath().some((target) => {
				if (!isDomNode(target)) return false;
				const node = target;
				return pdfView.containerEl.contains(node) || Boolean(toolbarRoot?.contains(node)) || Boolean(focusLeaf?.contains(node)) ||
					Boolean(this.activePopup?.el.ownerDocument === ownerDocument && this.activePopup.el.contains(node));
			});
			const rootTarget = event.target === ownerDocument || event.target === ownerDocument.body || event.target === ownerDocument.documentElement;
			return inActivePdf || rootTarget ? pdfView : null;
		} catch {
			return null;
		}
	}

	private handleSelectedAnnotationBackspace(ownerDocument: Document, event: KeyboardEvent) {
		const selected = this.selectedAnnotation;
		if (!selected || this.isUnloading || event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
			event.repeat || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey ||
			this.activePopup !== selected.popup || !selected.popup.el.isConnected ||
			selected.popup.el.ownerDocument !== ownerDocument) return;
		const elements = eventElements(event);
		if (elements.some(isEditableElement) || isEditableElement(ownerDocument.activeElement) ||
			hasIgnoredShortcutContext(ownerDocument, elements, ownerDocument.activeElement)) return;
		const view = this.getFocusedPdfViewForKeyEvent(ownerDocument, event);
		if (!view || view.containerEl !== selected.capture.pdfView.containerEl || view.file !== selected.capture.file ||
			!this.isCapturedPdfCurrent(selected.capture)) return;
		this.consumeKeyboardEvent(event);
		// Clearing synchronously prevents held/repeated keys deleting another mark.
		this.hideActiveMenu();
		void this.performRemoveTarget(selected.capture, selected.target);
	}

	private handleSelectedAnnotationCopy(ownerDocument: Document, event: KeyboardEvent) {
		const selected = this.selectedAnnotation;
		if (!selected?.copy || this.isUnloading || event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
			event.repeat || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey ||
			this.activePopup !== selected.popup || !selected.popup.el.isConnected ||
			selected.popup.el.ownerDocument !== ownerDocument) return;
		const elements = eventElements(event);
		if (elements.some(isEditableElement) || isEditableElement(ownerDocument.activeElement) ||
			hasIgnoredShortcutContext(ownerDocument, elements, ownerDocument.activeElement)) return;
		const selection = ownerDocument.defaultView?.getSelection();
		if (selection && !selection.isCollapsed && selection.toString().length > 0) return;
		const view = this.getFocusedPdfViewForKeyEvent(ownerDocument, event);
		if (!view || view.containerEl !== selected.capture.pdfView.containerEl || view.file !== selected.capture.file ||
			!this.isCapturedPdfCurrent(selected.capture)) return;
		this.consumeKeyboardEvent(event);
		selected.copy();
	}

	private handlePdfKeyboardShortcut(ownerDocument: Document, event: KeyboardEvent) {
		if (event.key.toLowerCase() === 'c' && event.metaKey) {
			this.handleSelectedAnnotationCopy(ownerDocument, event);
			return;
		}
		if (event.key === 'Backspace') {
			this.handleSelectedAnnotationBackspace(ownerDocument, event);
			return;
		}
		const escapeWithoutModifiers = event.key.toLowerCase() === 'escape' &&
			!event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
		if (event.defaultPrevented || event.isComposing || event.repeat ||
			(!isPotentialPdfKeyboardShortcut(event, Platform.isMacOS) && !escapeWithoutModifiers)) return;
		const pdfView = this.getFocusedPdfViewForKeyEvent(ownerDocument, event);
		if (!pdfView) return;
		const elements = eventElements(event);
		const activeElement = ownerDocument.activeElement;
		const editableTarget = elements.some(isEditableElement) || isEditableElement(activeElement);
		const modalOrSearch = hasIgnoredShortcutContext(ownerDocument, elements, activeElement);
		const popupOpen = this.activePopup?.el.ownerDocument === ownerDocument;
		const focusState = this.pdfFocusModes.get(ownerDocument);
		const isCurrentFocusView = focusState?.containerEl === pdfView.containerEl && focusState.file === pdfView.file;
		if (escapeWithoutModifiers && isCurrentFocusView) {
			if (editableTarget || modalOrSearch || popupOpen) return;
			const toolbarRight = pdfView.getToolbarRightElement();
			const state = toolbarRight ? this.annotationToolbars.get(toolbarRight) : undefined;
			// On macOS, preserve the existing first-Escape behavior: leave
			// annotation mode before the next Escape exits reading mode.
			if (Platform.isMacOS && state?.highlighting) {
				this.consumeKeyboardEvent(event);
				this.setAnnotationMode(pdfView, state, false);
				return;
			}
			this.consumeKeyboardEvent(event);
			this.exitPdfFocusMode(ownerDocument, true);
			return;
		}
		if (!isPotentialPdfKeyboardShortcut(event, Platform.isMacOS)) return;
		const shortcut = classifyPdfKeyboardShortcut(event, {
			isMac: Platform.isMacOS,
			focusedPdfPane: true,
			editableTarget,
			modalOrSearch,
			popupOpen,
		});
		if (!shortcut) {
			return;
		}

		const toolbarRight = pdfView.getToolbarRightElement();
		const state = toolbarRight ? this.annotationToolbars.get(toolbarRight) : undefined;
		switch (shortcut.type) {
			case 'select-mode':
				if (!state?.highlighting) return;
				this.consumeKeyboardEvent(event);
				this.setAnnotationMode(pdfView, state, false);
				return;
			case 'toggle-mode':
				if (!state) return;
				this.consumeKeyboardEvent(event);
				this.setAnnotationMode(pdfView, state, !state.highlighting);
				return;
			case 'select-color': {
				const color = this.settings.colors[shortcut.index];
				if (!color || !this.selectAnnotationColor(pdfView, color.id, this.trySelectionContext(pdfView))) return;
				this.consumeKeyboardEvent(event);
				return;
			}
			case 'undo':
			case 'redo':
				this.consumeKeyboardEvent(event);
				void this.applyPdfHistory(pdfView, shortcut.type);
				return;
		}
	}

	private consumeKeyboardEvent(event: KeyboardEvent) {
		event.preventDefault();
		event.stopImmediatePropagation();
	}

	private cancelPendingSelectionUpdate() {
		this.selectionGestureGeneration++;
		window.clearTimeout(this.selectionUpdateTimer);
		this.selectionUpdateTimer = 0;
	}

	private isInsideActivePopup(target: EventTarget | null): boolean {
		if (!target || typeof target !== 'object') return false;
		const nodeType = (target as { nodeType?: unknown }).nodeType;
		if (typeof nodeType !== 'number' || !Number.isInteger(nodeType) || nodeType < 1 || nodeType > 12) return false;
		// Avoid `instanceof Node`: PDF panes can live in a popout window with a
		// distinct Node constructor, while Element.contains accepts that node.
		return Boolean(this.activePopup?.el.contains(target as Node)) ||
			Array.from(this.annotationToolbars.values()).some(({ toolbar }) => toolbar.el.contains(target as Node));
	}

	private hideActiveMenu() {
		this.clearSelectedAnnotation();
		this.menuGeneration++;
		this.activePopup?.hide();
		this.activePopup = null;
	}

	private clearSelectedAnnotation() {
		this.selectedAnnotation?.clearOutline();
		this.selectedAnnotation = null;
	}


	/** Silent version of the selection lookup: no Notices, since this runs on
	 * every mouseup across all of Obsidian (to decide whether to show a menu) --
	 * most of those clicks have nothing to do with a PDF selection at all, and
	 * popping error notices for that would be spammy. */
	private trySelectionContext(pdfView = getActivePdfView(this.app)): SelectionContext | null {
		const nativeSelection = this.getOwnedNativeSelection(pdfView);
		if (!nativeSelection) return null;
		const { pdfView: ownedPdfView, selection, range } = nativeSelection;
		const segments = selectionSegmentsForRange(ownedPdfView, range);
		if (!segments) return null;

		const capture = capturePdfTarget(ownedPdfView.file, ownedPdfView);
		return { capture, pdfView: ownedPdfView, range, segments, text: selection.toString() };
	}

	/** Validates native selection ownership without walking text nodes or
	 * capturing per-node geometry. Use this for preview and commit eligibility;
	 * full quote/quad capture stays on actual annotation actions. */
	private getOwnedNativeSelection(pdfView = getActivePdfView(this.app)): OwnedNativeSelection | null {
		if (!pdfView) return null;
		const pane = pdfView.containerEl;
		const selection = (pane.ownerDocument.defaultView ?? window).getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0 ||
			!selection.anchorNode || !selection.focusNode ||
			!pane.contains(selection.anchorNode) || !pane.contains(selection.focusNode)) return null;
		try {
			const range = selection.getRangeAt(0);
			if (!pane.contains(range.commonAncestorContainer) ||
				!pane.contains(range.startContainer) || !pane.contains(range.endContainer)) return null;
			return { pdfView, selection, range };
		} catch {
			return null;
		}
	}

	private readPdfSelectionSnapshot(pdfView: ActivePdfView): SelectionSnapshot | null {
		const ownerDocument = pdfView.containerEl.ownerDocument;
		const selection = ownerDocument.defaultView?.getSelection();
		if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return null;
		if (!pdfView.containerEl.contains(selection.anchorNode) || !pdfView.containerEl.contains(selection.focusNode)) return null;
		return {
			anchorNode: selection.anchorNode,
			anchorOffset: selection.anchorOffset,
			focusNode: selection.focusNode,
			focusOffset: selection.focusOffset,
		};
	}

	/** Same lookup, but explains itself with a Notice on failure -- for the
	 * explicit "Highlight selection" command, where silent failure would be
	 * confusing (the user just ran a command and nothing happened). */
	private getSelectionContextOrNotify(): SelectionContext | null {
		const pdfView = getActivePdfView(this.app);
		if (!pdfView) {
			new Notice('Study PDF: no PDF is open in the active pane.');
			return null;
		}
		const selection = (pdfView.containerEl.ownerDocument.defaultView ?? window).getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
			new Notice('Study PDF: select some text in the PDF first.');
			return null;
		}
		const ctx = this.trySelectionContext(pdfView);
		if (!ctx) {
			new Notice('Study PDF: could not capture the full selection. Try a contiguous selection through rendered page text.');
			return null;
		}
		return ctx;
	}

	/** Coalesces mouseup and pointerup checks onto the shared selection timer. */
	private scheduleSelectionUpdate(delayMs: number, commitSelection: CapturedPdfTarget<TFile, ActivePdfView> | null = null, editNote = false) {
		if (this.isUnloading) return;
		window.clearTimeout(this.selectionUpdateTimer);
		const gestureGeneration = this.selectionGestureGeneration;
		this.selectionUpdateTimer = window.setTimeout(() => {
			if (this.isUnloading || this.mouseSelectionDown) return;
			const isCurrent = gestureGeneration === this.selectionGestureGeneration;
			void this.updateSelectionMenu(isCurrent ? commitSelection : null, isCurrent && editNote);
		}, delayMs);
	}

	/** Shows/refreshes the "add highlight" color-dot popup for whatever the
	 * current text selection is, or does nothing if the selection is collapsed
	 * (e.g. it just got cleared by performHighlight). Used by the
	 * selectionchange path, which -- unlike a mouseup -- can't tell whether "no
	 * selection" means "check for a highlight to remove instead": a selection
	 * merely collapsing isn't the same user action as a deliberate click. */
	/** Records where a press landed inside a rendered PDF page, and — just as
	 * importantly — forgets the previous one when it landed anywhere else.
	 *
	 * Without the forgetting, pressing outside the pages (the grey margin, the
	 * toolbar, another pane) leaves a stale `lastPdfClick` pointing at whatever
	 * highlight was pressed before, so the follow-up check hides the popup and
	 * then immediately re-shows the identical popup in the identical place. To
	 * the user the popup simply refuses to dismiss.
	 *
	 * Presses inside our own popup are exempt: its buttons act on that remembered
	 * click, so tapping "remove" must not erase the thing it is about to remove. */
	private recordPdfPress(evt: { target: EventTarget | null; clientX: number; clientY: number }) {
		if (this.isInsideActivePopup(evt.target)) return;
		this.selectionGestureGeneration++;

		const owner = findPdfViewForNode(getAllPdfViews(this.app), evt.target);
		this.selectionAtPress = owner ? this.readPdfSelectionSnapshot(owner.view) : null;
		if (!owner) {
			this.lastPdfClick = null;
			return;
		}
		const { view: pdfView, pageIndex } = owner;
		const pdfPoint = this.pdfPointAtPress(pdfView, pageIndex, evt.clientX, evt.clientY);
		if (!pdfPoint) {
			this.lastPdfClick = null;
			return;
		}
		this.lastPdfClick = capturePdfPress(capturePdfTarget(pdfView.file, pdfView), {
			pageIndex,
			clientX: evt.clientX,
			clientY: evt.clientY,
			pdfPoint,
		});
	}

	private pdfPointAtPress(
		pdfView: ActivePdfView,
		pageIndex: number,
		clientX: number,
		clientY: number,
	): { x: number; y: number } | null {
		try {
			const pageEl = pdfView.getPageElement(pageIndex);
			if (!pageEl) return null;
			const pageOrigin = pageEl.getBoundingClientRect();
			const viewport = pdfView.getPageViewport(pageIndex);
			const [x, y] = viewport.convertToPdfPoint(clientX - pageOrigin.left, clientY - pageOrigin.top);
			return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
		} catch {
			return null;
		}
	}

	private pdfRevisionKey(file: TFile): string {
		return `${file.path}:${file.stat.mtime}:${file.stat.size}`;
	}

	private async getHighlightIndexForCapture(
		capture: CapturedPdfTarget<TFile, ActivePdfView>,
	): Promise<HighlightIndex> {
		this.assertCapturedPdfCurrent(capture);
		await this.pdfMutationCoordinator.whenIdle(capture.path);
		this.assertCapturedPdfCurrent(capture);
		const file = capture.file;
		const key = this.pdfRevisionKey(file);
		if (this.highlightIndex?.file === file && this.highlightIndex.key === key) return this.highlightIndex.index;
		const generation = this.highlightIndexGeneration;
		const pending = this.highlightIndexBuild;
		if (pending?.file === file && pending.key === key && pending.generation === generation) return pending.promise;
		const promise = (async () => {
			const bytes = await this.app.vault.readBinary(file);
			this.assertCapturedPdfCurrent(capture);
			const index = await buildHighlightIndex(new Uint8Array(bytes));
			this.assertCapturedPdfCurrent(capture);
			if (generation !== this.highlightIndexGeneration || key !== this.pdfRevisionKey(file)) {
				throw new Error('Study PDF: the PDF changed while inspecting annotations. Click it again.');
			}
			this.highlightIndex = { key, file, index };
			return index;
		})();
		this.highlightIndexBuild = { key, file, generation, promise };
		try { return await promise; }
		finally { if (this.highlightIndexBuild?.promise === promise) this.highlightIndexBuild = null; }
	}

	/** Drops the cached index after our own writes. The mtime+size key would
	 * usually catch these anyway, but two saves inside the same millisecond that
	 * happen to land on the same size would not -- and the cost of being wrong
	 * here is a popup that lies about what is in the file. */
	private invalidateHighlightIndex() {
		this.highlightIndexGeneration++;
		this.highlightIndexBuild = null;
		this.highlightIndex = null;
	}

	/** Books a pointer as lifted. Returns true when this event belongs to a
	 * multi-touch gesture and must not be treated as a tap.
	 *
	 * Note the ids are dropped defensively: iOS swallows the pointerdown of a tap
	 * while a selection is up (see the pointerdown listener), so an id can be
	 * absent here without anything being wrong. */
	private releasePointer(pointerId: number): boolean {
		this.activePointers.delete(pointerId);
		if (!this.isMultiTouchGesture) return false;
		// Stay latched until the last finger leaves, then swallow this one too.
		if (this.activePointers.size === 0 && !this.hasActiveTouchContacts()) this.isMultiTouchGesture = false;
		return true;
	}

	private hasActiveTouchContacts(): boolean {
		for (const contacts of this.activeTouchContacts.values()) {
			if (contacts.size > 0) return true;
		}
		return false;
	}

	private trackTouchStart(ownerDocument: Document, event: TouchEvent) {
		let contacts = this.activeTouchContacts.get(ownerDocument);
		if (!contacts) {
			contacts = new Set<number>();
			this.activeTouchContacts.set(ownerDocument, contacts);
		}
		for (const touch of Array.from(event.changedTouches)) contacts.add(touch.identifier);
	}

	private trackTouchEnd(ownerDocument: Document, event: TouchEvent) {
		const contacts = this.activeTouchContacts.get(ownerDocument);
		if (contacts) {
			for (const touch of Array.from(event.changedTouches)) contacts.delete(touch.identifier);
			if (contacts.size === 0) this.activeTouchContacts.delete(ownerDocument);
		}
		if (this.isMultiTouchGesture && this.activePointers.size === 0 && !this.hasActiveTouchContacts()) {
			this.isMultiTouchGesture = false;
		}
	}

	private startPencilGesture(
		target: EventTarget | null,
		clientX: number,
		clientY: number,
		input: PencilInput,
	): boolean {
		if (this.isUnloading || this.pencilGesture || !target || this.isInsideActivePopup(target)) return false;
		try {
			const owner = findPdfViewForNode(getAllPdfViews(this.app), target);
			if (!owner) return false;
			const { view: pdfView, pageIndex } = owner;
			const toolbarRight = pdfView.getToolbarRightElement();
			const toolbar = toolbarRight ? this.annotationToolbars.get(toolbarRight) : undefined;
			if (!toolbar?.highlighting) return false;
			const color = this.settings.colors.find((option) => option.id === toolbar.colorId) ?? getDefaultColor(this.settings);
			const pageElement = pdfView.getPageElement(pageIndex);
			const textLayer = findRenderedTextLayer(target, pdfView.containerEl, pageElement);
			if (!textLayer || pageElement !== textLayer) return false;
			const selection = beginPencilTextSelection(
				pdfView.containerEl.ownerDocument,
				textLayer,
				pageIndex,
				clientX,
				clientY,
			);
			if (!selection) return false;

			this.cancelPendingSelectionUpdate();
			this.pencilGesture = {
				input,
				selection,
				capture: capturePdfTarget(pdfView.file, pdfView),
				pdfView,
				pageElement,
				textLayer,
				colorId: color.id,
				colorHex: color.hex,
				color: hexToRgbColor(color.hex),
				generation: this.selectionGestureGeneration,
				selectionStyleApplied: false,
				hadSelectionStyleClass: textLayer.classList.contains('study-pdf-pencil-selection-active'),
				previousSelectionColor: textLayer.style.getPropertyValue('--study-pdf-pencil-selection-color'),
				previousSelectionPriority: textLayer.style.getPropertyPriority('--study-pdf-pencil-selection-color'),
				frameRequestId: null,
				pendingCoordinates: null,
			};
			return true;
		} catch {
			return false;
		}
	}

	private isPencilGestureCurrent(gesture: ActivePencilGesture): boolean {
		if (this.isUnloading || this.pencilGesture !== gesture || gesture.generation !== this.selectionGestureGeneration ||
			!this.isCapturedPdfCurrent(gesture.capture) || !gesture.textLayer.isConnected ||
			gesture.pdfView.getPageElement(gesture.selection.pageIndex) !== gesture.pageElement ||
			!gesture.pageElement.contains(gesture.textLayer) ||
			(gesture.selection.anchor &&
				gesture.pdfView.findPageIndexForNode(gesture.selection.anchor.node) !== gesture.selection.pageIndex)) return false;
		const toolbarRight = gesture.pdfView.getToolbarRightElement();
		const toolbar = toolbarRight ? this.annotationToolbars.get(toolbarRight) : undefined;
		const color = this.settings.colors.find((option) => option.id === gesture.colorId);
		return toolbar?.highlighting === true && toolbar.colorId === gesture.colorId && color?.hex === gesture.colorHex;
	}

	private applyPencilSelectionColor(gesture: ActivePencilGesture) {
		if (!gesture.selection.moved || gesture.selectionStyleApplied) return;
		gesture.textLayer.classList.add('study-pdf-pencil-selection-active');
		gesture.textLayer.style.setProperty('--study-pdf-pencil-selection-color', gesture.colorHex);
		gesture.selectionStyleApplied = true;
	}

	private restorePencilSelectionColor(gesture: ActivePencilGesture) {
		if (!gesture.selectionStyleApplied) return;
		if (!gesture.hadSelectionStyleClass) gesture.textLayer.classList.remove('study-pdf-pencil-selection-active');
		if (gesture.previousSelectionColor) {
			gesture.textLayer.style.setProperty(
				'--study-pdf-pencil-selection-color',
				gesture.previousSelectionColor,
				gesture.previousSelectionPriority,
			);
		} else {
			gesture.textLayer.style.removeProperty('--study-pdf-pencil-selection-color');
		}
		gesture.selectionStyleApplied = false;
	}

	private cancelPencilGesture(clearSelection: boolean) {
		const gesture = this.pencilGesture;
		if (!gesture) return;
		this.pencilGesture = null;
		this.cancelQueuedPencilGestureUpdate(gesture);
		if (clearSelection && gesture.selection.moved) clearPencilTextSelection(gesture.selection);
		this.restorePencilSelectionColor(gesture);
		this.refreshSelectionOverlay();
	}

	/** Stores only the latest drag coordinates; one frame owns caret hit-testing,
	 * DOM selection changes and the corresponding iOS overlay repaint. */
	private queuePencilGestureUpdate(gesture: ActivePencilGesture, clientX: number, clientY: number) {
		if (this.isUnloading || this.pencilGesture !== gesture) return;
		gesture.pendingCoordinates = { clientX, clientY };
		if (gesture.frameRequestId !== null) return;
		const ownerWindow = gesture.pdfView.containerEl.ownerDocument.defaultView;
		if (!ownerWindow) return;
		gesture.frameRequestId = ownerWindow.requestAnimationFrame(() => {
			gesture.frameRequestId = null;
			const coordinates = gesture.pendingCoordinates;
			gesture.pendingCoordinates = null;
			if (!coordinates || this.pencilGesture !== gesture) return;
			if (!this.isPencilGestureCurrent(gesture)) {
				this.cancelPencilGesture(true);
				return;
			}
			this.applyPencilGesturePoint(gesture, coordinates.clientX, coordinates.clientY);
		});
	}

	private cancelQueuedPencilGestureUpdate(gesture: ActivePencilGesture) {
		const ownerWindow = gesture.pdfView.containerEl.ownerDocument.defaultView;
		if (gesture.frameRequestId !== null) {
			try { ownerWindow?.cancelAnimationFrame(gesture.frameRequestId); } catch { /* A closing popout may already have lost its window. */ }
		}
		gesture.frameRequestId = null;
		gesture.pendingCoordinates = null;
	}

	private applyPencilGesturePoint(
		gesture: ActivePencilGesture,
		clientX: number,
		clientY: number,
		paintOverlay = true,
	) {
		const changed = extendPencilTextSelection(gesture.selection, clientX, clientY);
		if (gesture.selection.hasRange) this.applyPencilSelectionColor(gesture);
		if (paintOverlay && changed) this.refreshSelectionOverlay();
	}

	private async finishPencilGesture(
		gesture: ActivePencilGesture,
		clientX: number,
		clientY: number,
	): Promise<'tap' | 'gesture' | 'committed' | 'cancelled'> {
		if (this.pencilGesture !== gesture) return 'cancelled';
		this.cancelQueuedPencilGestureUpdate(gesture);
		if (!this.isPencilGestureCurrent(gesture)) {
			this.cancelPencilGesture(true);
			this.lastPdfClick = null;
			this.lastTouchPressPoint = null;
			return 'cancelled';
		}
		// The final event can arrive before its queued frame. Apply it now so the
		// commit always uses the lift point, never stale coordinates.
		this.applyPencilGesturePoint(gesture, clientX, clientY, false);
		if (!gesture.selection.moved) {
			this.pencilGesture = null;
			this.restorePencilSelectionColor(gesture);
			this.refreshSelectionOverlay();
			return 'tap';
		}
		const selection = gesture.pdfView.containerEl.ownerDocument.defaultView?.getSelection();
		const selectionIsOwned = Boolean(selection && !selection.isCollapsed && selection.rangeCount > 0 &&
			selection.anchorNode && selection.focusNode && gesture.textLayer.contains(selection.anchorNode) &&
			gesture.textLayer.contains(selection.focusNode) &&
			gesture.pdfView.findPageIndexForNode(selection.anchorNode) === gesture.selection.pageIndex &&
			gesture.pdfView.findPageIndexForNode(selection.focusNode) === gesture.selection.pageIndex);
		const selectionContext = selectionIsOwned ? this.trySelectionContext(gesture.pdfView) : null;
		if (!gesture.selection.hasRange || !selection?.toString().trim() || !selectionContext || selectionContext.segments.length !== 1 ||
			selectionContext.segments[0]!.pageIndex !== gesture.selection.pageIndex ||
			selectionContext.capture.file !== gesture.capture.file || selectionContext.pdfView.containerEl !== gesture.capture.pdfView.containerEl) {
			this.cancelPencilGesture(true);
			this.lastPdfClick = null;
			this.lastTouchPressPoint = null;
			return 'gesture';
		}

		this.pencilGesture = null;
		this.lastPdfClick = null;
		this.lastTouchPressPoint = null;
		const save = this.performHighlight(selectionContext, gesture.color);
		this.restorePencilSelectionColor(gesture);
		this.refreshSelectionOverlay();
		await save;
		return 'committed';
	}

	private handleStylusTouchStart(ownerDocument: Document, event: TouchEvent) {
		this.trackTouchStart(ownerDocument, event);
		const changed = Array.from(event.changedTouches);
		const active = this.pencilGesture;
		const hasFinger = changed.some((touch) => touch.touchType !== 'stylus');
		if (active?.input.kind === 'touch' && active.pdfView.containerEl.ownerDocument === ownerDocument &&
			(event.touches.length > 1 || hasFinger)) {
			this.cancelPencilGesture(true);
			this.pendingStylusTouch = null;
			this.pendingPress = null;
			this.lastPdfClick = null;
			this.lastTouchPressPoint = null;
			this.isMultiTouchGesture = true;
			return;
		}
		const touch = changed.find((candidate) => candidate.touchType === 'stylus');
		if (!touch) return;
		if (event.touches.length > 1) {
			if (this.pencilGesture?.input.kind === 'touch') this.cancelPencilGesture(true);
			this.pendingStylusTouch = null;
			this.pendingPress = null;
			this.lastPdfClick = null;
			this.lastTouchPressPoint = null;
			this.isMultiTouchGesture = true;
			return;
		}

		this.lastNonMousePointerAt = performance.now();
		const target = touch.target;
		const insideToolbar = this.isInsideActivePopup(target);
		this.pendingStylusTouch = {
			id: touch.identifier,
			x: touch.clientX,
			y: touch.clientY,
			at: performance.now(),
			ownerDocument,
			insideToolbar,
		};
		this.pendingPress = { x: touch.clientX, y: touch.clientY, at: this.pendingStylusTouch.at };
		if (!insideToolbar) this.lastTouchPressPoint = { x: touch.clientX, y: touch.clientY };
		this.recordPdfPress({ target, clientX: touch.clientX, clientY: touch.clientY });
		const claimed = this.startPencilGesture(target, touch.clientX, touch.clientY, { kind: 'touch', id: touch.identifier });
		if (claimed && this.pencilGesture?.selection.anchor && event.cancelable) event.preventDefault();
	}

	private handleStylusTouchMove(ownerDocument: Document, event: TouchEvent) {
		const gesture = this.pencilGesture;
		if (!gesture || gesture.input.kind !== 'touch' || gesture.pdfView.containerEl.ownerDocument !== ownerDocument) return;
		const fingerIsDown = Array.from(event.touches).some((touch) => touch.identifier !== gesture.input.id || touch.touchType !== 'stylus');
		if (event.touches.length > 1 || fingerIsDown) {
			this.cancelPencilGesture(true);
			this.pendingStylusTouch = null;
			this.pendingPress = null;
			this.lastPdfClick = null;
			this.lastTouchPressPoint = null;
			this.isMultiTouchGesture = true;
			return;
		}
		const touch = Array.from(event.changedTouches).find((candidate) => candidate.identifier === gesture.input.id);
		if (!touch) return;
		gesture.selection.moved ||= hasPencilDragDistance(gesture.selection, touch.clientX, touch.clientY);
		if (event.cancelable) event.preventDefault();
		this.queuePencilGestureUpdate(gesture, touch.clientX, touch.clientY);
	}

	private async handleStylusTouchEnd(ownerDocument: Document, event: TouchEvent) {
		this.trackTouchEnd(ownerDocument, event);
		const pending = this.pendingStylusTouch;
		if (!pending || pending.ownerDocument !== ownerDocument) return;
		const touch = Array.from(event.changedTouches).find((candidate) => candidate.identifier === pending.id);
		if (!touch) return;
		this.pendingStylusTouch = null;
		const press = this.pendingPress;
		this.pendingPress = null;
		const gesture = this.pencilGesture;
		if (gesture?.input.kind === 'touch' && gesture.input.id === touch.identifier) {
			const outcome = await this.finishPencilGesture(gesture, touch.clientX, touch.clientY);
			if (outcome !== 'tap') return;
		}
		if (pending.insideToolbar || this.isInsideActivePopup(touch.target)) return;
		if (!press || !shouldKeepPressForGesture({
			downX: press.x,
			downY: press.y,
			endX: touch.clientX,
			endY: touch.clientY,
			durationMs: performance.now() - press.at,
		})) {
			this.lastPdfClick = null;
			this.lastTouchPressPoint = null;
			return;
		}
		this.lastTouchPressPoint ??= { x: touch.clientX, y: touch.clientY };
		// A Pencil tap still opens the existing annotation controls. Passing no
		// commit target prevents a tap-created native selection from auto-saving.
		this.scheduleSelectionUpdate(0);
	}

	private handleStylusTouchCancel(ownerDocument: Document, event: TouchEvent) {
		this.trackTouchEnd(ownerDocument, event);
		const gesture = this.pencilGesture;
		if (gesture?.input.kind === 'touch' && gesture.pdfView.containerEl.ownerDocument === ownerDocument &&
			Array.from(event.changedTouches).some((touch) => touch.identifier !== gesture.input.id)) {
			this.cancelPencilGesture(true);
			this.pendingStylusTouch = null;
			this.pendingPress = null;
			this.lastPdfClick = null;
			this.lastTouchPressPoint = null;
			this.isMultiTouchGesture = true;
			this.selectionGestureGeneration++;
			this.selectionAtPress = null;
			return;
		}
		const pending = this.pendingStylusTouch;
		if (!pending || pending.ownerDocument !== ownerDocument) return;
		if (!Array.from(event.changedTouches).some((touch) => touch.identifier === pending.id)) return;
		this.pendingStylusTouch = null;
		this.pendingPress = null;
		if (this.pencilGesture?.input.kind === 'touch' && this.pencilGesture.input.id === pending.id) this.cancelPencilGesture(true);
		this.selectionGestureGeneration++;
		this.selectionAtPress = null;
		this.lastPdfClick = null;
		this.lastTouchPressPoint = null;
	}

	/** True when the last touch/pen press landed away from the given selection.
	 *
	 * Mouse presses never qualify: desktop collapses a selection on click by
	 * itself, so that path already works and has no reason to enter this logic.
	 * A press *inside* the selection is how a long-press that just created one
	 * arrives here — treating that as "tapped away" would throw away the
	 * selection the moment the user made it. */
	private touchPressLandedOutside(nativeSelection: OwnedNativeSelection): boolean {
		const press = this.lastTouchPressPoint;
		if (!press) return false;
		const rects = Array.from(nativeSelection.range.getClientRects()).map((r) => ({
			left: r.left,
			top: r.top,
			right: r.right,
			bottom: r.bottom,
		}));
		const inside = pointWithinRects(press, rects, SELECTION_HIT_SLOP_PX);
		return rects.length > 0 && !inside;
	}

	private cancelSelectionOverlayRefresh() {
		const pending = this.selectionOverlayFrame;
		if (pending) pending.ownerWindow.cancelAnimationFrame(pending.id);
		this.selectionOverlayFrame = null;
	}

	private scheduleSelectionOverlayRefresh(ownerDocument: Document) {
		if (this.isUnloading || !this.selectionOverlay || this.selectionOverlayDocument !== ownerDocument ||
			this.selectionOverlayFrame || !ownerDocument.defaultView) return;
		const ownerWindow = ownerDocument.defaultView;
		const pending = { id: 0, ownerWindow };
		this.selectionOverlayFrame = pending;
		pending.id = ownerWindow.requestAnimationFrame(() => {
			if (this.selectionOverlayFrame !== pending) return;
			this.selectionOverlayFrame = null;
			if (!this.isUnloading && this.selectionOverlayDocument === ownerDocument) this.refreshSelectionOverlay();
		});
	}

	/** Repaints the optional iOS preview using native visual boxes only. The
	 * complete text/quad capture remains on the actual annotation-save path. */
	private refreshSelectionOverlay() {
		this.cancelSelectionOverlayRefresh();
		const overlay = this.selectionOverlay;
		if (!overlay || this.isUnloading) return;
		const gesture = this.pencilGesture;
		const selectionDocument = this.selectionOverlayDocument ?? gesture?.pdfView.containerEl.ownerDocument;
		const selection = selectionDocument?.defaultView?.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
			overlay.update([]);
			return;
		}
		try {
			const pdfView = gesture?.pdfView ?? getActivePdfView(this.app);
			if (!pdfView || pdfView.containerEl.ownerDocument !== selectionDocument) {
				overlay.update([]);
				return;
			}
			this.paintSelectionOverlay(pdfView, selection.getRangeAt(0));
		} catch {
			// The optional preview must also clear while a native viewer loads.
			overlay.update([]);
		}
	}

	private paintSelectionOverlay(pdfView: ActivePdfView | null, range?: Range) {
		this.cancelSelectionOverlayRefresh();
		const overlay = this.selectionOverlay;
		if (!overlay) return;
		if (!pdfView || !range || pdfView.containerEl.ownerDocument !== this.selectionOverlayDocument) {
			overlay.update([]);
			return;
		}
		const gesture = this.pencilGesture;
		const previewColor = gesture?.selection.moved && gesture.pdfView.containerEl === pdfView.containerEl &&
			gesture.textLayer.contains(range.commonAncestorContainer) ? gesture.colorHex : undefined;
		overlay.update(liveSelectionOverlayRects(pdfView, range), previewColor);
	}

	private hasNewSelection(selection: Selection): boolean {
		if (selection.isCollapsed) return false;
		const before = this.selectionAtPress;
		return !before || before.anchorNode !== selection.anchorNode || before.anchorOffset !== selection.anchorOffset ||
			before.focusNode !== selection.focusNode || before.focusOffset !== selection.focusOffset;
	}

	/** Commit a completed selection only in Highlight mode, otherwise leave it
	 * available for copying or the fixed palette. Annotation clicks retain their
	 * existing note, recolour and removal controls. */
	private async updateSelectionMenu(commitSelection: CapturedPdfTarget<TFile, ActivePdfView> | null = null, editNote = false) {
		if (this.isUnloading) return;
		const click = this.lastPdfClick;
		if (editNote && click) {
			// Double-click also selects a word natively. Resolve annotation intent
			// before Highlight mode can commit that word as a new annotation.
			const generation = this.menuGeneration;
			const gesture = this.selectionGestureGeneration;
			const found = await this.showCandidatesForClick(click, false, undefined, true);
			if (found !== false || this.isUnloading ||
				this.menuGeneration !== generation || this.selectionGestureGeneration !== gesture || this.lastPdfClick !== click) return;
		}
		const nativeSelection = this.getOwnedNativeSelection(commitSelection?.pdfView);
		// Final pointer-up painting is immediate. Native rectangles supply the
		// preview; complete text/quad capture waits until a changed Highlight-mode
		// selection is actually going to be saved.
		this.paintSelectionOverlay(nativeSelection?.pdfView ?? null, nativeSelection?.range);
		const pressLandedOutside = nativeSelection !== null && this.touchPressLandedOutside(nativeSelection);
		this.lastTouchPressPoint = null; // one-shot, see the field's doc comment
		if (nativeSelection && pressLandedOutside) {
			// iOS keeps a selection alive when you tap away from it, so "there is
			// still a selection" is not evidence the user still wants one. Drop it
			// ourselves and carry on into the remove-menu check below, exactly as
			// if the press had found no selection.
			nativeSelection.selection.removeAllRanges();
			this.refreshSelectionOverlay();
			this.hideActiveMenu();
			await this.maybeShowRemoveMenu();
			return;
		}
		if (nativeSelection) {
			const completedSelection = Boolean(commitSelection && this.hasNewSelection(nativeSelection.selection) &&
				commitSelection.file === nativeSelection.pdfView.file &&
				commitSelection.pdfView.containerEl === nativeSelection.pdfView.containerEl && this.isCapturedPdfCurrent(commitSelection));
			if (completedSelection) {
				const right = nativeSelection.pdfView.getToolbarRightElement();
				let state = right ? this.annotationToolbars.get(right) : undefined;
				if (right && !state) {
					this.ensureAnnotationToolbar(nativeSelection.pdfView, right);
					state = this.annotationToolbars.get(right);
				}
				if (state?.highlighting) {
					const selectionCtx = this.trySelectionContext(nativeSelection.pdfView);
					if (!selectionCtx) {
						this.hideActiveMenu();
						await this.maybeShowRemoveMenu();
						return;
					}
					if (commitSelection!.file === selectionCtx.capture.file &&
						commitSelection!.pdfView.containerEl === selectionCtx.pdfView.containerEl) {
						const color = this.settings.colors.find((option) => option.id === state.colorId) ?? getDefaultColor(this.settings);
						await this.performHighlight(selectionCtx, hexToRgbColor(color.hex));
					}
				}
			}
			return;
		}

		this.hideActiveMenu();
		await this.maybeShowRemoveMenu();
	}

	private async maybeShowRemoveMenu() {
		const click = this.lastPdfClick;
		if (!click) return;
		await this.showCandidatesForClick(click, false);
	}

	private async showCandidatesForClick(
		click: CapturedPdfPress<TFile, ActivePdfView>,
		notify: boolean,
		areaInteraction?: { isCurrent(): boolean; regionsOnly: boolean },
		editNote = false,
	): Promise<boolean | null> {
		// Only a completed lookup with no hit may fall back to word selection.
		if (this.isUnloading) return null;
		const menuGeneration = this.menuGeneration;
		const gestureGeneration = this.selectionGestureGeneration;
		const { capture } = click;
		const pdfView = capture.pdfView;
		if (!this.isCapturedPdfCurrent(capture)) {
			if (notify) new Notice('Study PDF: the PDF where you clicked is no longer open at that location.');
			return null;
		}
		const resolved = resolveCapturedPdfPress(click);
		try {
			const index = await this.getHighlightIndexForCapture(capture);
			if (this.isUnloading || menuGeneration !== this.menuGeneration ||
				(areaInteraction ? !areaInteraction.isCurrent() : this.mouseSelectionDown || this.lastPdfClick !== click) ||
				(editNote && gestureGeneration !== this.selectionGestureGeneration) || !this.isCapturedPdfCurrent(capture)) return null;
			const infos = findHighlightsInIndexAtPoint(index, resolved.pageIndex, resolved.point)
				.filter((info) => !areaInteraction?.regionsOnly || Boolean(info.regionBox));
			if (!infos.length) {
				if (notify) new Notice('Study PDF: no highlight found where you clicked.');
				return false;
			}
			// A delayed index build must not move an earlier press onto a later pane
			// or location. The captured file and view stay attached to this chooser.
			const doc = pdfView.containerEl.ownerDocument;
			const position = { x: click.clientX, y: click.clientY + 8, aboveY: click.clientY - 8 };
			const candidates: CandidateChoice[] = infos.map((info) => ({ ...info, pageIndex: resolved.pageIndex }));
			if (editNote) {
				const selection = this.getOwnedNativeSelection(pdfView);
				selection?.selection.removeAllRanges();
				this.paintSelectionOverlay(null);
				const candidate = candidates.length === 1 ? candidates[0] : null;
				if (candidate?.target) {
					this.openAnnotationNote(capture, candidate.target, candidate.note, position);
					return true;
				}
			}
			this.showCandidateChooser(doc, position, candidates, capture);
			return true;
		} catch (error) {
			// Silent: this is a passive background check, not an explicit user action.
			if (notify && !this.isUnloading && menuGeneration === this.menuGeneration) {
				new Notice(`Study PDF: could not inspect highlights -- ${(error as Error).message}`, 0);
			}
			return null;
		}
	}

	private showCandidateChooser(
		doc: Document,
		position: PopupAnchor,
		candidates: readonly CandidateChoice[],
		capture: CapturedPdfTarget<TFile, ActivePdfView>,
	) {
		if (this.isUnloading) return;
		this.hideActiveMenu();
		const palette = {
			colors: this.settings.colors.map((color) => ({ ...color })),
			defaultColorId: this.settings.defaultColorId,
		};
		let popup: IconPopup;
		const copyCandidate = (candidate: CandidateChoice, dismiss = true) => {
			if (this.isUnloading || !this.isCapturedPdfCurrent(capture)) return;
			if (candidate.regionBox) {
				void copyPdfRegionImage(capture.pdfView, candidate.pageIndex, candidate.regionBox,
					() => !this.isUnloading && this.isCapturedPdfCurrent(capture)).then(
					() => { if (dismiss) { new Notice('Selected area copied as an image.'); if (this.activePopup === popup) this.hideActiveMenu(); } },
					(error: unknown) => new Notice(`Could not copy the selected area: ${(error as Error).message}`),
				);
				return;
			}
			void copyPdfHighlightText(capture.pdfView, candidate.pageIndex, candidate,
				() => !this.isUnloading && this.isCapturedPdfCurrent(capture)).then(
				() => {
					if (dismiss) {
						new Notice('Study PDF: copied highlighted text to the clipboard.');
						if (this.activePopup === popup) popup.hide();
					}
				},
				(error: unknown) => new Notice(`Could not copy the highlighted text: ${(error as Error).message}`),
			);
		};
		popup = showColorPaletteModal(doc, position, candidates, palette.colors, palette.defaultColorId, {
			onRecolor: (target, color) => {
				this.hideActiveMenu();
				void this.performRecolor(capture, target, color);
			},
			onEditNote: (candidate) => {
				if (candidate.target) this.openAnnotationNote(capture, candidate.target, candidate.note, position);
			},
			onCopy: (candidate) => copyCandidate(candidate),
			onRemove: (candidate) => {
				if (!candidate.target) return;
				const target = candidate.target;
				this.hideActiveMenu();
				void this.performRemoveTarget(capture, target);
			},
			onDismiss: () => {
				if (this.selectedAnnotation?.popup === popup) this.clearSelectedAnnotation();
				if (this.activePopup === popup) { this.activePopup = null; this.menuGeneration++; }
			},
		});
		this.activePopup = popup;
		const candidate = candidates.length === 1 ? candidates[0] : undefined;
		if (candidate?.target) {
			this.selectedAnnotation = {
				capture, target: candidate.target, popup,
				copy: canCopyHighlight(candidate) ? () => copyCandidate(candidate, false) : null,
				clearOutline: capture.pdfView.markSelectedAnnotation?.(candidate.target) ?? (() => {}),
			};
		}
	}

	/** Writes (or refreshes) the sibling "<PDF> (highlights).md" note.
	 *
	 * The whole managed block is regenerated rather than diffed per annotation
	 * id: pdf-lib re-serializes the entire document on every write, and while
	 * measurement showed untouched annotations keeping their object numbers
	 * through one, that is a property of pdf-lib's writer rather than anything
	 * this plugin controls. Regenerating costs nothing and can't preserve a
	 * stale link. */
	private async exportHighlightsToNote(pdfView: ActivePdfView) {
		try {
			const capture = capturePdfTarget(pdfView.file, pdfView);
			await withPdfHighlightSnapshot({
				path: capture.path,
				pdfView,
				coordinator: this.pdfMutationCoordinator,
				read: () => this.app.vault.readBinary(capture.file),
				assertCurrent: () => this.assertCapturedPdfCurrent(capture),
			}, async (entries, _snapshotFingerprint, assertSourceUnchanged) => {
				const notePath = exportNotePath(pdfView.file.parent?.path, pdfView.file.basename);
				const existingFile = this.app.vault.getAbstractFileByPath(notePath);
				if (entries.length === 0 && !existingFile) {
					new Notice('Study PDF: no highlights in this PDF yet.');
					return;
				}
				if (existingFile && !(existingFile instanceof TFile)) {
					new Notice(`Study PDF: "${notePath}" is a folder, not a note.`);
					return;
				}
				const link = (subpath: string, alias?: string) =>
					this.app.fileManager.generateMarkdownLink(pdfView.file, notePath, subpath, alias);
				const body = formatExportBody(
					entries.map((entry) => ({ ...entry, link: buildEntryLink(entry, link) })),
					{
						sourceLink: this.app.fileManager.generateMarkdownLink(pdfView.file, notePath),
						palette: this.settings.colors,
					},
				);
				await assertSourceUnchanged();
				if (existingFile) {
					await this.app.vault.process(existingFile, (latest) => mergeExportedNote(latest, body));
				} else {
					const created = await this.app.vault.create(notePath, mergeExportedNote(null, body));
					await this.app.workspace.getLeaf('tab').openFile(created);
				}
				new Notice(`Exported ${entries.length} highlight${entries.length === 1 ? '' : 's'} to ${notePath}.`);
			});
		} catch (err) {
			new Notice(`Study PDF: could not export highlights — ${(err as Error).message}`);
		}
	}

	/** Exports only the checked rows into a separate managed note. The source
	 * snapshot is rechecked under the mutation queue so stale list entries can
	 * never be written after the PDF changes. */
	private async exportSelectedHighlightsToNote(
		pdfView: ActivePdfView,
		entries: HighlightEntry[],
		snapshotFingerprint: string,
	) {
		try {
			const capture = capturePdfTarget(pdfView.file, pdfView);
			await this.pdfMutationCoordinator.runExclusive(capture.path, async () => {
				const assertSourceUnchanged = async () => {
					this.assertCapturedPdfCurrent(capture);
					const currentBytes = new Uint8Array(await this.app.vault.readBinary(capture.file));
					this.assertCapturedPdfCurrent(capture);
					const currentFingerprint = await fingerprintPdfBytes(currentBytes);
					this.assertCapturedPdfCurrent(capture);
					if (currentFingerprint !== snapshotFingerprint) {
						throw new Error('The PDF changed after this list was scanned. Reopen the highlights list and try again.');
					}
				};
				await assertSourceUnchanged();
				const notePath = selectionExportNotePath(pdfView.file.parent?.path, pdfView.file.basename);
				const existingFile = this.app.vault.getAbstractFileByPath(notePath);
				if (existingFile && !(existingFile instanceof TFile)) {
					new Notice(`Study PDF: "${notePath}" is a folder, not a note.`);
					return;
				}
				const link = (subpath: string, alias?: string) =>
					this.app.fileManager.generateMarkdownLink(pdfView.file, notePath, subpath, alias);
				const body = formatExportBody(
					entries.map((entry) => ({ ...entry, link: buildEntryLink(entry, link) })),
					{
						sourceLink: this.app.fileManager.generateMarkdownLink(pdfView.file, notePath),
						palette: this.settings.colors,
						selection: true,
					},
				);
				await assertSourceUnchanged();
				if (existingFile) {
					await this.app.vault.process(existingFile, (latest) => mergeExportedNote(latest, body));
				} else {
					const created = await this.app.vault.create(notePath, mergeExportedNote(null, body));
					await this.app.workspace.getLeaf('tab').openFile(created);
				}
				new Notice(`Exported ${entries.length} selected highlight${entries.length === 1 ? '' : 's'} to ${notePath}.`);
			});
		} catch (err) {
			new Notice(`Study PDF: could not export selected highlights — ${(err as Error).message}`);
		}
	}

	/** Writes new spaced-repetition cards into "<PDF> (flashcards).md".
	 *
	 * Changed cards are updated in place while preserving their inline review
	 * schedules. Merge against the latest note atomically so concurrent review
	 * updates and user-written paragraphs survive. See flashcards.ts. */
	private async syncFlashcards(pdfView: ActivePdfView) {
		try {
			const capture = capturePdfTarget(pdfView.file, pdfView);
			await withPdfHighlightSnapshot({
				path: capture.path,
				pdfView,
				coordinator: this.pdfMutationCoordinator,
				read: () => this.app.vault.readBinary(capture.file),
				assertCurrent: () => this.assertCapturedPdfCurrent(capture),
			}, async (entries, _snapshotFingerprint, assertSourceUnchanged) => {
				const notePath = siblingNotePath(pdfView.file.parent?.path, pdfView.file.basename, 'flashcards');
				const existingFile = this.app.vault.getAbstractFileByPath(notePath);
				const withNotes = entries.filter((entry) => !entry.standaloneNote && (entry.note ?? '').trim().length > 0);
				if (withNotes.length === 0 && !existingFile) {
					new Notice('Study PDF: add a note to a highlight first — the note becomes the question.');
					return;
				}
				if (existingFile && !(existingFile instanceof TFile)) {
					new Notice(`Study PDF: "${notePath}" is a folder, not a note.`);
					return;
				}
				const blocks = buildFlashcardBlocks(withNotes.map((entry) => ({
					pageNumber: entry.pageNumber,
					quote: entry.quote,
					note: entry.note,
					link: this.app.fileManager.generateMarkdownLink(
						pdfView.file,
						notePath,
						annotationSubpath(entry.pageNumber, entry.annotationId),
						`p. ${entry.pageNumber}`,
					),
					key: entry.annotationId ? `annotation=${entry.annotationId}` : entry.quote,
				})));

				await assertSourceUnchanged();
				let merged: ReturnType<typeof mergeFlashcardNote>;
				if (existingFile) {
					let processed: ReturnType<typeof mergeFlashcardNote> | undefined;
					await this.app.vault.process(existingFile, (latest) => {
						processed = mergeFlashcardNote(latest, blocks);
						return processed.content;
					});
					if (!processed) throw new Error('The flashcard note could not be processed.');
					merged = processed;
				} else {
					merged = mergeFlashcardNote(null, blocks);
					const created = await this.app.vault.create(notePath, merged.content);
					await this.app.workspace.getLeaf('tab').openFile(created);
				}

				const parts = [`${merged.added} new card${merged.added === 1 ? '' : 's'}`];
				if (merged.updated > 0) parts.push(`${merged.updated} updated`);
				if (merged.kept > 0) parts.push(`${merged.kept} already there`);
				if (merged.orphaned > 0) parts.push(`${merged.orphaned} moved to "Orphaned" (highlight gone; review history kept)`);
				new Notice(`Study PDF: ${parts.join(', ')} in ${notePath}.`);
			});
		} catch (err) {
			new Notice(`Study PDF: could not sync flashcards — ${(err as Error).message}`);
		}
	}

	private highlightRegion(view: ActivePdfView, region: SelectedPdfRegion, hex: string) {
		const capture = capturePdfTarget(view.file, view);
		if (!this.isCapturedPdfCurrent(capture)) return;
		// Freeze the selected PDF coordinates; resizing cannot move an in-flight save.
		const viewport = region.viewport;
		const rect = region.pageLocalRect;
		void this.performHighlight({
			capture, pdfView: view, text: '', isRegion: true,
			segments: [{ pageIndex: region.pageIndex, textLayer: region.pageElement,
				pageLocalRects: [rect], viewport, text: '' }],
		}, hexToRgbColor(hex));
	}

	private async highlightCurrentSelection(color: RgbColor) {
		const ctx = this.getSelectionContextOrNotify();
		if (!ctx) return;
		await this.performHighlight(ctx, color);
	}

	private async performHighlight(ctx: SelectionContext, color: RgbColor) {
		const { capture, pdfView, segments } = ctx;
		if (this.isUnloading) return;
		if (!this.isCapturedPdfCurrent(capture)) {
			new Notice('Study PDF: the PDF view changed before this highlight could be saved.');
			return;
		}
		const ownerDocument = pdfView.containerEl.ownerDocument;
		const ownerWindow = ownerDocument.defaultView;
		if (!ownerWindow || ownerWindow.closed) return;
		const expandTop = ctx.isRegion ? 0 : HIGHLIGHT_EXPAND_TOP;
		const expandBottom = ctx.isRegion ? 0 : HIGHLIGHT_EXPAND_BOTTOM;
		const annotations = segments.map((segment) => {
			const { quadPoints, box } = selectionRectsToQuadPoints(
				segment.pageLocalRects,
				segment.viewport,
				expandTop,
				expandBottom,
			);
			return {
				pageIndex: segment.pageIndex,
				quadPoints,
				box,
				color,
				isRegion: ctx.isRegion,
				quote: segments.length === 1 ? normalizeQuote(ctx.text) : segment.text,
			};
		});

		// Keep the compatibility curtain paint; the live view gets an immediate
		// preview independently of the save/write latency.
		const colorCss = `rgb(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)})`;
		const paints: CurtainPaint[] = [];
		for (const segment of segments) {
			const origin = segment.textLayer.getBoundingClientRect();
			if (!segment.textLayer.isConnected) continue;
			paints.push({
				pageNumber: String(segment.pageIndex + 1),
				// Mirror the vertical adjustment the real annotation gets, so the
				// painted preview and final render line up when the curtain lifts.
				rects: segment.pageLocalRects.map((r) => {
					const height = r.bottom - r.top;
					return {
						left: r.left + origin.left,
						top: r.top + origin.top - height * expandTop,
						width: r.right - r.left,
						height: height * (1 + expandTop + expandBottom),
					};
				}),
				color: colorCss,
				opacity: 1,
			});
		}
		const action = new AbortController();
		const abortAction = () => action.abort();
		this.activeHighlightActions.add(action);
		let preview: { dispose(): void } | null = null;
		try {
			ownerWindow.addEventListener('pagehide', abortAction, { once: true });
			ownerWindow.addEventListener('beforeunload', abortAction, { once: true });
			const previews = segments.flatMap((segment) => {
				return segment.textLayer.isConnected
					? [showHighlightPreview(segment.textLayer, segment.pageLocalRects, colorCss, expandTop, expandBottom)]
					: [];
			});
			preview = previews.length > 0 ? { dispose: () => { for (const item of previews) item.dispose(); } } : null;
			if (preview) this.pendingPreviews.add(preview);
			ownerWindow.getSelection()?.removeAllRanges();
			this.paintSelectionOverlay(null);
			this.hideActiveMenu();

			const result = await this.mutateCapturedPdf(
				capture,
				segments.map((segment) => segment.pageIndex),
				async (existingBytes) => {
					await letPreviewPaint(
						ownerDocument,
						action.signal,
						this.app.workspace.containerEl.ownerDocument.defaultView ?? window,
					);
					return {
						bytes: await (ctx.isRegion ? addHighlightAnnotations : replaceOverlappingHighlightAnnotations)(existingBytes, annotations),
						value: undefined,
					};
				},
				paints,
				() => preview?.dispose(),
				undefined,
				action.signal,
			);
			if (!result.changed) {
				this.invalidateHighlightIndex();
			}
		} catch (err) {
			this.invalidateHighlightIndex();
			if (this.isUnloading || action.signal.aborted) return;
			console.error('Study PDF: failed to add highlight', err);
			new Notice(`Study PDF: failed to add highlight -- ${(err as Error).message}`, 0);
		} finally {
			try { preview?.dispose(); } catch { /* Preview cleanup must not retain the action lifecycle. */ }
			if (preview) this.pendingPreviews.delete(preview);
			try { ownerWindow.removeEventListener('pagehide', abortAction); } catch { /* The popout may already be closed. */ }
			try { ownerWindow.removeEventListener('beforeunload', abortAction); } catch { /* The popout may already be closed. */ }
			this.activeHighlightActions.delete(action);
		}
	}

	/** Explicit "Remove highlight at selection" command: uses the last click,
	 * same as the menu, but explains itself with a Notice on failure. */
	private async removeHighlightAtLastClick() {
		const click = this.lastPdfClick;
		if (!click) {
			new Notice('Study PDF: click on a highlight first.');
			return;
		}
		await this.showCandidatesForClick(click, true);
	}

	private async performRecolor(
		capture: CapturedPdfTarget<TFile, ActivePdfView>,
		target: HighlightTarget,
		color: RgbColor,
	) {
		if (!this.isCapturedPdfCurrent(capture)) {
			new Notice('Study PDF: the PDF view changed before this color could be saved.');
			return;
		}
		this.hideActiveMenu();
		try {
			const result = await this.mutateCapturedPdf(capture, [target.pageIndex], async (existingBytes) => {
				const updated = await setHighlightColorAt(existingBytes, { ...target, color });
				return { bytes: updated.bytes, value: updated.updatedCount, changed: updated.updatedCount > 0 };
			});
			if (!result.changed || result.value === 0) return; // same-color selection: no write was needed
		} catch (err) {
			this.invalidateHighlightIndex();
			if (this.isUnloading) return;
			console.error('Study PDF: failed to change highlight color', err);
			new Notice(`Study PDF: could not change highlight color -- ${(err as Error).message}`, 0);
		}
	}

	private async performSetNoteForTarget(
		capture: CapturedPdfTarget<TFile, ActivePdfView>,
		target: HighlightTarget,
		note: string,
	): Promise<boolean> {
		if (!this.isCapturedPdfCurrent(capture)) {
			new Notice('Study PDF: the PDF view changed before this note could be saved.');
			return false;
		}
		try {
			const result = await this.mutateCapturedPdf(capture, [target.pageIndex], async (existingBytes) => {
				const sourceFingerprint = await fingerprintPdfBytes(existingBytes);
				const currentTarget = sourceFingerprint === target.sourceFingerprint
					? target
					: await reinspectHighlightTarget(existingBytes, target);
				if (!currentTarget) {
					throw new Error('The original highlight is no longer uniquely identifiable. Reopen its popup before trying again; your draft is still here.');
				}
				const updated = await setHighlightNoteForTarget(existingBytes, { ...currentTarget, note });
				return { bytes: updated.bytes, value: updated.updatedCount, changed: updated.updatedCount > 0 };
			});
			if (!result.changed || result.value === 0) return true;
			return true;
		} catch (err) {
			this.invalidateHighlightIndex();
			if (this.isUnloading) return false;
			console.error('Study PDF: failed to save note', err);
			new Notice(`Study PDF: could not save note -- ${(err as Error).message}`, 0);
			return false;
		}
	}

	private async performRemoveTarget(
		capture: CapturedPdfTarget<TFile, ActivePdfView>,
		target: HighlightTarget,
	) {
		if (!this.isCapturedPdfCurrent(capture)) {
			new Notice('Study PDF: the PDF view changed before this highlight could be removed.');
			return;
		}
		this.hideActiveMenu();
		try {
			const result = await this.mutateCapturedPdf(capture, [target.pageIndex], async (existingBytes) => {
				const updated = await removeHighlightForTarget(existingBytes, target);
				return { bytes: updated.bytes, value: updated.removedCount, changed: updated.removedCount > 0 };
			});
			if (this.isUnloading) return;
			if (!result.changed || result.value === 0) {
				new Notice('Study PDF: the selected highlight is no longer present.');
			}
		} catch (err) {
			this.invalidateHighlightIndex();
			if (this.isUnloading) return;
			console.error('Study PDF: failed to remove highlight', err);
			new Notice(`Study PDF: could not remove highlight -- ${(err as Error).message}`, 0);
		}
	}

	private async applyPdfHistory(pdfView: ActivePdfView, direction: PdfHistoryDirection) {
		if (this.isUnloading) return;
		this.cancelPendingSelectionUpdate();
		this.hideActiveMenu();
		const capture = capturePdfTarget(pdfView.file, pdfView);
		type HistoryValue =
			| { status: 'empty' | 'mismatch' }
			| { status: 'ready'; transition: PdfHistoryTransition };
		try {
			const result = await this.mutateCapturedPdf(
				capture,
				(value: HistoryValue) => value.status === 'ready' ? value.transition.pageIndexes : [],
				async (currentBytes): Promise<PdfMutationTransform<HistoryValue>> => {
					const resolution = this.annotationHistory.resolve(capture.file, capture.path, currentBytes, direction);
					if (resolution.status !== 'ready') {
						return { bytes: currentBytes, value: { status: resolution.status }, changed: false };
					}
					return { bytes: resolution.transition.targetBytes, value: { status: 'ready', transition: resolution.transition } };
				},
				undefined,
				undefined,
				(_beforeBytes, _afterBytes, value) => {
					if (value.status === 'ready' && !value.transition.commit()) this.annotationHistory.clearPath(capture.path);
				},
			);
			if (this.isUnloading) return;
			this.refreshAnnotationToolbars();
			if (result.value.status === 'mismatch') {
				new Notice('Study PDF: the PDF no longer matches its undo history. History was cleared without changing the file.');
			}
		} catch (error) {
			if (this.isUnloading) return;
			this.refreshAnnotationToolbars();
			console.error(`Study PDF: failed to ${direction} PDF annotation`, error);
			new Notice(`Study PDF: could not ${direction} PDF annotation -- ${(error as Error).message}`, 0);
		}
	}

	private async mutateCapturedPdf<T>(
		capture: CapturedPdfTarget<TFile, ActivePdfView>,
		pageIndexes: number[] | ((value: T) => number[]),
		transform: (originalBytes: Uint8Array) => Promise<PdfMutationTransform<T>>,
		fallbackPaint?: CurtainPaint | readonly CurtainPaint[],
		onPreviewReady?: () => void,
		onSaved?: (beforeBytes: Uint8Array, afterBytes: Uint8Array, value: T) => void,
		actionSignal?: AbortSignal,
	) {
		const previewByView = new Map<HTMLElement, PdfUpdatePreview>();
		let activePageIndexes = Array.isArray(pageIndexes) ? pageIndexes : [];
		const assertMutationActive = () => {
			if (this.isUnloading) throw createMutationAbortError('Study PDF is unloading.');
			if (actionSignal?.aborted) {
				throw actionSignal.reason instanceof Error
					? actionSignal.reason
					: createMutationAbortError('The PDF view closed before this highlight could be saved.');
			}
			this.assertCapturedPdfCurrent(capture);
		};
		return this.pdfMutationCoordinator.run(capture.path, {
			read: async () => {
				assertMutationActive();
				const bytes = new Uint8Array(await this.app.vault.readBinary(capture.file));
				assertMutationActive();
				return bytes;
			},
			transform: async (originalBytes) => {
				assertMutationActive();
				const transformed = await transform(originalBytes);
				assertMutationActive();
				activePageIndexes = typeof pageIndexes === 'function' ? pageIndexes(transformed.value) : pageIndexes;
				return transformed;
			},
			preview: (bytes) => {
				if (this.isUnloading || actionSignal?.aborted) return { dispose() {} };
				const previews: PdfUpdatePreview[] = [];
				const handle = { dispose: () => {
					for (const preview of previews) {
						try { preview.dispose(); } catch { /* One failed preview cleanup must not skip the rest. */ }
					}
					this.pendingPreviews.delete(handle);
				} };
				try {
					for (const view of getAllPdfViews(this.app).filter((candidate) => candidate.file === capture.file)) {
						const preview = view.previewPdfUpdate(bytes, activePageIndexes, view.containerEl === capture.pdfView.containerEl ? onPreviewReady : undefined);
						previews.push(preview);
						previewByView.set(view.containerEl, preview);
					}
				} catch {
					handle.dispose();
					return { dispose() {} };
				}
				this.pendingPreviews.add(handle);
				return handle;
			},
			write: async (bytes, beforeBytes, value) => {
				const inPlace: { view: ActivePdfView; token: InPlacePdfWriteToken }[] = [];
				const fallback: {
					view: ActivePdfView;
					curtain: ReturnType<typeof showReloadCurtain>;
					position: ReturnType<typeof preserveReadingPosition>;
				}[] = [];
				let resourcesDisposed = false;
				let verified: ReturnType<typeof getVerifiedHighlightState> = undefined;
				const disposeOwnedResources = () => {
					if (resourcesDisposed) return;
					resourcesDisposed = true;
					for (const { view, token } of inPlace) {
						try { view.cancelInPlacePdfWrite(token); } catch { /* Continue cleaning the other owned resources. */ }
					}
					for (const item of fallback) {
						try { item.curtain?.cancel(); } catch { /* Continue cleaning the other owned resources. */ }
						try { item.position?.cancel(); } catch { /* Continue cleaning the other owned resources. */ }
					}
				};
				try {
					assertMutationActive();
					this.invalidateHighlightIndex();
					let views: ActivePdfView[];
					try {
						views = getAllPdfViews(this.app).filter((view) => view.file.path === capture.path);
					} catch {
						views = [capture.pdfView];
					}
					if (views.length === 0) views = [capture.pdfView];

					verified = getVerifiedHighlightState(bytes);
					const outputFingerprint = verified?.fingerprint ?? await fingerprintPdfBytes(bytes);
					assertMutationActive();
					for (const view of views) {
						assertMutationActive();
						let token: InPlacePdfWriteToken | null = null;
						try {
							token = await view.prepareInPlacePdfWrite(bytes, outputFingerprint);
						} catch {
							token = null;
						}
						if (token) inPlace.push({ view, token });
						assertMutationActive();
						if (token) continue;
						const paint = view.containerEl === capture.pdfView.containerEl ? fallbackPaint : undefined;
						const fallbackItem: typeof fallback[number] = { view, curtain: null, position: null };
						fallback.push(fallbackItem);
						fallbackItem.curtain = showReloadCurtain(this.app, view, paint);
						fallbackItem.position = preserveReadingPosition(this.app, view);
					}

					assertMutationActive();
					const currentBytes = new Uint8Array(await this.app.vault.readBinary(capture.file));
					assertMutationActive();
					if (!exactBytesEqual(beforeBytes, currentBytes)) {
						this.annotationHistory.clearPath(capture.path);
						if (!this.isUnloading) this.refreshAnnotationToolbars();
						throw new Error(`PDF changed since this operation began: ${capture.path}`);
					}
					assertMutationActive();
					await this.app.vault.modifyBinary(capture.file, toArrayBuffer(bytes));
				} catch (error) {
					disposeOwnedResources();
					throw error;
				}

				if (this.isUnloading) {
					disposeOwnedResources();
					return;
				}
				if (!this.isCapturedPdfFileCurrent(capture)) {
					this.annotationHistory.clearFile(capture.file);
				} else {
					try {
						if (onSaved) {
							onSaved(beforeBytes, bytes, value);
						} else {
							const recorded = this.annotationHistory.record(capture.file, capture.path, beforeBytes, bytes, activePageIndexes);
							if (recorded.status === 'too-large') {
								new Notice('Study PDF: this PDF is too large to fit one undo step in memory.');
							} else if (recorded.evictedHistories > 0) {
								new Notice(`Study PDF: cleared undo history for ${recorded.evictedHistories} other PDF${recorded.evictedHistories === 1 ? '' : 's'} to stay within the memory limit.`);
							}
						}
					} catch (error) {
						this.annotationHistory.clearPath(capture.path);
						console.error('Study PDF: could not update in-memory undo history after saving', error);
						new Notice('Study PDF: the PDF was saved, but its undo history could not be kept in memory.');
					}
				}
				if (!this.isUnloading) this.refreshAnnotationToolbars();

				const savedKey = this.pdfRevisionKey(capture.file);
				const savedGeneration = this.highlightIndexGeneration;
				let refreshed = fallback.length === 0 && inPlace.length > 0;
				await Promise.all(inPlace.map(async ({ view, token }) => {
					if (this.isUnloading) {
						disposeOwnedResources();
						return;
					}
					let result: Awaited<ReturnType<ActivePdfView['refreshAnnotationsInPlace']>>;
					try {
						result = await view.refreshAnnotationsInPlace(bytes, activePageIndexes, token, previewByView.get(view.containerEl));
					} catch {
						result = 'unavailable';
					}
					if (result === 'refreshed') this.noteMarkerViews.get(view.containerEl)?.watcher?.refresh(activePageIndexes);
					if (this.isUnloading) {
						disposeOwnedResources();
						return;
					}
					if (result !== 'refreshed') refreshed = false;
					if (result === 'superseded' || result === 'refreshed') return;

					const paint = view.containerEl === capture.pdfView.containerEl ? fallbackPaint : undefined;
					const fallbackItem: typeof fallback[number] = { view, curtain: null, position: null };
					fallback.push(fallbackItem);
					fallbackItem.curtain = showReloadCurtain(this.app, view, paint);
					fallbackItem.position = preserveReadingPosition(this.app, view);
					try {
						await view.forceReload();
						this.syncPdfNoteMarkers();
					} catch (error) {
						fallbackItem.curtain?.cancel();
						fallbackItem.position?.cancel();
						if (this.isUnloading) return;
						console.error('Study PDF: saved annotations but could not refresh the PDF view', error);
						new Notice('Study PDF: annotations were saved. Reopen the PDF to refresh its view.');
					}
					if (this.isUnloading) disposeOwnedResources();
				}));
				if (this.isUnloading) {
					disposeOwnedResources();
					return;
				}
				if (verified && refreshed && !this.isUnloading && savedGeneration === this.highlightIndexGeneration &&
					savedKey === this.pdfRevisionKey(capture.file) && this.isCapturedPdfCurrent(capture)) {
					this.highlightIndex = { key: savedKey, file: capture.file, index: verified.index };
				}
			},
		});
	}

	private isCapturedPdfCurrent(capture: CapturedPdfTarget<TFile, ActivePdfView>): boolean {
		if (!this.isCapturedPdfFileCurrent(capture)) return false;
		try {
			return isCapturedPdfViewLive(capture, getAllPdfViews(this.app));
		} catch {
			return false;
		}
	}

	private isCapturedPdfFileCurrent(capture: CapturedPdfTarget<TFile, ActivePdfView>): boolean {
		return isCapturedPdfCurrent(capture, (path) => this.app.vault.getAbstractFileByPath(path));
	}

	private assertCapturedPdfCurrent(capture: CapturedPdfTarget<TFile, ActivePdfView>): void {
		if (!this.isCapturedPdfCurrent(capture)) {
			throw new Error(`PDF is no longer at "${capture.path}". Select it again before changing highlights.`);
		}
	}
}
