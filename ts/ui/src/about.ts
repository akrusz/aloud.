/**
 * About modal wiring — lifted from src/web/static/js/chrome.js.
 *
 * Brand link toggles open/close, × closes, click outside closes, krusz.eth
 * span copies to clipboard with a brief 'copied!' confirmation. Update
 * checker omitted intentionally — that's desktop-app-specific and the
 * TS preview has no equivalent self-update story yet.
 */

export function initAbout(): void {
    const brand = document.getElementById('aboutLink');
    const modal = document.getElementById('aboutModal');
    const close = document.getElementById('aboutClose');
    const ethEl = document.querySelector<HTMLElement>('.about-eth');
    if (!brand || !modal || !close) return;

    brand.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        modal.classList.toggle('hidden');
    });
    close.addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.add('hidden');
    });

    if (ethEl) {
        ethEl.addEventListener('click', () => {
            navigator.clipboard.writeText('krusz.eth').then(() => {
                ethEl.textContent = 'copied!';
                setTimeout(() => {
                    ethEl.textContent = 'krusz.eth';
                }, 1500);
            });
        });
    }
}
