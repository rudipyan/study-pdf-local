import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('obsidian', () => {
	class Base {}
	return { Plugin: Base, Component: Base, Modal: Base, FileView: Base, PluginSettingTab: Base, Setting: Base,
		Scope: Base, TFile: Base, Notice: Base, Platform: {}, setIcon: vi.fn(), setTooltip: vi.fn() };
});
import StudyPdf from '../src/main';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
async function setup() {
	vi.useFakeTimers();
	const doc = new EventTarget() as EventTarget & { defaultView?: EventTarget; visibilityState?: string };
	const win = Object.assign(new EventTarget(), {
		document: doc,
		setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
		clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
		setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
		clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
	});
	doc.defaultView = win;
	vi.stubGlobal('document', doc); vi.stubGlobal('window', win);
	const listeners = new Map<unknown, Map<string, (event: unknown) => void>>();
	const plugin = new StudyPdf() as any;
	Object.assign(plugin, {
		manifest: { id: 'study-pdf-local', dir: '.obsidian/plugins/study-pdf-local' },
		app: { vault: { on() {}, configDir: '.obsidian', adapter: {
			exists: async () => false, read: async () => '[]', write: async () => {},
		} }, workspace: { onLayoutReady() {}, on() {} } },
		loadSettings: vi.fn(async () => {}), addSettingTab() {}, registerEvent() {}, register() {}, addCommand() {},
		addChild(component: any) { component.registerDomEvent = plugin.registerDomEvent.bind(plugin); component.register = () => {}; return component; }, removeChild() {},
		registerDomEvent(target: unknown, event: string, callback: (event: unknown) => void) {
			if (!listeners.has(target)) listeners.set(target, new Map());
			listeners.get(target)!.set(event, callback);
		},
		isInsideActivePopup: () => false, recordPdfPress() {}, hideActiveMenu: vi.fn(), refreshSelectionOverlay() {},
		updateSelectionMenu: vi.fn(async () => {}), updateSelectionToolbarForLiveSelection: vi.fn(),
	});
	await plugin.onload();
	const fire = (event: string, input = {}, target: unknown = doc) => listeners.get(target)!.get(event)!(input);
	return { plugin, fire, win, doc };
}
describe('desktop selection picker timing', () => {
	it('stays hidden through a paused drag and appears only after mouse release', async () => {
		const { plugin, fire } = await setup();
		fire('selectionchange'); // Even an already-pending update is cancelled by a new press.
		fire('mousedown', { button: 0 });
		fire('selectionchange');
		await vi.advanceTimersByTimeAsync(500);
		expect(plugin.updateSelectionMenu).not.toHaveBeenCalled();
		expect(plugin.updateSelectionToolbarForLiveSelection).not.toHaveBeenCalled();
		fire('mouseup', { button: 0 });
		await vi.advanceTimersByTimeAsync(1);
		expect(plugin.updateSelectionMenu).toHaveBeenCalledOnce();
	});
	it('recovers the selection check after focus leaves during a mouse drag', async () => {
		const { plugin, fire, win } = await setup();
		fire('mousedown', { button: 0 });
		fire('blur', {}, win);
		fire('selectionchange');
		await vi.advanceTimersByTimeAsync(100);
		expect(plugin.updateSelectionMenu).not.toHaveBeenCalled();
		fire('mouseup', { button: 0 });
		await vi.advanceTimersByTimeAsync(1);
		expect(plugin.updateSelectionMenu).toHaveBeenCalledOnce();
	});
	it('opens the annotation actions from both normal clicks and the explicit remove command', async () => {
		const { plugin } = await setup();
		const click = { captured: true };
		plugin.lastPdfClick = click;
		plugin.showCandidatesForClick = vi.fn(async () => {});
		await plugin.maybeShowRemoveMenu();
		expect(plugin.showCandidatesForClick).toHaveBeenLastCalledWith(click, false);
		await plugin.removeHighlightAtLastClick();
		expect(plugin.showCandidatesForClick).toHaveBeenLastCalledWith(click, true);
	});

	it.each(['one annotation', 'overlap', 'miss', 'read failure'])('routes a double-click with %s before word highlighting', async (result) => {
		const { plugin, fire, doc } = await setup();
		delete plugin.updateSelectionMenu;
		const text = { nodeType: 1, matches: () => false, closest: () => null };
		const file = { path: 'paper.pdf' };
		const toolbar = {};
		const view = { file, containerEl: { ownerDocument: doc, contains: (node: unknown) => node === text }, getToolbarRightElement: () => toolbar };
		const capture = { file, path: file.path, pdfView: view };
		const target = { pageIndex: 0, objectNumber: 12, generationNumber: 0, sourceFingerprint: 'source' };
		const hit = {
			target, note: 'Existing note', annotsOrder: 0,
			geometry: { invalidReason: null, polygons: [{ area: 100, points: [{ x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 0 }] }] },
		};
		const hits = result === 'overlap' ? [hit, { ...hit, target: { ...target, objectNumber: 13 }, annotsOrder: 1 }]
			: result === 'miss' ? [] : [hit];
		const selection = { isCollapsed: false, removeAllRanges: vi.fn() };
		Object.assign(plugin, {
			lastPdfClick: { capture, pageIndex: 0, clientX: 20, clientY: 30, pdfPoint: { x: 5, y: 5 } },
			getOwnedNativeSelection: () => ({ selection, pdfView: view, range: {} }),
			isCapturedPdfCurrent: () => true,
			getHighlightIndexForCapture: async () => {
				if (result === 'read failure') throw new Error('PDF changed during lookup');
				return new Map([[0, hits]]);
			},
			openAnnotationNote: vi.fn(), showCandidateChooser: vi.fn(), performHighlight: vi.fn(),
			trySelectionContext: () => ({ capture, pdfView: view }),
		});
		plugin.annotationToolbars.set(toolbar, { highlighting: true });

		fire('mouseup', { button: 0, detail: 2, clientX: 20, clientY: 30, target: text, composedPath: () => [text] });
		await vi.runAllTimersAsync();

		if (result === 'one annotation') {
			expect(plugin.openAnnotationNote).toHaveBeenCalledExactlyOnceWith(capture, target, 'Existing note', { x: 20, y: 38, aboveY: 22 });
		} else expect(plugin.openAnnotationNote).not.toHaveBeenCalled();
		expect(plugin.showCandidateChooser).toHaveBeenCalledTimes(result === 'overlap' ? 1 : 0);
		expect(selection.removeAllRanges).toHaveBeenCalledTimes(result === 'one annotation' || result === 'overlap' ? 1 : 0);
		expect(plugin.performHighlight).toHaveBeenCalledTimes(result === 'miss' ? 1 : 0);
	});

});
