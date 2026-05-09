/* ui.js — conversation display, typing indicator, timer, status,
   ember system, kasina mode, confirm dialog, doEndSession */

import { state, dom, socket } from './state.js';

// ---- Messaging ----

export function addMessage(role, text, historical, sender) {
    var wasAtBottom = isNearBottom();

    var msg = document.createElement('div');
    msg.className = 'message ' + role + (historical ? ' historical' : '');

    if (sender) {
        var senderEl = document.createElement('div');
        senderEl.className = 'message-sender';
        senderEl.textContent = sender;
        msg.appendChild(senderEl);
    }

    var content = document.createElement('div');
    content.className = 'message-content';
    content.textContent = text;
    msg.appendChild(content);

    dom.conversationEl.insertBefore(msg, dom.typingEl);
    if (wasAtBottom) {
        scrollToBottom();
    }
}

export function addContinuation(exchanges) {
    exchanges.forEach(function (ex) {
        var role = ex.role === 'assistant' ? 'facilitator' : 'user';
        addMessage(role, ex.content, true);
    });
    // Add visual separator between old and new conversation
    var sep = document.createElement('div');
    sep.className = 'continuation-separator';
    sep.innerHTML = '<span>continuing...</span>';
    dom.conversationEl.insertBefore(sep, dom.typingEl);
    scrollToBottom();
}

export function isNearBottom() {
    var threshold = 50;
    return dom.conversationEl.scrollTop + dom.conversationEl.clientHeight >= dom.conversationEl.scrollHeight - threshold;
}

export function scrollToBottom() {
    // Immediate scroll so isNearBottom() sees the right position
    dom.conversationEl.scrollTop = dom.conversationEl.scrollHeight;
    // Re-scroll after render to catch any layout reflow from text wrapping
    requestAnimationFrame(function () {
        dom.conversationEl.scrollTop = dom.conversationEl.scrollHeight;
    });
}

// ---- Typing indicator ----

export function showTyping() {
    dom.typingEl.classList.add('visible');
    scrollToBottom();
}

export function hideTyping() {
    dom.typingEl.classList.remove('visible');
}

export function setFacilitatorStatus(message) {
    let el = document.getElementById('facilitator-status-hint');
    if (!message) {
        if (el) el.classList.remove('visible');
        return;
    }
    if (!el) {
        el = document.createElement('div');
        el.id = 'facilitator-status-hint';
        el.className = 'facilitator-status-hint';
        dom.typingEl.insertAdjacentElement('afterend', el);
    }
    el.textContent = message;
    el.classList.add('visible');
    scrollToBottom();
}

// ---- Timer ----

export function startTimer() {
    state.timerInterval = setInterval(updateTimer, 1000);
}

export function stopTimer() {
    if (state.timerInterval) {
        clearInterval(state.timerInterval);
        state.timerInterval = null;
    }
}

export function updateTimer() {
    if (!state.sessionStart) return;
    var elapsed = Math.floor((Date.now() - state.sessionStart) / 1000);
    var hours = Math.floor(elapsed / 3600);
    var minutes = Math.floor((elapsed % 3600) / 60);
    var seconds = elapsed % 60;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    if (hours > 0) {
        dom.timerEl.textContent = hours + ':' + pad(minutes) + ':' + pad(seconds);
    } else {
        dom.timerEl.textContent = minutes + ':' + pad(seconds);
    }
}

// ---- Status ----

export function setStatus(text) {
    dom.voiceStatus.textContent = text;
}

// ---- Ember system ----

export var EMBER_COUNTS = [0, 3, 6, 12, 24, 48];
export var EMBER_COLORS_DARK = ['#e8a840', '#d4873a', '#c07830', '#e0a038', '#cc8030'];
export var EMBER_COLORS_LIGHT = ['#fed025', '#f6b818', '#fcc430', '#f0a80e', '#f8c020'];
export var EMBER_COLORS_RAINBOW = ['#f7a8c4', '#f4b8a0', '#f5e6a0', '#a8e6cf', '#a0e0f0', '#c4b4f0', '#e8a0d8'];
export var EMBER_SHRINK_RATE = 0.3; // px/s — constant for all embers

export function hexGlow(hex) {
    return 'rgba(' + parseInt(hex.slice(1, 3), 16) + ','
        + parseInt(hex.slice(3, 5), 16) + ','
        + parseInt(hex.slice(5, 7), 16) + ',0.4)';
}

export function setEmberLevel(level) {
    state.emberLevel = level;
    var blocks = dom.emberBlocks.querySelectorAll('.ember-block');
    for (var i = 0; i < blocks.length; i++) {
        blocks[i].classList.toggle('filled', i < level);
    }
    regenerateEmbers();
}

function gracefullyEndEmbers() {
    var existing = dom.emberContainer.querySelectorAll('.ember');
    for (var i = 0; i < existing.length; i++) {
        var el = existing[i];
        if (el.dataset.finishing) continue;
        el.dataset.finishing = '1';
        var anims = el.getAnimations();
        if (!anims.length) { el.remove(); continue; }
        var a = anims[0];
        try {
            var timing = a.effect.getTiming();
            var dur = timing.duration;
            var delay = timing.delay || 0;
            var elapsed = (a.currentTime || 0) - delay;
            var iters = elapsed < 0 ? 1 : Math.floor(elapsed / dur) + 1;
            a.effect.updateTiming({ iterations: iters });
            a.onfinish = (function (e) { return function () {
                e.remove();
                if (state.emberLevel === 0 && !dom.emberContainer.querySelector('.ember')) {
                    dom.emberContainer.classList.remove('active');
                }
            }; })(el);
        } catch (err) {
            el.remove();
        }
    }
}

export function regenerateEmbers() {
    gracefullyEndEmbers();
    if (state.emberLevel === 0) {
        if (!dom.emberContainer.querySelector('.ember')) {
            dom.emberContainer.classList.remove('active');
        }
        return;
    }
    dom.emberContainer.classList.add('active');
    var count = EMBER_COUNTS[state.emberLevel];
    var isLight = document.documentElement.getAttribute('data-theme') === 'light';
    var palette = state.orbRainbow ? EMBER_COLORS_RAINBOW
        : (isLight ? EMBER_COLORS_LIGHT : EMBER_COLORS_DARK);
    for (var i = 0; i < count; i++) {
        var span = document.createElement('span');
        span.className = 'ember';
        var sizeRange = [0, 2, 3.5, 5, 6.5, 8][state.emberLevel];
        var size = 2 + Math.random() * sizeRange;
        var color = palette[Math.floor(Math.random() * palette.length)];
        var glow = Math.round(3 + size);
        span.style.left = (5 + Math.random() * 90) + '%';
        span.style.width = size + 'px';
        span.style.height = size + 'px';
        span.style.background = color;
        span.style.boxShadow = '0 0 ' + glow + 'px ' + Math.round(size * 0.4) + 'px ' + hexGlow(color);

        var dur = 10 + Math.random() * 20; // 10-30s for speed variety
        var drift = Math.round(-30 + Math.random() * 60);
        var endScale = Math.max(0, 1 - EMBER_SHRINK_RATE * dur / size).toFixed(3);

        span.animate([
            { transform: 'translateY(0) translateX(0) scale(1)', opacity: 0, offset: 0 },
            { transform: 'translateY(-5vh) translateX(' + Math.round(drift * 0.06) + 'px) scale(0.97)', opacity: 0.7, offset: 0.06 },
            { transform: 'translateY(-95vh) translateX(' + drift + 'px) scale(' + endScale + ')', opacity: 0, offset: 1.0 },
        ], {
            duration: dur * 1000,
            delay: Math.random() * dur * 1000,
            iterations: Infinity,
            easing: 'linear',
        });

        dom.emberContainer.appendChild(span);
    }
}

export function burstEmbers(count) {
    var isLight = document.documentElement.getAttribute('data-theme') === 'light';
    var palette = state.orbRainbow ? EMBER_COLORS_RAINBOW
        : (isLight ? EMBER_COLORS_LIGHT : EMBER_COLORS_DARK);
    dom.emberContainer.classList.add('active');
    for (var i = 0; i < count; i++) {
        var span = document.createElement('span');
        span.className = 'ember';
        var size = 2 + Math.random() * 8;
        var color = palette[Math.floor(Math.random() * palette.length)];
        var glow = Math.round(3 + size);
        span.style.left = (5 + Math.random() * 90) + '%';
        span.style.bottom = '-10px';
        span.style.width = size + 'px';
        span.style.height = size + 'px';
        span.style.background = color;
        span.style.boxShadow = '0 0 ' + glow + 'px ' + Math.round(size * 0.4) + 'px ' + hexGlow(color);

        var dur = 2 + Math.random() * 3;
        var driftX = -60 + Math.random() * 120;
        var driftY = -(window.innerHeight * 0.4) - Math.random() * (window.innerHeight * 0.6);

        var anim = span.animate([
            { transform: 'translate(0,0) scale(1)', opacity: 0.9, offset: 0 },
            { transform: 'translate(' + (driftX * 0.3) + 'px,' + (driftY * 0.3) + 'px) scale(0.8)', opacity: 0.7, offset: 0.3 },
            { transform: 'translate(' + driftX + 'px,' + driftY + 'px) scale(0)', opacity: 0, offset: 1.0 },
        ], {
            duration: dur * 1000,
            delay: Math.random() * 400,
            easing: 'ease-out',
            fill: 'forwards',
        });

        dom.emberContainer.appendChild(span);
        anim.onfinish = (function (el) { return function () { el.remove(); }; })(span);
    }
}

// ---- Error toast ----

export function showErrorToast(message) {
    var toast = document.createElement('div');
    toast.className = 'error-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    // Trigger reflow so the transition runs
    toast.offsetHeight;
    toast.classList.add('visible');
    setTimeout(function () {
        toast.classList.remove('visible');
        setTimeout(function () { toast.remove(); }, 300);
    }, 5000);
}

// ---- Confirm dialog ----

export function showConfirm(message, onConfirm, opts) {
    dom.confirmText.textContent = message;
    state.pendingConfirmAction = onConfirm;
    dom.confirmOverlay.classList.remove('hidden');
    // Show "End Without Saving" link only when requested
    if (dom.confirmSkipSave) {
        dom.confirmSkipSave.classList.toggle('hidden', !(opts && opts.showSkipSave));
    }
}

export function hideConfirm() {
    dom.confirmOverlay.classList.add('hidden');
    state.pendingConfirmAction = null;
    state.pendingNavigation = null;
}

// ---- End session ----

export function doEndSession(deactivateVoiceFn, skipSave) {
    if (state.voiceActive) {
        deactivateVoiceFn();
    }
    socket.emit('end_session', { skip_save: !!skipSave });
}
