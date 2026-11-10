import { afterEach, expect, it, vi } from 'vitest';
import { watchPdfDocumentRetirement } from '../src/pdf-document-retirement';

afterEach(() => vi.useRealTimers());

it('coalesces native completion events and idle signals, then unregisters on disposal', async () => {
	vi.useFakeTimers();
	const listeners = new Map<string, () => void>();
	const bus = { _on: (name: string, fn: () => void) => listeners.set(name, fn), _off: (name: string) => listeners.delete(name) };
	let idle = true;
	const sweep = vi.fn();
	const watcher = watchPdfDocumentRetirement(bus, () => idle, sweep);
	listeners.get('pagerendered')!();
	listeners.get('thumbnailrendered')!();
	watcher.schedule();
	expect(sweep).not.toHaveBeenCalled();
	await vi.runAllTimersAsync();
	expect(sweep).toHaveBeenCalledOnce();
	idle = false;
	listeners.get('textlayerrendered')!();
	expect(vi.getTimerCount()).toBe(0);
	idle = true;
	watcher.schedule();
	watcher.dispose();
	await vi.runAllTimersAsync();
	expect(sweep).toHaveBeenCalledOnce();
	expect(listeners.size).toBe(0);
});

it('waits for 250ms of quiet across asynchronous render completions and rechecks eligibility', () => {
 vi.useFakeTimers(); const listeners = new Map<string, () => void>();
 let eligible = true; const sweep = vi.fn();
 const watcher = watchPdfDocumentRetirement({ _on: (n, fn) => listeners.set(n, fn), _off: n => { listeners.delete(n); } }, () => eligible, sweep);
 listeners.get('pagerendered')!(); vi.advanceTimersByTime(200);
 listeners.get('annotationlayerrendered')!(); vi.advanceTimersByTime(200);
 expect(sweep).not.toHaveBeenCalled(); vi.advanceTimersByTime(50); expect(sweep).toHaveBeenCalledOnce();
 watcher.schedule(); eligible = false; vi.advanceTimersByTime(250); expect(sweep).toHaveBeenCalledOnce();
 eligible = true; watcher.schedule(); watcher.dispose(); vi.runAllTimers(); expect(sweep).toHaveBeenCalledOnce();
});
