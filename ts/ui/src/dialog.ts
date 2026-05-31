/**
 * Promise-based in-app confirm / alert dialogs.
 *
 * window.confirm()/alert()/prompt() are unreliable inside the Tauri webview —
 * they can return immediately without ever showing a dialog, which made any
 * action gated on a confirm (voice Uninstall, history Delete, Ollama model
 * removal) silently do nothing. These render a small themed overlay and behave
 * identically in the browser and the desktop shell. Styling lives in
 * ui/src/style.css (.app-dialog*).
 */

interface ButtonSpec {
    label: string;
    value: boolean;
    /** The affirmative action — focused on open and triggered by Enter. */
    action?: boolean;
    danger?: boolean;
}

function showDialog(message: string, buttons: ButtonSpec[], dismissValue: boolean): Promise<boolean> {
    return new Promise((resolve) => {
        if (typeof document === 'undefined') {
            resolve(dismissValue);
            return;
        }
        const backdrop = document.createElement('div');
        backdrop.className = 'app-dialog-backdrop';
        const box = document.createElement('div');
        box.className = 'app-dialog';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');

        const msg = document.createElement('p');
        msg.className = 'app-dialog-message';
        msg.textContent = message;
        box.appendChild(msg);

        const btnRow = document.createElement('div');
        btnRow.className = 'app-dialog-buttons';

        let settled = false;
        const finish = (v: boolean): void => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey, true);
            backdrop.remove();
            resolve(v);
        };
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') {
                e.preventDefault();
                finish(dismissValue);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                finish(buttons.find((b) => b.action)?.value ?? dismissValue);
            }
        };

        let actionBtn: HTMLButtonElement | null = null;
        for (const b of buttons) {
            const el = document.createElement('button');
            el.type = 'button';
            el.textContent = b.label;
            el.className = `btn btn-small ${b.danger ? 'btn-danger' : b.action ? 'btn-begin' : 'btn-secondary'}`;
            el.addEventListener('click', () => finish(b.value));
            if (b.action) actionBtn = el;
            btnRow.appendChild(el);
        }
        box.appendChild(btnRow);
        backdrop.appendChild(box);
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) finish(dismissValue);
        });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(backdrop);
        actionBtn?.focus();
    });
}

export interface ConfirmOptions {
    okLabel?: string;
    cancelLabel?: string;
    /** Style the affirmative button as destructive. */
    danger?: boolean;
}

/** Resolves true if the user confirms, false on cancel / backdrop / Escape. */
export function confirmDialog(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
    return showDialog(
        message,
        [
            { label: opts.cancelLabel ?? 'Cancel', value: false },
            { label: opts.okLabel ?? 'OK', value: true, action: true, danger: opts.danger ?? false },
        ],
        false
    );
}

/** A one-button acknowledgement. Resolves once dismissed. */
export function alertDialog(message: string, okLabel = 'OK'): Promise<void> {
    return showDialog(message, [{ label: okLabel, value: true, action: true }], true).then(() => undefined);
}
