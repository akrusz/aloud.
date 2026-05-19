/**
 * Info panels and guided tour for the setup (index) page.
 *
 * Each section has a ? button that toggles an inline info panel.
 * The guide walks through all panels sequentially with a spotlight overlay,
 * reusing the .tour-* CSS classes from the settings tour.
 */

var GUIDE_DONE_KEY = 'aloud-index-guide-done';
var GUIDE_REMIND_KEY = 'aloud-index-guide-remind';

var PADDING = 10;
var FOOTER_HEIGHT = 60;

function getNavHeight() {
    var nav = document.querySelector('.nav');
    return nav ? nav.getBoundingClientRect().height + 16 : 80;
}

// ---- Standalone info panel toggle ----

function toggleInfo(id) {
    var panel = document.getElementById('info-' + id);
    if (!panel) return;
    var wasHidden = panel.classList.contains('hidden');
    document.querySelectorAll('.info-panel').forEach(function(p) { p.classList.add('hidden'); });
    if (wasHidden) panel.classList.remove('hidden');
}

// Delegated handler so ? clicks keep working regardless of any DOM
// manipulation during the tour (the buttons themselves don't get
// re-rendered, but delegation removes any chance of stale per-element
// listeners blocking clicks after a partial tour close).
document.addEventListener('click', function(e) {
    var btn = e.target.closest('.info-btn[data-info]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    if (guideActive) return;
    toggleInfo(btn.dataset.info);
});

// ---- Tour state ----

var overlayEl, spotlightEl, cardEl;
var currentStep = 0;
var guideActive = false;
var resizeTimer = null;
var prevTarget = null;

var SECTIONS = [
    {
        id: 'methods',
        target: function() { return document.querySelector('.setup-header'); },
    },
    {
        id: 'focus',
        target: function() {
            var btn = document.querySelector('[data-info="focus"]');
            return btn ? btn.closest('.form-group') : null;
        },
    },
    {
        id: 'vibe',
        target: function() {
            var btn = document.querySelector('[data-info="vibe"]');
            return btn ? btn.closest('.form-group') : null;
        },
    },
];

var TOTAL_STEPS = SECTIONS.length + 2; // welcome + sections + done

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
    if (overlayEl) overlayEl.remove();
    if (spotlightEl) spotlightEl.remove();
    if (cardEl) cardEl.remove();
    overlayEl = spotlightEl = cardEl = null;
    guideActive = false;
    if (prevTarget) { prevTarget.classList.remove('guide-elevated'); prevTarget = null; }
    document.querySelectorAll('.info-panel').forEach(function(p) { p.classList.add('hidden'); });
    window.removeEventListener('resize', onResizeDebounced);
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('keydown', onKeyDown);
}

function showCard(html, className) {
    if (cardEl) cardEl.remove();
    cardEl = document.createElement('div');
    cardEl.className = className || 'tour-tooltip';
    cardEl.innerHTML = html;
    document.body.appendChild(cardEl);
    wireActions();
}

function wireActions() {
    cardEl.querySelectorAll('[data-action]').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var action = this.dataset.action;
            if (action === 'next') advanceStep();
            else if (action === 'back') goBack();
            else if (action === 'done') completeGuide();
            else if (action === 'dismiss') dismissRemindLater();
            else if (action === 'start') goToStep(1);
        });
    });
}

function hideSpotlight() {
    if (spotlightEl) spotlightEl.style.display = 'none';
}

function positionSpotlight(el) {
    var rect = el.getBoundingClientRect();
    spotlightEl.classList.remove('tour-spotlight-fixed');
    spotlightEl.style.top = (rect.top + window.scrollY - PADDING) + 'px';
    spotlightEl.style.left = (rect.left + window.scrollX - PADDING) + 'px';
    spotlightEl.style.width = (rect.width + PADDING * 2) + 'px';
    spotlightEl.style.height = (rect.height + PADDING * 2) + 'px';
    spotlightEl.style.display = '';
}

function positionTooltip(el) {
    var rect = el.getBoundingClientRect();
    var tipRect = cardEl.getBoundingClientRect();
    var maxBottom = window.innerHeight - FOOTER_HEIGHT - 8;

    if (maxBottom - rect.bottom > tipRect.height + 16) {
        cardEl.style.top = (rect.bottom + 12) + 'px';
    } else {
        cardEl.style.top = Math.max(getNavHeight() + 4, rect.top - tipRect.height - 12) + 'px';
    }

    var left = rect.left + (rect.width - tipRect.width) / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
    cardEl.style.left = left + 'px';
}

function scrollToSection(el, cb) {
    var rect = el.getBoundingClientRect();
    var scrollTarget = window.scrollY + rect.top - getNavHeight();
    window.scrollTo({ top: Math.max(0, scrollTarget), behavior: 'smooth' });
    setTimeout(function() {
        // Bail if the tour was closed while we were waiting — otherwise
        // the cb would re-create cardEl after cleanup and leak the tour.
        if (!guideActive) return;
        cb();
    }, 300);
}

function ensureExplorationTab() {
    var panel = document.getElementById('exploration-panel');
    if (panel && panel.classList.contains('hidden')) {
        var btn = document.querySelector('[data-tab="exploration"]');
        if (btn) btn.click();
    }
}

// ---- Footer (dots + nav) ----

function footerHtml(opts) {
    var html = '<div class="tour-footer">';
    if (opts.skip !== false) {
        html += '<button class="tour-skip" data-action="dismiss">Skip</button>';
    } else {
        html += '<span></span>';
    }
    html += '<div class="tour-dots">';
    for (var i = 0; i < TOTAL_STEPS; i++) {
        html += '<div class="tour-dot' + (i === currentStep ? ' active' : '') + '"></div>';
    }
    html += '</div>';
    html += '<div class="tour-actions">';
    if (opts.back) html += '<button class="btn btn-small btn-secondary" data-action="back">Back</button>';
    if (opts.next) html += '<button class="btn btn-small btn-primary" data-action="next">Next</button>';
    if (opts.done) html += '<button class="btn btn-small btn-primary" data-action="done">Got it</button>';
    html += '</div></div>';
    return html;
}

// ---- Steps ----

function showWelcome() {
    currentStep = 0;
    hideSpotlight();
    if (prevTarget) { prevTarget.classList.remove('guide-elevated'); prevTarget = null; }
    document.querySelectorAll('.info-panel').forEach(function(p) { p.classList.add('hidden'); });

    var html = '<p><span class="brand-mark">aloud.</span> &mdash; a meditation facilitator that listens and responds to your experience in real time.</p>';
    html += '<div class="tour-choices">';
    html += '<button class="tour-choice" data-action="start">';
    html += '<strong>Show me around</strong>';
    html += '<small>A quick look at how it works</small>';
    html += '</button>';
    html += '<button class="tour-choice" data-action="dismiss">';
    html += '<strong>I\u2019ll explore on my own</strong>';
    html += '<small>You can tap <strong>?</strong> on any section for more info</small>';
    html += '</button>';
    html += '</div>';

    showCard(html, 'tour-welcome');
}

function showSection(index) {
    currentStep = index + 1;
    var section = SECTIONS[index];

    // Focus and vibe are on the exploration tab
    if (section.id === 'focus' || section.id === 'vibe') {
        ensureExplorationTab();
    }

    var target = section.target();
    if (!target) { advanceStep(); return; }

    // Clean up previous
    if (prevTarget) prevTarget.classList.remove('guide-elevated');
    document.querySelectorAll('.info-panel').forEach(function(p) { p.classList.add('hidden'); });

    // Open this section's info panel
    var panel = document.getElementById('info-' + section.id);
    if (panel) panel.classList.remove('hidden');

    // Elevate target above overlay so info panel is readable
    target.classList.add('guide-elevated');
    prevTarget = target;

    // Wait a frame for layout to settle after opening panel
    requestAnimationFrame(function() {
        scrollToSection(target, function() {
            positionSpotlight(target);

            var html = footerHtml({
                back: true,
                next: index < SECTIONS.length - 1,
                done: index === SECTIONS.length - 1,
                skip: true,
            });
            showCard(html, 'tour-tooltip');
            positionTooltip(target);
        });
    });
}

function showDone() {
    currentStep = SECTIONS.length + 1;
    hideSpotlight();
    if (prevTarget) { prevTarget.classList.remove('guide-elevated'); prevTarget = null; }
    document.querySelectorAll('.info-panel').forEach(function(p) { p.classList.add('hidden'); });

    var html = '<h3>You\u2019re ready</h3>';
    html += '<p>Pick what resonates and begin. Tap <strong>?</strong> on any section to revisit these notes.</p>';
    html += footerHtml({ back: true, done: true, skip: false });

    showCard(html, 'tour-welcome');
}

// ---- Navigation ----

function goToStep(step) {
    if (step === 0) showWelcome();
    else if (step <= SECTIONS.length) showSection(step - 1);
    else showDone();
}

function advanceStep() {
    if (currentStep < TOTAL_STEPS - 1) goToStep(currentStep + 1);
    else completeGuide();
}

function goBack() {
    if (currentStep > 0) goToStep(currentStep - 1);
}

function completeGuide() {
    localStorage.setItem(GUIDE_DONE_KEY, '1');
    cleanup();
}

function dismissRemindLater() {
    sessionStorage.setItem(GUIDE_REMIND_KEY, '1');
    cleanup();
}

// ---- Event handlers ----

function onScroll() {
    if (!guideActive || !spotlightEl || spotlightEl.style.display === 'none') return;
    var idx = currentStep - 1;
    if (idx >= 0 && idx < SECTIONS.length) {
        var target = SECTIONS[idx].target();
        if (target) positionSpotlight(target);
    }
}

function onResizeDebounced() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function() {
        if (guideActive) goToStep(currentStep);
    }, 150);
}

function onKeyDown(e) {
    if (e.key === 'Escape') dismissRemindLater();
}

// ---- Entry points ----

export function startGuide(startStep) {
    if (guideActive) return;
    guideActive = true;
    currentStep = 0;
    createOverlay();
    window.addEventListener('resize', onResizeDebounced);
    window.addEventListener('scroll', onScroll);
    document.addEventListener('keydown', onKeyDown);
    if (typeof startStep === 'number' && startStep > 0) {
        goToStep(startStep);
    } else {
        showWelcome();
    }
}

// "Take the full tour" link — user has explicitly opted in, so skip the
// welcome screen and jump straight to the first section.
export function resetAndStart() {
    localStorage.removeItem(GUIDE_DONE_KEY);
    sessionStorage.removeItem(GUIDE_REMIND_KEY);
    startGuide(1);
}

export function autoStart() {
    if (localStorage.getItem(GUIDE_DONE_KEY)) return;
    if (sessionStorage.getItem(GUIDE_REMIND_KEY)) return;
    // If the user has already started at least one session, they know the
    // app — don't pop up the tour. (aloud-client-id is set on first
    // session start in session.js.)
    if (localStorage.getItem('aloud-client-id')) return;
    setTimeout(function() { startGuide(); }, 600);
}

export function closeIfActive() {
    if (guideActive) cleanup();
}
