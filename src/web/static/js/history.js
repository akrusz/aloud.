/* History page — paginated session listing and transcript viewing */

(function () {
    'use strict';

    var loaded = {};
    var currentPage = 0;
    var totalPages = 1;
    var LIMIT = 50;
    var listEl = document.getElementById('session-list');
    var emptyEl = document.getElementById('empty-state');
    var loadMoreBtn = document.getElementById('load-more');

    var clientId = localStorage.getItem('glooow-client-id') || '';

    function loadPage() {
        currentPage++;
        fetch('/api/sessions?page=' + currentPage + '&limit=' + LIMIT + '&client_id=' + encodeURIComponent(clientId))
            .then(function (res) { return res.json(); })
            .then(function (data) {
                totalPages = data.pages;
                var sessions = data.sessions || [];

                if (currentPage === 1 && sessions.length === 0) {
                    emptyEl.classList.remove('hidden');
                    return;
                }

                sessions.forEach(function (s) {
                    listEl.appendChild(createSessionItem(s));
                });

                loadMoreBtn.classList.toggle('hidden', currentPage >= totalPages);
            })
            .catch(function () {});
    }

    function createSessionItem(s) {
        var item = document.createElement('div');
        item.className = 'session-item';
        item.setAttribute('data-session-id', s.session_id);
        item.setAttribute('data-summary', s.summary || '');

        var durationText = s.duration
            ? Math.floor(s.duration / 60) + 'm ' + Math.floor(s.duration % 60) + 's'
            : '--';
        var dateText = 'Unknown';
        if (s.date) {
            var d = new Date(s.date);
            if (!isNaN(d)) {
                dateText = d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
            } else {
                dateText = s.date.substring(0, 10);
            }
        }

        var header = document.createElement('div');
        header.className = 'session-item-header';
        header.onclick = function () { toggleSession(s.session_id); };

        var info = document.createElement('div');
        info.className = 'session-item-info';

        var dateSpan = document.createElement('span');
        dateSpan.className = 'session-date';
        dateSpan.textContent = dateText + (s.meditation_type
            ? ' \u00B7 ' + s.meditation_type.charAt(0).toUpperCase() + s.meditation_type.slice(1)
            : '');
        info.appendChild(dateSpan);

        var metaSpan = document.createElement('span');
        metaSpan.className = 'session-meta';
        metaSpan.textContent = durationText + ' \u00B7 ' + (s.exchange_count || 0) + ' exchanges';
        info.appendChild(metaSpan);

        if (s.summary) {
            var summarySpan = document.createElement('span');
            summarySpan.className = 'session-summary';
            summarySpan.textContent = s.summary;
            info.appendChild(summarySpan);
        }

        header.appendChild(info);

        var expand = document.createElement('span');
        expand.className = 'session-expand';
        expand.innerHTML = '&#9662;';
        header.appendChild(expand);

        item.appendChild(header);

        var body = document.createElement('div');
        body.className = 'session-item-body';
        body.id = 'body-' + s.session_id;
        body.classList.add('hidden');

        var transcript = document.createElement('div');
        transcript.className = 'session-transcript';
        transcript.id = 'transcript-' + s.session_id;
        transcript.innerHTML = '<p class="loading-text">Loading...</p>';
        body.appendChild(transcript);

        var actions = document.createElement('div');
        actions.className = 'session-actions';

        var continueBtn = document.createElement('button');
        continueBtn.className = 'btn btn-secondary btn-small';
        continueBtn.textContent = 'Continue from here';
        continueBtn.onclick = function () { continueSession(s.session_id, continueBtn); };
        actions.appendChild(continueBtn);

        var deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn btn-danger btn-small';
        deleteBtn.textContent = 'Delete';
        deleteBtn.onclick = function () { deleteSession(s.session_id); };
        actions.appendChild(deleteBtn);

        body.appendChild(actions);
        item.appendChild(body);

        return item;
    }

    window.toggleSession = function (sessionId) {
        var item = document.querySelector('[data-session-id="' + sessionId + '"]');
        var body = document.getElementById('body-' + sessionId);

        if (!item || !body) return;

        var isOpen = item.classList.contains('open');

        if (isOpen) {
            item.classList.remove('open');
            body.classList.add('hidden');
        } else {
            item.classList.add('open');
            body.classList.remove('hidden');

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
                    role.textContent = ex.name || (ex.role === 'assistant' ? 'Facilitator' : 'You');

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

    // Load first page on init
    loadPage();
    loadMoreBtn.addEventListener('click', loadPage);
})();
