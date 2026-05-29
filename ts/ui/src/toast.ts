/**
 * Transient error toast — a small fixed banner at the bottom of the screen
 * that fades in, auto-dismisses after a few seconds, and can be clicked to
 * dismiss early. Port of src/web/static/js/ui.js:showErrorToast; the
 * `.error-toast` styles come from the imported legacy stylesheet.
 *
 * Unlike the old session-only inline status line, this works anywhere in the
 * app, so errors raised outside a live session still get a visible surface.
 */

const TOAST_DURATION_MS = 5000;
const FADE_MS = 300;

export function showErrorToast(message: string): void {
    if (typeof document === 'undefined') return;
    const toast = document.createElement('div');
    toast.className = 'error-toast';
    toast.setAttribute('role', 'alert');
    toast.textContent = message;
    document.body.appendChild(toast);

    let removed = false;
    const remove = (): void => {
        if (removed) return;
        removed = true;
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), FADE_MS);
    };

    // Force a reflow so the opacity transition runs on the class add.
    void toast.offsetHeight;
    toast.classList.add('visible');
    toast.addEventListener('click', remove);
    setTimeout(remove, TOAST_DURATION_MS);
}
