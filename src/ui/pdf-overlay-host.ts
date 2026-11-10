// Shared ownership for overlays that use the PDF scroller's stable host.
const HOST_CLASS = 'study-pdf-link-return-host';

interface HostClassState {
	users: number;
	addedClass: boolean;
}

const hostClassStates = new WeakMap<HTMLElement, HostClassState>();

export function acquirePdfOverlayHostPositioning(host: HTMLElement): () => void {
	let state = hostClassStates.get(host);
	if (state) {
		state.users++;
	} else {
		const computed = host.ownerDocument.defaultView?.getComputedStyle(host);
		const needsPositioning = computed?.position === 'static';
		const addedClass = needsPositioning && !host.classList.contains(HOST_CLASS);
		if (addedClass) host.classList.add(HOST_CLASS);
		state = { users: 1, addedClass };
		hostClassStates.set(host, state);
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const current = hostClassStates.get(host);
		if (!current) return;
		current.users--;
		if (current.users > 0) return;
		if (current.addedClass) host.classList.remove(HOST_CLASS);
		hostClassStates.delete(host);
	};
}
