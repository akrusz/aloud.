/* ui.js — conversation display, typing indicator, timer, status,
   ember system, kasina mode, confirm dialog, endSession */

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

export var EMBER_COUNTS = [0, 3, 6, 12, 24];
export var EMBER_COLORS_DARK = ['#e8a840', '#d4873a', '#c07830', '#e0a038', '#cc8030'];
export var EMBER_COLORS_LIGHT = ['#fed025', '#f6b818', '#fcc430', '#f0a80e', '#f8c020'];
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

export function regenerateEmbers() {
    dom.emberContainer.innerHTML = '';
    if (state.emberLevel === 0) {
        dom.emberContainer.classList.remove('active');
        return;
    }
    dom.emberContainer.classList.add('active');
    var count = EMBER_COUNTS[state.emberLevel];
    var isLight = document.documentElement.getAttribute('data-theme') === 'light';
    var palette = isLight ? EMBER_COLORS_LIGHT : EMBER_COLORS_DARK;
    for (var i = 0; i < count; i++) {
        var span = document.createElement('span');
        span.className = 'ember';
        var sizeRange = [0, 2, 3.5, 5, 6.5][state.emberLevel];
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

export function showConfirm(message, onConfirm) {
    dom.confirmText.textContent = message;
    state.pendingConfirmAction = onConfirm;
    dom.confirmOverlay.style.display = 'flex';
}

export function hideConfirm() {
    dom.confirmOverlay.style.display = 'none';
    state.pendingConfirmAction = null;
}

// ---- End session ----

export function endSession(deactivateVoiceFn) {
    if (!state.sessionActive) return;
    showConfirm('End this session?', function () {
        dom.savingOverlay.style.display = 'flex';
        doEndSession(deactivateVoiceFn);
    });
}

export function doEndSession(deactivateVoiceFn) {
    if (state.voiceActive) {
        deactivateVoiceFn();
    }
    socket.emit('end_session');
}
