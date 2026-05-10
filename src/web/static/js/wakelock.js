/* wakelock.js — keep the screen on during an active meditation session.
   Without this, the phone sleeps mid-session and the audio/WebSocket
   connection breaks. Acquired on session start, released on session end,
   re-acquired on visibility change so a tab-switch doesn't drop it. */

let wakeLock = null;

export async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', function () {
            wakeLock = null;
        });
    } catch (err) {
        // Common reasons: tab not visible, page not in a secure context.
        // Not fatal — we'll try again on visibilitychange.
        console.warn('Wake Lock not acquired:', err && err.message);
    }
}

export function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release().catch(function () {});
        wakeLock = null;
    }
}

document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' &&
        document.body.dataset.sessionActive === 'true' &&
        wakeLock === null) {
        acquireWakeLock();
    }
});
