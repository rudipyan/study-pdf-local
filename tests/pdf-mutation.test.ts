import { describe, expect, it, vi } from 'vitest';
import {
	capturePdfPress,
	capturePdfTarget,
	findPdfViewForNode,
	isCapturedPdfCurrent,
	isCapturedPdfViewLive,
	PdfMutationCoordinator,
	resolveCapturedPdfPress,
} from '../src/pdf-mutation';
import { createVerifiedPdfBackup, type BackupFileAdapter } from '../src/pdf-backups';

describe('coordinatePdfMutation', () => {
	it('uses the no-backup path with only one fresh pre-write check and preserves output identity', async () => {
		const events: string[] = [];
		const bytes = new Uint8Array([2]);
		const read = vi.fn(async () => { events.push('read'); return new Uint8Array([1]); });
		const result = await new PdfMutationCoordinator().run('fast.pdf', {
			read,
			transform: async () => ({ bytes, value: 1 }),
			preview: (output) => { expect(output).toBe(bytes); events.push('preview'); return { dispose() { events.push('dispose'); } }; },
			write: async (output) => { expect(output).toBe(bytes); events.push('write'); },
		});
		expect(read).toHaveBeenCalledTimes(2);
		expect(result.bytes).toBe(bytes);
		expect(events).toEqual(['read', 'preview', 'read', 'write', 'dispose']);
	});
	it('rejects external edits before a no-backup write and removes its preview', async () => {
		let reads = 0;
		const write = vi.fn(); const dispose = vi.fn();
		await expect(new PdfMutationCoordinator().run('changed.pdf', {
			read: async () => new Uint8Array([++reads]),
			transform: async () => ({ bytes: new Uint8Array([9]), value: undefined }),
			preview: () => ({ dispose }), write,
		})).rejects.toThrow(/changed since/);
		expect(write).not.toHaveBeenCalled(); expect(dispose).toHaveBeenCalledOnce();
	});
	it('previews before a slow backup and removes the preview only after writing finishes', async () => {
		const events: string[] = [];
		let release!: () => void;
		let started!: () => void;
		const backupStarted = new Promise<void>((resolve) => { started = resolve; });
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const coordinator = new PdfMutationCoordinator();
		const pending = coordinator.run('slow.pdf', {
			read: async () => new Uint8Array([1]),
			transform: async () => ({ bytes: new Uint8Array([2]), value: null }),
			preview: () => { events.push('preview'); return { dispose: () => { events.push('dispose'); } }; },
			backup: async () => { events.push('backup'); started(); await gate; },
			write: async () => { events.push('write'); },
		});
		await backupStarted;
		expect(events).toEqual(['preview', 'backup']);
		let idle = false;
		const wait = coordinator.whenIdle('slow.pdf').then(() => { idle = true; });
		await Promise.resolve();
		expect(idle).toBe(false);
		release();
		await pending;
		await wait;
		expect(events).toEqual(['preview', 'backup', 'write', 'dispose']);
	});

	it('removes optimistic visuals after a failed backup without writing the source', async () => {
		let removed = false;
		let wrote = false;
		await expect(new PdfMutationCoordinator().run('fail.pdf', {
			read: async () => new Uint8Array([1]),
			transform: async () => ({ bytes: new Uint8Array([2]), value: null }),
			preview: () => ({ dispose: () => { removed = true; } }),
			backup: async () => { throw new Error('disk full'); },
			write: async () => { wrote = true; },
		})).rejects.toThrow('disk full');
		expect(removed).toBe(true);
		expect(wrote).toBe(false);
	});

	it('serializes mutations for the same normalized path and continues after a rejected operation', async () => {
		const coordinator = new PdfMutationCoordinator();
		const source = new Map<string, Uint8Array>([['papers/a.pdf', new Uint8Array([1])]]);
		const events: string[] = [];
		let releaseFirst!: () => void;
		let markFirstStarted!: () => void;
		const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
		const firstStarted = new Promise<void>((resolve) => (markFirstStarted = resolve));
		const makeDeps = (label: string, wait = false) => ({
			read: async () => {
				events.push(`${label}:read`);
				return source.get('papers/a.pdf')!.slice();
			},
			backup: async () => { events.push(`${label}:backup`); },
			write: async (bytes: Uint8Array) => {
				events.push(`${label}:write`);
				source.set('papers/a.pdf', bytes.slice());
			},
			transform: async (original: Uint8Array) => {
				events.push(`${label}:transform`);
				if (wait) markFirstStarted();
				if (wait) await firstGate;
				if (label === 'failed') throw new Error('transform failed');
				return { bytes: new Uint8Array([...original, label === 'first' ? 2 : 3]), value: label };
			},
		});

		const first = coordinator.run('papers/a.pdf', makeDeps('first', true));
		const failed = coordinator.run('papers/./a.pdf', makeDeps('failed'));
		const last = coordinator.run('papers//a.pdf', makeDeps('last'));
		await firstStarted;
		expect(events).toEqual(['first:read', 'first:transform']);
		releaseFirst();
		await expect(failed).rejects.toThrow('transform failed');
		await expect(first).resolves.toMatchObject({ changed: true, value: 'first' });
		await expect(last).resolves.toMatchObject({ changed: true, value: 'last' });
		expect(events).toEqual([
			'first:read', 'first:transform', 'first:read', 'first:backup', 'first:read', 'first:write',
			'failed:read', 'failed:transform', 'last:read', 'last:transform', 'last:read', 'last:backup',
			'last:read', 'last:write',
		]);
	});

	it('lets different paths make progress independently', async () => {
		const coordinator = new PdfMutationCoordinator();
		const events: string[] = [];
		let release!: () => void;
		let markOtherFinished!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const otherFinished = new Promise<void>((resolve) => (markOtherFinished = resolve));
		const run = (path: string, wait: boolean) => coordinator.run(path, {
			read: async () => { events.push(`${path}:read`); return new Uint8Array([1]); },
			transform: async (bytes) => {
				events.push(`${path}:transform`);
				if (wait) await gate;
				return { bytes: new Uint8Array([bytes[0]! + 1]), value: path };
			},
			backup: async () => { events.push(`${path}:backup`); },
			write: async () => {
				events.push(`${path}:write`);
				if (path === 'b.pdf') markOtherFinished();
			},
		});

		const first = run('a.pdf', true);
		const other = run('b.pdf', false);
		await otherFinished;
		expect(events).toContain('b.pdf:write');
		release();
		await Promise.all([first, other]);
	});

	it('recovers a same-path queue after its first read rejects', async () => {
		const coordinator = new PdfMutationCoordinator();
		let reads = 0;
		let writes = 0;
		const dependencies = {
			read: async () => {
				reads++;
				if (reads === 1) throw new Error('read failed');
				return new Uint8Array([1]);
			},
			transform: async () => ({ bytes: new Uint8Array([2]), value: undefined }),
			backup: async () => undefined,
			write: async () => { writes++; },
		};
		await expect(coordinator.run('read-recovers.pdf', dependencies)).rejects.toThrow('read failed');
		await expect(coordinator.run('read-recovers.pdf', dependencies)).resolves.toMatchObject({ changed: true });
		expect(reads).toBe(4);
		expect(writes).toBe(1);
	});

	it('returns byte-identical transforms without backup or write', async () => {
		const coordinator = new PdfMutationCoordinator();
		const events: string[] = [];
		const original = new Uint8Array([1, 2]);
		const result = await coordinator.run('a.pdf', {
			read: async () => original.slice(),
			transform: async (bytes) => ({ bytes, value: 'unchanged' }),
			backup: async () => { events.push('backup'); },
			write: async () => { events.push('write'); },
		});
		expect(result).toMatchObject({ changed: false, value: 'unchanged' });
		expect(result.bytes).toEqual(original);
		expect(events).toEqual([]);
	});

	it('honors an explicit no-change result and returns the original bytes', async () => {
		let writes = 0;
		const original = new Uint8Array([1]);
		const result = await new PdfMutationCoordinator().run('explicit-no-op.pdf', {
			read: async () => original.slice(),
			transform: async (bytes) => {
				bytes[0] = 2;
				return { bytes, value: 'no change', changed: false };
			},
			backup: async () => { throw new Error('must not back up'); },
			write: async () => { writes++; },
		});
		expect(result).toMatchObject({ changed: false, value: 'no change' });
		expect(result.bytes).toEqual(original);
		expect(writes).toBe(0);
	});

	it('does not write after backup failure and leaves a verified backup after source-write failure', async () => {
		let writes = 0;
		const failingBackupAdapter = new MemoryBackupAdapter();
		failingBackupAdapter.failNextBinaryWrite = true;
		await expect(new PdfMutationCoordinator().run('backup-fails.pdf', {
			read: async () => new Uint8Array([1]),
			transform: async () => ({ bytes: new Uint8Array([2]), value: undefined }),
			backup: async (original) => {
				await createVerifiedPdfBackup('.cfg', failingBackupAdapter, 'backup-fails.pdf', original, 1);
			},
			write: async () => { writes++; },
		})).rejects.toThrow(/write/i);
		expect(writes).toBe(0);

		const adapter = new MemoryBackupAdapter();
		await expect(new PdfMutationCoordinator().run('write-fails.pdf', {
			read: async () => new Uint8Array([1]),
			transform: async () => ({ bytes: new Uint8Array([2]), value: undefined }),
			backup: async (original) => { await createVerifiedPdfBackup('.cfg', adapter, 'write-fails.pdf', original, 1); },
			write: async () => { throw new Error('source write failed'); },
		})).rejects.toThrow('source write failed');
		const storedPath = [...adapter.files.keys()].find((path) => path.endsWith('/original.pdf'));
		expect(storedPath).toBeDefined();
		expect(new Uint8Array(await adapter.readBinary(storedPath!))).toEqual(new Uint8Array([1]));
	});

	it('rejects stale bytes at either checkpoint and never writes', async () => {
		for (const staleAt of [2, 3]) {
			const coordinator = new PdfMutationCoordinator();
			let reads = 0;
			let writes = 0;
			let backups = 0;
			await expect(coordinator.run(`stale-${staleAt}.pdf`, {
				read: async () => {
					reads++;
					return new Uint8Array(reads === staleAt ? [9] : [1]);
				},
				transform: async () => ({ bytes: new Uint8Array([2]), value: undefined }),
				backup: async () => { backups++; },
				write: async () => { writes++; },
			})).rejects.toThrow(/changed since/i);
			expect(reads).toBe(staleAt === 2 ? 2 : 3);
			expect(backups).toBe(staleAt === 2 ? 0 : 1);
			expect(writes).toBe(0);
		}
	});

	it('keeps the original snapshot immutable for backup when a transform mutates its input', async () => {
		const coordinator = new PdfMutationCoordinator();
		const original = new Uint8Array([10, 20]);
		let backedUp: Uint8Array | undefined;
		await coordinator.run('immutable.pdf', {
			read: async () => original.slice(),
			transform: async (working) => {
				working[0] = 99;
				return { bytes: working, value: undefined };
			},
			backup: async (bytes) => { backedUp = bytes; },
			write: async () => undefined,
		});
		expect(backedUp).toEqual(original);
	});
});

describe('verified PDF backups', () => {
	it('creates the shared backup root safely for concurrent different-path backups', async () => {
		const adapter = new MemoryBackupAdapter();
		const [first, second] = await Promise.all([
			createVerifiedPdfBackup('.cfg', adapter, 'a.pdf', new Uint8Array([1]), 1),
			createVerifiedPdfBackup('.cfg', adapter, 'b.pdf', new Uint8Array([2]), 2),
		]);
		expect(first.directory).not.toBe(second.directory);
		expect(adapter.directories.has('.cfg/plugins/study-pdf-local/backups')).toBe(true);
	});

	it('rejects absolute or traversing configDir paths before touching the adapter', async () => {
		const adapter = new MemoryBackupAdapter();
		await expect(createVerifiedPdfBackup('/absolute/config', adapter, 'a.pdf', new Uint8Array([1])))
			.rejects.toThrow(/vault-relative/i);
		await expect(createVerifiedPdfBackup('C:\\outside\\config', adapter, 'a.pdf', new Uint8Array([1])))
			.rejects.toThrow(/vault-relative/i);
		await expect(createVerifiedPdfBackup('../outside', adapter, 'a.pdf', new Uint8Array([1])))
			.rejects.toThrow(/traverse/i);
		expect(adapter.directories.size).toBe(0);
	});

	it('stores and verifies exact pre-transform bytes and metadata', async () => {
		const adapter = new MemoryBackupAdapter();
		const source = new Uint8Array([0, 1, 2, 255]);
		const view = new Uint8Array([77, ...source, 88]).subarray(1, 5);
		const backup = await createVerifiedPdfBackup('.config-dir', adapter, 'papers/book.pdf', view, 1234);
		expect(backup.directory).toContain('.config-dir/plugins/study-pdf-local/backups/');
		expect(backup.directory).not.toContain('.obsidian');
		expect(new Uint8Array(await adapter.readBinary(`${backup.directory}/original.pdf`))).toEqual(source);
		const metadata = JSON.parse(await adapter.read(`${backup.directory}/metadata.json`));
		expect(metadata).toMatchObject({
			sourcePath: 'papers/book.pdf',
			timestamp: new Date(1234).toISOString(),
			byteLength: source.length,
			contentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
	});

	it('rejects a backup directory whose metadata belongs to a different source path', async () => {
		const adapter = new MemoryBackupAdapter();
		const first = await createVerifiedPdfBackup('.cfg', adapter, 'a.pdf', new Uint8Array([1]), 1);
		const metadataPath = `${first.directory}/metadata.json`;
		const metadata = JSON.parse(await adapter.read(metadataPath));
		metadata.sourcePath = 'other.pdf';
		await adapter.write(metadataPath, JSON.stringify(metadata));
		await expect(createVerifiedPdfBackup('.cfg', adapter, 'a.pdf', new Uint8Array([2]), 2))
			.rejects.toThrow(/belongs to a different source/i);
		expect(new Uint8Array(await adapter.readBinary(`${first.directory}/original.pdf`))).toEqual(new Uint8Array([1]));
	});

	it('rejects staged readback corruption and preserves the previous valid backup', async () => {
		const adapter = new MemoryBackupAdapter();
		const first = await createVerifiedPdfBackup('.cfg', adapter, 'a.pdf', new Uint8Array([1]), 1);
		adapter.corruptBinaryReadForStage = true;
		await expect(createVerifiedPdfBackup('.cfg', adapter, 'a.pdf', new Uint8Array([2]), 2))
			.rejects.toThrow(/readback/i);
		expect(new Uint8Array(await adapter.readBinary(`${first.directory}/original.pdf`))).toEqual(new Uint8Array([1]));
	});

	it('preserves the previous valid backup if staging cannot write the replacement', async () => {
		const adapter = new MemoryBackupAdapter();
		const first = await createVerifiedPdfBackup('.cfg', adapter, 'a.pdf', new Uint8Array([1]), 1);
		adapter.failNextBinaryWrite = true;
		await expect(createVerifiedPdfBackup('.cfg', adapter, 'a.pdf', new Uint8Array([2]), 2))
			.rejects.toThrow(/write/i);
		expect(new Uint8Array(await adapter.readBinary(`${first.directory}/original.pdf`))).toEqual(new Uint8Array([1]));
	});

	it('restores the prior backup when promotion fails', async () => {
		const adapter = new MemoryBackupAdapter();
		const first = await createVerifiedPdfBackup('.cfg', adapter, 'a.pdf', new Uint8Array([1]), 1);
		adapter.failNextPromotion = true;
		await expect(createVerifiedPdfBackup('.cfg', adapter, 'a.pdf', new Uint8Array([2]), 2))
			.rejects.toThrow(/promotion failed/i);
		expect(new Uint8Array(await adapter.readBinary(`${first.directory}/original.pdf`))).toEqual(new Uint8Array([1]));
		expect([...adapter.directories].some((path) => path.includes('.stage-') || path.includes('.previous-'))).toBe(false);
	});

	it('restores the prior backup after final-location readback failure', async () => {
		const adapter = new MemoryBackupAdapter();
		const first = await createVerifiedPdfBackup('.cfg', adapter, 'a.pdf', new Uint8Array([1]), 1);
		adapter.corruptFinalReadOnPromotion = true;
		await expect(createVerifiedPdfBackup('.cfg', adapter, 'a.pdf', new Uint8Array([2]), 2))
			.rejects.toThrow(/readback/i);
		expect(new Uint8Array(await adapter.readBinary(`${first.directory}/original.pdf`))).toEqual(new Uint8Array([1]));
		expect([...adapter.directories].some((path) => path.includes('.stage-') || path.includes('.previous-'))).toBe(false);
	});

	it('surfaces a previous-folder recovery path after bounded cleanup retries', async () => {
		const adapter = new MemoryBackupAdapter();
		const first = await createVerifiedPdfBackup('.cfg', adapter, 'a.pdf', new Uint8Array([1]), 1);
		adapter.failRmdirPathIncludes = '.previous-';
		const source = new Uint8Array([9]);
		let writes = 0;
		await expect(new PdfMutationCoordinator().run('a.pdf', {
			read: async () => source.slice(),
			transform: async () => ({ bytes: new Uint8Array([10]), value: undefined }),
			backup: async (original) => { await createVerifiedPdfBackup('.cfg', adapter, 'a.pdf', original, 2); },
			write: async (bytes) => { writes++; source.set(bytes); },
		})).rejects.toThrow(/Recovery folder: .*\.previous-/);
		expect(adapter.rmdirCalls.filter((path) => path.includes('.previous-'))).toHaveLength(2);
		expect(new Uint8Array(await adapter.readBinary(`${first.directory}/original.pdf`))).toEqual(new Uint8Array([9]));
		expect(source).toEqual(new Uint8Array([9]));
		expect(writes).toBe(0);
	});

	it('surfaces both prior and staging recovery paths if rollback and stage cleanup fail', async () => {
		const adapter = new MemoryBackupAdapter();
		await createVerifiedPdfBackup('.cfg', adapter, 'a.pdf', new Uint8Array([1]), 1);
		adapter.failNextPromotion = true;
		adapter.failRestorePrevious = true;
		adapter.failRmdirPathIncludes = '.stage-';
		await expect(createVerifiedPdfBackup('.cfg', adapter, 'a.pdf', new Uint8Array([2]), 2))
			.rejects.toThrow(/recoverable backup paths: .*\.previous-.*\.stage-/);
		expect(adapter.rmdirCalls.filter((path) => path.includes('.stage-'))).toHaveLength(2);
	});

	it('refuses malformed or mismatched staged metadata without replacing the existing backup', async () => {
		const adapter = new MemoryBackupAdapter();
		const first = await createVerifiedPdfBackup('.cfg', adapter, 'a.pdf', new Uint8Array([1]), 1);
		adapter.corruptTextReadForStage = true;
		await expect(createVerifiedPdfBackup('.cfg', adapter, 'a.pdf', new Uint8Array([2]), 2))
			.rejects.toThrow(/metadata/i);
		expect(new Uint8Array(await adapter.readBinary(`${first.directory}/original.pdf`))).toEqual(new Uint8Array([1]));
	});
});

describe('captured PDF targets', () => {
	it('chooses the pane that owns a cross-window node before checking its page', () => {
		const target = { nodeType: 1 } as unknown as Node;
		let wrongPanePageLookups = 0;
		const paneA = {
			containerEl: { contains: (_node: Node) => false },
			findPageIndexForNode: (_node: Node) => { wrongPanePageLookups++; return 0; },
		};
		const paneB = {
			containerEl: { contains: (node: Node) => node === target },
			findPageIndexForNode: (node: Node) => node === target ? 2 : null,
		};

		expect(findPdfViewForNode([paneA, paneB], target)).toEqual({ view: paneB, pageIndex: 2 });
		expect(wrongPanePageLookups).toBe(0);
		expect(findPdfViewForNode([paneA, paneB], { nodeType: 'not-a-node' })).toBeNull();
	});

	it('keeps callbacks tied to the original view and file when the active selection changes', () => {
		const originalFile = { path: 'a.pdf' };
		const originalView = { file: originalFile, containerEl: {} };
		let activeFile = originalFile;
		let activeView = originalView;
		const capture = capturePdfTarget(originalFile, originalView);
		activeFile = { path: 'b.pdf' };
		activeView = { file: activeFile, containerEl: {} };
		const deferredCallback = () => capture;
		expect(activeFile).not.toBe(deferredCallback().file);
		expect(activeView).not.toBe(deferredCallback().pdfView);
		expect(deferredCallback()).toMatchObject({ file: originalFile, path: 'a.pdf', pdfView: originalView });
	});

	it('keeps a press on A bound to A after switching to B and rejects a reused A container', () => {
		const fileA = { path: 'a.pdf' };
		const fileB = { path: 'b.pdf' };
		const containerA = {};
		const viewA = { file: fileA, containerEl: containerA };
		const viewB = { file: fileB, containerEl: {} };
		const press = capturePdfPress(capturePdfTarget(fileA, viewA), {
			pageIndex: 2,
			clientX: 120,
			clientY: 240,
			pdfPoint: { x: 80, y: 160 },
		});
		let activeView = viewA;
		const invokedTargets: string[] = [];
		const deferredRemoveOrMenu = () => {
			if (isCapturedPdfViewLive(press.capture, [viewA, viewB])) {
				invokedTargets.push(press.capture.path);
			}
		};

		activeView = viewB;
		deferredRemoveOrMenu();
		expect(activeView.file).toBe(fileB);
		expect(invokedTargets).toEqual(['a.pdf']);

		const reusedBView = { file: fileB, containerEl: containerA };
		invokedTargets.length = 0;
		if (isCapturedPdfViewLive(press.capture, [reusedBView])) invokedTargets.push(press.capture.path);
		expect(invokedTargets).toEqual([]);
	});

	it('clones the PDF point captured synchronously at touch press', () => {
		const file = { path: 'a.pdf' };
		const view = { file, containerEl: {} };
		const sourcePoint = { x: 82.5, y: 141 };
		const press = capturePdfPress(capturePdfTarget(file, view), {
			pageIndex: 1,
			clientX: 120,
			clientY: 240,
			pdfPoint: sourcePoint,
		});
		sourcePoint.x = 0;
		expect(resolveCapturedPdfPress(press)).toEqual({ pageIndex: 1, point: { x: 82.5, y: 141 } });
	});

	it('rejects a renamed file or a replacement occupying the original path', () => {
		const file = { path: 'a.pdf' };
		const view = { file, containerEl: {} };
		const capture = capturePdfTarget(file, view);
		expect(isCapturedPdfCurrent(capture, (path) => path === 'a.pdf' ? file : null)).toBe(true);
		file.path = 'renamed.pdf';
		expect(isCapturedPdfCurrent(capture, (path) => path === 'a.pdf' ? file : null)).toBe(false);
		file.path = 'a.pdf';
		expect(isCapturedPdfCurrent(capture, (path) => path === 'a.pdf' ? { path: 'a.pdf' } : null)).toBe(false);
		expect(() => capturePdfTarget(file, { file: { path: 'other.pdf' }, containerEl: {} })).toThrow(/do not match/);
	});
});

class MemoryBackupAdapter implements BackupFileAdapter {
	files = new Map<string, string | Uint8Array>();
	directories = new Set<string>();
	corruptBinaryReadForStage = false;
	corruptTextReadForStage = false;
	failNextBinaryWrite = false;
	failNextPromotion = false;
	failRestorePrevious = false;
	corruptFinalReadOnPromotion = false;
	failRmdirPathIncludes: string | null = null;
	rmdirCalls: string[] = [];
	private corruptFinalReadPath: string | null = null;

	async exists(path: string) { return this.files.has(path) || this.directories.has(path); }
	async mkdir(path: string) {
		if (this.directories.has(path)) throw new Error('already exists');
		this.directories.add(path);
	}
	async read(path: string) {
		const value = this.files.get(path);
		if (typeof value !== 'string') throw new Error('not text');
		if (this.corruptTextReadForStage && path.includes('.stage-')) {
			this.corruptTextReadForStage = false;
			return '{';
		}
		return value;
	}
	async readBinary(path: string) {
		const value = this.files.get(path);
		if (!(value instanceof Uint8Array)) throw new Error('not binary');
		if (path === this.corruptFinalReadPath) {
			this.corruptFinalReadPath = null;
			return Uint8Array.from([...value, 1]).buffer as ArrayBuffer;
		}
		if (this.corruptBinaryReadForStage && path.includes('.stage-')) {
			this.corruptBinaryReadForStage = false;
			return Uint8Array.from([...value, 1]).buffer as ArrayBuffer;
		}
		return value.slice().buffer as ArrayBuffer;
	}
	async write(path: string, data: string) { this.files.set(path, data); }
	async writeBinary(path: string, data: ArrayBuffer) {
		if (this.failNextBinaryWrite) {
			this.failNextBinaryWrite = false;
			throw new Error('binary write failed');
		}
		this.files.set(path, new Uint8Array(data.slice(0)));
	}
	async rename(from: string, to: string) {
		const destinationName = to.slice(to.lastIndexOf('/') + 1);
		if (from.includes('.stage-') && /^[a-f0-9]{64}$/.test(destinationName)) {
			if (this.failNextPromotion) {
				this.failNextPromotion = false;
				throw new Error('promotion failed');
			}
			if (this.corruptFinalReadOnPromotion) {
				this.corruptFinalReadOnPromotion = false;
				this.corruptFinalReadPath = `${to}/original.pdf`;
			}
		}
		if (from.includes('.previous-') && this.failRestorePrevious) {
			this.failRestorePrevious = false;
			throw new Error('prior backup restore failed');
		}
		if (this.directories.has(from)) {
			if (this.directories.has(to)) throw new Error('destination exists');
			this.directories.delete(from);
			this.directories.add(to);
			for (const [path, value] of [...this.files]) {
				if (path.startsWith(`${from}/`)) {
					this.files.delete(path);
					this.files.set(`${to}${path.slice(from.length)}`, value);
				}
			}
			return;
		}
		const value = this.files.get(from);
		if (value === undefined) throw new Error('source missing');
		if (this.files.has(to)) throw new Error('destination exists');
		this.files.delete(from);
		this.files.set(to, value);
	}
	async rmdir(path: string, recursive: boolean) {
		this.rmdirCalls.push(path);
		if (this.failRmdirPathIncludes && path.includes(this.failRmdirPathIncludes)) {
			throw new Error(`cleanup failed for ${path}`);
		}
		if (recursive) {
			this.directories.delete(path);
			for (const key of this.directories) if (key.startsWith(`${path}/`)) this.directories.delete(key);
			for (const key of this.files.keys()) if (key.startsWith(`${path}/`)) this.files.delete(key);
			return;
		}
		this.directories.delete(path);
	}
}
