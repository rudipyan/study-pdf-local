import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({ Notice: vi.fn() }));
vi.mock('../src/ui/pdf-overlay-host', () => ({ acquirePdfOverlayHostPositioning: vi.fn(() => () => {}) }));
vi.mock('../src/ui/icon-popup', () => ({ showIconPopup: vi.fn() }));

import { createRegionSelection } from '../src/ui/region-selection';

type FakeRect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

class FakeElement extends EventTarget {
	readonly children: FakeElement[] = [];
	readonly style: Record<string, string> = {};
	parentElement: FakeElement | null = null;
	className = '';
	hidden = false;
	clientLeft = 0;
	clientTop = 0;
	private capturedPointer: number | null = null;

	constructor(readonly ownerDocument: FakeDocument, readonly tagName: string) { super(); }
	get isConnected(): boolean {
		let current: FakeElement | null = this;
		while (current?.parentElement) current = current.parentElement;
		return current === this.ownerDocument.body;
	}
	createDiv(options: { cls?: string } = {}): FakeElement {
		const child = new FakeElement(this.ownerDocument, 'div');
		child.className = options.cls ?? '';
		return this.appendChild(child);
	}
	appendChild<T extends FakeElement>(child: T): T {
		child.remove();
		child.parentElement = this;
		this.children.push(child);
		return child;
	}
	contains(node: unknown): boolean {
		return node === this || this.children.some((child) => child.contains(node));
	}
	getClientRects(): DOMRect[] { return this.isConnected ? [{} as DOMRect] : []; }
	getBoundingClientRect(): DOMRect {
		const rect: FakeRect = { left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800 };
		return rect as DOMRect;
	}
	setAttribute(_name: string, _value: string): void {}
	setCssStyles(styles: Record<string, string>): void { Object.assign(this.style, styles); }
	setPointerCapture(pointerId: number): void { this.capturedPointer = pointerId; }
	hasPointerCapture(pointerId: number): boolean { return this.capturedPointer === pointerId; }
	releasePointerCapture(pointerId: number): void { if (this.capturedPointer === pointerId) this.capturedPointer = null; }
	remove(): void {
		if (!this.parentElement) return;
		const index = this.parentElement.children.indexOf(this);
		if (index >= 0) this.parentElement.children.splice(index, 1);
		this.parentElement = null;
	}
}

class FakeWindow extends EventTarget {
	innerWidth = 600;
	innerHeight = 800;
	readonly ResizeObserver = class { observe(): void {} disconnect(): void {} };
	requestAnimationFrame(): number { return 1; }
	cancelAnimationFrame(): void {}
	getSelection() { return { removeAllRanges() {} }; }
}

class FakeDocument extends EventTarget {
	readonly body = new FakeElement(this, 'body');
	readonly defaultView = new FakeWindow();
	activeElement: FakeElement | null = null;
	createElement(tagName: string): FakeElement { return new FakeElement(this, tagName); }
	querySelector(): null { return null; }
}

function keyEvent(key: string, properties: Record<string, unknown> = {}): KeyboardEvent {
	const event = new Event('keydown', { cancelable: true }) as KeyboardEvent;
	Object.defineProperty(event, 'key', { value: key });
	for (const [name, value] of Object.entries(properties)) Object.defineProperty(event, name, { value });
	return event;
}

function openRegionSelection(overrides: {
	onExit?: () => void;
	isCurrent?: () => boolean;
	hasOpenPopup?: () => boolean;
	canHandleEscape?: (event: KeyboardEvent) => boolean;
} = {}) {
	const doc = new FakeDocument();
	const pane = doc.body.createDiv();
	const scroller = pane.createDiv();
	const onExit = overrides.onExit ?? vi.fn();
	const canHandleEscape = overrides.canHandleEscape ?? vi.fn(() => true);
	const controller = createRegionSelection({
		containerEl: pane,
		getPdfScrollElement: () => scroller,
		getPdfScrollHostElement: () => pane,
	} as never, {
		isCurrent: overrides.isCurrent ?? (() => true),
		colors: () => [],
		onHighlight() {},
		canHandleEscape,
		hasOpenPopup: overrides.hasOpenPopup,
		onExit,
	});
	return { doc, controller, onExit, canHandleEscape };
}

describe('area selection Escape handling', () => {
	it('ignores handled, composing, repeated, and modified Escape events', () => {
		const f = openRegionSelection();
		const events = [
			keyEvent('Escape', { isComposing: true }),
			keyEvent('Escape', { keyCode: 229 }),
			keyEvent('Escape', { repeat: true }),
			keyEvent('Escape', { shiftKey: true }),
			keyEvent('Escape', { altKey: true }),
			keyEvent('Escape', { ctrlKey: true }),
			keyEvent('Escape', { metaKey: true }),
		];
		const alreadyHandled = keyEvent('Escape');
		alreadyHandled.preventDefault();
		events.push(alreadyHandled);

		for (const event of events) f.doc.dispatchEvent(event);

		expect(f.onExit).not.toHaveBeenCalled();
		expect(f.canHandleEscape).not.toHaveBeenCalled();
		expect(events.every((event) => !event.defaultPrevented || event === alreadyHandled)).toBe(true);
		f.controller.dispose();
	});

	it('leaves popup and non-owning pane Escape to the matching UI', () => {
		const otherPane = openRegionSelection({ canHandleEscape: () => false });
		const otherPaneEscape = keyEvent('Escape');
		otherPane.doc.dispatchEvent(otherPaneEscape);
		expect(otherPane.onExit).not.toHaveBeenCalled();
		expect(otherPaneEscape.defaultPrevented).toBe(false);
		otherPane.controller.dispose();

		const popup = openRegionSelection({ hasOpenPopup: () => true });
		const popupEscape = keyEvent('Escape');
		popup.doc.dispatchEvent(popupEscape);
		expect(popup.onExit).not.toHaveBeenCalled();
		expect(popup.canHandleEscape).not.toHaveBeenCalled();
		popup.controller.dispose();

		const stale = openRegionSelection({ isCurrent: () => false });
		const staleEscape = keyEvent('Escape');
		stale.doc.dispatchEvent(staleEscape);
		expect(stale.onExit).not.toHaveBeenCalled();
		expect(stale.canHandleEscape).not.toHaveBeenCalled();
		stale.controller.dispose();
	});

	it('exits once for an unmodified Escape accepted by the owning active PDF', () => {
		const f = openRegionSelection();
		const event = keyEvent('Escape');
		f.doc.dispatchEvent(event);

		expect(f.canHandleEscape).toHaveBeenCalledExactlyOnceWith(event);
		expect(f.onExit).toHaveBeenCalledOnce();
		expect(event.defaultPrevented).toBe(true);
		expect(event.cancelBubble).toBe(true);
		f.controller.dispose();
	});
});
