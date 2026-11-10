import { expect, it, vi } from 'vitest';
import { createSelectionOverlay, liveSelectionOverlayRects } from '../src/ui/selection-overlay';

const bounds = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
function fixture(pages = 1) {
 const doc = { documentElement: {}, createTreeWalker: vi.fn(() => { throw new Error('No text traversal during live paint'); }), createRange: vi.fn(() => { throw new Error('No per-node ranges'); }), defaultView: { innerWidth: 800, innerHeight: 400, visualViewport: { offsetLeft: 0, offsetTop: 0, width: 800, height: 400 }, getComputedStyle: () => ({ overflowX: 'hidden', overflowY: 'hidden' }) } };
 const ancestor = { parentElement: doc.documentElement, clientLeft: 0, clientTop: 0, clientWidth: 700, clientHeight: 400, getBoundingClientRect: () => bounds(0, 0, 700, 400) };
 const scroll = { parentElement: ancestor, ownerDocument: doc, clientLeft: 0, clientTop: 0, clientWidth: 800, clientHeight: 350, getBoundingClientRect: () => bounds(0, 50, 800, 350) };
 const layers = Array.from({ length: pages }, (_, pageIndex) => ({ pageIndex, isConnected: true, ownerDocument: doc, matches: () => true, querySelector: () => null, contains: (node: unknown) => node === layers[pageIndex] || nodes[pageIndex] === node, getBoundingClientRect: () => bounds(0, 0, 800, 800), childNodes: [{}, {}] }));
 const nodes = layers.map(layer => ({ nodeType: 3, isConnected: true, ownerDocument: doc, parentElement: { closest: () => layer } }));
 const pane = { ownerDocument: doc, contains: (node: unknown) => nodes.includes(node as never) || layers.includes(node as never) || node === scroll, getBoundingClientRect: () => bounds(0, 0, 800, 400), querySelector: () => ({ getBoundingClientRect: () => bounds(0, 0, 800, 80) }) };
 const range = { startContainer: nodes[0]!, endContainer: nodes[pages - 1]!, collapsed: false, getClientRects: vi.fn(() => [bounds(-10, 60, 900, 40)]), cloneRange: vi.fn() };
 const view = { containerEl: pane, getPdfScrollElement: () => scroll, findPageIndexForNode: (node: unknown) => { const i = nodes.indexOf(node as never); return i >= 0 ? i : layers.indexOf(node as never); }, getPageElement: (i: number) => layers[i] ?? null };
 return { doc, scroll, range, view, nodes, layers, ancestor };
}

it('paints owned native range rectangles clipped below the toolbar and inside the pane without text capture', () => {
 const f = fixture();
 expect(liveSelectionOverlayRects(f.view as never, f.range as never)).toEqual([{ left: 0, top: 80, width: 700, height: 20 }]);
 expect(f.range.getClientRects).toHaveBeenCalledOnce(); expect(f.doc.createTreeWalker).not.toHaveBeenCalled(); expect(f.doc.createRange).not.toHaveBeenCalled();
});

it('intersects the visual viewport while preserving fixed viewport coordinates', () => {
 const f = fixture(); Object.assign(f.doc.defaultView.visualViewport, { offsetLeft: 100, offsetTop: 90, width: 450, height: 200 });
 expect(liveSelectionOverlayRects(f.view as never, f.range as never)).toEqual([{ left: 100, top: 90, width: 450, height: 10 }]);
});

it.each(['collapsed', 'detached', 'foreign', 'missing-layer', 'replaced-layer'])('clears %s selections without native rectangle reads', reason => {
 const f = fixture();
 if (reason === 'collapsed') f.range.collapsed = true;
 if (reason === 'detached') f.nodes[0]!.isConnected = false;
 if (reason === 'foreign') f.view.containerEl.contains = () => false;
 if (reason === 'missing-layer') f.nodes[0]!.parentElement.closest = () => null as never;
 if (reason === 'replaced-layer') f.view.getPageElement = () => null;
 expect(liveSelectionOverlayRects(f.view as never, f.range as never)).toEqual([]); expect(f.range.getClientRects).not.toHaveBeenCalled();
});

it('uses text-layer subranges for multiple pages instead of page-sized parent range boxes', () => {
 const f = fixture(2); const perPage = [bounds(10, 100, 200, 20), bounds(20, 140, 100, 20)];
 const clones: { setStart: ReturnType<typeof vi.fn>; setEnd: ReturnType<typeof vi.fn>; getClientRects: ReturnType<typeof vi.fn> }[] = [];
 f.range.cloneRange.mockImplementation(() => { const clone = { setStart: vi.fn(), setEnd: vi.fn(), getClientRects: vi.fn(() => [perPage[clones.length - 1]]) }; clones.push(clone); return clone; });
 expect(liveSelectionOverlayRects(f.view as never, f.range as never)).toEqual(perPage.map(({ left, top, width, height }) => ({ left, top, width, height })));
 expect(f.range.getClientRects).not.toHaveBeenCalled(); expect(clones).toHaveLength(2);
 expect(clones[0]!.setEnd).toHaveBeenCalledWith(f.layers[0], 2); expect(clones[1]!.setStart).toHaveBeenCalledWith(f.layers[1], 0);
 expect(f.doc.createTreeWalker).not.toHaveBeenCalled();
});

it('reuses painted rectangle nodes and clears their temporary Pencil color when native selection resumes', () => {
 const children: any[] = []; const make = () => { const child = { style: { backgroundColor: '' }, setCssStyles: vi.fn(), remove: vi.fn(() => children.splice(children.indexOf(child), 1)) }; children.push(child); return child; };
 const element = { createDiv: vi.fn(make), empty: vi.fn(() => { children.length = 0; }), remove: vi.fn() };
 const overlay = createSelectionOverlay({ body: { createDiv: () => element } } as never);
 overlay.update([bounds(1, 2, 30, 10)], '#ff0000'); const first = children[0];
 overlay.update([bounds(4, 5, 30, 10)]); expect(children[0]).toBe(first); expect(element.createDiv).toHaveBeenCalledOnce(); expect(first.style.backgroundColor).toBe('');
 overlay.update([]); expect(children).toHaveLength(0); overlay.destroy(); expect(element.remove).toHaveBeenCalledOnce();
});

it('skips offscreen selected pages before sentinel and native range reads', () => {
 const f = fixture(100);
 const sentinelReads = f.layers.map(layer => { const read = vi.fn(() => null); layer.querySelector = read; return read; });
 f.layers.forEach((layer, index) => { layer.getBoundingClientRect = () => bounds(0, index * 500, 800, 300); });
 const nativeReads: ReturnType<typeof vi.fn>[] = [];
 f.range.cloneRange.mockImplementation(() => {
  const nativeRead = vi.fn(() => [bounds(10, 100, 100, 20)]); nativeReads.push(nativeRead);
  return { setStart: vi.fn(), setEnd: vi.fn(), intersectsNode: () => false, getClientRects: nativeRead };
 });

	 expect(liveSelectionOverlayRects(f.view as never, f.range as never)).toEqual([{ left: 10, top: 100, width: 100, height: 20 }]);
 expect(f.range.cloneRange).toHaveBeenCalledOnce();
 expect(nativeReads).toHaveLength(1); expect(nativeReads[0]).toHaveBeenCalledOnce();
 expect(sentinelReads.filter(read => read.mock.calls.length > 0)).toEqual([sentinelReads[0]]);
});

it('avoids repeated style writes for identical normalized geometry and color', () => {
 const children: any[] = []; const colors: string[] = [];
 const make = () => {
  const child = { setCssStyles: vi.fn(), remove: vi.fn(() => children.splice(children.indexOf(child), 1)), style: {} as any };
  Object.defineProperty(child.style, 'backgroundColor', { set: (value: string) => colors.push(value) });
  children.push(child); return child;
 };
 const element = { createDiv: vi.fn(make), remove: vi.fn() };
 const overlay = createSelectionOverlay({ body: { createDiv: () => element } } as never);
 const geometry = [bounds(1, 2, 30, 10)];

 overlay.update(geometry, '#ff0000'); const first = children[0];
 overlay.update(geometry, '#ff0000');
 expect(first.setCssStyles).toHaveBeenCalledOnce(); expect(colors).toEqual(['#ff0000']);

 overlay.update(geometry);
 expect(first.setCssStyles).toHaveBeenCalledOnce(); expect(colors).toEqual(['#ff0000', '']);
 overlay.update([]); expect(children).toHaveLength(0); overlay.destroy();
});

it.each([{ pages: 1, placement: 'trailing' }, { pages: 1, placement: 'middle' }, { pages: 2, placement: 'trailing' }, { pages: 2, placement: 'middle' }, { pages: 1, placement: 'nested' }, { pages: 2, placement: 'nested' }])('excludes a full-page $placement sentinel across $pages layers while retaining text on both sides', ({ pages, placement }) => {
 const f = fixture(pages);
 const textRects = [bounds(20, 100, 150, 20), bounds(20, 140, 150, 20)];
 const sentinels = f.layers.map(() => ({}));
 const models = f.layers.map((layer, index) => {
  const children = placement !== 'trailing' ? [{ rect: textRects[index] }, sentinels[index], { rect: bounds(200, 100 + index * 40, 80, 20) }] : [{ rect: textRects[index] }, sentinels[index]];
  const nested = placement === 'nested';
  const markedContent = { childNodes: children };
  Object.assign(layer, { childNodes: nested ? [markedContent] : children, querySelector: (selector: string) => nested && selector.startsWith(':scope >') ? null : sentinels[index] });
  const sentinelIndex = children.indexOf(sentinels[index]);
  const makeRange = (start = 0, end = children.length): any => ({
   cloneRange: () => makeRange(start, end),
   setStart: (_node: unknown, value: number) => { start = value; if (end < start) end = start; },
   setEnd: (node: unknown, value: number) => { end = nested && node === layer && value === 1 ? children.length : value; if (start > end) start = end; },
   intersectsNode: () => start < sentinelIndex + 1 && end > sentinelIndex,
   setEndBefore: () => { end = sentinelIndex; if (start > end) start = end; },
   setStartAfter: () => { start = sentinelIndex + 1; if (end < start) end = start; },
   getClientRects: vi.fn(() => children.slice(start, end).map(child => child === sentinels[index] ? bounds(0, 0, 800, 800) : (child as { rect: ReturnType<typeof bounds> }).rect)),
  });
  return { makeRange, children };
 });
 if (pages === 1) Object.assign(f.range, models[0]!.makeRange());
 else { let page = 0; f.range.cloneRange.mockImplementation(() => models[page++]!.makeRange()); }
 const expected = models.flatMap(model => model.children.filter(child => 'rect' in child!).map(child => (child as { rect: ReturnType<typeof bounds> }).rect));
 expect(liveSelectionOverlayRects(f.view as never, f.range as never)).toEqual(expected.map(({ left, top, width, height }) => ({ left, top, width, height })));
 expect(f.range.getClientRects).not.toHaveBeenCalled(); expect(f.doc.createTreeWalker).not.toHaveBeenCalled();
});
