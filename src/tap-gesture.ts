// Decides whether a completed touch can still act on its captured PDF press.
// iOS may cancel a brief thumb tap as well as a scroll; the measured travel and
// duration distinguish those cases while the captured PDF point stays fixed.
//
// Pure and DOM-free so it can be unit tested, like geometry.ts.

export interface PointerGesture {
	downX: number;
	downY: number;
	/** Where the pointer was when it ended -- pointerup or pointercancel. */
	endX: number;
	endY: number;
	durationMs: number;
}

/** Maximum finger travel still counted as a tap, in CSS pixels. Deliberately
 * loose to allow normal thumb drift on touch screens. */
export const TAP_MAX_TRAVEL_PX = 16;

/** Above this, the touch was a long-press and must not pop the remove menu in
 * the middle of native text selection. */
export const TAP_MAX_DURATION_MS = 700;

export function classifyPointerGesture(gesture: PointerGesture): 'tap' | 'gesture' {
	const travel = Math.hypot(gesture.endX - gesture.downX, gesture.endY - gesture.downY);
	if (travel > TAP_MAX_TRAVEL_PX) return 'gesture';
	if (gesture.durationMs > TAP_MAX_DURATION_MS) return 'gesture';
	return 'tap';
}

/** A brief low-travel cancellation is still a tap on iOS; scrolls and long
 * presses must discard the captured press. */
export function shouldKeepPressForGesture(gesture: PointerGesture): boolean {
	return classifyPointerGesture(gesture) === 'tap';
}
