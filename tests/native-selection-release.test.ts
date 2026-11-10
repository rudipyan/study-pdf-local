import { afterEach, expect, it, vi } from 'vitest';
vi.mock('obsidian', () => {
 class Base {}
 return { Plugin: Base, Component: Base, Modal: Base, FileView: Base, PluginSettingTab: Base, Setting: Base, Scope: Base, TFile: Base, Notice: vi.fn(), Platform: { isIosApp: true }, setIcon: vi.fn(), setTooltip: vi.fn() };
});
vi.mock('../src/ui/selection-overlay', async importOriginal => ({ ...await importOriginal<typeof import('../src/ui/selection-overlay')>(), createSelectionOverlay: vi.fn(() => ({ update: vi.fn(), destroy: vi.fn() })) }));
vi.mock('../src/obsidian-pdf-internals', async importOriginal => ({ ...await importOriginal<typeof import('../src/obsidian-pdf-internals')>(), getActivePdfView: vi.fn(() => null) }));
import { getActivePdfView } from '../src/obsidian-pdf-internals';
import StudyPdf from '../src/main';
import { createSelectionOverlay } from '../src/ui/selection-overlay';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
function fixture() {
 vi.mocked(getActivePdfView).mockReset();
 vi.useFakeTimers(); const frames = new Map<number, FrameRequestCallback>(); let id = 0;
 const win = { setTimeout, clearTimeout, requestAnimationFrame: vi.fn((fn: FrameRequestCallback) => { frames.set(++id, fn); return id; }), cancelAnimationFrame: vi.fn((key: number) => frames.delete(key)), getSelection: () => selection };
 const doc = { defaultView: win };
 const anchor = { ownerDocument: doc }; const focus = { ownerDocument: doc };
 const range = { startContainer: anchor, endContainer: focus, commonAncestorContainer: anchor, getClientRects: vi.fn(() => [{ left: 0, top: 0, right: 30, bottom: 10 }]) };
 const selection = { isCollapsed: false, rangeCount: 1, anchorNode: anchor, anchorOffset: 1, focusNode: focus, focusOffset: 12,
  getRangeAt: vi.fn(() => range), toString: () => 'Selected passage' };
 Object.assign(win, { document: doc }); vi.stubGlobal('window', win);
 const plugin = new StudyPdf() as any;
 const listeners = new Map<unknown, Map<string, (event: any) => unknown>>(); const cleanups: (() => void)[] = [];
 Object.assign(plugin, { app: {}, addChild(component: any) { component.register = (fn: () => void) => cleanups.push(fn); component.registerDomEvent = (target: unknown, name: string, fn: (event: any) => unknown) => { if (!listeners.has(target)) listeners.set(target, new Map()); listeners.get(target)!.set(name, fn); }; return component; }, removeChild() {}, hideActiveMenu: vi.fn(), touchPressLandedOutside: () => false, recordPdfPress: vi.fn(), isInsideActivePopup: () => false, maybeShowRemoveMenu: vi.fn(async () => {}) });
 plugin.bindPdfDocumentInteractions(doc);
 const right = {};
 const view = { file: { path: 'paper.pdf' }, containerEl: { ownerDocument: doc, contains: (node: unknown) => node === anchor || node === focus }, getToolbarRightElement: () => right };
 const capture = { file: view.file, path: view.file.path, pdfView: view };
 const ctx = { capture, pdfView: view, range, segments: [{}], text: 'Selected passage' };
 plugin.selectionAtPress = { anchorNode: anchor, anchorOffset: 1, focusNode: focus, focusOffset: 3, text: 'Sel' };
 plugin.lastPdfClick = { capture }; plugin.annotationToolbars.set(right, { highlighting: true, colorId: plugin.settings.colors[0]!.id });
 plugin.trySelectionContext = vi.fn(() => selection.isCollapsed ? null : ctx);
 plugin.paintSelectionOverlay = vi.fn(); plugin.isCapturedPdfCurrent = vi.fn(() => true);
 plugin.performHighlight = vi.fn(async () => { selection.isCollapsed = true; });
 const fire = (name: string, event: any = {}, target: unknown = doc) => listeners.get(target)!.get(name)!(event);
 const release = () => fire('pointerup', { pointerType: 'touch', pointerId: 1, clientX: 20, clientY: 30 });
 const flush = () => { const queued = [...frames.values()]; frames.clear(); for (const frame of queued) frame(0); };
 return { plugin, selection, range, doc, view, ctx, capture, win, frames, cleanups, fire, release, flush, right };
}

it('commits one changed native handle selection on actual release in Highlight mode, preserving its original capture', async () => {
 const f = fixture(); await f.release(); await vi.runAllTimersAsync();
 expect(f.plugin.performHighlight).toHaveBeenCalledOnce(); expect(f.plugin.performHighlight.mock.calls[0]![0]).toBe(f.ctx);
 expect(f.plugin.recordPdfPress).not.toHaveBeenCalled(); expect(f.plugin.lastTouchPressPoint).toBeNull();
});

it.each(['Select', 'unchanged', 'stale', 'multitouch'])('does not commit a %s native selection', async reason => {
 const f = fixture();
 if (reason === 'Select') f.plugin.annotationToolbars.get(f.right).highlighting = false;
 if (reason === 'unchanged') { f.selection.focusOffset = 3; f.plugin.selectionAtPress.text = f.selection.toString(); }
 if (reason === 'stale') f.plugin.isCapturedPdfCurrent.mockReturnValue(false);
 if (reason === 'multitouch') { f.plugin.activePointers.add(1); f.plugin.activePointers.add(2); f.plugin.isMultiTouchGesture = true; }
 await f.release(); await vi.runAllTimersAsync(); expect(f.plugin.performHighlight).not.toHaveBeenCalled();
});

it.each(['Select mode', 'no commit request', 'unchanged endpoints'])('keeps a shallow native selection without full capture for %s', async reason => {
 const f = fixture();
 f.plugin.trySelectionContext = vi.fn(() => f.ctx);
 f.plugin.paintSelectionOverlay = vi.fn();
 f.selection.toString = vi.fn(() => 'Selected passage');
 if (reason === 'Select mode') f.plugin.annotationToolbars.get(f.right).highlighting = false;
 if (reason === 'no commit request') { f.plugin.selectionAtPress = null; vi.mocked(getActivePdfView).mockReturnValue(f.view as never); }
 if (reason === 'unchanged endpoints') f.plugin.selectionAtPress = {
  anchorNode: f.selection.anchorNode, anchorOffset: f.selection.anchorOffset,
  focusNode: f.selection.focusNode, focusOffset: f.selection.focusOffset,
 };

 await f.plugin.updateSelectionMenu(reason === 'no commit request' ? null : f.capture);

 expect(f.plugin.trySelectionContext).not.toHaveBeenCalled();
 expect(f.selection.toString).not.toHaveBeenCalled();
 expect(f.selection.isCollapsed).toBe(false);
 expect(f.selection.getRangeAt).toHaveBeenCalled();
 expect(f.plugin.paintSelectionOverlay).toHaveBeenCalledWith(f.view, f.range);
 expect(f.plugin.performHighlight).not.toHaveBeenCalled();
});

it('captures the full selection only for a changed selection that will commit in Highlight mode', async () => {
 const f = fixture();
 f.plugin.paintSelectionOverlay = vi.fn();
 await f.plugin.updateSelectionMenu(f.capture);
 expect(f.plugin.trySelectionContext).toHaveBeenCalledOnce();
 expect(f.plugin.performHighlight).toHaveBeenCalledOnce();
});

it('keeps touch-away clearing and annotation-click menus on the shallow selection path', async () => {
 const f = fixture();
 f.plugin.trySelectionContext = vi.fn(() => f.ctx);
 f.plugin.paintSelectionOverlay = vi.fn();
 f.plugin.refreshSelectionOverlay = vi.fn();
 f.plugin.hideActiveMenu = vi.fn();
 f.plugin.maybeShowRemoveMenu = vi.fn(async () => {});
 delete f.plugin.touchPressLandedOutside;
 f.plugin.lastTouchPressPoint = { x: 100, y: 100 };
 f.selection.removeAllRanges = vi.fn(() => { f.selection.isCollapsed = true; f.selection.rangeCount = 0; });

 await f.plugin.updateSelectionMenu(f.capture);

 expect(f.plugin.trySelectionContext).not.toHaveBeenCalled();
 expect(f.selection.removeAllRanges).toHaveBeenCalledOnce();
 expect(f.plugin.hideActiveMenu).toHaveBeenCalledOnce();
 expect(f.plugin.maybeShowRemoveMenu).toHaveBeenCalledOnce();
});

it('coalesces scroll and native selection events into one visual frame, then cancels on document teardown', () => {
 const f = fixture(); f.plugin.refreshSelectionOverlay = vi.fn();
 f.fire('selectionchange'); f.fire('scroll'); f.fire('selectionchange');
 expect(f.plugin.refreshSelectionOverlay).not.toHaveBeenCalled(); expect(f.frames.size).toBe(1);
 f.flush(); expect(f.plugin.refreshSelectionOverlay).toHaveBeenCalledOnce();
 f.fire('selectionchange'); const staleFrame = [...f.frames.values()][0]!; for (const cleanup of f.cleanups) cleanup();
 staleFrame(0); f.flush(); expect(f.plugin.refreshSelectionOverlay).toHaveBeenCalledOnce(); expect(f.frames.size).toBe(0);
 expect(vi.mocked(createSelectionOverlay).mock.results.at(-1)!.value.destroy).toHaveBeenCalledOnce();
});

it('leaves Pencil selectionchange painting to its gesture batch', () => {
 const f = fixture(); f.plugin.refreshSelectionOverlay = vi.fn(); f.plugin.pencilGesture = {};
 f.fire('selectionchange'); expect(f.frames.size).toBe(0); expect(f.plugin.refreshSelectionOverlay).not.toHaveBeenCalled();
});

it('does not commit from selectionchange silence or a swallowed/cancelled handle event', async () => {
 const f = fixture(); f.plugin.refreshSelectionOverlay = vi.fn();
 f.fire('selectionchange'); f.flush(); await vi.advanceTimersByTimeAsync(1000);
 expect(f.plugin.performHighlight).not.toHaveBeenCalled();
 f.fire('pointercancel', { pointerType: 'touch', pointerId: 1 }); await vi.runAllTimersAsync();
 expect(f.plugin.performHighlight).not.toHaveBeenCalled();
});

it('cancels a queued visual frame immediately when a committed selection clears', () => {
 const f = fixture(); f.fire('selectionchange'); expect(f.frames.size).toBe(1);
 delete f.plugin.paintSelectionOverlay;
 f.plugin.paintSelectionOverlay(null);
 expect(f.frames.size).toBe(0);
 expect(vi.mocked(createSelectionOverlay).mock.results.at(-1)!.value.update).toHaveBeenLastCalledWith([]);
});

it('cancels visual work during plugin unload and ignores later native events', () => {
 const f = fixture(); f.plugin.annotationToolbars.clear(); f.plugin.refreshSelectionOverlay = vi.fn();
 f.fire('selectionchange'); expect(f.frames.size).toBe(1);
 f.plugin.onunload(); f.flush(); f.fire('selectionchange');
 expect(f.frames.size).toBe(0); expect(f.plugin.refreshSelectionOverlay).not.toHaveBeenCalled();
});

it('keeps full quote and fragment capture for actual annotation saving', () => {
 const f = fixture(); delete f.plugin.trySelectionContext;
 const node = Object.assign(f.selection.anchorNode, { nodeType: 3, data: 'Selected passage', isConnected: true, parentElement: null as any });
 const layer = { matches: () => true, contains: (value: unknown) => value === layer || value === node, getBoundingClientRect: () => ({ left: 10, top: 20 }) };
 node.parentElement = { closest: () => layer };
 const nativeRects = [{ left: 30, top: 40, right: 130, bottom: 60, width: 100, height: 20 }];
 const nodeRange = { selectNodeContents: vi.fn(), setStart: vi.fn(), setEnd: vi.fn(), getClientRects: vi.fn(() => nativeRects) };
 const range = { startContainer: node, endContainer: node, commonAncestorContainer: node, intersectsNode: () => true, compareBoundaryPoints: () => 0, toString: () => node.data };
 Object.assign(f.doc, { createRange: vi.fn(() => nodeRange) });
 Object.assign(f.win, { NodeFilter: { SHOW_TEXT: 4 }, Range: { START_TO_START: 0, END_TO_END: 2 } });
 Object.assign(f.selection, { rangeCount: 1, getRangeAt: () => range });
 Object.assign(f.view, { getPageElement: () => layer, findPageIndexForNode: () => 0, getPageViewport: () => ({ convertToPdfPoint: (x: number, y: number) => [x, y] }) });
 const captured = f.plugin.trySelectionContext(f.view);
 expect(captured.text).toBe('Selected passage'); expect(captured.segments[0].text).toBe('Selected passage');
 expect(captured.segments[0].pageLocalRects).toEqual([{ left: 20, top: 20, right: 120, bottom: 40 }]);
 expect(nodeRange.getClientRects).toHaveBeenCalledOnce(); expect(nodeRange.selectNodeContents).toHaveBeenCalledWith(node);
 // A mismatch between captured fragment text and the native selection is rejected.
 range.toString = () => 'Different text'; expect(f.plugin.trySelectionContext(f.view)).toBeNull();
});

it('visits only the selected text nodes between normal Text endpoints', () => {
 const f = fixture(); delete f.plugin.trySelectionContext;
 const nodeCount = 10_000; const startIndex = 5_000; const endIndex = startIndex + 2;
 let nodes: any[] = [];
 const layer = {
  matches: () => true, isConnected: true,
  contains: (value: unknown) => value === layer || nodes.some(node => node === value || node.parentElement === value),
  getBoundingClientRect: () => ({ left: 0, top: 0 }),
 };
 nodes = Array.from({ length: nodeCount }, (_, index) => {
  const data = index === startIndex ? 'start' : index === endIndex ? 'ending' : index === startIndex + 1 ? 'middle' : `node-${index}`;
  const span = { closest: () => layer };
  return { nodeType: 3, data, textContent: data, isConnected: true, ownerDocument: f.doc, parentElement: span };
 });
 const visited: unknown[] = [];
 let walkerNextCalls = 0;
 f.doc.createTreeWalker = vi.fn((root: Node) => {
  let currentNode: Node = root;
  return {
   get currentNode() { return currentNode; },
   set currentNode(node: Node) { currentNode = node; },
   nextNode: vi.fn(() => {
    walkerNextCalls++;
    const index = currentNode === root ? 0 : nodes.indexOf(currentNode as never) + 1;
    currentNode = nodes[index] ?? root;
    return nodes[index] ?? null;
   }),
  } as unknown as TreeWalker;
 });
 Object.assign(f.win, { NodeFilter: { SHOW_TEXT: 4 }, Range: { START_TO_START: 0, END_TO_END: 2 } });
 let measuredNode: any = null;
 f.doc.createRange = vi.fn(() => ({
  selectNodeContents: (node: unknown) => { measuredNode = node; },
  setStart: vi.fn(), setEnd: vi.fn(),
  getClientRects: () => [{ left: 10, top: 50, right: 30, bottom: 60, width: 20, height: 10 }],
  get node() { return measuredNode; },
 } as unknown as Range));
 const range = {
  startContainer: nodes[startIndex], endContainer: nodes[endIndex], commonAncestorContainer: layer,
  startOffset: 2, endOffset: 2, collapsed: false,
  intersectsNode: vi.fn((node: Node) => { visited.push(node); return nodes.indexOf(node as never) >= startIndex && nodes.indexOf(node as never) <= endIndex; }),
  compareBoundaryPoints: (how: number, nodeRange: Range) => {
   const index = nodes.indexOf((nodeRange as any).node);
   return how === 0 ? (index === startIndex ? 1 : -1) : (index === endIndex ? -1 : 1);
  },
  toString: () => 'artmiddleen',
 };
 Object.assign(f.selection, { anchorNode: nodes[startIndex], focusNode: nodes[endIndex], rangeCount: 1, getRangeAt: () => range, toString: () => 'artmiddleen' });
 Object.assign(layer, { ownerDocument: f.doc });
 Object.assign(f.view, {
  getPageElement: () => layer,
  findPageIndexForNode: (node: unknown) => node === layer || nodes.includes(node as never) ? 0 : null,
  getPageViewport: () => ({ convertToPdfPoint: (x: number, y: number) => [x, y] }),
 });
 f.view.containerEl.contains = (node: unknown) => node === layer || nodes.includes(node as never) || nodes.some(text => text.parentElement === node);

 const captured = f.plugin.trySelectionContext(f.view);

 expect(captured?.text).toBe('artmiddleen');
 expect(captured?.segments[0]?.text).toBe('artmiddleen');
 expect(visited).toHaveLength(3);
 expect(visited).toEqual(nodes.slice(startIndex, endIndex + 1));
 expect(walkerNextCalls).toBe(2);
});

it('clears the committed visual overlay before an annotation save finishes', async () => {
 const f = fixture(); delete f.plugin.performHighlight; delete f.plugin.paintSelectionOverlay;
 Object.assign(f.win, { addEventListener() {}, removeEventListener() {} });
 Object.assign(f.selection, { removeAllRanges: vi.fn(() => { f.selection.isCollapsed = true; }) });
 const textLayer = { isConnected: false, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
 f.ctx.segments = [{ pageIndex: 0, textLayer, pageLocalRects: [{ left: 20, top: 30, right: 120, bottom: 50 }], viewport: { convertToPdfPoint: (x: number, y: number) => [x, y] } }] as any;
 let finish!: () => void;
 f.plugin.mutateCapturedPdf = vi.fn(() => new Promise(resolve => { finish = () => resolve({ changed: true }); }));
 f.fire('selectionchange'); expect(f.frames.size).toBe(1);
 const saving = f.plugin.performHighlight(f.ctx, { r: 1, g: 1, b: 0 });
 expect(f.selection.removeAllRanges).toHaveBeenCalledOnce(); expect(f.frames.size).toBe(0);
 expect(vi.mocked(createSelectionOverlay).mock.results.at(-1)!.value.update).toHaveBeenLastCalledWith([]);
 finish(); await saving;
});

it('keeps reversed native handle selection eligible through the same owned release path', async () => {
 const f = fixture(); const anchor = f.selection.anchorNode; f.selection.anchorNode = f.selection.focusNode; f.selection.focusNode = anchor;
 await f.release(); await vi.runAllTimersAsync(); expect(f.plugin.performHighlight).toHaveBeenCalledOnce(); expect(f.plugin.recordPdfPress).not.toHaveBeenCalled();
});

it('clears a collapsed selection before consulting a potentially loading native PDF viewer', () => {
 const f = fixture(); f.selection.isCollapsed = true;
 vi.mocked(getActivePdfView).mockImplementation(() => { throw new Error('PDF viewer is not ready'); });
 f.plugin.refreshSelectionOverlay();
 expect(getActivePdfView).not.toHaveBeenCalled();
 expect(vi.mocked(createSelectionOverlay).mock.results.at(-1)!.value.update).toHaveBeenLastCalledWith([]);
});

it('clears the optional preview when the selected native PDF viewer is still loading', () => {
 const f = fixture(); Object.assign(f.selection, { rangeCount: 1 });
 vi.mocked(getActivePdfView).mockImplementation(() => { throw new Error('PDF viewer is not ready'); });
 expect(() => f.plugin.refreshSelectionOverlay()).not.toThrow();
 expect(getActivePdfView).toHaveBeenCalledOnce();
 expect(vi.mocked(createSelectionOverlay).mock.results.at(-1)!.value.update).toHaveBeenLastCalledWith([]);
});
