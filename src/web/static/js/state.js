/* state.js — shared mutable state, DOM refs, and socket instance */

export const socket = io();

// DOM refs — initialised by initDOM() after DOMContentLoaded
export const dom = {
    conversationEl: null,
    voiceBtn: null,
    voiceStatus: null,
    ttsToggle: null,
    endBtn: null,
    newSessionBtn: null,
    historyBtn: null,
    speedSlider: null,
    voicePickerBtn: null,
    voiceModal: null,
    voiceModalList: null,
    voiceModalClose: null,
    modalSpeedSlider: null,
    typingEl: null,
    timerEl: null,
    orbEl: null,
    confirmOverlay: null,
    confirmText: null,
    confirmYes: null,
    confirmNo: null,
    savingOverlay: null,
    endedOverlay: null,
    kasinaToggle: null,
    emberBlocks: null,
    emberContainer: null,
    sessionContainer: null,
    listenBtn: null,
};

export function initDOM() {
    dom.conversationEl = document.getElementById('conversation');
    dom.voiceBtn = document.getElementById('voice-btn');
    dom.voiceStatus = document.getElementById('voice-status');
    dom.ttsToggle = document.getElementById('tts-toggle');
    dom.endBtn = document.getElementById('end-btn');
    dom.newSessionBtn = document.getElementById('new-session-btn');
    dom.historyBtn = document.getElementById('history-btn');
    dom.speedSlider = document.getElementById('speed-slider');
    dom.voicePickerBtn = document.getElementById('voice-picker-btn');
    dom.voiceModal = document.getElementById('voice-modal');
    dom.voiceModalList = document.getElementById('voice-modal-list');
    dom.voiceModalClose = document.getElementById('voice-modal-close');
    dom.modalSpeedSlider = document.getElementById('modal-speed-slider');
    dom.typingEl = document.getElementById('typing-indicator');
    dom.timerEl = document.getElementById('timer');
    dom.orbEl = document.getElementById('orb');
    dom.confirmOverlay = document.getElementById('session-confirm');
    dom.confirmText = document.getElementById('confirm-text');
    dom.confirmYes = document.getElementById('confirm-yes');
    dom.confirmNo = document.getElementById('confirm-no');
    dom.savingOverlay = document.getElementById('session-saving');
    dom.endedOverlay = document.getElementById('session-ended');
    dom.kasinaToggle = document.getElementById('kasina-toggle');
    dom.emberBlocks = document.getElementById('ember-blocks');
    dom.emberContainer = document.getElementById('ember-container');
    dom.sessionContainer = document.querySelector('.session-container');
    dom.listenBtn = document.getElementById('listen-btn');
}

// Mutable state — all modules read/write through this single object
export const state = {
    sessionActive: false,
    voiceActive: false,
    timerInterval: null,
    sessionStart: null,
    sessionId: null,
    initialConnectDone: false,
    queuedSpeech: null,
    orbDragging: false,
    orbMoved: false,
    inSilenceMode: false,
    silenceBuffer: [],
    emberLevel: 1,
    pendingNavigation: null,
    pendingConfirmAction: null,
    ttsRate: 160,
    synth: window.speechSynthesis || null,
    preferredVoice: null,
    scoredVoices: [],
    previewUtterance: null,

    // Audio capture state
    audioContext: null,
    mediaStream: null,
    sourceNode: null,
    scriptProcessor: null,
    audioChunks: [],
    listening: false,
    ttsSpeaking: false,
    ttsMismatchStart: 0,
    serverAudioSource: null,
    serverAudioPlaying: false,
    queuedAudio: null,
    preBuffer: [],
    pendingTranscriptions: 0,

    // VAD state machine
    vadState: 'silence',
    speechStartTime: 0,
    lastSpeechTime: 0,
    noiseFloor: 0.005,
    noiseSamples: 0,
    bargeInCount: 0,
    smoothedLevel: 0,

    // Speculative transcription
    speculativeGen: 0,
    speculativeSent: false,
    speculativeText: null,
    awaitingSpeculative: false,

    // Voice list internals
    _maxRawVoices: 0,
    _serverVoices: null,
};
