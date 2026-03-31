/**
 * Interactive onboarding wizard for the settings page.
 *
 * Walks first-time users through choosing an LLM provider and voice,
 * actually setting the form values for them based on their choices.
 */

var TOUR_DISMISSED_KEY = 'glooow-tour-dismissed';
var TOUR_REMIND_KEY = 'glooow-tour-remind-later';

var PADDING = 10;
var FOOTER_HEIGHT = 60; // approximate footer height

function getNavHeight() {
    var nav = document.querySelector('.nav');
    return nav ? nav.getBoundingClientRect().height + 16 : 80;
}
var TOTAL_STEPS = 4; // welcome, llm, voice, done

// ---- State ----

var overlayEl, spotlightEl, cardEl;
var currentStep = 0;
var onCompleteCb = null;
var resizeTimer = null;
var tourOptions = {};

// ---- DOM helpers ----

function createOverlay() {
    overlayEl = document.createElement('div');
    overlayEl.className = 'tour-overlay';

    spotlightEl = document.createElement('div');
    spotlightEl.className = 'tour-spotlight';

    document.body.appendChild(overlayEl);
    document.body.appendChild(spotlightEl);
}

function cleanup() {
    if (overlayEl && overlayEl.parentNode) overlayEl.remove();
    if (spotlightEl && spotlightEl.parentNode) spotlightEl.remove();
    if (cardEl && cardEl.parentNode) cardEl.remove();
    window.removeEventListener('resize', onResizeDebounced);
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('keydown', onKeyDown);
    overlayEl = spotlightEl = cardEl = null;
}

function hideTour() {
    if (overlayEl && overlayEl.parentNode) overlayEl.remove();
    if (spotlightEl && spotlightEl.parentNode) spotlightEl.remove();
    if (cardEl && cardEl.parentNode) cardEl.remove();
}

function showTour() {
    // Re-attach elements to DOM
    if (overlayEl && !overlayEl.parentNode) document.body.appendChild(overlayEl);
    if (spotlightEl && !spotlightEl.parentNode) document.body.appendChild(spotlightEl);
}

function showCard(html, className) {
    if (cardEl && cardEl.parentNode) cardEl.remove();
    cardEl = document.createElement('div');
    cardEl.className = className || 'tour-tooltip';
    cardEl.innerHTML = html;
    document.body.appendChild(cardEl);
    wireActions();
}

function wireActions() {
    // Let links inside tour cards open normally without triggering the button action
    cardEl.querySelectorAll('a[href]').forEach(function(link) {
        link.addEventListener('click', function(e) { e.stopPropagation(); });
    });
    cardEl.querySelectorAll('[data-action]').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            if (e.target.closest('a')) return;
            e.stopPropagation();
            var action = this.dataset.action;
            if (action === 'self-serve') dismissRemindLater();
            else if (action === 'help') goToStep(1);
            else if (action === 'back') goBack();
            else if (action === 'done') completeTour();
            else if (action === 'skip') dismissRemindLater();
            else if (action === 'next') advanceStep();
            else if (action === 'provider') chooseProvider(this.dataset.value);
            else if (action === 'show-api-keys') showApiKeyChoices();
            else if (action === 'voice') chooseVoice(this.dataset.value);
        });
    });
}

// ---- Footer (dots + nav) ----

function footerHtml(opts) {
    var html = '<div class="tour-footer">';

    if (opts.skip !== false) {
        html += '<button class="tour-skip" data-action="skip">Skip</button>';
    } else {
        html += '<span></span>';
    }

    html += '<div class="tour-dots">';
    for (var i = 0; i < TOTAL_STEPS; i++) {
        html += '<div class="tour-dot' + (i === currentStep ? ' active' : '') + '"></div>';
    }
    html += '</div>';

    html += '<div class="tour-actions">';
    if (opts.back) {
        html += '<button class="btn btn-small btn-secondary" data-action="back">Back</button>';
    }
    if (opts.next) {
        html += '<button class="btn btn-small btn-primary" data-action="next">Next</button>';
    }
    if (opts.done) {
        html += '<button class="btn btn-small btn-primary" data-action="done">Got it</button>';
    }
    html += '</div></div>';
    return html;
}

// ---- Positioning ----

function positionSpotlight(el, fixed) {
    var rect = el.getBoundingClientRect();
    var pad = fixed ? 0 : PADDING;
    if (fixed) {
        spotlightEl.classList.add('tour-spotlight-fixed');
        spotlightEl.style.top = (rect.top - pad) + 'px';
        spotlightEl.style.left = (rect.left - pad) + 'px';
    } else {
        spotlightEl.classList.remove('tour-spotlight-fixed');
        spotlightEl.style.top = (rect.top + window.scrollY - pad) + 'px';
        spotlightEl.style.left = (rect.left + window.scrollX - pad) + 'px';
    }
    spotlightEl.style.width = (rect.width + pad * 2) + 'px';
    spotlightEl.style.height = (rect.height + pad * 2) + 'px';
    spotlightEl.style.display = '';
}

function positionTooltip(el) {
    var rect = el.getBoundingClientRect();
    var tipRect = cardEl.getBoundingClientRect();
    var maxBottom = window.innerHeight - FOOTER_HEIGHT - 8;
    var spaceBelow = maxBottom - rect.bottom;

    if (spaceBelow > tipRect.height + 16) {
        cardEl.style.top = (rect.bottom + 12) + 'px';
    } else {
        // Place above, clamped below the nav
        cardEl.style.top = Math.max(getNavHeight() + 4, rect.top - tipRect.height - 12) + 'px';
    }

    var left = rect.left + (rect.width - tipRect.width) / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
    cardEl.style.left = left + 'px';

    // Final clamp: don't let tooltip extend below footer
    var finalRect = cardEl.getBoundingClientRect();
    if (finalRect.bottom > maxBottom) {
        cardEl.style.top = (maxBottom - finalRect.height) + 'px';
    }
}

function hideSpotlight() {
    spotlightEl.style.display = 'none';
}

function scrollToSection(el, cb) {
    var rect = el.getBoundingClientRect();
    var scrollTarget = window.scrollY + rect.top - getNavHeight();
    window.scrollTo({ top: Math.max(0, scrollTarget), behavior: 'smooth' });
    setTimeout(cb, 300);
}

// ---- Step 0: Welcome ----

function showWelcome() {
    currentStep = 0;
    hideSpotlight();

    var html = '<h3>Welcome to glooow</h3>';
    html += '<p>Let\u2019s get your meditation facilitator set up. It only takes a minute.</p>';
    html += '<div class="tour-choices">';
    html += '<button class="tour-choice" data-action="help">';
    html += '<strong>Help me set up</strong>';
    html += '<small>We\u2019ll walk you through choosing an AI provider and voice</small>';
    html += '</button>';
    html += '<button class="tour-choice" data-action="self-serve">';
    html += '<strong>I\u2019ll set this up myself</strong>';
    html += '<small>Use the settings page directly</small>';
    html += '</button>';
    html += '</div>';

    showCard(html, 'tour-welcome');
}

// ---- Step 1: LLM Provider ----

function showLLMStep() {
    currentStep = 1;
    var section = document.getElementById('s-provider').closest('.settings-section');

    scrollToSection(section, function() {
        positionSpotlight(section, false);

        var html = '<h3>Choose Your AI Provider</h3>';
        html += '<p>An LLM is the AI that guides your meditation. Pick what works for you:</p>';
        html += '<div class="tour-choices">';

        // Ollama
        var ollamaDesc = 'Free &amp; private. Runs AI entirely on your computer.';
        if (tourOptions.ollamaRec) {
            ollamaDesc += ' Recommended model: <strong>' + tourOptions.ollamaRec + '</strong>';
        }
        html += '<button class="tour-choice" data-action="provider" data-value="ollama">';
        html += '<strong>Ollama \u2014 free, runs locally</strong>';
        html += '<small>' + ollamaDesc + '</small>';
        html += '</button>';

        // Claude subscription
        html += '<button class="tour-choice" data-action="provider" data-value="claude_proxy">';
        html += '<strong>I have a Claude subscription</strong>';
        html += '<small>Uses your existing plan via CLIProxyAPI. No extra cost.</small>';
        html += '</button>';

        // API key
        html += '<button class="tour-choice" data-action="show-api-keys">';
        html += '<strong>I have an API key</strong>';
        html += '<small>Anthropic, OpenAI, OpenRouter, or Venice</small>';
        html += '</button>';

        html += '</div>';
        html += footerHtml({ back: true, skip: true });

        showCard(html, 'tour-tooltip');
        positionTooltip(section);
    });
}

function showApiKeyChoices() {
    var section = document.getElementById('s-provider').closest('.settings-section');

    var html = '<h3>Which provider?</h3>';
    html += '<p>Select the provider you have an API key for:</p>';
    html += '<div class="tour-choice-group">';
    html += '<button class="tour-choice-sm" data-action="provider" data-value="anthropic">Anthropic</button>';
    html += '<button class="tour-choice-sm" data-action="provider" data-value="openai">OpenAI</button>';
    html += '<button class="tour-choice-sm" data-action="provider" data-value="openrouter">OpenRouter</button>';
    html += '<button class="tour-choice-sm" data-action="provider" data-value="venice">Venice</button>';
    html += '</div>';
    html += footerHtml({ back: true, skip: true });

    showCard(html, 'tour-tooltip');
    positionTooltip(section);
}

function chooseProvider(value) {
    var sel = document.getElementById('s-provider');
    sel.value = value;
    sel.dispatchEvent(new Event('change'));

    // Hide tour so user can interact with the section freely
    hideTour();

    var resumeToVoice = function() {
        showTour();
        showVoiceStep();
    };

    if (value === 'ollama') {
        // Wait for a model to be available (downloaded) before advancing
        waitForCondition(function() {
            var m = document.getElementById('s-model');
            if (!m || m.options.length === 0) return false;
            var text = m.options[0].textContent;
            return m.value && text !== 'Loading...' && text !== 'No models available';
        }, resumeToVoice);
    } else if (value === 'claude_proxy') {
        // Wait for proxy to show "Connected"
        waitForCondition(function() {
            var el = document.getElementById('s-proxy-status');
            return el && el.textContent.indexOf('Connected') !== -1;
        }, resumeToVoice);
    } else {
        // API key provider — wait for key field to be filled
        var keyMap = {
            anthropic: 's-anthropic-key',
            openai: 's-openai-key',
            openrouter: 's-openrouter-key',
            venice: 's-venice-key',
        };
        var fieldId = keyMap[value];
        waitForCondition(function() {
            var input = fieldId && document.getElementById(fieldId);
            return input && input.value.trim().length > 8;
        }, resumeToVoice);
    }
}

function waitForCondition(test, cb) {
    // Check immediately in case condition is already met
    if (test()) { cb(); return; }
    var timer = setInterval(function() {
        if (test()) {
            clearInterval(timer);
            cb();
        }
    }, 500);
    // Safety: don't block forever — after 5 minutes give up and advance
    setTimeout(function() { clearInterval(timer); cb(); }, 300000);
}

// ---- Step 2: Voice ----

function showVoiceStep() {
    currentStep = 2;
    var section = document.getElementById('s-tts-engine').closest('.settings-section');

    scrollToSection(section, function() {
        positionSpotlight(section, false);

        var html = '<h3>Set Up Your Voice</h3>';
        html += '<p>This is how glooow speaks to you. A natural-sounding voice makes a big difference.</p>';
        html += '<div class="tour-choices">';

        if (tourOptions.piperAvailable) {
            html += '<button class="tour-choice" data-action="voice" data-value="piper">';
            html += '<strong>Piper \u2014 free, natural sounding</strong>';
            html += '<small>Local neural TTS. Pick and download a voice (~60\u2013100 MB).</small>';
            html += '</button>';
        }

        if (tourOptions.isMac) {
            html += '<button class="tour-choice" data-action="voice" data-value="macos">';
            html += '<strong>Premium macOS voices</strong>';
            html += '<small>Download from System Settings \u2192 Accessibility \u2192 Spoken Content. In the System Voice row, click the <b>ⓘ</b> then click Voice. <a href="#" onclick="fetch(\'/api/open-voice-settings\',{method:\'POST\'}); return false;">Open Settings</a></small>';
            html += '</button>';
        }

        if (!tourOptions.isMac) {
            html += '<button class="tour-choice" data-action="voice" data-value="skip">';
            html += '<strong>Browser voices</strong>';
            html += '<small>On Windows, Edge and the desktop app include high-quality natural voices.</small>';
            html += '</button>';
        }

        html += '<button class="tour-choice" data-action="voice" data-value="skip">';
        html += '<strong>Skip \u2014 I\u2019ll pick later</strong>';
        html += '</button>';

        html += '</div>';
        html += footerHtml({ back: true, skip: true });

        showCard(html, 'tour-tooltip');
        positionTooltip(section);
    });
}

function chooseVoice(value) {
    if (value === 'skip' || value === 'macos') {
        showDoneStep();
        return;
    }

    if (value === 'piper') {
        // Hide the tour so the voice picker modal is fully usable
        hideTour();

        // Open picker (all voices are already loaded)
        setTimeout(function() {
            document.getElementById('s-voice-btn').click();
            // Watch for the voice picker to close, then show done step
            waitForPickerClose(function() {
                showTour();
                showDoneStep();
            });
        });
    }
}

function waitForVoices(cb) {
    var attempts = 0;
    var check = setInterval(function() {
        var btn = document.getElementById('s-voice-btn');
        if (btn && !btn.classList.contains('no-voices') && btn.textContent !== 'Default') {
            clearInterval(check);
            cb();
            return;
        }
        attempts++;
        if (attempts >= 40) { // 4 second timeout
            clearInterval(check);
            cb();
        }
    }, 100);
}

function waitForPickerClose(cb) {
    var modal = document.getElementById('settings-voice-modal');
    if (!modal) { cb(); return; }

    var observer = new MutationObserver(function(mutations) {
        if (modal.classList.contains('hidden')) {
            observer.disconnect();
            cb();
        }
    });
    observer.observe(modal, { attributes: true, attributeFilter: ['class'] });

    // Safety timeout: if modal never gets hidden class, resume after 60s
    setTimeout(function() { observer.disconnect(); cb(); }, 60000);
}

// ---- Step 3: Done ----

function showDoneStep() {
    currentStep = 3;
    var footer = document.querySelector('.settings-footer');

    // Footer is position:fixed, so spotlight must be fixed too
    positionSpotlight(footer, true);

    var html = '<h3>You\u2019re All Set</h3>';
    html += '<p>Hit <strong>Save &amp; Start</strong> to begin your first meditation. You can always come back to change these settings later.</p>';
    html += footerHtml({ back: true, done: true, skip: false });

    showCard(html, 'tour-tooltip');

    // Position tooltip above the footer, clamped in viewport
    var footerRect = footer.getBoundingClientRect();
    var tipRect = cardEl.getBoundingClientRect();
    cardEl.style.top = (footerRect.top - tipRect.height - 12) + 'px';
    var left = footerRect.left + (footerRect.width - tipRect.width) / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
    cardEl.style.left = left + 'px';
}

// ---- Navigation ----

function goToStep(step) {
    if (step === 0) showWelcome();
    else if (step === 1) showLLMStep();
    else if (step === 2) showVoiceStep();
    else if (step === 3) showDoneStep();
}

function advanceStep() {
    if (currentStep < TOTAL_STEPS - 1) {
        goToStep(currentStep + 1);
    } else {
        completeTour();
    }
}

function goBack() {
    if (currentStep > 0) {
        goToStep(currentStep - 1);
    }
}

function completeTour() {
    localStorage.setItem(TOUR_DISMISSED_KEY, '1');
    cleanup();
    if (onCompleteCb) onCompleteCb();
}

function dismissRemindLater() {
    sessionStorage.setItem(TOUR_REMIND_KEY, '1');
    cleanup();
    if (onCompleteCb) onCompleteCb();
}

// ---- Event handlers ----

function onScroll() {
    if (!spotlightEl || spotlightEl.style.display === 'none') return;
    if (currentStep === 3) return; // footer spotlight is fixed
    var el = null;
    if (currentStep === 1) el = document.getElementById('s-provider').closest('.settings-section');
    else if (currentStep === 2) el = document.getElementById('s-tts-engine').closest('.settings-section');
    if (el) positionSpotlight(el, false);
}

function onResizeDebounced() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function() {
        if (!cardEl) return;
        goToStep(currentStep);
    }, 150);
}

function onKeyDown(e) {
    if (e.key === 'Escape') dismissRemindLater();
}

// ---- Entry point ----

export function startTour(options) {
    if (localStorage.getItem(TOUR_DISMISSED_KEY)) {
        if (options.onComplete) options.onComplete();
        return;
    }
    if (sessionStorage.getItem(TOUR_REMIND_KEY)) {
        if (options.onComplete) options.onComplete();
        return;
    }

    onCompleteCb = options.onComplete || null;
    tourOptions = {
        piperAvailable: options.piperAvailable,
        isMac: options.isMac,
    };

    // Fetch Ollama recommendation, then start
    fetch('/api/providers')
        .then(function(r) { return r.json(); })
        .then(function(data) {
            var rec = data.ollama && data.ollama.recommendation;
            tourOptions.ollamaRec = rec ? rec.recommended_model : null;
            initTour();
        })
        .catch(function() {
            initTour();
        });
}

export function resetAndStart(options) {
    localStorage.removeItem(TOUR_DISMISSED_KEY);
    sessionStorage.removeItem(TOUR_REMIND_KEY);
    startTour(options);
}

function initTour() {
    currentStep = 0;
    createOverlay();
    window.addEventListener('resize', onResizeDebounced);
    window.addEventListener('scroll', onScroll);
    document.addEventListener('keydown', onKeyDown);
    showWelcome();
}
