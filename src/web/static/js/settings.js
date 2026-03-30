// Settings page — extracted from inline <script> in settings.html

import {
    scoreVoiceName, buildScoredVoiceList, renderVoiceList,
    updateVoiceSelection, previewVoice as sharedPreview, stopPreview,
    getSavedVoice, setSavedVoice, getSavedSpeed, setSavedSpeed,
} from './voice-picker.js';

const settingsDataEl = document.getElementById('settings-data');
const firstRun = settingsDataEl.dataset.firstRun === 'true';
const isFrozen = settingsDataEl.dataset.frozen === 'true';
const piperAvailable = settingsDataEl.dataset.piperAvailable === 'true';

// Clear client-side state on fresh/first-run so prompts re-appear
if (firstRun) {
    localStorage.removeItem('glooow-voice');
    localStorage.removeItem('glooow-speed');
    localStorage.removeItem('glooow-embers');
    localStorage.removeItem('glooow-voice-quality-prompted-permanent');
    localStorage.removeItem('glooow-tour-dismissed');
}
const form = document.getElementById('settings-form');
const providerSelect = document.getElementById('s-provider');
const modelSelect = document.getElementById('s-model');
const ttsEngineSelect = document.getElementById('s-tts-engine');
const savedEl = document.getElementById('settings-saved');
const errorEl = document.getElementById('settings-error');
const voiceBtn = document.getElementById('s-voice-btn');
const voiceModal = document.getElementById('settings-voice-modal');
const voiceModalList = document.getElementById('settings-voice-modal-list');
const voiceModalClose = document.getElementById('settings-voice-modal-close');

// Text scale — live preview via style preview panel
const textScaleSlider = document.getElementById('s-text-scale');
const textScaleLabel = document.getElementById('s-text-scale-label');
const textScalePreviewInner = document.getElementById('text-scale-preview-inner');

textScaleSlider.addEventListener('input', function() {
    const scale = parseFloat(textScaleSlider.value);
    textScaleLabel.textContent = Math.round(scale * 100) + '%';
    textScalePreviewInner.style.fontSize = (18 * scale) + 'px';
});

// TTS engine hints
var _openSettingsLink = ' <a href="#" onclick="fetch(\'/api/open-voice-settings\',{method:\'POST\'}); return false;">Download Premium voices</a>';
const TTS_ENGINE_HINTS = {
    macos: 'Built-in macOS voices. Zero latency, works offline.' + (/Mac/.test(navigator.platform) ? _openSettingsLink : ''),
    browser: "Uses your browser's built-in speech synthesis. Quality varies by browser.",
    elevenlabs: "Cloud neural TTS with natural, expressive voices. Requires an API key and internet.",
    piper: 'Fast local neural TTS. Download voice models (~60\u2013100 MB each) from the voice picker. <a href="https://rhasspy.github.io/piper-samples/" target="_blank" rel="noopener">Listen to samples</a>',
};
const ttsEngineHintEl = document.getElementById('s-tts-engine-hint');

function updateTtsEngineHint() {
    var hint = TTS_ENGINE_HINTS[ttsEngineSelect.value] || '';
    ttsEngineHintEl.innerHTML = hint;
}



// Voice state
let serverVoices = [];
let scoredVoices = [];
let selectedVoiceName = getSavedVoice() || '';

function openVoiceModal() {
    renderVoiceList(voiceModalList, scoredVoices, selectedVoiceName, { showUninstall: true, showEngine: true });
    voiceModal.classList.remove('hidden');
}

function selectSettingsVoice(name) {
    selectedVoiceName = name;
    voiceBtn.textContent = name + ' \u00b7 ' + rateSlider.value + ' wpm';
    updateVoiceSelection(voiceModalList, name);
    _syncEngineFromVoice();
}

// Speed slider in voice modal
const rateSlider = document.getElementById('s-tts-rate');
const rateLabel = document.getElementById('s-tts-rate-label');
function updateRateDisplay() {
    rateLabel.textContent = rateSlider.value + ' wpm';
    if (selectedVoiceName) {
        voiceBtn.textContent = selectedVoiceName + ' \u00b7 ' + rateSlider.value + ' wpm';
    } else {
        voiceBtn.textContent = 'Choose a voice';
    }
}
rateSlider.addEventListener('input', updateRateDisplay);

// Voice modal events
let settingsNoVoicesMode = false;
var configLoaded = false;
var tourActive = false;
var vqModalShown = false;
var VQ_PROMPTED_KEY = 'glooow-voice-quality-prompted';
voiceBtn.addEventListener('click', function() {
    if (!settingsNoVoicesMode) openVoiceModal();
});
voiceModalClose.addEventListener('click', function() {
    stopPreview();
    voiceModal.classList.add('hidden');
});
voiceModal.addEventListener('click', function(e) {
    if (e.target === voiceModal) { stopPreview(); voiceModal.classList.add('hidden'); }
});
voiceModalList.addEventListener('click', function(e) {
    const dlBtn = e.target.closest('.voice-row-download');
    if (dlBtn) {
        e.stopPropagation();
        downloadTtsModel(dlBtn.dataset.engine || ttsEngineSelect.value, dlBtn.dataset.voiceName, dlBtn);
        return;
    }
    const unBtn = e.target.closest('.voice-row-uninstall');
    if (unBtn) {
        e.stopPropagation();
        uninstallVoice(unBtn.dataset.engine, unBtn.dataset.voiceName, unBtn);
        return;
    }
    const previewBtn = e.target.closest('.voice-row-preview');
    if (previewBtn) {
        e.stopPropagation();
        if (previewBtn.classList.contains('preview-unavailable')) {
            _showPreviewHint(previewBtn.closest('.voice-row'));
            return;
        }
        sharedPreview(previewBtn.dataset.voiceName, rateSlider.value);
        return;
    }
    const row = e.target.closest('.voice-row');
    if (row) {
        if (row.classList.contains('voice-row-locked')) return;
        selectSettingsVoice(row.dataset.voiceName);
    }
});

var _previewHintEl = null;
function _showPreviewHint(row) {
    // Remove any existing hint
    if (_previewHintEl) { _previewHintEl.remove(); _previewHintEl = null; }
    var hint = document.createElement('div');
    hint.className = 'voice-preview-tooltip';
    hint.innerHTML = 'Download to preview in-app. <a href="https://rhasspy.github.io/piper-samples/" target="_blank" rel="noopener">Listen online</a>';
    row.style.position = 'relative';
    row.appendChild(hint);
    _previewHintEl = hint;
    setTimeout(function() { if (hint.parentNode) { hint.remove(); _previewHintEl = null; } }, 4000);
}

function downloadTtsModel(engine, voice, btn) {
    const row = btn.closest('.voice-row');
    btn.disabled = true;
    btn.textContent = 'Downloading\u2026';

    // Replace size badge with progress bar
    const sizeEl = row.querySelector('.voice-row-size');
    var progressEl = document.createElement('span');
    progressEl.className = 'voice-row-progress';
    progressEl.innerHTML = '<span class="dl-bar"><span class="dl-bar-fill"></span></span><span class="dl-status">0%</span>';
    if (sizeEl) sizeEl.replaceWith(progressEl);

    const barFill = progressEl.querySelector('.dl-bar-fill');
    const statusEl = progressEl.querySelector('.dl-status');

    fetch('/api/tts/download-model', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({engine: engine, voice: voice}),
    }).then(function(resp) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        function read() {
            reader.read().then(function(result) {
                if (result.done) {
                    onComplete();
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
                            btn.textContent = 'Error';
                            btn.disabled = false;
                            statusEl.textContent = obj.error || 'Failed';
                            return;
                        }
                        if (obj.status === 'done' || obj.status === 'already_downloaded') {
                            onComplete();
                            return;
                        }
                        if (obj.total && obj.completed != null) {
                            const pct = Math.round((obj.completed / obj.total) * 100);
                            barFill.style.width = pct + '%';
                            const dlMB = (obj.completed / (1024 * 1024)).toFixed(0);
                            const totalMB = (obj.total / (1024 * 1024)).toFixed(0);
                            statusEl.textContent = dlMB + '/' + totalMB + ' MB';
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
        statusEl.textContent = 'Connection failed';
    });

    var completed = false;
    function onComplete() {
        if (completed) return;
        completed = true;
        if (btn.parentNode) btn.remove();
        if (progressEl.parentNode) progressEl.remove();
        row.classList.remove('voice-row-locked');
        var preview = row.querySelector('.voice-row-preview');
        if (preview) {
            preview.classList.remove('preview-unavailable');
            preview.title = '';
        }
        // Refresh voice list so global state reflects the download
        setTimeout(fetchVoices, 500);
    }
}

function uninstallVoice(engine, voice, btn) {
    btn.disabled = true;
    btn.textContent = 'Removing\u2026';
    fetch('/api/tts/uninstall-model', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({engine: engine, voice: voice}),
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
        if (data.status === 'removed') {
            if (selectedVoiceName === voice) {
                selectedVoiceName = '';
                updateRateDisplay();
            }
            setTimeout(fetchVoices, 300);
        } else {
            btn.disabled = false;
            btn.textContent = 'Uninstall';
        }
    })
    .catch(function() {
        btn.disabled = false;
        btn.textContent = 'Uninstall';
    });
}

// Fetch all available voices (aggregated from all engines)
function fetchVoices() {
    const lang = document.getElementById('s-language').value || 'en';
    fetch('/api/voices?lang=' + encodeURIComponent(lang))
        .then(function(r) { return r.json(); })
        .then(function(voices) {
            serverVoices = voices;
            scoredVoices = buildScoredVoiceList(voices, false);
            // If current voice isn't available (missing or not downloaded), pick another
            let found = false;
            for (let i = 0; i < scoredVoices.length; i++) {
                if (scoredVoices[i].name === selectedVoiceName) {
                    found = !scoredVoices[i].needsDownload || scoredVoices[i].downloaded;
                    break;
                }
            }
            if (!found) {
                // Pick the first selectable voice (skip undownloaded)
                selectedVoiceName = '';
                for (let i = 0; i < scoredVoices.length; i++) {
                    if (!scoredVoices[i].needsDownload || scoredVoices[i].downloaded) {
                        selectedVoiceName = scoredVoices[i].name;
                        break;
                    }
                }
                updateRateDisplay();
            }
            // Auto-set engine from voice
            _syncEngineFromVoice();
            updateVoiceBtnState();
            if (configLoaded) checkVoiceQuality();
        })
        .catch(function() {});
}

function _syncEngineFromVoice() {
    if (!selectedVoiceName) return;
    for (var i = 0; i < scoredVoices.length; i++) {
        if (scoredVoices[i].name === selectedVoiceName && scoredVoices[i].engine) {
            ttsEngineSelect.value = scoredVoices[i].engine;
            showGroupsFor(ttsEngineSelect, ttsKeyGroups);
            return;
        }
    }
}

var NO_VOICES_HELP = {
    macos: 'No macOS voices found. Check System Settings \u2192 Accessibility \u2192 Spoken Content.',
    browser: 'Your browser has no speechSynthesis voices. Try Chrome or Edge for better support.',
    elevenlabs: 'Add your ElevenLabs API key below to load voices.',
};

// Engines that can be pip-installed from the UI
var TTS_INSTALLABLE = {};

var ttsInstallSection = document.getElementById('s-tts-install');
var ttsInstallRow = document.getElementById('s-tts-install-row');
var ttsInstallDone = document.getElementById('install-done-tts');

function updateVoiceBtnState() {
    // Remove any lingering warning banner
    var banner = document.querySelector('.no-voices-banner');
    if (banner) banner.remove();

    if (scoredVoices.length === 0) {
        settingsNoVoicesMode = true;
        voiceBtn.classList.add('no-voices');
        voiceBtn.textContent = '\u26a0 No voices';
        voiceBtn.title = '';
    } else {
        settingsNoVoicesMode = false;
        voiceBtn.classList.remove('no-voices');
        voiceBtn.title = '';
        updateRateDisplay();
    }
}

updateTtsEngineHint();

// Refresh voices when language changes
document.getElementById('s-language').addEventListener('change', fetchVoices);

// Map provider to which API key group to show
const providerKeyGroups = {
    claude_proxy: ['s-proxy-group'],
    anthropic: ['s-anthropic-key-group'],
    openai: ['s-openai-key-group'],
    openrouter: ['s-openrouter-key-group'],
    venice: ['s-venice-key-group'],
    ollama: ['s-ollama-group'],
};

const ttsKeyGroups = {
    elevenlabs: ['s-elevenlabs-key-group'],
};

function showGroupsFor(select, groupMap) {
    const section = select.closest('.settings-section');
    section.querySelectorAll('.api-key-group').forEach(function(el) { el.classList.add('hidden'); });
    const groups = groupMap[select.value] || [];
    groups.forEach(function(id) {
        const el = document.getElementById(id);
        if (el) el.classList.remove('hidden');
    });
}

function checkProxyStatus() {
    const statusEl = document.getElementById('s-proxy-status');
    const installEl = document.getElementById('s-proxy-install');
    const proxyRow = statusEl.closest('.form-row');
    if (providerSelect.value !== 'claude_proxy') {
        statusEl.innerHTML = '';
        if (proxyRow) proxyRow.classList.add('hidden');
        if (installEl) installEl.classList.add('hidden');
        return;
    }
    if (proxyRow) proxyRow.classList.remove('hidden');
    statusEl.innerHTML = 'Proxy Status: <span style="color:var(--text-muted)">Checking...</span>';
    fetch('/api/proxy/status')
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data.running) {
                statusEl.innerHTML = 'Proxy Status: <span style="color:var(--success)">Connected</span>';
                if (installEl) installEl.classList.add('hidden');
            } else if (data.installed) {
                statusEl.innerHTML = 'Proxy Status: <span style="color:var(--text-muted)">Not running </span>'
                    + '<a href="#" onclick="window.startProxyFromSettings(); return false" '
                    + 'class="btn btn-small btn-primary" '
                    + 'style="padding:0.15rem 0.6rem; font-size:0.875rem">Start</a>';
                if (installEl) installEl.classList.add('hidden');
            } else {
                statusEl.innerHTML = '';
                if (installEl) installEl.classList.remove('hidden');
            }
        })
        .catch(function() {
            statusEl.innerHTML = '';
        });
}

window.startProxyFromSettings = function() {
    const statusEl = document.getElementById('s-proxy-status');
    statusEl.innerHTML = 'Proxy Status: <span style="color:var(--text-muted)">Starting...</span>';
    fetch('/api/proxy/start', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data.ok) {
                checkProxyStatus();
                fetchModels('claude_proxy');
            } else {
                statusEl.innerHTML = '<span style="color:var(--danger)">' + data.message + '</span>';
            }
        })
        .catch(function() {
            statusEl.innerHTML = '<span style="color:var(--danger)">Failed to start</span>';
        });
};

// Shared tool install function (CLIProxyAPI, Ollama)
function installTool(tool, btn) {
    const progressEl = document.getElementById('install-progress-' + tool);
    const statusEl = progressEl ? progressEl.querySelector('.tool-install-status') : null;
    const barFill = progressEl ? progressEl.querySelector('.tool-install-bar-fill') : null;
    const doneEl = document.getElementById('install-done-' + tool);
    const rowEl = btn.closest('.tool-install-row');

    btn.disabled = true;
    btn.textContent = 'Installing...';
    if (progressEl) progressEl.classList.remove('hidden');

    if (barFill) barFill.classList.add('indeterminate');

    fetch('/api/install/' + tool, { method: 'POST' })
        .then(function(resp) {
            if (!resp.ok) {
                return resp.json().then(function(data) {
                    if (data.download_url) {
                        window.open(data.download_url, '_blank');
                    }
                    throw new Error(data.error || 'Install failed');
                });
            }

            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let hadError = false;

            function read() {
                reader.read().then(function(result) {
                    if (result.done) {
                        if (barFill) { barFill.classList.remove('indeterminate'); barFill.style.width = '100%'; }
                        if (!hadError) {
                            if (rowEl) rowEl.classList.add('hidden');
                            if (progressEl) progressEl.classList.add('hidden');
                            if (doneEl) doneEl.classList.remove('hidden');
                        }
                        // Refresh status
                        refreshSettingsProviders();
                        if (tool === 'cliproxyapi') checkProxyStatus();
                        if (tool === 'ollama') fetchModels('ollama');
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
                                hadError = true;
                                btn.textContent = 'Retry';
                                btn.disabled = false;
                                if (barFill) barFill.classList.remove('indeterminate');
                                if (statusEl) statusEl.textContent = obj.error || 'Install failed';
                                return;
                            }
                            if (statusEl && obj.status && obj.status !== 'done') {
                                statusEl.textContent = obj.status;
                            }
                        } catch (e) {}
                    });
                    read();
                });
            }
            read();
        })
        .catch(function(err) {
            btn.textContent = 'Retry';
            btn.disabled = false;
            if (statusEl) statusEl.textContent = err.message || 'Install failed';
            if (barFill) barFill.classList.remove('indeterminate');
        });
}

// Theme selector drives the preview box
(function() {
    var previewBox = document.getElementById('text-scale-preview');
    var themeSelect = document.getElementById('s-theme-mode');

    function resolveTheme(mode) {
        if (mode === 'dark' || mode === 'light') return mode;
        // Auto: derive from system or time
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
        var hour = new Date().getHours();
        return (hour >= 7 && hour < 19) ? 'light' : 'dark';
    }

    function syncPreview() {
        previewBox.setAttribute('data-preview-theme', resolveTheme(themeSelect.value));
    }
    syncPreview();

    themeSelect.addEventListener('change', syncPreview);
})();

document.getElementById('tts-info-btn').addEventListener('click', function() {
    document.getElementById('tts-info-panel').classList.toggle('hidden');
});
document.getElementById('llm-info-btn').addEventListener('click', function() {
    document.getElementById('llm-info-panel').classList.toggle('hidden');
});

document.getElementById('btn-install-cliproxyapi').addEventListener('click', function() {
    installTool('cliproxyapi', this);
});
document.getElementById('btn-install-ollama').addEventListener('click', function() {
    installTool('ollama', this);
});
document.getElementById('btn-install-tts').addEventListener('click', function() {
    var engine = ttsEngineSelect.value;
    var info = TTS_INSTALLABLE[engine];
    if (!info) return;
    var btn = this;
    // Use the shared installTool pattern but with custom completion handler
    var progressEl = document.getElementById('install-progress-tts');
    var statusEl = progressEl.querySelector('.tool-install-status');
    var barFill = progressEl.querySelector('.tool-install-bar-fill');

    btn.disabled = true;
    btn.textContent = 'Installing\u2026';
    progressEl.classList.remove('hidden');
    if (barFill) barFill.classList.add('indeterminate');

    fetch('/api/install/' + info.tool, { method: 'POST' })
        .then(function(resp) {
            if (!resp.ok) {
                return resp.json().then(function(data) {
                    btn.textContent = 'Error';
                    btn.disabled = false;
                    if (statusEl) statusEl.textContent = data.error || 'Install failed';
                    if (barFill) barFill.classList.remove('indeterminate');
                });
            }
            var reader = resp.body.getReader();
            var decoder = new TextDecoder();
            var buffer = '';
            function read() {
                reader.read().then(function(result) {
                    if (result.done) { onDone(); return; }
                    buffer += decoder.decode(result.value, {stream: true});
                    var lines = buffer.split('\n');
                    buffer = lines.pop();
                    lines.forEach(function(line) {
                        if (!line.trim()) return;
                        try {
                            var obj = JSON.parse(line);
                            if (obj.status === 'error') {
                                btn.textContent = 'Error';
                                btn.disabled = false;
                                if (statusEl) statusEl.textContent = obj.error || 'Failed';
                                return;
                            }
                            if (obj.status === 'done') { onDone(); return; }
                            if (statusEl) statusEl.textContent = obj.status;
                        } catch(e) {}
                    });
                    read();
                });
            }
            read();
        })
        .catch(function() {
            btn.textContent = 'Error';
            btn.disabled = false;
            if (statusEl) statusEl.textContent = 'Connection failed';
        });

    function onDone() {
        if (barFill) barFill.classList.remove('indeterminate');
        ttsInstallRow.classList.add('hidden');
        progressEl.classList.add('hidden');
        ttsInstallDone.classList.remove('hidden');
        // Refresh voices now that the engine is installed
        setTimeout(fetchVoices, 500);
    }
});

// Fetch system info to show/hide install buttons
fetch('/api/system-info')
    .then(function(r) { return r.json(); })
    .then(function(info) {
        if (!info.tools.ollama.installed) {
            document.getElementById('s-ollama-install').classList.remove('hidden');
        }
        // CLIProxyAPI install visibility is handled by checkProxyStatus()
        if (info.platform === 'windows') {
            const btns = document.querySelectorAll('.btn-tool-install');
            btns.forEach(function(btn) { btn.textContent = 'Download'; });
        }
    })
    .catch(function() {});

let settingsProviderStatus = {};
const providerStatusEl = document.getElementById('s-provider-status');

function applySettingsProviderAvailability() {
    for (let i = 0; i < providerSelect.options.length; i++) {
        const opt = providerSelect.options[i];
        const info = settingsProviderStatus[opt.value];
        // Strip existing markers
        opt.textContent = opt.textContent.replace(/ [\u2718\u2731]$/, '');
        opt.classList.remove('provider-unavailable');
        if (info && !info.available) {
            if (info.installed) {
                opt.textContent += ' \u2731';  // *
            } else {
                opt.classList.add('provider-unavailable');
                opt.textContent += ' \u2718';  // X
            }
        }
    }
    updateSettingsProviderHint();
}

const providerKeyInfo = {
    anthropic: { env: 'ANTHROPIC_API_KEY', url: 'https://console.anthropic.com/settings/keys', label: 'console.anthropic.com' },
    openai: { env: 'OPENAI_API_KEY', url: 'https://platform.openai.com/api-keys', label: 'platform.openai.com' },
    openrouter: { env: 'OPENROUTER_API_KEY', url: 'https://openrouter.ai/keys', label: 'openrouter.ai' },
    venice: { env: 'VENICE_API_KEY', url: 'https://venice.ai/settings/api', label: 'venice.ai' }
};

function updateSettingsProviderHint() {
    const key = providerSelect.value;
    const info = settingsProviderStatus[key];
    if (info && !info.available && key !== 'claude_proxy' && key !== 'ollama') {
        const ki = providerKeyInfo[key];
        if (ki) {
            providerStatusEl.innerHTML =
                'Add your API key above or set <code>' + ki.env + '</code> in your environment. ' +
                'See <a href="' + ki.url + '" target="_blank" rel="noopener">' + ki.label + '</a> for more.';
        } else {
            providerStatusEl.innerHTML = info.hint || '';
        }
        providerStatusEl.classList.remove('hidden');
    } else {
        providerStatusEl.classList.add('hidden');
    }
}

function refreshSettingsProviders() {
    fetch('/api/providers')
        .then(function(r) { return r.json(); })
        .then(function(data) {
            settingsProviderStatus = data;
            applySettingsProviderAvailability();
        })
        .catch(function() {});
}

providerSelect.addEventListener('change', function() {
    showGroupsFor(providerSelect, providerKeyGroups);
    fetchModels(providerSelect.value);
    checkProxyStatus();
    updateSettingsProviderHint();
});

document.getElementById('s-proxy-url-reset').addEventListener('click', function() {
    document.getElementById('s-proxy-url').value = 'http://127.0.0.1:8317';
});

ttsEngineSelect.addEventListener('change', function() {
    showGroupsFor(ttsEngineSelect, ttsKeyGroups);
    updateTtsEngineHint();
});

// LAN info display
const hostSelect = document.getElementById('s-host');
const lanInfo = document.getElementById('s-lan-info');

function updateLanInfo() {
    if (hostSelect.value !== '0.0.0.0') {
        lanInfo.classList.add('hidden');
        return;
    }
    fetch('/api/lan-info')
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (!data.ip) {
                lanInfo.classList.add('hidden');
                return;
            }
            const url = data.https_port
                ? 'https://' + data.ip + ':' + data.https_port
                : 'http://' + data.ip + ':' + data.port;
            lanInfo.innerHTML = 'Anyone on your local network can connect by using a web browser to visit <a href="#" class="lan-url">' + url + '</a>';
            lanInfo.classList.remove('hidden');
            lanInfo.querySelector('.lan-url').addEventListener('click', function(e) {
                e.preventDefault();
                navigator.clipboard.writeText(url).then(function() {
                    const link = lanInfo.querySelector('.lan-url');
                    const original = link.textContent;
                    link.textContent = 'Copied!';
                    setTimeout(function() { link.textContent = original; }, 1500);
                });
            });
        })
        .catch(function() { lanInfo.classList.add('hidden'); });
}

hostSelect.addEventListener('change', updateLanInfo);

// Stepper buttons
document.querySelectorAll('.stepper-inc, .stepper-dec').forEach(function(btn) {
    btn.addEventListener('click', function() {
        const input = document.getElementById(btn.dataset.target);
        const step = parseFloat(input.step) || 1;
        let val = parseFloat(input.value) || 0;
        const min = parseFloat(input.min);
        const max = parseFloat(input.max);
        if (btn.classList.contains('stepper-inc')) {
            val = Math.min(val + step, max);
        } else {
            val = Math.max(val - step, min);
        }
        // Avoid floating point artifacts
        input.value = parseFloat(val.toFixed(1));
    });
});

// Remove a pulled Ollama model (with confirmation)
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
            // Refresh the model list and tiers
            fetchModels('ollama');
        }
    }).catch(function() {
        btn.textContent = 'Error';
        btn.disabled = false;
    });
}

// Pull an Ollama model with streaming progress
function pullOllamaModel(model, btn) {
    const safeId = model.replace(/[:.]/g, '-');
    const progressEl = document.getElementById('pull-progress-' + safeId);
    const barFill = progressEl ? progressEl.querySelector('.ollama-pull-bar-fill') : null;
    const statusEl = progressEl ? progressEl.querySelector('.ollama-pull-status') : null;

    btn.disabled = true;
    btn.textContent = 'Downloading...';
    if (progressEl) progressEl.classList.remove('hidden');

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
                    btn.textContent = 'Done';
                    if (statusEl) statusEl.textContent = 'Complete';
                    if (barFill) barFill.style.width = '100%';
                    // Refresh model list after pull
                    setTimeout(function() { fetchModels('ollama'); }, 500);
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
    }).catch(function(err) {
        btn.textContent = 'Error';
        btn.disabled = false;
        if (statusEl) statusEl.textContent = 'Connection failed';
    });
}

// Fetch models for a provider
function fetchModels(provider) {
    modelSelect.innerHTML = '<option value="">Loading...</option>';

    if (provider === 'ollama') {
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
                const recEl = document.getElementById('s-ollama-recommendation');
                if (recEl && rec.tiers) {
                    let html = '';
                    if (rec.ram_gb) {
                        html += '<div style="margin-bottom:0.5rem">Your system has ' + rec.ram_gb + 'GB RAM.</div>';
                    }
                    html += '<div class="ollama-tiers">';
                    rec.tiers.forEach(function(t) {
                        const isRec = t.model === rec.recommended_model;
                        const diskInfo = t.actual_disk ? t.actual_disk + ' on disk' : t.disk + ' on disk';
                        const sizeText = t.download + ' download, ' + diskInfo + ', ' + t.ram + ' in memory';
                        const ramNote = t.fits === false ? ' (needs ' + t.min_gb + 'GB+ RAM)' : '';
                        const recBadge = isRec ? ' <span class="ollama-rec-badge">recommended</span>' : '';

                        html += '<div class="ollama-tier-row' + (isRec ? ' ollama-tier-recommended' : '') + '">';
                        html += '<div class="ollama-tier-info">';
                        html += '<strong>' + t.model + '</strong> — ' + t.label + recBadge;
                        html += '<div class="ollama-tier-size">' + sizeText + ramNote + '</div>';
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
                    recEl.innerHTML = html;

                    // Attach download handlers
                    recEl.querySelectorAll('.btn-ollama-pull').forEach(function(btn) {
                        btn.addEventListener('click', function() { pullOllamaModel(btn.dataset.model, btn); });
                    });
                    // Attach remove handlers
                    recEl.querySelectorAll('.btn-ollama-remove').forEach(function(btn) {
                        btn.addEventListener('click', function() { removeOllamaModel(btn.dataset.model, btn); });
                    });
                } else if (recEl) {
                    recEl.innerHTML = '';
                }
            })
            .catch(function() {
                modelSelect.innerHTML = '<option value="">Could not fetch models</option>';
            });
        return;
    }

    fetch('/api/models/' + provider)
        .then(function(r) { return r.json(); })
        .then(function(models) {
            modelSelect.innerHTML = '';
            if (!models.length) {
                modelSelect.innerHTML = '<option value="">No models available</option>';
                return;
            }
            models.forEach(function(m) {
                const opt = document.createElement('option');
                opt.value = m.value;
                opt.textContent = m.label;
                modelSelect.appendChild(opt);
            });
        })
        .catch(function() {
            modelSelect.innerHTML = '<option value="">Could not fetch models</option>';
        });
}

// Default language to system locale
const langSelect = document.getElementById('s-language');
const systemLang = (navigator.language || 'en').split(/[-_]/)[0];
// Try to select system language, fall back to 'en'
const systemLangOption = langSelect.querySelector('option[value="' + systemLang + '"]');
if (systemLangOption) {
    langSelect.value = systemLang;
}

// Load current config and populate form
fetch('/api/config')
    .then(function(r) { return r.json(); })
    .then(function(cfg) {
        // LLM
        providerSelect.value = cfg.llm?.provider || 'claude_proxy';
        showGroupsFor(providerSelect, providerKeyGroups);
        checkProxyStatus();

        document.getElementById('s-proxy-url').value = cfg.llm?.proxy_url || 'http://127.0.0.1:8317';
        document.getElementById('s-ollama-url').value = cfg.llm?.ollama_url || 'http://localhost:11434';

        // Show saved API key indicator for the configured provider
        if (cfg.llm?.api_key && cfg.llm.api_key !== '***') {
            const keyFieldMap = {
                anthropic: 's-anthropic-key',
                openai: 's-openai-key',
                openrouter: 's-openrouter-key',
                venice: 's-venice-key',
            };
            const fieldId = keyFieldMap[cfg.llm?.provider];
            if (fieldId) {
                const input = document.getElementById(fieldId);
                input.placeholder = 'enter new key to replace';
                const hint = document.createElement('div');
                hint.className = 'field-hint saved-key-hint';
                hint.textContent = 'key saved (' + cfg.llm.api_key + ')';
                input.parentNode.insertBefore(hint, input.nextSibling);
            }
        }

        // TTS
        ttsEngineSelect.value = cfg.tts?.engine || 'macos';
        showGroupsFor(ttsEngineSelect, ttsKeyGroups);
        updateTtsEngineHint();
        const voiceName = cfg.tts?.voice || '';
        if (voiceName) selectedVoiceName = voiceName;
        const rate = cfg.tts?.rate || 160;
        rateSlider.value = rate;
        rateLabel.textContent = rate + ' wpm';
        updateRateDisplay();

        // Language
        const cfgLang = cfg.stt?.language || 'en';
        if (langSelect.querySelector('option[value="' + cfgLang + '"]')) {
            langSelect.value = cfgLang;
        }
        configLoaded = true;
        fetchVoices();

        // Start onboarding tour on first run
        if (firstRun) {
            tourActive = true;
            import('./tour.js').then(function(mod) {
                mod.startTour({
                    piperAvailable: piperAvailable,
                    isMac: /Mac/.test(navigator.platform),
                    onComplete: function() { tourActive = false; },
                });
            });
        }

        // STT
        document.getElementById('s-whisper-model').value = cfg.stt?.model || 'small';

        // Pacing
        document.getElementById('s-silence-base').value = (cfg.pacing?.silence_base_ms || 3000) / 1000;
        document.getElementById('s-silence-max').value = (cfg.pacing?.silence_max_ms || 7000) / 1000;
        document.getElementById('s-response-delay').value = (cfg.pacing?.response_delay_ms || 2000) / 1000;
        document.getElementById('s-silence-sec').value = cfg.pacing?.extended_silence_sec || 300;

        // Display
        const textScale = cfg.web?.text_scale || 1;
        document.getElementById('s-text-scale').value = textScale;
        document.getElementById('s-text-scale-label').textContent = Math.round(textScale * 100) + '%';
        document.getElementById('s-host').value = cfg.web?.host || '127.0.0.1';
        updateLanInfo();
        document.getElementById('s-window-mode').value = cfg.web?.window_mode || 'remember';
        document.getElementById('s-frameless').checked = cfg.web?.frameless !== false;
        document.getElementById('s-theme-mode').value = cfg.web?.theme_mode || 'auto';
        document.getElementById('s-auto-start-proxy').checked = cfg.web?.auto_start_proxy !== false;

        // Config folder button
        if (cfg._config_path) {
            const openBtn = document.getElementById('btn-open-config-folder');
            openBtn.classList.remove('hidden');
            openBtn.onclick = function() {
                fetch('/api/open-config-folder', {method: 'POST'});
            };
        }

        // Fetch provider availability, then models for current provider
        refreshSettingsProviders();
        fetchModels(providerSelect.value);
        const targetModel = providerSelect.value === 'ollama'
            ? (cfg.llm?.ollama_model || '')
            : (cfg.llm?.model || '');

        // Wait for models to load, then select
        if (targetModel) {
            let attempts = 0;
            const selectModel = setInterval(function() {
                for (let i = 0; i < modelSelect.options.length; i++) {
                    if (modelSelect.options[i].value === targetModel) {
                        modelSelect.value = targetModel;
                        clearInterval(selectModel);
                        return;
                    }
                }
                attempts++;
                if (attempts >= 20) clearInterval(selectModel);
            }, 200);
        }
    })
    .catch(function(err) {
        console.error('Failed to load config:', err);
    });

// Save
form.addEventListener('submit', function(e) {
    e.preventDefault();
    errorEl.classList.add('hidden');

    // Validate voice selection
    if (!selectedVoiceName) {
        errorEl.textContent = 'Please choose a voice';
        errorEl.classList.remove('hidden');
        voiceBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        voiceBtn.classList.add('voice-btn-attention');
        setTimeout(function() { voiceBtn.classList.remove('voice-btn-attention'); }, 2000);
        return;
    }

    const provider = providerSelect.value;
    const data = {
        llm: {
            provider: provider,
            proxy_url: document.getElementById('s-proxy-url').value,
            ollama_url: document.getElementById('s-ollama-url').value,
        },
        tts: {
            engine: ttsEngineSelect.value,
            voice: selectedVoiceName || '',
            rate: parseInt(rateSlider.value, 10),
        },
        stt: {
            model: document.getElementById('s-whisper-model').value,
            language: langSelect.value,
        },
        pacing: {
            silence_base_ms: Math.round(parseFloat(document.getElementById('s-silence-base').value) * 1000),
            silence_max_ms: Math.round(parseFloat(document.getElementById('s-silence-max').value) * 1000),
            response_delay_ms: Math.round(parseFloat(document.getElementById('s-response-delay').value) * 1000),
            extended_silence_sec: parseInt(document.getElementById('s-silence-sec').value, 10),
        },
        web: {
            host: document.getElementById('s-host').value,
            text_scale: parseFloat(document.getElementById('s-text-scale').value),
            window_mode: document.getElementById('s-window-mode').value,
            frameless: document.getElementById('s-frameless').checked,
            theme_mode: document.getElementById('s-theme-mode').value,
            auto_start_proxy: document.getElementById('s-auto-start-proxy').checked,
        },
    };

    // Set model field based on provider
    const modelVal = modelSelect.value;
    if (modelVal) {
        if (provider === 'ollama') {
            data.llm.ollama_model = modelVal;
        } else {
            data.llm.model = modelVal;
        }
    }

    // API keys — only include if filled
    const keyFields = {
        anthropic: 's-anthropic-key',
        openai: 's-openai-key',
        openrouter: 's-openrouter-key',
        venice: 's-venice-key',
    };

    // Map current provider's key to llm.api_key
    const currentKeyField = keyFields[provider];
    if (currentKeyField) {
        const val = document.getElementById(currentKeyField).value.trim();
        if (val) data.llm.api_key = val;
    }

    // ElevenLabs API key
    const elKey = document.getElementById('s-elevenlabs-key').value.trim();
    if (elKey) data.tts.api_key = elKey;

    fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    })
    .then(function(r) { return r.json(); })
    .then(function(result) {
        if (result.error) {
            errorEl.textContent = result.error;
            errorEl.classList.remove('hidden');
            return;
        }
        // Sync voice and speed to localStorage so the session page picks them up
        var savedVoice = selectedVoiceName;
        if (savedVoice && savedVoice !== 'Default') {
            setSavedVoice(savedVoice);
        }
        setSavedSpeed(parseInt(rateSlider.value, 10));

        // Apply theme preference
        var themeMode = document.getElementById('s-theme-mode').value;
        localStorage.setItem('themeMode', themeMode);
        localStorage.removeItem('theme'); // clear toggle override
        if (themeMode === 'dark' || themeMode === 'light') {
            document.documentElement.setAttribute('data-theme', themeMode);
        } else {
            // Auto: revert to system preference
            if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
                document.documentElement.setAttribute('data-theme', 'light');
            } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
                document.documentElement.setAttribute('data-theme', 'dark');
            } else {
                var hour = new Date().getHours();
                document.documentElement.setAttribute('data-theme', (hour >= 7 && hour < 19) ? 'light' : 'dark');
            }
        }

        if (firstRun) {
            window.location.href = '/';
        } else {
            if (savedEl) {
                savedEl.classList.remove('hidden');
                setTimeout(function() { savedEl.classList.add('hidden'); }, 3000);
            }
            // Refresh voice list in case TTS engine changed
            fetchVoices();
        }
    })
    .catch(function(err) {
        errorEl.textContent = 'Failed to save: ' + err.message;
        errorEl.classList.remove('hidden');
    });
});

// Update check from settings
(function() {
    var checkBtn = document.getElementById('s-check-update');
    var statusEl = document.getElementById('s-update-status');
    var resultEl = document.getElementById('s-update-result');
    if (!checkBtn) return;

    checkBtn.addEventListener('click', function() {
        checkBtn.disabled = true;
        checkBtn.textContent = 'Checking...';
        resultEl.classList.add('hidden');

        if (window._glooowCheckUpdate) {
            window._glooowCheckUpdate(function(data, err) {
                checkBtn.disabled = false;
                checkBtn.textContent = 'Check for Updates';
                if (err || !data) {
                    resultEl.textContent = 'Could not check for updates. Check your connection.';
                    resultEl.className = 'settings-update-result update-error';
                    resultEl.classList.remove('hidden');
                    return;
                }
                if (data.available) {
                    var label = data.is_release
                        ? 'Version ' + data.latest_version + ' available!'
                        : data.commits_behind + ' update' + (data.commits_behind !== 1 ? 's' : '') + ' available';
                    statusEl.textContent = label;
                    resultEl.innerHTML = '';
                    var link = document.createElement('a');
                    link.href = '#';
                    link.textContent = 'View details and install';
                    link.addEventListener('click', function(e) {
                        e.preventDefault();
                        var aboutModal = document.getElementById('aboutModal');
                        if (aboutModal) aboutModal.classList.remove('hidden');
                    });
                    resultEl.appendChild(link);
                    resultEl.className = 'settings-update-result';
                    resultEl.classList.remove('hidden');
                } else {
                    statusEl.textContent = 'You\u2019re up to date';
                    resultEl.textContent = 'No updates available.';
                    resultEl.className = 'settings-update-result update-success';
                    resultEl.classList.remove('hidden');
                }
            });
        }
    });
})();

// ---- Voice quality prompt ----

function needsVoiceQualityPrompt() {
    if (scoredVoices.length === 0) return false;
    // If the selected voice is already high quality, no prompt needed
    for (var i = 0; i < scoredVoices.length; i++) {
        if (scoredVoices[i].name === selectedVoiceName && scoredVoices[i].score >= 2) return false;
        if (scoredVoices[i].name === selectedVoiceName && scoredVoices[i].needsDownload && scoredVoices[i].downloaded) return false;
    }
    return true;
}

function checkVoiceQuality() {
    if (tourActive) return;
    var hintEl = document.getElementById('voice-quality-hint');
    if (!needsVoiceQualityPrompt()) {
        hintEl.classList.add('hidden');
        return;
    }
    if (localStorage.getItem(VQ_PROMPTED_KEY + '-permanent')) {
        return;
    }
    var prompted = sessionStorage.getItem(VQ_PROMPTED_KEY);
    if (!prompted && !vqModalShown) {
        showVoiceQualityModal();
    } else {
        showVoiceQualityHint();
    }
}

function showVoiceQualityModal() {
    vqModalShown = true;
    var isMac = /Mac/.test(navigator.platform);

    document.getElementById('vq-macos-option').classList.toggle('hidden', !isMac);
    document.getElementById('vq-piper-option').classList.toggle('hidden', !piperAvailable);

    var piperTitle = document.getElementById('vq-piper-title');
    var piperBtn = document.getElementById('vq-try-piper');
    piperTitle.textContent = 'Download a Piper voice';
    piperBtn.textContent = 'Open voice picker';
    piperBtn.dataset.action = 'open-picker';

    document.getElementById('voice-quality-modal').classList.remove('hidden');
}

function dismissVoiceQualityModal() {
    sessionStorage.setItem(VQ_PROMPTED_KEY, '1');
    document.getElementById('voice-quality-modal').classList.add('hidden');
    if (needsVoiceQualityPrompt()) showVoiceQualityHint();
}

function dismissVoiceQualityPermanent() {
    localStorage.setItem(VQ_PROMPTED_KEY + '-permanent', '1');
    document.getElementById('voice-quality-modal').classList.add('hidden');
}

function showVoiceQualityHint() {
    var hintEl = document.getElementById('voice-quality-hint');
    var openSettings = '<a href="#" onclick="fetch(\'/api/open-voice-settings\',{method:\'POST\'}); return false;">Open Settings</a>';
    if (/Mac/.test(navigator.platform)) {
        hintEl.innerHTML = piperAvailable
            ? 'Tip: Download a Premium macOS voice (' + openSettings + ') or a Piper voice from the voice picker.'
            : 'Tip: Download a Premium voice from System Settings \u2192 Accessibility \u2192 Spoken Content. ' + openSettings;
    } else if (piperAvailable) {
        hintEl.textContent = 'Tip: Download a Piper voice from the voice picker for better quality.';
    } else {
        hintEl.textContent = 'Tip: Try a different voice for better quality.';
    }
    hintEl.classList.remove('hidden');
}

document.getElementById('vq-close').addEventListener('click', dismissVoiceQualityModal);
document.getElementById('vq-dismiss').addEventListener('click', dismissVoiceQualityModal);
document.getElementById('vq-dismiss-permanent').addEventListener('click', dismissVoiceQualityPermanent);
document.getElementById('vq-try-piper').addEventListener('click', function() {
    dismissVoiceQualityModal();
    openVoiceModal();
});
document.getElementById('voice-quality-modal').addEventListener('click', function(e) {
    if (e.target === this) dismissVoiceQualityModal();
});

// ---- Setup guide button ----
document.getElementById('btn-show-tour').addEventListener('click', function() {
    tourActive = true;
    import('./tour.js').then(function(mod) {
        mod.resetAndStart({
            piperAvailable: piperAvailable,
            isMac: /Mac/.test(navigator.platform),
            onComplete: function() { tourActive = false; },
        });
    });
});
