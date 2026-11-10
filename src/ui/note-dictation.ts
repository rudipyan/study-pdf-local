import { setIcon, setTooltip } from 'obsidian';

interface SpeechResult {
	isFinal: boolean;
	readonly [index: number]: { transcript: string } | undefined;
}

interface SpeechResultEvent extends Event {
	resultIndex: number;
	results: ArrayLike<SpeechResult>;
}

interface SpeechRecognition extends EventTarget {
	continuous: boolean;
	interimResults: boolean;
	start(): void;
	stop(): void;
	abort(): void;
}

type SpeechWindow = Window & {
	SpeechRecognition?: new () => SpeechRecognition;
	webkitSpeechRecognition?: new () => SpeechRecognition;
};

const DICTATION_FALLBACK = ' Use keyboard Dictation in the note field.';

function speechError(error: string): string {
	switch (error) {
		case 'NotAllowedError':
		case 'not-allowed': return 'Microphone access was denied.';
		case 'audio-capture': return 'The microphone is unavailable.';
		case 'network':
		case 'service-not-allowed': return 'Speech recognition service is unavailable.';
		case 'no-speech': return 'No speech was detected.';
		default: return 'Speech recognition could not run.';
	}
}

function insertTranscript(input: HTMLTextAreaElement, transcript: string) {
	const start = input.selectionStart;
	const end = input.selectionEnd;
	const left = input.value.slice(0, start);
	const right = input.value.slice(end);
	const wordStart = /^[\p{L}\p{N}\p{M}]/u;
	const wordEnd = /[\p{L}\p{N}\p{M}\p{Pe}.,!?…:;]$/u;
	const before = wordEnd.test(left) && wordStart.test(transcript) ? ' ' : '';
	const after = wordEnd.test(transcript) && wordStart.test(right) ? ' ' : '';
	input.setRangeText(before + transcript + after, start, end, 'end');
	if (after) input.setSelectionRange(input.selectionStart - after.length, input.selectionStart - after.length);
	input.dispatchEvent(new Event('input', { bubbles: true }));
}

export function bindNoteDictation(
	input: HTMLTextAreaElement,
	button: HTMLButtonElement,
	status: HTMLElement,
	options: { canDictate(): boolean; onActiveChange(active: boolean): void; reposition(): void },
) {
	const doc = input.ownerDocument;
	const win = doc.defaultView as SpeechWindow | null;
	const Recognizer = win?.SpeechRecognition ?? win?.webkitSpeechRecognition;
	let disclosed = false;
	let session: { recognition: SpeechRecognition; phase: 'starting' | 'listening' | 'finishing'; detach(): void } | null = null;
	const setMessage = (message: string) => {
		if (status.textContent === message) return;
		status.hidden = !message;
		status.textContent = message;
		options.reposition();
	};
	const setActive = (active: boolean) => {
		button.setAttribute('aria-pressed', String(active));
		setIcon(button, active ? 'square' : 'mic');
		setTooltip(button, active ? 'Stop dictation' : 'Dictate note');
		options.onActiveChange(active);
	};
	const closeSession = (message: string, abort: boolean) => {
		const current = session;
		session = null;
		if (current) {
			current.detach();
			if (abort) {
				try { current.recognition.abort(); } catch { /* The host already ended the session. */ }
			}
			setActive(false);
		}
		setMessage(message);
	};
	const abort = () => closeSession('', true);
	const onVisibilityChange = () => { if (doc.hidden && session) abort(); };
	const preserveSelection = (event: MouseEvent) => event.preventDefault();
	const toggle = () => {
		if (session) {
			if (session.phase !== 'listening') { abort(); return; }
			session.phase = 'finishing';
			setMessage('Finishing dictation…');
			try { session.recognition.stop(); } catch { closeSession('Speech recognition could not finish.' + DICTATION_FALLBACK, true); }
			return;
		}
		if (!options.canDictate()) {
			setMessage('Switch to editing to dictate.');
			return;
		}
		if (typeof Recognizer !== 'function') {
			setMessage('Dictation is unavailable in this app window.' + DICTATION_FALLBACK);
			return;
		}
		if (!disclosed) {
			disclosed = true;
			setMessage('The speech service may process audio online. Press the microphone again to start.');
			return;
		}
		try {
			const recognition = new Recognizer();
			recognition.continuous = true;
			recognition.interimResults = false;
			let hasTranscript = false;
			const onStart = () => {
				if (session?.recognition !== recognition || session.phase !== 'starting') return;
				session.phase = 'listening';
				setMessage('Listening…');
			};
			const onResult = (event: Event) => {
				if (session?.recognition !== recognition || !options.canDictate()) return;
				const { results, resultIndex } = event as SpeechResultEvent;
				let transcript = '';
				// Results before resultIndex were already sent, and the engine
				// supplies whitespace between consecutive final segments.
				for (let index = resultIndex; index < results.length; index++) {
					const result = results[index];
					if (result?.isFinal) transcript += result[0]?.transcript ?? '';
				}
				transcript = transcript.trim();
				if (!transcript) return;
				hasTranscript = true;
				insertTranscript(input, transcript);
			};
			const onError = (event: Event) => {
				if (session?.recognition === recognition) closeSession(speechError((event as Event & { error: string }).error) + DICTATION_FALLBACK, true);
			};
			const onEnd = () => {
				if (session?.recognition !== recognition) return;
				closeSession(hasTranscript ? '' : 'No speech was transcribed.' + DICTATION_FALLBACK, false);
			};
			recognition.addEventListener('start', onStart);
			recognition.addEventListener('result', onResult);
			recognition.addEventListener('error', onError);
			recognition.addEventListener('end', onEnd);
			session = {
				recognition,
				phase: 'starting',
				detach() {
					recognition.removeEventListener('start', onStart);
					recognition.removeEventListener('result', onResult);
					recognition.removeEventListener('error', onError);
					recognition.removeEventListener('end', onEnd);
				},
			};
			setActive(true);
			setMessage('Starting dictation…');
			recognition.start();
		} catch (error) {
			closeSession(speechError(error instanceof Error ? error.name : '') + DICTATION_FALLBACK, true);
		}
	};
	button.setAttribute('aria-pressed', 'false');
	button.addEventListener('mousedown', preserveSelection);
	button.addEventListener('click', toggle);
	doc.addEventListener('visibilitychange', onVisibilityChange);
	return {
		abort,
		dispose() {
			button.removeEventListener('mousedown', preserveSelection);
			button.removeEventListener('click', toggle);
			doc.removeEventListener('visibilitychange', onVisibilityChange);
			abort();
		},
	};
}
