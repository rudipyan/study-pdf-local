interface StreamLifetimeCallbacks {
	onComplete: () => void;
	onUnobservable: () => void;
}

/** Observe the native text-layer reader without locking, reading, or buffering
 * its stream. Unknown consumption stays retained until the document closes. */
export function observePdfStreamLifetime(
	value: unknown,
	{ onComplete, onUnobservable }: StreamLifetimeCallbacks,
): (() => void) | null {
	let finished = false;
	let unobservable = false;
	let cancellations = 0;
	const failClosed = () => {
		if (finished || unobservable) return;
		unobservable = true;
		onUnobservable();
	};
	const finish = () => {
		if (finished || unobservable || cancellations > 0) return;
		finished = true;
		onComplete();
	};
	const cancel = (original: (...args: unknown[]) => Promise<void>, receiver: unknown, args: unknown[]) => {
		cancellations++;
		try {
			const result = original.apply(receiver, args);
			void result.then(() => { cancellations--; finish(); }, () => { cancellations--; failClosed(); });
			return result;
		} catch (error) {
			cancellations--;
			failClosed();
			throw error;
		}
	};
	if (!value || typeof value !== 'object') { failClosed(); return null; }
	const stream = value as ReadableStream<unknown>;
	// Keep native method identities and explicitly supply the calling receiver.
	// eslint-disable-next-line @typescript-eslint/unbound-method -- All calls below use .apply(this, args).
	const originalGetReader = stream.getReader;
	// eslint-disable-next-line @typescript-eslint/unbound-method -- All calls below use .apply(this, args).
	const originalCancel = stream.cancel;
	if (typeof originalGetReader !== 'function' || typeof originalCancel !== 'function' || stream.locked !== false) {
		failClosed();
		return null;
	}
	const getReader = function (this: ReadableStream<unknown>, ...args: Parameters<typeof originalGetReader>) {
		const reader = originalGetReader.apply(this, args);
		if (this !== stream || finished || unobservable) return reader;
		let released = false;
		try {
			// eslint-disable-next-line @typescript-eslint/unbound-method -- The wrapper preserves the calling receiver.
			const releaseLock = reader.releaseLock;
			// eslint-disable-next-line @typescript-eslint/unbound-method -- cancel() calls this with the original receiver.
			const readerCancel = reader.cancel;
			const closed = reader.closed;
			const release = function (this: typeof reader) {
				const result = releaseLock.call(this);
				if (this === reader) released = true;
				return result;
			};
			const trackedCancel = function (this: typeof reader, ...cancelArgs: Parameters<typeof readerCancel>) {
				if (this !== reader) return readerCancel.apply(this, cancelArgs);
				return cancel(readerCancel, this, cancelArgs);
			};
			reader.releaseLock = release;
			reader.cancel = trackedCancel;
			if (reader.releaseLock !== release || reader.cancel !== trackedCancel) { failClosed(); return reader; }
			// Cancellation closes the reader before underlying work has settled.
			// A releaseLock rejection, in contrast, does not finish the stream.
			void closed.then(finish, () => { if (!released) finish(); });
		} catch {
			failClosed();
		}
		return reader;
	};
	const trackedCancel = function (this: ReadableStream<unknown>, ...args: Parameters<typeof originalCancel>) {
		if (this !== stream || this.locked) return originalCancel.apply(this, args);
		return cancel(originalCancel, this, args);
	};
	const getReaderDescriptor = Object.getOwnPropertyDescriptor(stream, 'getReader');
	const cancelDescriptor = Object.getOwnPropertyDescriptor(stream, 'cancel');
	const restore = () => {
		failClosed();
		for (const [name, tracked, descriptor] of [
			['getReader', getReader, getReaderDescriptor], ['cancel', trackedCancel, cancelDescriptor],
		] as const) {
			if (stream[name] !== tracked) continue;
			if (descriptor) Object.defineProperty(stream, name, descriptor);
			else Reflect.deleteProperty(stream, name);
		}
	};
	try {
		stream.getReader = getReader as typeof stream.getReader;
		stream.cancel = trackedCancel;
		if (stream.getReader !== getReader || stream.cancel !== trackedCancel) throw new Error('Unwritable PDF text stream');
	} catch {
		restore();
		return null;
	}
	return restore;
}
