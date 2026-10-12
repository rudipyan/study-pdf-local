import type { PdfPageProxyLike, PdfPageViewLike } from './pdf-in-place';

export interface PdfUpdatePreview {
	/** Exact immutable output whose private copy was loaded by PDF.js. */
	sourceBytes?: Uint8Array;
	/** Transfers ownership to the live viewer after the write succeeds. */
	takeDocument?(): Promise<PreviewLoadingTask | null>;
	dispose(): void;
}

export interface PreviewLoadingTask {
	promise: Promise<{ numPages: number; getPage(number: number): Promise<PdfPageProxyLike> }>;
	destroy(): Promise<void> | void;
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
	let task: PreviewLoadingTask | null = null;
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
		void releaseTask();
	};
	void (async () => {
		try {
			if (!isCurrent()) return;
			task = load();
			const document = await task.promise;
			for (const index of new Set(pageIndexes)) {
				if (disposed || !isCurrent()) break;
				const view = getPageView(index);
				const original = view?.canvas;
				if (!view || !original?.parentElement || !view._getRenderingContext) continue;
				const parent = original.parentElement;
				const viewport = view.viewport;
				const size = viewport as { width: number; height: number };
				if (!size?.width || !size.height) continue;
				const overlay = original.cloneNode(false) as HTMLCanvasElement;
				overlay.classList.add('study-pdf-page-preview');
				overlay.setAttribute('aria-hidden', 'true');
				const context = overlay.getContext('2d', { alpha: false });
				if (!context) continue;
				overlays.add(overlay);
				const page = await document.getPage(index + 1);
				if (disposed || !isCurrent() || !page.render) break;
				const options = view._getRenderingContext(context, [overlay.width / size.width, 0, 0, overlay.height / size.height, 0, 0]);
				// Preview renders must not mutate the live form/annotation canvas map.
				options.annotationCanvasMap = new Map();
				const render = page.render(options);
				renders.add(render);
				await render.promise;
				renders.delete(render);
				if (disposed || !isCurrent() || view.canvas !== original || view.viewport !== viewport ||
					original.parentElement !== parent || original.isConnected === false ||
					original.width !== overlay.width || original.height !== overlay.height) break;
				parent.append(overlay);
				const Observer = original.ownerDocument?.defaultView?.MutationObserver;
				if (Observer) {
					const style = original.style.cssText;
					const parentStyle = parent.getAttribute('style');
					const observer = new Observer(() => {
						if (!isCurrent() || view.canvas !== original || view.viewport !== viewport ||
							original.parentElement !== parent || original.style.cssText !== style ||
							parent.getAttribute('style') !== parentStyle ||
							original.width !== overlay.width || original.height !== overlay.height) dispose();
					});
					observer.observe(parent, { childList: true, attributes: true, attributeFilter: ['style'] });
					observer.observe(original, { attributes: true, attributeFilter: ['style', 'width', 'height'] });
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
	};
}
