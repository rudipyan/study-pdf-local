import type { PdfPageProxyLike, PdfPageViewLike } from './pdf-in-place';

export interface PdfUpdatePreview {
	/** Exact immutable output whose private copy was loaded by PDF.js. */
	sourceBytes?: Uint8Array;
	/** Transfers ownership to the live viewer after the write succeeds. */
	takeDocument?(): Promise<PreviewLoadingTask | null>;
	/** Return only a completed raster from the adopted preview document. */
	getRaster?(pageIndex: number, pageView: PdfPageViewLike, updatedPage: PdfPageProxyLike): HTMLCanvasElement | null;
	dispose(): void;
}

export interface PreviewLoadingTask {
	promise: Promise<{ numPages: number; getPage(number: number): Promise<PdfPageProxyLike> }>;
	destroy(): Promise<void> | void;
}

interface PreviewRaster {
	pageView: PdfPageViewLike;
	sourcePage: PdfPageProxyLike | null;
	page: PdfPageProxyLike;
	document: Awaited<PreviewLoadingTask['promise']>;
	task: PreviewLoadingTask;
	canvas: HTMLCanvasElement;
	rasterCanvas: HTMLCanvasElement;
	parent: HTMLElement;
	viewport: unknown;
	viewportWidth: number;
	viewportHeight: number;
	viewportScale: number | undefined;
	viewportRotation: number | undefined;
	pageViewRotate: number;
	pageRotate: number;
	width: number;
	height: number;
	style: string;
	className: string;
	parentStyle: string | null;
	parentClassName: string | null;
	annotationCanvasMap: Map<unknown, unknown>;
}

function isCurrentRaster(raster: PreviewRaster): boolean {
	const { pageView, canvas, parent, viewport } = raster;
	const size = viewport as { width?: number; height?: number; scale?: number; rotation?: number } | null;
	return !!size && pageView.pdfPage === raster.sourcePage && pageView.canvas === canvas &&
		canvas.parentElement === parent && canvas.isConnected !== false &&
		pageView.viewport === viewport && pageView.pdfPageRotate === raster.pageViewRotate &&
		size.width === raster.viewportWidth && size.height === raster.viewportHeight &&
		size.scale === raster.viewportScale && size.rotation === raster.viewportRotation &&
		canvas.width === raster.width && canvas.height === raster.height &&
		raster.rasterCanvas.width === raster.width && raster.rasterCanvas.height === raster.height &&
		(canvas.style?.cssText ?? '') === raster.style && (canvas.className ?? '') === raster.className &&
		(parent.getAttribute?.('style') ?? null) === raster.parentStyle &&
		(parent.getAttribute?.('class') ?? null) === raster.parentClassName;
}

/** Show the actual updated PDF pixels while the save finishes.
 * The real page canvas, PDF document and annotation objects stay untouched. */
export function startPdfUpdatePreview(
	load: () => PreviewLoadingTask,
	getPageView: (pageIndex: number) => PdfPageViewLike | null,
	pageIndexes: readonly number[],
	isCurrent: () => boolean,
	onReady?: () => void,
): PdfUpdatePreview {
	let disposed = false;
	let claimed = false;
	const overlays = new Set<HTMLCanvasElement>();
	const observers = new Set<MutationObserver>();
	const renders = new Set<{ cancel?(): void }>();
	const rasters = new Map<number, PreviewRaster>();
	let task: PreviewLoadingTask | null = null;
	let document: Awaited<PreviewLoadingTask['promise']> | null = null;
	let release: Promise<void> | null = null;
	const releaseTask = () => {
		if (!claimed && !release && task) {
			const ownedTask = task;
			release = Promise.resolve().then(() => ownedTask.destroy()).then(() => undefined, () => undefined);
		}
		return release;
	};
	const dispose = () => {
		disposed = true;
		for (const observer of observers) observer.disconnect();
		observers.clear();
		for (const render of renders) { try { render.cancel?.(); } catch { /* Already finished. */ } }
		for (const canvas of overlays) { canvas.remove(); canvas.width = canvas.height = 0; }
		overlays.clear();
		rasters.clear();
		void releaseTask();
	};
	void (async () => {
		try {
			if (!isCurrent()) return;
			const previewTask = load();
			task = previewTask;
			const previewDocument = await previewTask.promise;
			document = previewDocument;
			for (const index of new Set(pageIndexes)) {
				if (disposed || !isCurrent()) break;
				const view = getPageView(index);
				const original = view?.canvas;
				if (!view || !original?.parentElement || !view._getRenderingContext) continue;
				const parent = original.parentElement;
				const viewport = view.viewport;
				const size = viewport as { width: number; height: number; scale?: number; rotation?: number };
				if (!size?.width || !size.height) continue;
				const sourcePage = view.pdfPage;
				const pageViewRotate = view.pdfPageRotate;
				const viewportWidth = size.width;
				const viewportHeight = size.height;
				const viewportScale = size.scale;
				const viewportRotation = size.rotation;
				const width = original.width;
				const height = original.height;
				const style = original.style?.cssText ?? '';
				const className = original.className ?? '';
				const parentStyle = parent.getAttribute?.('style') ?? null;
				const parentClassName = parent.getAttribute?.('class') ?? null;
				const overlay = original.cloneNode(false) as HTMLCanvasElement;
				overlay.classList.add('study-pdf-page-preview');
				overlay.setAttribute('aria-hidden', 'true');
				const context = overlay.getContext('2d', { alpha: false });
				if (!context) continue;
				overlays.add(overlay);
				const page = await previewDocument.getPage(index + 1);
				if (disposed || !isCurrent() || !page.render) break;
				const options = view._getRenderingContext(context, [overlay.width / size.width, 0, 0, overlay.height / size.height, 0, 0]);
				// Preview renders must not mutate the live form/annotation canvas map.
				const annotationCanvasMap = new Map<unknown, unknown>();
				options.annotationCanvasMap = annotationCanvasMap;
				const render = page.render(options);
				renders.add(render);
				await render.promise;
				renders.delete(render);
				if (disposed || !isCurrent() || view.canvas !== original || view.viewport !== viewport ||
					original.parentElement !== parent || original.isConnected === false ||
					original.width !== overlay.width || original.height !== overlay.height) break;
				parent.append(overlay);
				const raster: PreviewRaster = {
					pageView: view,
					sourcePage,
					page,
					document: previewDocument,
					task: previewTask,
					canvas: original,
					rasterCanvas: overlay,
					parent,
					viewport,
					viewportWidth,
					viewportHeight,
					viewportScale,
					viewportRotation,
					pageViewRotate,
					pageRotate: page.rotate,
					width,
					height,
					style,
					className,
					parentStyle,
					parentClassName,
					annotationCanvasMap,
				};
				if (!isCurrentRaster(raster)) {
					dispose();
					break;
				}
				rasters.set(index, raster);
				const Observer = original.ownerDocument?.defaultView?.MutationObserver;
				if (Observer) {
					const observer = new Observer(() => {
						if (!isCurrent() || !isCurrentRaster(raster)) dispose();
					});
					observer.observe(parent, { childList: true, attributes: true, attributeFilter: ['style', 'class'] });
					observer.observe(original, { attributes: true, attributeFilter: ['style', 'class', 'width', 'height'] });
					observers.add(observer);
				}
				onReady?.();
			}
		} catch {
			// The normal verified save/refresh path remains available if previewing fails.
			dispose();
		}
	})();
	return {
		dispose,
		async takeDocument() {
			if (disposed || claimed || !task || !isCurrent()) return null;
			try { await task.promise; } catch { return null; }
			if (disposed || claimed || !isCurrent()) return null;
			claimed = true;
			return task;
		},
		getRaster(pageIndex, pageView, updatedPage) {
			if (disposed || !claimed || !task || !document || !isCurrent()) return null;
			const raster = rasters.get(pageIndex);
			if (!raster || raster.pageView !== pageView || raster.page !== updatedPage ||
				raster.document !== document || raster.task !== task || raster.pageRotate !== updatedPage.rotate ||
				raster.annotationCanvasMap.size > 0 || pageView._annotationCanvasMap?.size) return null;
			if (!isCurrentRaster(raster)) {
				dispose();
				return null;
			}
			return raster.canvas === pageView.canvas ? raster.rasterCanvas : null;
		},
	};
}
