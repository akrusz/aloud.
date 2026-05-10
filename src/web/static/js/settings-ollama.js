/* Settings page — Ollama-specific UI and actions.
   Extracted from settings.js. Owns the recommended-tiers list rendering
   and the pull/remove/restart/upgrade flows. */

let _modelSelectEl = null;
let _recEl = null;

function _refresh() {
    if (_modelSelectEl && _recEl) loadOllamaModels(_modelSelectEl, _recEl);
}

function removeOllamaModel(model, btn) {
    if (!confirm('Remove ' + model + '?\n\nThis will delete the model from disk. You can re-download it later.')) {
        return;
    }
    btn.disabled = true;
    btn.textContent = 'Removing...';
    fetch('/api/ollama/delete', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({model: model}),
    }).then(function(resp) {
        return resp.json();
    }).then(function(data) {
        if (data.error) {
            btn.textContent = 'Error';
            btn.disabled = false;
            alert('Failed to remove model: ' + data.error);
        } else {
            _refresh();
        }
    }).catch(function() {
        btn.textContent = 'Error';
        btn.disabled = false;
    });
}

function restartOllama(btn) {
    const progressEl = document.getElementById('ollama-upgrade-progress');
    const statusEl = progressEl ? progressEl.querySelector('.ollama-pull-status') : null;

    btn.disabled = true;
    btn.textContent = 'Restarting...';
    if (progressEl) progressEl.classList.remove('hidden');
    if (statusEl) statusEl.textContent = 'Stopping...';

    fetch('/api/ollama/restart', { method: 'POST' }).then(function(resp) {
        if (!resp.ok) {
            btn.disabled = false;
            btn.textContent = 'Restart Ollama';
            if (statusEl) statusEl.textContent = 'Restart failed.';
            return;
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let restartFailed = false;

        function read() {
            reader.read().then(function(result) {
                if (result.done) {
                    if (!restartFailed) {
                        // Pull fresh provider info to clear the banner if the new version is current.
                        setTimeout(_refresh, 250);
                    }
                    return;
                }
                buffer += decoder.decode(result.value, {stream: true});
                const lines = buffer.split('\n');
                buffer = lines.pop();
                lines.forEach(function(line) {
                    if (!line.trim()) return;
                    try {
                        const obj = JSON.parse(line);
                        if (obj.status === 'error') {
                            restartFailed = true;
                            btn.disabled = false;
                            btn.textContent = 'Restart Ollama';
                            if (statusEl) statusEl.textContent = obj.error || 'Restart failed';
                            return;
                        }
                        if (obj.status === 'done') {
                            btn.textContent = 'Restarted';
                            if (statusEl) statusEl.textContent = obj.message || 'Ollama is back up.';
                        } else if (obj.status) {
                            if (statusEl) statusEl.textContent = obj.status;
                        }
                    } catch (e) {}
                });
                read();
            });
        }
        read();
    }).catch(function() {
        btn.disabled = false;
        btn.textContent = 'Restart Ollama';
        if (statusEl) statusEl.textContent = 'Connection failed';
    });
}

function upgradeOllama(btn) {
    const progressEl = document.getElementById('ollama-upgrade-progress');
    const statusEl = progressEl ? progressEl.querySelector('.ollama-pull-status') : null;

    btn.disabled = true;
    btn.textContent = 'Upgrading...';
    if (progressEl) progressEl.classList.remove('hidden');
    if (statusEl) statusEl.textContent = 'Starting...';

    fetch('/api/ollama/upgrade', { method: 'POST' }).then(function(resp) {
        // 400 with download_url means there's no automatic path on this platform.
        if (!resp.ok) {
            return resp.json().then(function(data) {
                if (data.download_url) {
                    window.open(data.download_url, '_blank', 'noopener');
                    if (statusEl) statusEl.textContent = data.error || 'Opened the Ollama download page.';
                } else if (statusEl) {
                    statusEl.textContent = data.error || 'Upgrade failed.';
                }
                btn.disabled = false;
                btn.textContent = 'Update Ollama';
            });
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let upgradeFailed = false;

        function read() {
            reader.read().then(function(result) {
                if (result.done) {
                    if (upgradeFailed) return;
                    btn.textContent = 'Done';
                    if (statusEl) {
                        statusEl.textContent = 'Upgrade complete. Restarting Ollama...';
                    }
                    // Auto-chain into restart so the running daemon picks up
                    // the new version — otherwise the banner would still show
                    // the old version even after a successful brew upgrade.
                    const restartBtn = document.getElementById('btn-ollama-restart');
                    if (restartBtn && !restartBtn.disabled) {
                        restartOllama(restartBtn);
                    }
                    return;
                }
                buffer += decoder.decode(result.value, {stream: true});
                const lines = buffer.split('\n');
                buffer = lines.pop();
                lines.forEach(function(line) {
                    if (!line.trim()) return;
                    try {
                        const obj = JSON.parse(line);
                        if (obj.status === 'error') {
                            upgradeFailed = true;
                            btn.textContent = 'Update Ollama';
                            btn.disabled = false;
                            if (statusEl) statusEl.textContent = obj.error || 'Upgrade failed';
                            return;
                        }
                        if (obj.status === 'done' && obj.message) {
                            if (statusEl) statusEl.textContent = obj.message;
                        } else if (obj.status) {
                            if (statusEl) statusEl.textContent = obj.status;
                        }
                    } catch (e) {}
                });
                read();
            });
        }
        read();
    }).catch(function() {
        btn.disabled = false;
        btn.textContent = 'Update Ollama';
        if (statusEl) statusEl.textContent = 'Connection failed';
    });
}

function pullOllamaModel(model, btn) {
    const safeId = model.replace(/[:.]/g, '-');
    const progressEl = document.getElementById('pull-progress-' + safeId);
    const barFill = progressEl ? progressEl.querySelector('.ollama-pull-bar-fill') : null;
    const statusEl = progressEl ? progressEl.querySelector('.ollama-pull-status') : null;

    btn.disabled = true;
    btn.textContent = 'Downloading...';
    if (progressEl) progressEl.classList.remove('hidden');

    let pullFailed = false;
    fetch('/api/ollama/pull', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({model: model}),
    }).then(function(resp) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        function read() {
            reader.read().then(function(result) {
                if (result.done) {
                    if (pullFailed) return;
                    btn.textContent = 'Done';
                    if (statusEl) statusEl.textContent = 'Complete';
                    if (barFill) barFill.style.width = '100%';
                    setTimeout(_refresh, 500);
                    return;
                }
                buffer += decoder.decode(result.value, {stream: true});
                const lines = buffer.split('\n');
                buffer = lines.pop(); // keep incomplete line
                lines.forEach(function(line) {
                    if (!line.trim()) return;
                    try {
                        const obj = JSON.parse(line);
                        if (obj.status === 'error') {
                            pullFailed = true;
                            btn.textContent = 'Error';
                            btn.disabled = false;
                            if (statusEl) statusEl.textContent = obj.error || 'Pull failed';
                            return;
                        }
                        if (obj.total && obj.completed != null) {
                            const pct = Math.round((obj.completed / obj.total) * 100);
                            if (barFill) barFill.style.width = pct + '%';
                            const dlMB = (obj.completed / (1024 * 1024)).toFixed(0);
                            const totalMB = (obj.total / (1024 * 1024)).toFixed(0);
                            if (statusEl) statusEl.textContent = dlMB + ' / ' + totalMB + ' MB';
                        } else if (obj.status) {
                            if (statusEl) statusEl.textContent = obj.status;
                        }
                    } catch (e) {}
                });
                read();
            });
        }
        read();
    }).catch(function() {
        btn.textContent = 'Error';
        btn.disabled = false;
        if (statusEl) statusEl.textContent = 'Connection failed';
    });
}

// Fetch /api/providers and render the Ollama model picker + recommended tiers
// into the given <select> and recommendation container.
export function loadOllamaModels(modelSelect, recEl) {
    _modelSelectEl = modelSelect;
    _recEl = recEl;

    fetch('/api/providers')
        .then(function(r) { return r.json(); })
        .then(function(data) {
            const info = data.ollama || {};
            const models = info.models || [];
            const rec = info.recommendation || {};
            modelSelect.innerHTML = '';
            if (models.length === 0) {
                modelSelect.innerHTML = '<option value="">No models available</option>';
            } else {
                // Build a set of tier models for labeling
                const tierLabels = {};
                (rec.tiers || []).forEach(function(t) {
                    tierLabels[t.model] = t.label;
                });
                models.forEach(function(m) {
                    const opt = document.createElement('option');
                    opt.value = m;
                    const label = tierLabels[m];
                    opt.textContent = label ? m + ' (' + label + ')' : m;
                    modelSelect.appendChild(opt);
                });
            }
            // Show recommendation with download buttons
            if (recEl && rec.tiers) {
                let html = '';
                if (info.outdated) {
                    html += '<div class="ollama-outdated-banner" id="ollama-outdated-banner">';
                    html += '<div class="ollama-outdated-message">';
                    html += 'Your Ollama (v' + (info.version || '?') + ') is outdated and may not be able to download recent models. ';
                    html += 'Minimum recommended: v' + (info.min_version || '') + '. ';
                    html += 'After updating, the running daemon needs a restart to take effect.';
                    html += '</div>';
                    html += '<div class="ollama-outdated-actions">';
                    html += '<button type="button" class="btn-ollama" id="btn-ollama-upgrade">Update Ollama</button>';
                    html += '<button type="button" class="btn-ollama" id="btn-ollama-restart">Restart Ollama</button>';
                    html += '</div>';
                    html += '<div class="ollama-pull-progress hidden" id="ollama-upgrade-progress">';
                    html += '<span class="ollama-pull-status"></span>';
                    html += '</div>';
                    html += '</div>';
                }
                if (rec.ram_gb) {
                    html += '<div style="margin-bottom:0.5rem">Your system has ' + rec.ram_gb + 'GB RAM.</div>';
                }
                html += '<div class="ollama-tiers">';
                rec.tiers.forEach(function(t) {
                    // Hide tiers the system can't run, when RAM is known.
                    // (If RAM detection failed, show everything so the user can choose.)
                    if (rec.ram_gb && t.fits === false) return;
                    const isRec = t.model === rec.recommended_model;
                    const sizeText = t.download + ' download, ' + t.ram + ' in memory';
                    const recBadge = isRec ? ' <span class="ollama-rec-badge">recommended</span>' : '';

                    html += '<div class="ollama-tier-row' + (isRec ? ' ollama-tier-recommended' : '') + '">';
                    html += '<div class="ollama-tier-info">';
                    html += '<strong>' + t.model + '</strong> — ' + t.label + recBadge;
                    html += '<div class="ollama-tier-size">' + sizeText + '</div>';
                    if (t.note) {
                        html += '<div class="ollama-tier-note">' + t.note + '</div>';
                    }
                    html += '</div>';

                    if (t.installed) {
                        html += '<div class="ollama-tier-actions">';
                        html += '<span class="ollama-tier-installed">Installed</span>';
                        html += '<button type="button" class="btn-ollama btn-ollama-remove" data-model="' + t.model + '">Remove</button>';
                        html += '</div>';
                    } else {
                        html += '<button type="button" class="btn-ollama btn-ollama-pull" data-model="' + t.model + '">Download</button>';
                    }
                    html += '<div class="ollama-pull-progress hidden" id="pull-progress-' + t.model.replace(/[:.]/g, '-') + '">';
                    html += '<div class="ollama-pull-bar"><div class="ollama-pull-bar-fill"></div></div>';
                    html += '<span class="ollama-pull-status"></span>';
                    html += '</div>';
                    html += '</div>';
                });
                html += '</div>';

                // Other installed Ollama models the user pulled themselves
                const others = rec.other_installed || [];
                if (others.length) {
                    html += '<div class="ollama-others-heading">Other installed models</div>';
                    html += '<div class="ollama-tiers">';
                    others.forEach(function(o) {
                        const sizeText = o.size ? o.size + ' on disk' : '';
                        html += '<div class="ollama-tier-row">';
                        html += '<div class="ollama-tier-info">';
                        html += '<strong>' + o.model + '</strong>';
                        if (sizeText) {
                            html += '<div class="ollama-tier-size">' + sizeText + '</div>';
                        }
                        html += '</div>';
                        html += '<div class="ollama-tier-actions">';
                        html += '<span class="ollama-tier-installed">Installed</span>';
                        html += '<button type="button" class="btn-ollama btn-ollama-remove" data-model="' + o.model + '">Remove</button>';
                        html += '</div>';
                        html += '</div>';
                    });
                    html += '</div>';
                }

                recEl.innerHTML = html;

                // Attach download handlers
                recEl.querySelectorAll('.btn-ollama-pull').forEach(function(btn) {
                    btn.addEventListener('click', function() { pullOllamaModel(btn.dataset.model, btn); });
                });
                // Attach remove handlers
                recEl.querySelectorAll('.btn-ollama-remove').forEach(function(btn) {
                    btn.addEventListener('click', function() { removeOllamaModel(btn.dataset.model, btn); });
                });
                // Attach upgrade/restart handlers (only present when info.outdated)
                const upgradeBtn = document.getElementById('btn-ollama-upgrade');
                if (upgradeBtn) {
                    upgradeBtn.addEventListener('click', function() { upgradeOllama(upgradeBtn); });
                }
                const restartBtn = document.getElementById('btn-ollama-restart');
                if (restartBtn) {
                    restartBtn.addEventListener('click', function() { restartOllama(restartBtn); });
                }
            } else if (recEl) {
                recEl.innerHTML = '';
            }
        })
        .catch(function() {
            modelSelect.innerHTML = '<option value="">Could not fetch models</option>';
        });
}
