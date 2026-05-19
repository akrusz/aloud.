/* Persistent UI shell — runs on every page (loaded from base.html).
   Contains: no-voices banner, about modal + update flow, theme toggle,
   fullscreen toggle, pywebview window-close, external-link forwarding,
   mobile More sheet, SPA-style nav. Excludes the head-level FOUC theme
   bootstrap, which must stay inline so it runs before paint. */

// ---- Shared no-voices banner ----
// Used by session, index, and settings pages
window.toggleNoVoicesBanner = function(anchorEl, customMessage) {
    var existing = document.querySelector('.no-voices-banner');
    if (existing) { existing.remove(); return; }

    var isSettings = window.location.pathname.indexOf('/settings') !== -1;
    var msg = customMessage || 'No text-to-speech voices available for the selected engine.';
    var banner = document.createElement('div');
    banner.className = 'no-voices-banner inline';
    banner.innerHTML =
        '<span>' + msg + '</span> ' +
        (isSettings ? '' : '<a href="/settings">Set up TTS in Settings</a> ') +
        '<button class="toast-close" aria-label="Dismiss">×</button>';
    banner.querySelector('.toast-close').addEventListener('click', function() {
        banner.remove();
    });
    anchorEl.parentElement.appendChild(banner);
};

// ---- About modal + update checking ----
(function() {
    var brand = document.getElementById('aboutLink');
    var aboutModal = document.getElementById('aboutModal');
    window._aloudUpdateData = null;

    // About modal — brand toggles open/closed (update-during-session guard is on the Update Now button)
    brand.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        aboutModal.classList.toggle('hidden');
    });
    document.getElementById('aboutClose').addEventListener('click', function() {
        aboutModal.classList.add('hidden');
    });
    aboutModal.addEventListener('click', function(e) {
        if (e.target === aboutModal) aboutModal.classList.add('hidden');
    });
    // Clicking anywhere else on the nav (which now sits above the modal
    // overlay) also dismisses About. Brand handler above stops propagation
    // so it stays a toggle rather than open-then-close.
    var navEl = document.querySelector('.nav');
    if (navEl) {
        navEl.addEventListener('click', function() {
            if (!aboutModal.classList.contains('hidden')) {
                aboutModal.classList.add('hidden');
            }
        });
    }
    var ethEl = document.querySelector('.about-eth');
    if (ethEl) {
        ethEl.addEventListener('click', function() {
            navigator.clipboard.writeText('krusz.eth').then(function() {
                ethEl.textContent = 'copied!';
                setTimeout(function() { ethEl.textContent = 'krusz.eth'; }, 1500);
            });
        });
    }

    // Populate update section inside about modal
    function _populateUpdateUI(data) {
        window._aloudUpdateData = data;
        var section = document.getElementById('aboutUpdate');
        var info = document.getElementById('aboutUpdateInfo');
        var commits = document.getElementById('updateCommits');
        var btn = document.getElementById('updateNowBtn');
        if (!section || !data) return;

        commits.innerHTML = '';
        if (!data.available) {
            section.classList.remove('hidden');
            info.textContent = 'You’re up to date';
            btn.classList.add('hidden');
            return;
        }

        section.classList.remove('hidden');
        if (data.is_release) {
            var cur = data.current_version || document.querySelector('.about-version').textContent;
            info.textContent = 'Version ' + data.latest_version + ' is available'
                + ' (you have ' + cur + ')';
            if (data.release_notes) {
                var notes = document.createElement('div');
                notes.className = 'update-release-notes';
                notes.textContent = data.release_notes;
                commits.appendChild(notes);
            }
            if (data.download_size) {
                var size = document.createElement('div');
                size.className = 'update-download-size';
                var mb = (data.download_size / 1024 / 1024).toFixed(1);
                size.textContent = 'Download size: ' + mb + ' MB';
                commits.appendChild(size);
            }
            btn.textContent = 'Download Update';
        } else {
            info.textContent = data.commits_behind + ' new commit' +
                (data.commits_behind !== 1 ? 's' : '') + ' available';
            if (data.commit_messages && data.commit_messages.length) {
                var ul = document.createElement('ul');
                data.commit_messages.forEach(function(msg) {
                    var li = document.createElement('li');
                    li.textContent = msg;
                    ul.appendChild(li);
                });
                commits.appendChild(ul);
            }
            btn.textContent = 'Update Now';
        }
        btn.classList.remove('hidden');
        btn.disabled = false;
        document.getElementById('updateStatus').innerHTML = '';
    }

    // Check for updates on page load
    fetch('/api/update/check')
        .then(function(r) { return r.json(); })
        .then(function(data) {
            _populateUpdateUI(data);
            if (data.available) {
                brand.classList.add('has-update');
                setTimeout(function() {
                    brand.classList.remove('has-update');
                    brand.classList.add('has-update-static');
                }, 10000);
            }
        })
        .catch(function() {});

    // Show about modal (used after session ends with pending update)
    function _showUpdateModal() {
        aboutModal.classList.remove('hidden');
    }
    window._aloudShowUpdateModal = _showUpdateModal;

    // Shared: check for update (force) and populate UI
    window._aloudCheckUpdate = function(callback) {
        fetch('/api/update/check?force=1')
            .then(function(r) { return r.json(); })
            .then(function(data) {
                _populateUpdateUI(data);
                if (data.available) {
                    brand.classList.add('has-update-static');
                } else {
                    brand.classList.remove('has-update', 'has-update-static');
                }
                if (callback) callback(data);
            })
            .catch(function(err) {
                if (callback) callback(null, err);
            });
    };

    // Apply update
    document.getElementById('updateNowBtn').addEventListener('click', function() {
        // If in an active session, confirm ending it first
        if (window._aloudSessionActive && window._aloudConfirmEnd) {
            aboutModal.classList.add('hidden');
            window._aloudPendingUpdate = true;
            window._aloudConfirmEnd();
            return;
        }
        var btn = this;
        var status = document.getElementById('updateStatus');
        var data = window._aloudUpdateData;
        var isRelease = data && data.is_release;
        var defaultLabel = isRelease ? 'Download Update' : 'Update Now';
        btn.disabled = true;
        btn.textContent = isRelease ? 'Downloading...' : 'Updating...';
        status.innerHTML = '';
        status.className = 'update-status';

        var fetchOpts = { method: 'POST' };
        if (isRelease) {
            fetchOpts.headers = { 'Content-Type': 'application/json' };
            fetchOpts.body = JSON.stringify({
                download_url: data.download_url,
                asset_name: data.asset_name,
            });
        }

        fetch('/api/update/apply', fetchOpts)
            .then(function(r) { return r.json(); })
            .then(function(result) {
                if (result.success) {
                    status.textContent = result.message;
                    status.classList.add('update-success');
                    brand.classList.remove('has-update', 'has-update-static');
                    if (result.needs_restart) {
                        btn.textContent = 'Close';
                        btn.disabled = false;
                        btn.onclick = function() {
                            fetch('/api/close-window', { method: 'POST' })
                                .finally(function() { window.close(); });
                        };
                    }
                } else {
                    status.textContent = result.message;
                    status.classList.add('update-error');
                    btn.textContent = defaultLabel;
                    btn.disabled = false;
                }
            })
            .catch(function() {
                status.textContent = 'Update failed. Check your connection.';
                status.classList.add('update-error');
                btn.textContent = defaultLabel;
                btn.disabled = false;
            });
    });
})();

// ---- Fullscreen toggle ----
(function() {
    var fsBtn = document.getElementById('fullscreenToggle');
    var isDesktop = false;
    var desktopExpanded = false;
    var expandSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    var contractSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    function updateIcon() {
        var expanded = isDesktop ? desktopExpanded : !!document.fullscreenElement;
        fsBtn.innerHTML = expanded ? contractSvg : expandSvg;
    }
    updateIcon();
    document.addEventListener('fullscreenchange', updateIcon);
    fsBtn.addEventListener('click', function() {
        fetch('/api/toggle-fullscreen', { method: 'POST' }).then(function(r) {
            if (r.ok) {
                isDesktop = true;
                desktopExpanded = !desktopExpanded;
                updateIcon();
            }
        }).catch(function() {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().catch(function() {});
            } else {
                document.exitFullscreen().catch(function() {});
            }
        });
    });
})();

// ---- Window close button (pywebview) ----
(function() {
    var closeBtn = document.getElementById('windowCloseBtn');

    function initCloseBtn() {
        if (!closeBtn || closeBtn.dataset.init) return;
        closeBtn.dataset.init = '1';
        closeBtn.classList.remove('hidden');
        closeBtn.addEventListener('click', function() {
            if (window._aloudSessionActive) {
                if (!confirm('End session and close aloud?')) return;
            }
            fetch('/api/close-window', { method: 'POST' });
        });
    }

    // pywebview injects window.pywebview asynchronously — check now and on ready event
    if (closeBtn && window.pywebview) {
        initCloseBtn();
    } else if (closeBtn) {
        window.addEventListener('pywebviewready', initCloseBtn);
    }

    // Prevent accidental close during active session (browser tab / Cmd+W)
    window.addEventListener('beforeunload', function(e) {
        if (window._aloudSessionActive) {
            e.preventDefault();
        }
    });
})();

// ---- External link forwarding (pywebview) ----
(function() {
    function init() {
        document.addEventListener('click', function(e) {
            var a = e.target.closest('a[href]');
            if (!a) return;
            var href = a.getAttribute('href');
            if (href && (href.startsWith('mailto:') || a.target === '_blank')) {
                e.preventDefault();
                fetch('/api/open-url', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({url: href})
                });
            }
        });
    }
    if (window.pywebview) init();
    else window.addEventListener('pywebviewready', init);
})();

// ---- Theme toggle (with easter egg) ----
(function() {
    var THEME_TTL = 4 * 60 * 60 * 1000;
    var btn = document.getElementById('themeToggle');
    function updateIcon() {
        var theme = document.documentElement.getAttribute('data-theme');
        btn.innerHTML = theme === 'dark'
            ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
            : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    }
    updateIcon();
    var themeClicks = [];
    btn.addEventListener('click', function() {
        var current = document.documentElement.getAttribute('data-theme');
        var next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('theme', JSON.stringify({ value: next, ts: Date.now() }));
        updateIcon();
        // Easter egg: 8 toggles in 4 seconds
        var now = Date.now();
        themeClicks.push(now);
        if (themeClicks.length >= 8) {
            if (now - themeClicks[themeClicks.length - 8] < 4000) {
                themeClicks = [];
                var u = new SpeechSynthesisUtterance('the system... is down...');
                var savedVoiceName = localStorage.getItem('aloud-voice');
                if (savedVoiceName) {
                    var voices = speechSynthesis.getVoices();
                    for (var vi = 0; vi < voices.length; vi++) {
                        if (voices[vi].name === savedVoiceName) { u.voice = voices[vi]; break; }
                    }
                }
                var savedSpeed = localStorage.getItem('aloud-speed');
                if (savedSpeed) u.rate = parseInt(savedSpeed) / 180;
                speechSynthesis.speak(u);
            }
        }
        if (themeClicks.length > 8) themeClicks = themeClicks.slice(-8);
    });
    // Listen for system preference changes (only if no manual or settings override)
    if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
            var mode = localStorage.getItem('themeMode');
            if (mode === 'dark' || mode === 'light') return;
            var raw = localStorage.getItem('theme');
            var hasOverride = false;
            if (raw) {
                try {
                    var parsed = JSON.parse(raw);
                    hasOverride = parsed.ts && (Date.now() - parsed.ts < THEME_TTL);
                } catch(ex) {}
            }
            if (!hasOverride) {
                document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
                updateIcon();
            }
        });
    }
})();

// ---- Mobile bottom-nav "More" sheet ----
// Surfaces theme/fullscreen/about/close on phone. Sheet buttons proxy clicks
// to the existing top-nav buttons (single source of truth for handlers — they
// remain in the DOM even when the top nav is hidden on mobile).
(function() {
    var sheet = document.getElementById('mobileMoreSheet');
    if (!sheet) return;

    function open() { sheet.classList.remove('hidden'); }
    function close() { sheet.classList.add('hidden'); }

    // Any element with data-mobile-more-open opens the sheet.
    // Used by the bottom-nav More button on non-session pages and
    // by the floating hamburger on the session page.
    document.addEventListener('click', function(e) {
        if (e.target.closest('[data-mobile-more-open]')) {
            e.preventDefault();
            open();
        }
    });

    sheet.addEventListener('click', function(e) {
        if (e.target.closest('[data-mobile-more-close]')) {
            close();
            return;
        }
        // data-action: call a named function on window. Used for
        // session-aware actions (End / History) that need to run
        // confirm + save flows, not just toggle a visible control.
        var actionEl = e.target.closest('[data-action]');
        if (actionEl) {
            var fn = window[actionEl.getAttribute('data-action')];
            close();
            if (typeof fn === 'function') fn();
            return;
        }
        // data-proxy-click: forward the click to a real button
        // elsewhere in the DOM. Used for stateless toggles
        // (Theme, Fullscreen, About, Close).
        var proxy = e.target.closest('[data-proxy-click]');
        if (proxy) {
            var targetId = proxy.getAttribute('data-proxy-click');
            var target = document.getElementById(targetId);
            close();
            if (target) target.click();
        }
    });

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && !sheet.classList.contains('hidden')) close();
    });
})();

// ---- Service worker registration (PWA offline shell) ----
// Skipped in pywebview so the in-app updater (which depends on fresh HTML
// from a Flask reload) is never sitting behind a SW cache. pywebview
// injects window.pywebview asynchronously, so we wait briefly for it
// before deciding.
(function() {
    if (!('serviceWorker' in navigator)) return;

    function register() {
        if (window.pywebview) return;
        navigator.serviceWorker.register('/sw.js').catch(function() {
            // Registration failure is non-fatal; the app still works
            // online without offline shell caching.
        });
    }

    if (document.readyState === 'complete') {
        setTimeout(register, 500);
    } else {
        window.addEventListener('load', function() { setTimeout(register, 500); });
    }
})();

// ---- Client-side navigation ----
// Swap <main> + page scripts without tearing down the nav.
(function() {
    var NAV_ROUTES = ['/', '/history', '/settings'];

    function isNavRoute(url) {
        return NAV_ROUTES.indexOf(url) !== -1;
    }

    function activateScripts(container) {
        // Scripts inserted via innerHTML don't execute — replace with fresh elements
        var scripts = container.querySelectorAll('script');
        for (var i = 0; i < scripts.length; i++) {
            var old = scripts[i];
            var fresh = document.createElement('script');
            for (var j = 0; j < old.attributes.length; j++) {
                var attr = old.attributes[j];
                var val = attr.value;
                // Cache-bust module src so the browser re-executes it
                if (attr.name === 'src' && old.type === 'module') {
                    val += (val.indexOf('?') === -1 ? '?' : '&') + '_t=' + Date.now();
                }
                fresh.setAttribute(attr.name, val);
            }
            if (old.textContent) fresh.textContent = old.textContent;
            old.parentNode.replaceChild(fresh, old);
        }
    }

    function navigate(url, addToHistory) {
        fetch(url)
            .then(function(r) { return r.text(); })
            .then(function(html) {
                var doc = new DOMParser().parseFromString(html, 'text/html');

                // Swap main content
                document.querySelector('.main').innerHTML =
                    doc.querySelector('.main').innerHTML;

                // Swap page scripts (and re-execute them)
                var oldScripts = document.getElementById('page-scripts');
                var newScripts = doc.getElementById('page-scripts');
                if (oldScripts && newScripts) {
                    oldScripts.innerHTML = newScripts.innerHTML;
                    activateScripts(oldScripts);
                }

                // Update nav active state (top + bottom)
                var links = document.querySelectorAll('.nav-links a[href]');
                for (var i = 0; i < links.length; i++) {
                    var href = links[i].getAttribute('href');
                    if (isNavRoute(href)) {
                        links[i].classList.toggle('nav-active', href === url);
                    }
                }
                var bottomLinks = document.querySelectorAll('.bottom-nav a[href]');
                for (var k = 0; k < bottomLinks.length; k++) {
                    var bhref = bottomLinks[k].getAttribute('href');
                    if (isNavRoute(bhref)) {
                        bottomLinks[k].classList.toggle('bottom-nav-active', bhref === url);
                    }
                }

                document.title = doc.title;
                if (addToHistory !== false) history.pushState({}, '', url);
                window.scrollTo(0, 0);
            })
            .catch(function() {
                // Fetch failed — fall back to regular navigation
                window.location.href = url;
            });
    }

    // Intercept nav-link clicks to nav routes (top nav + bottom nav)
    document.addEventListener('click', function(e) {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        var a = e.target.closest('.nav-links a[href], .bottom-nav a[href]');
        if (!a) return;
        var href = a.getAttribute('href');
        if (!isNavRoute(href) || href === location.pathname) return;
        e.preventDefault();
        // During an active session, run the end-session confirm flow
        // instead of SPA-navigating away — otherwise the session keeps
        // running in the background.
        if (window._aloudSessionActive && window._aloudRequestEndSession) {
            window._aloudRequestEndSession(href);
            return;
        }
        navigate(href);
    });

    // Back/forward — only SPA-navigate if we still have standard nav links
    window.addEventListener('popstate', function() {
        if (!isNavRoute(location.pathname)) return;
        if (!document.querySelector('.nav-links a[href="/"]')) {
            window.location.reload();
            return;
        }
        navigate(location.pathname, false);
    });
})();
