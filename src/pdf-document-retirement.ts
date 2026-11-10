interface PdfLifecycleBus {
	_on(name: string, callback: () => void): void;
	_off(name: string, callback: () => void): void;
}

/** Recheck leases after native rendering settles, never during selection or on
 * a recurring timer. The caller still decides whether each worker is safe. */
export function watchPdfDocumentRetirement(
	bus: PdfLifecycleBus,
	hasWork: () => boolean,
	sweep: () => void,
) {
	const events = ['pagerendered', 'textlayerrendered', 'annotationlayerrendered', 'annotationeditorlayerrendered', 'xfalayerrendered', 'thumbnailrendered', 'afterprint'];
	let disposed = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const schedule = () => {
		if (disposed) return;
		if (timer !== null) clearTimeout(timer);
		timer = null;
		if (!hasWork()) return;
		// Wait for a quiet render interval so asynchronous page/layer completions
		// share one guarded sweep rather than repeatedly scanning all pages.
		timer = setTimeout(() => {
			timer = null;
			if (!disposed && hasWork()) sweep();
		}, 250);
	};
	for (const event of events) bus._on(event, schedule);
	return {
		schedule,
		dispose() {
			disposed = true;
			if (timer !== null) clearTimeout(timer);
			timer = null;
			for (const event of events) bus._off(event, schedule);
		},
	};
}
