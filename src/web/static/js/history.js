/* History page — session listing and transcript viewing */

(function () {
    'use strict';

    var loaded = {};

    window.toggleSession = function (sessionId) {
        var item = document.querySelector('[data-session-id="' + sessionId + '"]');
        var body = document.getElementById('body-' + sessionId);

        if (!item || !body) return;

        var isOpen = item.classList.contains('open');

        if (isOpen) {
            item.classList.remove('open');
            body.style.display = 'none';
        } else {
            item.classList.add('open');
            body.style.display = 'block';

            if (!loaded[sessionId]) {
                loadTranscript(sessionId);
            }
        }
    };

    function loadTranscript(sessionId) {
        var container = document.getElementById('transcript-' + sessionId);

        fetch('/api/sessions/' + sessionId)
            .then(function (res) { return res.json(); })
            .then(function (data) {
                loaded[sessionId] = true;
                container.innerHTML = '';

                var exchanges = data.exchanges || [];
                if (exchanges.length === 0) {
                    container.innerHTML = '<p class="loading-text">No exchanges recorded.</p>';
                    return;
                }

                exchanges.forEach(function (ex) {
                    var msg = document.createElement('div');
                    msg.className = 'transcript-message';

                    var role = document.createElement('div');
                    role.className = 'transcript-role ' + ex.role;
                    role.textContent = ex.role === 'assistant' ? 'Facilitator' : 'You';

                    var text = document.createElement('div');
                    text.className = 'transcript-text';
                    text.textContent = ex.content;

                    msg.appendChild(role);
                    msg.appendChild(text);
                    container.appendChild(msg);
                });
            })
            .catch(function () {
                container.innerHTML = '<p class="loading-text">Failed to load session.</p>';
            });
    }

    window.continueSession = function (sessionId, btnEl) {
        sessionStorage.setItem('continueFrom', sessionId);
        // Grab summary from the parent session-item's data attribute
        var item = btnEl && btnEl.closest('[data-summary]');
        var summary = item ? item.getAttribute('data-summary') : '';
        if (summary) {
            sessionStorage.setItem('continueFromSummary', summary);
        } else {
            sessionStorage.removeItem('continueFromSummary');
        }
        window.location.href = '/';
    };

    window.deleteSession = function (sessionId) {
        if (!confirm('Delete this session permanently?')) return;

        fetch('/api/sessions/' + sessionId, { method: 'DELETE' })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (data.deleted) {
                    var item = document.querySelector('[data-session-id="' + sessionId + '"]');
                    if (item) {
                        item.style.transition = 'opacity 0.3s';
                        item.style.opacity = '0';
                        setTimeout(function () { item.remove(); }, 300);
                    }
                }
            });
    };
})();
