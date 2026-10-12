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
	const win = { setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args), clearTimeout: (id: number) => clearTimeout(id) };
	const doc = { defaultView: win };
	vi.stubGlobal('document', doc); vi.stubGlobal('window', win);
	const listeners = new Map<unknown, Map<string, (event: unknown) => void>>();
	const plugin = new StudyPdf() as any;
	Object.assign(plugin, {
		app: { vault: { on() {}, configDir: '.obsidian', adapter: { read: async () => '[]' } }, workspace: { onLayoutReady() {}, on() {} } },
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
	return { plugin, fire, win };
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
	it('still updates keyboard selections and recovers after focus leaves the window', async () => {
		const { plugin, fire, win } = await setup();
		fire('mousedown', { button: 0 });
		fire('blur', {}, win);
		fire('selectionchange');
		await vi.advanceTimersByTimeAsync(100);
		expect(plugin.updateSelectionToolbarForLiveSelection).toHaveBeenCalledOnce();
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

});
