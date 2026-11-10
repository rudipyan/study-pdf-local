import { describe, expect, it, vi } from 'vitest';
import { observePdfStreamLifetime } from '../src/pdf-stream-lifetime';

function createStream(options: {
	start?: (controller: ReadableStreamDefaultController<string>) => void;
	pull?: (controller: ReadableStreamDefaultController<string>) => void | Promise<void>;
	cancel?: (reason: unknown) => void | Promise<void>;
} = {}) {
	let controller!: ReadableStreamDefaultController<string>;
	const stream = new ReadableStream<string>({
		start(value) {
			controller = value;
			options.start?.(value);
		},
		pull(value) {
			return options.pull?.(value);
		},
		cancel(reason) {
			return options.cancel?.(reason);
		},
	}, { highWaterMark: 0 });
	return { stream, controller: () => controller };
}

function observe(stream: unknown, onComplete = vi.fn(), onUnobservable = vi.fn()) {
	const restore = observePdfStreamLifetime(stream, { onComplete, onUnobservable });
	return { restore, onComplete, onUnobservable };
}

async function flushPromises() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe('PDF direct stream lifetime observation', () => {
	it('does not acquire a reader or pull while observing and preserves the native stream', () => {
		let pulls = 0;
		const { stream } = createStream({ pull: () => { pulls++; } });
		const nativeGetReader = stream.getReader;
		let getReaderCalls = 0;
		stream.getReader = function (...args) {
			getReaderCalls++;
			return nativeGetReader.apply(this, args);
		};

		const observation = observe(stream);

		expect(observation.restore).toEqual(expect.any(Function));
		expect(stream).toBeInstanceOf(ReadableStream);
		expect(stream.locked).toBe(false);
		expect(getReaderCalls).toBe(0);
		expect(pulls).toBe(0);
		expect(observation.onComplete).not.toHaveBeenCalled();
	});

	it('waits for a default reader to exhaust the stream and finishes once', async () => {
		const { stream, controller } = createStream({ start: (value) => value.enqueue('chunk') });
		const observation = observe(stream);
		const reader = stream.getReader();

		await expect(reader.read()).resolves.toEqual({ value: 'chunk', done: false });
		expect(observation.onComplete).not.toHaveBeenCalled();
		controller().close();
		await expect(reader.read()).resolves.toEqual({ value: undefined, done: true });
		await flushPromises();
		await reader.closed;

		expect(observation.onComplete).toHaveBeenCalledOnce();
		expect(observation.onUnobservable).not.toHaveBeenCalled();
	});

	it('keeps unread and in-flight streams alive until they close', async () => {
		let resolvePull!: () => void;
		const pull = new Promise<void>((resolve) => { resolvePull = resolve; });
		const { stream, controller } = createStream({ pull: () => pull });
		const observation = observe(stream);
		const reader = stream.getReader();
		const read = reader.read();

		await flushPromises();
		expect(observation.onComplete).not.toHaveBeenCalled();
		resolvePull();
		controller().enqueue('partial');
		await expect(read).resolves.toEqual({ value: 'partial', done: false });
		expect(observation.onComplete).not.toHaveBeenCalled();
		controller().close();
		await expect(reader.read()).resolves.toEqual({ value: undefined, done: true });
		await flushPromises();
		expect(observation.onComplete).toHaveBeenCalledOnce();
	});

	it('treats a native stream error as terminal', async () => {
		const { stream, controller } = createStream();
		const observation = observe(stream);
		const reader = stream.getReader();
		const failure = new Error('source failed');
		controller().error(failure);

		await expect(reader.read()).rejects.toBe(failure);
		await expect(reader.closed).rejects.toBe(failure);
		await flushPromises();
		expect(observation.onComplete).toHaveBeenCalledOnce();
	});

	it('ignores releaseLock rejection and observes a reacquired reader', async () => {
		const { stream, controller } = createStream({ start: (value) => value.enqueue('first') });
		const observation = observe(stream);
		const firstReader = stream.getReader();
		await expect(firstReader.read()).resolves.toEqual({ value: 'first', done: false });
		firstReader.releaseLock();
		await expect(firstReader.closed).rejects.toBeInstanceOf(TypeError);
		await flushPromises();
		expect(observation.onComplete).not.toHaveBeenCalled();

		const secondReader = stream.getReader();
		controller().close();
		await expect(secondReader.read()).resolves.toEqual({ value: undefined, done: true });
		await secondReader.closed;
		await flushPromises();
		expect(observation.onComplete).toHaveBeenCalledOnce();
	});

	it('holds completion until a delayed reader cancellation resolves', async () => {
		let resolveCancel!: () => void;
		const cancellation = new Promise<void>((resolve) => { resolveCancel = resolve; });
		const { stream } = createStream({ cancel: () => cancellation });
		const observation = observe(stream);
		const reader = stream.getReader();
		const cancel = reader.cancel('stop');

		await flushPromises();
		await reader.closed;
		expect(observation.onComplete).not.toHaveBeenCalled();
		resolveCancel();
		await cancel;
		await flushPromises();
		expect(observation.onComplete).toHaveBeenCalledOnce();
	});

	it('preserves native read and cancel promise identities', async () => {
		let nativeReadPromise: Promise<ReadableStreamReadResult<string>> | undefined;
		let nativeCancelPromise: Promise<void> | undefined;
		const { stream } = createStream({ start: (value) => value.enqueue('value') });
		const nativeGetReader = stream.getReader;
		stream.getReader = function (...args) {
			const reader = nativeGetReader.apply(this, args);
			const nativeRead = reader.read;
			const nativeCancel = reader.cancel;
			reader.read = function (...readArgs) {
				nativeReadPromise = nativeRead.apply(this, readArgs);
				return nativeReadPromise;
			};
			reader.cancel = function (reason) {
				nativeCancelPromise = nativeCancel.call(this, reason);
				return nativeCancelPromise;
			};
			return reader;
		};
		const observation = observe(stream);
		const reader = stream.getReader();
		const read = reader.read();
		expect(read).toBe(nativeReadPromise);
		await read;
		const cancel = reader.cancel();
		expect(cancel).toBe(nativeCancelPromise);
		await cancel;
		await flushPromises();
		expect(observation.onComplete).toHaveBeenCalledOnce();
	});

	it('latches a failed cancellation as unobservable', async () => {
		const failure = new Error('cancel failed');
		const { stream } = createStream({ cancel: () => Promise.reject(failure) });
		const observation = observe(stream);
		const reader = stream.getReader();

		await expect(reader.cancel()).rejects.toBe(failure);
		await flushPromises();
		expect(observation.onComplete).not.toHaveBeenCalled();
		expect(observation.onUnobservable).toHaveBeenCalledOnce();
	});

	it('does not poison a stream after its locked cancel delegates the native error', async () => {
		const { stream, controller } = createStream();
		const observation = observe(stream);
		const reader = stream.getReader();

		await expect(stream.cancel('locked')).rejects.toBeInstanceOf(TypeError);
		expect(observation.onUnobservable).not.toHaveBeenCalled();
		expect(observation.onComplete).not.toHaveBeenCalled();
		controller().close();
		await reader.read();
		await reader.closed;
		await flushPromises();
		expect(observation.onComplete).toHaveBeenCalledOnce();
	});

	it('waits for the first of multiple cancellation promises to settle', async () => {
		let resolveCancel!: () => void;
		const cancellation = new Promise<void>((resolve) => { resolveCancel = resolve; });
		const { stream } = createStream({ cancel: () => cancellation });
		const observation = observe(stream);
		const first = stream.cancel();
		const second = stream.cancel();
		await second;
		await flushPromises();
		expect(observation.onComplete).not.toHaveBeenCalled();
		resolveCancel();
		await first;
		await flushPromises();
		expect(observation.onComplete).toHaveBeenCalledOnce();
	});

	it.each(['pipeTo', 'pipeThrough', 'tee', 'asyncIterator', 'values'] as const)(
		'pins a stream used through unsupported %s consumption', async (consumer) => {
			const { stream } = createStream();
			const observation = observe(stream);
			if (consumer === 'pipeTo') {
				const destination = new WritableStream<string>({ write: () => undefined });
				void stream.pipeTo(destination).catch(() => undefined);
			} else if (consumer === 'pipeThrough') {
				const transform = new TransformStream<string, string>();
				stream.pipeThrough(transform);
			} else if (consumer === 'tee') {
				stream.tee();
			} else if (consumer === 'values') {
				stream.values();
			} else {
				stream[Symbol.asyncIterator]();
			}
			expect(observation.onComplete).not.toHaveBeenCalled();
		},
	);

	it('does not attribute a borrowed getReader receiver to the observed stream', async () => {
		const a = createStream();
		const b = createStream({ start: (value) => value.close() });
		const observation = observe(a.stream);
		const borrowedReader = a.stream.getReader.call(b.stream);
		await borrowedReader.read();
		await borrowedReader.closed;
		await flushPromises();
		expect(observation.onComplete).not.toHaveBeenCalled();
		const reader = a.stream.getReader();
		a.controller().close();
		await reader.read();
		await reader.closed;
		await flushPromises();
		expect(observation.onComplete).toHaveBeenCalledOnce();
	});

	it('does not attribute a borrowed stream cancel receiver to the observed stream', async () => {
		const a = createStream();
		const b = createStream();
		const observation = observe(a.stream);
		await a.stream.cancel.call(b.stream);
		await flushPromises();
		expect(observation.onComplete).not.toHaveBeenCalled();
		const reader = a.stream.getReader();
		a.controller().close();
		await reader.read();
		await reader.closed;
		await flushPromises();
		expect(observation.onComplete).toHaveBeenCalledOnce();
	});

	it('does not attribute borrowed reader cancel or releaseLock receivers', async () => {
		const a = createStream();
		const b = createStream({ start: (value) => value.enqueue('b') });
		const observation = observe(a.stream);
		const readerA = a.stream.getReader();
		const nativeReaderB = b.stream.getReader();
		await readerA.cancel.call(nativeReaderB, 'borrowed');
		await flushPromises();
		expect(observation.onComplete).not.toHaveBeenCalled();
		readerA.releaseLock.call(nativeReaderB);
		expect(a.stream.locked).toBe(true);
		a.controller().close();
		await readerA.read();
		await readerA.closed;
		await flushPromises();
		expect(observation.onComplete).toHaveBeenCalledOnce();
	});

	it('fails closed for unknown, locked, and frozen stream objects', () => {
		const unknown = observe({});
		expect(unknown.restore).toBeNull();
		expect(unknown.onUnobservable).toHaveBeenCalledOnce();

		const lockedStream = createStream().stream;
		const reader = lockedStream.getReader();
		const locked = observe(lockedStream);
		expect(locked.restore).toBeNull();
		expect(locked.onUnobservable).toHaveBeenCalledOnce();
		void reader.cancel();

		const frozenStream = Object.freeze(createStream().stream);
		const frozen = observe(frozenStream);
		expect(frozen.restore).toBeNull();
		expect(frozen.onUnobservable).toHaveBeenCalledOnce();
	});
});
