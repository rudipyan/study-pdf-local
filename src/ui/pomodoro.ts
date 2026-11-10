import { Scope, setIcon, type App } from 'obsidian';
import { formatPomodoroTime, type PomodoroTimer, type PomodoroSnapshot } from '../pomodoro';
import type { PomodoroChime } from '../pomodoro-chime';
import { positionPopup, trackPopupPosition, type IconPopup } from './icon-popup';

export function createPomodoroButton(parent: HTMLElement, timer: PomodoroTimer,
	onOpen: (anchor: HTMLButtonElement) => void): { button: HTMLButtonElement; dispose(): void } {
	const button = parent.createEl('button', { cls: 'clickable-icon study-pdf-pomodoro-button' });
	button.type = 'button';
	button.setAttribute('aria-haspopup', 'dialog');
	button.setAttribute('aria-expanded', 'false');
	const icon = button.createSpan({ cls: 'study-pdf-pomodoro-icon' });
	icon.setAttribute('aria-hidden', 'true');
	const clock = button.createSpan({ cls: 'study-pdf-pomodoro-clock' });
	let phase = '';
	const unsubscribe = timer.subscribe((state) => {
		const time = formatPomodoroTime(state.remainingSeconds);
		if (clock.textContent !== time) clock.setText(time);
		if (phase !== state.phase) { phase = state.phase; setIcon(icon, phase === 'break' ? 'coffee' : 'timer'); }
		button.dataset.phase = state.phase;
		button.classList.toggle('is-running', state.running);
		button.setAttribute('aria-label', `${state.phase === 'study' ? 'Study' : 'Break'} timer: ${time}${state.running ? '' : ', paused'}. Open timer controls`);
	});
	const click = () => onOpen(button);
	button.addEventListener('click', click);
	return { button, dispose() { unsubscribe(); button.removeEventListener('click', click); button.remove(); } };
}

export function showPomodoroPopup(app: App, doc: Document, anchor: HTMLButtonElement,
	timer: PomodoroTimer, chime: PomodoroChime, onDismiss: () => void): IconPopup {
	const el = doc.body.createDiv({ cls: 'study-pdf-popup study-pdf-pomodoro-popup' });
	el.setAttribute('role', 'dialog');
	el.setAttribute('aria-label', 'Study timer');
	let closed = false;
	const heading = el.createDiv({ cls: 'study-pdf-pomodoro-heading' });
	const phaseGroup = heading.createDiv({ cls: 'study-pdf-pomodoro-phase' });
	const phaseIcon = phaseGroup.createSpan();
	phaseIcon.setAttribute('aria-hidden', 'true');
	const phaseLabel = phaseGroup.createSpan();
	let displayedPhase = '';
	const round = heading.createSpan({ cls: 'study-pdf-pomodoro-round' });
	const row = el.createDiv({ cls: 'study-pdf-pomodoro-actions' });
	const countdown = row.createDiv({ cls: 'study-pdf-pomodoro-display' });
	countdown.setAttribute('role', 'timer');
	countdown.setAttribute('aria-live', 'off');
	const button = (parent: HTMLElement, icon: string, label: string, action: () => void) => {
		const control = parent.createEl('button', { cls: 'clickable-icon' });
		control.type = 'button';
		control.setAttribute('aria-label', label);
		setIcon(control, icon);
		control.addEventListener('click', action);
		return control;
	};
	const arm = () => { const win = doc.defaultView; return win ? chime.arm(win) : Promise.resolve(); };
	void arm();
	const play = button(row, 'play', 'Start timer', () => { void arm(); timer.toggle(); });
	button(row, 'rotate-ccw', 'Reset timer and rounds', () => timer.reset());
	const skip = button(row, 'skip-forward', 'Skip break', () => { void arm(); timer.skipBreak(); });
	const durations = el.createDiv({ cls: 'study-pdf-pomodoro-fields' });
	const makeDuration = (label: string, key: 'studyMinutes' | 'breakMinutes', maximum: number) => {
		const group = durations.createEl('label', { cls: 'study-pdf-pomodoro-duration' });
		group.createSpan({ text: `${label} · min` });
		const input = group.createEl('input', { type: 'number' });
		input.min = '1'; input.max = String(maximum); input.step = '1';
		input.inputMode = 'numeric';
		input.setAttribute('aria-label', `${label} minutes, 1 to ${maximum}`);
		input.addEventListener('change', () => {
			const minutes = Number(input.value);
			if (Number.isInteger(minutes) && minutes >= 1 && minutes <= maximum) {
				input.removeAttribute('aria-invalid');
				timer.configure({ [key]: minutes });
			} else {
				input.setAttribute('aria-invalid', 'true');
				input.value = String(timer.snapshot()[key]);
			}
		});
		return { input, key };
	};
	const study = makeDuration('Study', 'studyMinutes', 180);
	const rest = makeDuration('Break', 'breakMinutes', 60);
	const soundRow = el.createDiv({ cls: 'study-pdf-pomodoro-sound' });
	const repeat = button(soundRow, 'repeat', 'Repeat study and break automatically', () => {
		timer.configure({ autoRepeat: !timer.snapshot().autoRepeat });
	});
	const mute = button(soundRow, 'volume-2', 'Mute gong', () => {
		void arm(); timer.configure({ muted: !timer.snapshot().muted });
	});
	const volume = soundRow.createEl('input', { type: 'range' });
	volume.min = '0'; volume.max = '100'; volume.step = '5';
	volume.setAttribute('aria-label', 'Gong volume');
	volume.addEventListener('change', () => { void arm(); timer.configure({ volume: Number(volume.value) / 100 }); });
	button(soundRow, 'bell', 'Preview gong', () => {
		void arm().then(() => {
			if (closed) return;
			const state = timer.snapshot();
			chime.play(state.volume, false);
		});
	});
	const sync = (state: PomodoroSnapshot) => {
		const time = formatPomodoroTime(state.remainingSeconds);
		if (countdown.textContent !== time) countdown.setText(time);
		phaseLabel.setText(state.phase === 'study' ? 'Study' : 'Break');
		if (displayedPhase !== state.phase) { displayedPhase = state.phase; setIcon(phaseIcon, state.phase === 'study' ? 'timer' : 'coffee'); }
		round.setText(`Round ${state.phase === 'study' ? state.completedRounds + 1 : state.completedRounds}`);
		const action = state.running ? 'Pause timer' : 'Start timer';
		if (play.getAttribute('aria-label') !== action) { play.setAttribute('aria-label', action); setIcon(play, state.running ? 'pause' : 'play'); }
		skip.disabled = state.phase !== 'break';
		for (const group of [study, rest]) {
			if (doc.activeElement !== group.input) { group.input.value = String(state[group.key]); group.input.removeAttribute('aria-invalid'); }
		}
		const soundLabel = state.muted ? 'Unmute gong' : 'Mute gong';
		if (mute.getAttribute('aria-label') !== soundLabel) { mute.setAttribute('aria-label', soundLabel); setIcon(mute, state.muted ? 'volume-x' : 'volume-2'); }
		mute.setAttribute('aria-pressed', String(state.muted));
		repeat.setAttribute('aria-pressed', String(state.autoRepeat));
		if (doc.activeElement !== volume) volume.value = String(state.volume * 100);
	};
	const unsubscribe = timer.subscribe(sync);
	const rect = anchor.getBoundingClientRect();
	const position = { x: rect.right - 220, y: rect.bottom + 6 };
	positionPopup(doc, el, position);
	const positioning = trackPopupPosition(doc, el, position);
	const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); hide(); } };
	const outside = (event: PointerEvent) => { const path = event.composedPath(); if (!path.includes(el) && !path.includes(anchor)) hide(false); };
	const scope = new Scope();
	scope.register([], 'ArrowLeft', () => true);
	scope.register([], 'ArrowRight', () => true);
	app.keymap.pushScope(scope);
	anchor.setAttribute('aria-expanded', 'true');
	doc.addEventListener('keydown', key);
	doc.addEventListener('pointerdown', outside, true);
	play.focus({ preventScroll: true });
	function hide(restoreFocus = true) {
		if (closed) return;
		const focusWasInside = Boolean(doc.activeElement && el.contains(doc.activeElement));
		closed = true;
		unsubscribe(); positioning.dispose();
		doc.removeEventListener('keydown', key);
		doc.removeEventListener('pointerdown', outside, true);
		app.keymap.popScope(scope);
		anchor.setAttribute('aria-expanded', 'false');
		el.remove();
		if (restoreFocus && focusWasInside && anchor.isConnected && anchor.getClientRects().length > 0 && doc.hasFocus()) anchor.focus({ preventScroll: true });
		onDismiss();
	}
	return { el, preserveOnScroll: true, reposition: () => positioning.schedule(), hide };
}
