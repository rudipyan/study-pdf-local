import { normalizeVaultRelativePath } from './pdf-mutation';

export interface BackupFileAdapter {
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	read(path: string): Promise<string>;
	readBinary(path: string): Promise<ArrayBuffer>;
	write(path: string, data: string): Promise<void>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	rmdir(path: string, recursive: boolean): Promise<void>;
}

export interface PdfBackupMetadata {
	version: 1;
	sourcePath: string;
	timestamp: string;
	byteLength: number;
	contentFingerprint: string;
}

export interface VerifiedPdfBackup {
	directory: string;
	metadata: PdfBackupMetadata;
}

const PLUGIN_BACKUP_FOLDER = 'plugins/study-pdf-local/backups';
let stagingSequence = 0;

export async function createVerifiedPdfBackup(
	configDir: string,
	adapter: BackupFileAdapter,
	sourcePath: string,
	originalBytes: Uint8Array,
	timestamp = Date.now(),
): Promise<VerifiedPdfBackup> {
	const normalizedSourcePath = normalizeVaultRelativePath(sourcePath);
	const configRoot = normalizeVaultRelativePath(configDir);
	const backupRoot = `${configRoot}/${PLUGIN_BACKUP_FOLDER}`;
	const pathFingerprint = await sha256Hex(new TextEncoder().encode(normalizedSourcePath));
	const directory = `${backupRoot}/${pathFingerprint}`;
	const stageDirectory = `${backupRoot}/.${pathFingerprint}.stage-${nextSequence()}`;
	const previousDirectory = `${backupRoot}/.${pathFingerprint}.previous-${nextSequence()}`;
	const sourceSnapshot = Uint8Array.from(originalBytes);
	const metadata: PdfBackupMetadata = {
		version: 1,
		sourcePath: normalizedSourcePath,
		timestamp: new Date(timestamp).toISOString(),
		byteLength: sourceSnapshot.byteLength,
		contentFingerprint: await sha256Hex(sourceSnapshot),
	};

	await ensureDirectoryTree(adapter, backupRoot);
	const hadPrevious = await adapter.exists(directory);
	if (hadPrevious) await verifyBackup(adapter, directory, normalizedSourcePath);

	let stageExists = false;
	let previousMoved = false;
	let promoted = false;
	try {
		await adapter.mkdir(stageDirectory);
		stageExists = true;
		await adapter.writeBinary(`${stageDirectory}/original.pdf`, toArrayBuffer(sourceSnapshot));
		await adapter.write(`${stageDirectory}/metadata.json`, JSON.stringify(metadata, null, 2));
		await verifyBackup(adapter, stageDirectory, normalizedSourcePath, metadata, sourceSnapshot);

		if (hadPrevious) {
			await adapter.rename(directory, previousDirectory);
			previousMoved = true;
		}
		await adapter.rename(stageDirectory, directory);
		stageExists = false;
		promoted = true;
		await verifyBackup(adapter, directory, normalizedSourcePath, metadata, sourceSnapshot);
	} catch (error) {
		const recoveryPaths: string[] = [];
		if (promoted) {
			const removePromotedError = await removeDirectoryWithRetry(adapter, backupRoot, directory);
			if (removePromotedError) {
				const failedDirectory = `${backupRoot}/.${pathFingerprint}.failed-${nextSequence()}`;
				try {
					await adapter.rename(directory, failedDirectory);
					const failedCleanupError = await removeDirectoryWithRetry(adapter, backupRoot, failedDirectory);
					if (failedCleanupError) recoveryPaths.push(`${failedDirectory} (${failedCleanupError})`);
				} catch (moveError) {
					recoveryPaths.push(`${directory} (${errorMessage(moveError)})`);
				}
			}
		}
		if (previousMoved) {
			try {
				if (await adapter.exists(directory)) throw new Error(`destination remains occupied: ${directory}`);
				await adapter.rename(previousDirectory, directory);
				previousMoved = false;
			} catch (restoreError) {
				recoveryPaths.push(`${previousDirectory} (${errorMessage(restoreError)})`);
			}
		}
		if (stageExists) {
			const stageCleanupError = await removeDirectoryWithRetry(adapter, backupRoot, stageDirectory);
			if (stageCleanupError) recoveryPaths.push(`${stageDirectory} (${stageCleanupError})`);
		}
		if (recoveryPaths.length > 0) {
			throw new Error(`${errorMessage(error)}; recoverable backup paths: ${recoveryPaths.join('; ')}`);
		}
		throw error;
	}

	if (previousMoved) {
		const cleanupError = await removeDirectoryWithRetry(adapter, backupRoot, previousDirectory);
		if (cleanupError) {
			throw new Error(
				`Verified PDF backup is at ${directory}, but the prior backup could not be cleaned after two attempts. Recovery folder: ${previousDirectory} (${cleanupError})`,
			);
		}
	}
	return { directory, metadata };
}

async function verifyBackup(
	adapter: BackupFileAdapter,
	directory: string,
	expectedSourcePath: string,
	expectedMetadata?: PdfBackupMetadata,
	expectedBytes?: Uint8Array,
): Promise<PdfBackupMetadata> {
	let metadata: PdfBackupMetadata;
	try {
		metadata = JSON.parse(await adapter.read(`${directory}/metadata.json`)) as PdfBackupMetadata;
	} catch (error) {
		throw new Error(`PDF backup metadata is invalid at ${directory}: ${errorMessage(error)}`);
	}
	if (!isMetadata(metadata)) throw new Error(`PDF backup metadata is malformed at ${directory}.`);
	if (metadata.sourcePath !== expectedSourcePath) {
		throw new Error(`PDF backup directory belongs to a different source path: ${directory}`);
	}
	if (expectedMetadata && !metadataEqual(metadata, expectedMetadata)) {
		throw new Error(`PDF backup metadata verification failed at ${directory}.`);
	}

	let backedUpBytes: Uint8Array;
	try {
		backedUpBytes = new Uint8Array(await adapter.readBinary(`${directory}/original.pdf`));
	} catch (error) {
		throw new Error(`PDF backup byte readback failed at ${directory}: ${errorMessage(error)}`);
	}
	if (
		backedUpBytes.byteLength !== metadata.byteLength ||
		(await sha256Hex(backedUpBytes)) !== metadata.contentFingerprint
	) {
		throw new Error(`PDF backup byte readback did not match metadata at ${directory}.`);
	}
	if (expectedBytes && !bytesEqual(backedUpBytes, expectedBytes)) {
		throw new Error(`PDF backup readback failed at ${directory}.`);
	}
	return metadata;
}

function isMetadata(value: PdfBackupMetadata): boolean {
	return Boolean(
		value &&
		value.version === 1 &&
		typeof value.sourcePath === 'string' &&
		typeof value.timestamp === 'string' &&
		Number.isFinite(Date.parse(value.timestamp)) &&
		Number.isInteger(value.byteLength) &&
		value.byteLength >= 0 &&
		/^[a-f0-9]{64}$/.test(value.contentFingerprint),
	);
}

function metadataEqual(left: PdfBackupMetadata, right: PdfBackupMetadata): boolean {
	return (
		left.version === right.version &&
		left.sourcePath === right.sourcePath &&
		left.timestamp === right.timestamp &&
		left.byteLength === right.byteLength &&
		left.contentFingerprint === right.contentFingerprint
	);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let i = 0; i < left.byteLength; i++) if (left[i] !== right[i]) return false;
	return true;
}

async function ensureDirectoryTree(adapter: BackupFileAdapter, path: string): Promise<void> {
	const segments = path.split('/').filter(Boolean);
	let current = '';
	for (const segment of segments) {
		current = current ? `${current}/${segment}` : segment;
		if (await adapter.exists(current)) continue;
		try {
			await adapter.mkdir(current);
		} catch (mkdirError) {
			// Different PDF mutations may create the shared backups root at once.
			// Treat mkdir as a concurrent success only after confirming the path exists.
			const createdByAnotherOperation = await adapter.exists(current).catch(() => false);
			if (!createdByAnotherOperation) throw mkdirError;
		}
	}
}

async function removeDirectory(adapter: BackupFileAdapter, backupRoot: string, path: string): Promise<void> {
	if (!path.startsWith(`${backupRoot}/`)) throw new Error('Refusing to clean a path outside the plugin backup directory.');
	if (await adapter.exists(path)) await adapter.rmdir(path, true);
}

async function removeDirectoryWithRetry(
	adapter: BackupFileAdapter,
	backupRoot: string,
	path: string,
): Promise<string | null> {
	let lastError = 'directory removal failed';
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await removeDirectory(adapter, backupRoot, path);
			return null;
		} catch (error) {
			lastError = errorMessage(error);
		}
	}
	return lastError;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) throw new Error('Web Crypto SHA-256 is unavailable; refusing to create an unverified PDF backup.');
	if (!(bytes.buffer instanceof ArrayBuffer)) {
		throw new Error('PDF backup bytes must use an ArrayBuffer; refusing to hash an unsupported byte view.');
	}
	const exactBytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const digest = await subtle.digest('SHA-256', exactBytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function nextSequence(): string {
	stagingSequence++;
	return `${Date.now()}-${stagingSequence}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
