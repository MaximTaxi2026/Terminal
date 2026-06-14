/**
 * TERMINAL-092026 // Core Javascript Logic
 * Handles Authentication, WS connection, image compression, and Web Audio API synth
 */

// Shared State
let authToken = localStorage.getItem('terminal_auth') || '';
let wsClient = null;
let clientUUID = getOrCreateUUID();
let audioContext = null;

// Page Detectors
const isGuest = document.getElementById('nickname-input') !== null;
const isBroadcast = document.getElementById('feed') !== null;
const isAdmin = document.getElementById('admin-feed') !== null;

// Initialize on Load
document.addEventListener('DOMContentLoaded', () => {
    setupAuth();
    if (authToken) {
        initPage();
    }
});

// --- 1. Authentication System ---
function setupAuth() {
    const lockScreen = document.getElementById('lock-screen');
    const mainContent = document.getElementById('main-content');
    const passwordInput = document.getElementById('password-input');
    const authBtn = document.getElementById('auth-btn');
    const authError = document.getElementById('auth-error');

    if (authToken) {
        lockScreen.style.display = 'none';
        mainContent.style.display = 'block';
        return;
    }

    const attemptAuth = async () => {
        const password = passwordInput.value.strip ? passwordInput.value.strip() : passwordInput.value;
        if (!password) {
            authError.textContent = 'ВВЕДИТЕ КЛЮЧ ДОСТУПА';
            return;
        }

        try {
            const response = await fetch('/api/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });

            if (response.ok) {
                const data = await response.json();
                authToken = data.token;
                localStorage.setItem('terminal_auth', authToken);
                
                // Animate overlay out
                lockScreen.style.opacity = '0';
                lockScreen.style.transition = 'opacity 0.3s ease';
                setTimeout(() => {
                    lockScreen.style.display = 'none';
                    mainContent.style.display = 'block';
                    initPage();
                }, 300);
            } else {
                const err = await response.json();
                authError.textContent = err.detail || 'КЛЮЧ ОТКЛОНЕН';
                triggerInputGlitch(passwordInput);
            }
        } catch (e) {
            authError.textContent = 'ОШИБКА СОЕДИНЕНИЯ С СЕРВЕРОМ';
        }
    };

    authBtn.addEventListener('click', attemptAuth);
    passwordInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') attemptAuth();
    });
}

function triggerInputGlitch(input) {
    input.style.borderColor = 'var(--acid-red)';
    input.style.boxShadow = '0 0 10px rgba(255, 0, 60, 0.5)';
    setTimeout(() => {
        input.style.borderColor = '';
        input.style.boxShadow = '';
    }, 500);
}

// --- 2. Page Specific Init ---
function initPage() {
    setupWebSocket();

    if (isGuest) {
        initGuestPage();
    } else if (isBroadcast) {
        initBroadcastPage();
    } else if (isAdmin) {
        initAdminPage();
    }
}

// --- 3. WebSocket Manager ---
function setupWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?token=${authToken}`;
    
    const statusText = document.getElementById('status-text');
    const statusDot = document.getElementById('status-dot');

    wsClient = new WebSocket(wsUrl);

    wsClient.onopen = () => {
        if (statusText) statusText.textContent = 'ПОДКЛЮЧЕНО';
        if (statusDot) {
            statusDot.className = 'status-dot';
        }
    };

    wsClient.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            handleWebSocketEvent(message);
        } catch (e) {
            console.error('WS parsing error:', e);
        }
    };

    wsClient.onclose = () => {
        if (statusText) statusText.textContent = 'ОТКЛЮЧЕНО (ПОВТОР...)';
        if (statusDot) {
            statusDot.className = 'status-dot disconnected';
        }
        // Reconnect after 3 seconds
        setTimeout(setupWebSocket, 3000);
    };

    wsClient.onerror = (err) => {
        console.error('WS Error:', err);
    };
}

function handleWebSocketEvent(message) {
    const { event, data } = message;

    if (event === 'new_message') {
        if (isBroadcast) {
            appendMessageToBroadcast(data);
        } else if (isGuest) {
            appendMessageToPreview(data);
        } else if (isAdmin) {
            appendMessageToAdmin(data);
        }
    } else if (event === 'delete_message') {
        removeMessageFromDOM(data.id);
    } else if (event === 'play_sound') {
        if (isBroadcast) {
            playSynthesizedSound(data.sound_id);
        }
    }
}

// --- 4. Guest / Mobile Sender Code ---
let selectedColor = '#00FF41'; // Default neon green
let compressedImageBase64 = '';

function initGuestPage() {
    const nicknameInput = document.getElementById('nickname-input');
    const messageInput = document.getElementById('message-input');
    const photoInput = document.getElementById('photo-input');
    const uploadBox = document.getElementById('upload-box');
    const uploadLabel = document.getElementById('upload-label');
    const photoPreviewContainer = document.getElementById('photo-preview-container');
    const photoPreviewImg = document.getElementById('photo-preview-img');
    const clearPhotoBtn = document.getElementById('clear-photo-btn');
    const sendBtn = document.getElementById('send-btn');

    // Restore nickname and color from localStorage
    if (localStorage.getItem('terminal_nick')) {
        nicknameInput.value = localStorage.getItem('terminal_nick');
    }
    if (localStorage.getItem('terminal_color')) {
        selectedColor = localStorage.getItem('terminal_color');
        document.querySelectorAll('.color-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.getAttribute('data-color') === selectedColor) {
                btn.classList.add('active');
            }
        });
    }

    // Color buttons handler
    document.querySelectorAll('.color-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            selectedColor = btn.getAttribute('data-color');
            localStorage.setItem('terminal_color', selectedColor);
        });
    });

    // Duration buttons handler
    document.querySelectorAll('.duration-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.duration-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });

    // Image Picker & Compressor (Canvas client side)
    photoInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            showNotification('Файл должен быть изображением!', true);
            return;
        }

        uploadLabel.textContent = 'СЖАТИЕ ИЗОБРАЖЕНИЯ...';
        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;
                const max_size = 800;

                // Scale proportional clamping
                if (width > height) {
                    if (width > max_size) {
                        height = Math.round((height * max_size) / width);
                        width = max_size;
                    }
                } else {
                    if (height > max_size) {
                        width = Math.round((width * max_size) / height);
                        height = max_size;
                    }
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                // Convert canvas to jpeg base64
                compressedImageBase64 = canvas.toDataURL('image/jpeg', 0.8);
                
                // Show Preview
                photoPreviewImg.src = compressedImageBase64;
                photoPreviewContainer.style.display = 'block';
                clearPhotoBtn.style.display = 'inline-block';
                uploadLabel.style.display = 'none';
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    });

    // Clear Photo
    const clearPhoto = () => {
        photoInput.value = '';
        compressedImageBase64 = '';
        photoPreviewImg.src = '';
        photoPreviewContainer.style.display = 'none';
        clearPhotoBtn.style.display = 'none';
        uploadLabel.style.display = 'inline';
        uploadLabel.textContent = '📎 НАЖМИТЕ ДЛЯ ВЫБОРА ФОТО';
    };
    clearPhotoBtn.addEventListener('click', clearPhoto);

    // Form Submit
    sendBtn.addEventListener('click', async () => {
        const nickname = nicknameInput.value.trim();
        const text = messageInput.value.trim();

        if (!nickname) {
            showNotification('Введите ваш никнейм!', true);
            nicknameInput.focus();
            return;
        }

        if (!text && !compressedImageBase64) {
            showNotification('Напишите сообщение или добавьте фото!', true);
            messageInput.focus();
            return;
        }

        // Save Nickname
        localStorage.setItem('terminal_nick', nickname);

        // Client-side rate-limit lock check (backup protection)
        const lastSentTime = localStorage.getItem('terminal_last_sent') || 0;
        const now = Date.now();
        const diff = (now - lastSentTime) / 1000;
        if (diff < 10) {
            const wait = Math.ceil(10 - diff);
            showNotification(`Подождите ${wait} сек. перед следующей отправкой`, true);
            return;
        }

        // Disable button
        sendBtn.disabled = true;
        sendBtn.textContent = 'ОТПРАВКА СИГНАЛА...';

        const activeDurationBtn = document.querySelector('.duration-btn.active');
        const duration = activeDurationBtn ? parseInt(activeDurationBtn.getAttribute('data-seconds')) : 7;

        try {
            const response = await fetch('/api/message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    nickname,
                    color: selectedColor,
                    text,
                    image: compressedImageBase64,
                    client_id: clientUUID,
                    token: authToken,
                    duration
                })
            });

            if (response.ok) {
                showNotification('СИГНАЛ УСПЕШНО ОТПРАВЛЕН В ЭФИР!');
                messageInput.value = ''; // Clean input
                clearPhoto(); // Clean photo
                localStorage.setItem('terminal_last_sent', Date.now().toString());
                
                // Visual cooldown on send button
                let cooldown = 10;
                const interval = setInterval(() => {
                    if (cooldown > 0) {
                        sendBtn.textContent = `ПЕРЕЗАРЯДКА: ${cooldown}С`;
                        cooldown--;
                    } else {
                        clearInterval(interval);
                        sendBtn.disabled = false;
                        sendBtn.textContent = 'ОТПРАВИТЬ СИГНАЛ';
                    }
                }, 1000);
            } else {
                const err = await response.json();
                showNotification(err.detail || 'Ошибка при отправке!', true);
                sendBtn.disabled = false;
                sendBtn.textContent = 'ОТПРАВИТЬ СИГНАЛ';
            }
        } catch (e) {
            showNotification('Ошибка связи с сервером!', true);
            sendBtn.disabled = false;
            sendBtn.textContent = 'ОТПРАВИТЬ СИГНАЛ';
        }
    });

    // Populate active live-preview on load
    loadHistory(appendMessageToPreview);
}

// --- 5. Broadcast / Projector Screen Code ---
function initBroadcastPage() {
    // Attempt to initialize audio context immediately
    initAudioContext();

    // Silently activate or resume the audio context on the first user interaction anywhere on the page
    window.addEventListener('click', () => {
        initAudioContext();
    }, { once: true });

    // Fetch history disabled for projector to start with empty screen
    // loadHistory(appendMessageToBroadcast);
}

function appendMessageToBroadcast(msg) {
    const feed = document.getElementById('feed');
    
    // Remove default placeholder if present
    const placeholder = feed.querySelector('.message-card[style*="text-align: center"]');
    if (placeholder) {
        placeholder.remove();
    }

    const card = document.createElement('div');
    card.className = 'message-card new-entry';
    card.id = `msg-${msg.id}`;
    card.style.borderLeftColor = msg.color;

    // Time representation
    const timeStr = formatTimestamp(msg.timestamp);

    let imgHtml = '';
    if (msg.image) {
        imgHtml = `
            <div class="message-image-container">
                <img class="message-image" src="${msg.image}" alt="Загруженное фото">
            </div>
        `;
    }

    card.innerHTML = `
        <div class="message-header">
            <span class="message-nickname" style="color: ${msg.color}; text-shadow: 0 0 5px ${msg.color};">> ${msg.nickname}</span>
            <span class="message-time">${timeStr}</span>
        </div>
        <div class="message-text">${msg.text}</div>
        ${imgHtml}
    `;

    // Prepend to feed
    feed.insertBefore(card, feed.firstChild);

    // Audio chirp
    playSynthesizedSound('chirp');

    // Trigger smooth slide-in animation
    setTimeout(() => {
        card.classList.remove('new-entry');
    }, 50);

    // Auto-removal based on duration
    const duration = msg.duration || 7;
    setTimeout(() => {
        card.classList.add('hidden-card');
        setTimeout(() => {
            card.remove();
        }, 500); // Wait for CSS opacity/transform transition
    }, duration * 1000);

    // DOM clean count buffer
    while (feed.children.length > 50) {
        feed.lastChild.remove();
    }
}

// --- 5.1 Guest Live Preview Code ---
function appendMessageToPreview(msg) {
    const feed = document.getElementById('preview-feed');
    if (!feed) return;
    
    // Remove default placeholder if present
    const placeholder = feed.querySelector('.message-card[style*="text-align: center"]');
    if (placeholder) {
        placeholder.remove();
    }

    const card = document.createElement('div');
    card.className = 'message-card new-entry';
    card.id = `msg-${msg.id}`;
    card.style.borderLeftColor = msg.color;

    const timeStr = formatTimestamp(msg.timestamp);

    let imgHtml = '';
    if (msg.image) {
        imgHtml = `
            <div class="message-image-container">
                <img class="message-image" src="${msg.image}" alt="Загруженное фото">
            </div>
        `;
    }

    card.innerHTML = `
        <div class="message-header">
            <span class="message-nickname" style="color: ${msg.color}; text-shadow: 0 0 5px ${msg.color};">> ${msg.nickname}</span>
            <span class="message-time">${timeStr}</span>
        </div>
        <div class="message-text">${msg.text}</div>
        ${imgHtml}
    `;

    // Prepend to feed
    feed.insertBefore(card, feed.firstChild);

    // Trigger smooth slide-in
    setTimeout(() => {
        card.classList.remove('new-entry');
    }, 50);

    // Auto-removal based on duration
    const duration = msg.duration || 7;
    setTimeout(() => {
        card.classList.add('hidden-card');
        setTimeout(() => {
            card.remove();
        }, 500);
    }, duration * 1000);

    // DOM clean count buffer for mobile preview (max 15 items to save memory)
    while (feed.children.length > 15) {
        feed.lastChild.remove();
    }
}

// --- 6. Admin Panel Code ---
function initAdminPage() {
    // Fetch History
    loadHistory(appendMessageToAdmin);

    // Setup Soundboard buttons
    document.querySelectorAll('.btn-sound').forEach(btn => {
        btn.addEventListener('click', () => {
            const soundId = btn.getAttribute('data-sound');
            if (wsClient && wsClient.readyState === WebSocket.OPEN) {
                wsClient.send(JSON.stringify({
                    event: 'trigger_sound',
                    sound_id: soundId
                }));
                showNotification(`Сигнал звука "${soundId.toUpperCase()}" отправлен!`);
            } else {
                showNotification('Ошибка: Нет соединения по WebSockets!', true);
            }
        });
    });
}

function appendMessageToAdmin(msg) {
    const feed = document.getElementById('admin-feed');
    const placeholder = feed.querySelector('.admin-message-row[style*="justify-content: center"]');
    if (placeholder) {
        placeholder.remove();
    }

    const row = document.createElement('div');
    row.className = 'admin-message-row';
    row.id = `msg-${msg.id}`;

    const timeStr = formatTimestamp(msg.timestamp);
    const hasPhoto = msg.image ? '<span style="color: var(--cyber-yellow);">[ФОТО]</span>' : '';

    row.innerHTML = `
        <div class="admin-message-info">
            <div class="admin-message-details">
                <span style="color: ${msg.color}; font-weight: bold;">${msg.nickname}</span> 
                <span style="color: #666; margin-left: 10px;">${timeStr}</span>
                <span style="margin-left: 10px;">${hasPhoto}</span>
            </div>
            <div class="admin-message-content">${msg.text}</div>
        </div>
        <div>
            <button class="btn-terminal btn-delete" onclick="deleteMessageById(${msg.id})">УДАЛИТЬ</button>
        </div>
    `;

    feed.insertBefore(row, feed.firstChild);
}

// Global scope binder for admin deletions
window.deleteMessageById = async (id) => {
    if (!confirm(`Вы действительно хотите удалить сообщение #${id}?`)) return;

    try {
        const response = await fetch(`/api/message/${id}?token=${authToken}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            showNotification(`Сообщение #${id} удалено.`);
        } else {
            showNotification('Ошибка удаления!', true);
        }
    } catch (e) {
        showNotification('Ошибка связи с сервером!', true);
    }
};

// --- 7. Shared Helpers ---
async function loadHistory(renderCallback) {
    try {
        const response = await fetch(`/api/history?token=${authToken}`);
        if (response.ok) {
            const messages = await response.json();
            messages.forEach(msg => {
                renderCallback(msg);
            });
        } else if (response.status === 401) {
            // Expired token
            localStorage.removeItem('terminal_auth');
            window.location.reload();
        }
    } catch (e) {
        console.error('Failed to load messages history', e);
    }
}

function removeMessageFromDOM(id) {
    const card = document.getElementById(`msg-${id}`);
    if (card) {
        card.style.opacity = '0.3';
        card.style.transform = 'scale(0.95)';
        card.style.transition = 'all 0.3s ease';
        setTimeout(() => {
            card.remove();
        }, 300);
    }
}

function showNotification(text, isError = false) {
    const container = document.getElementById('notification-container');
    const toast = document.createElement('div');
    toast.className = `notification ${isError ? 'error' : ''}`;
    toast.innerHTML = `<span>${isError ? '⚡' : '>'}</span> <span>${text}</span>`;
    
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-10px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function getOrCreateUUID() {
    let uuid = localStorage.getItem('terminal_client_id');
    if (!uuid) {
        uuid = 'device_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        localStorage.setItem('terminal_client_id', uuid);
    }
    return uuid;
}

function formatTimestamp(timestamp) {
    const date = new Date(timestamp * 1000);
    const hrs = String(date.getHours()).padStart(2, '0');
    const mins = String(date.getMinutes()).padStart(2, '0');
    const secs = String(date.getSeconds()).padStart(2, '0');
    return `${hrs}:${mins}:${secs}`;
}

// --- 8. Web Audio API Procedural Synthesizer ---
function initAudioContext() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
}

function playSynthesizedSound(soundId) {
    if (!audioContext) return;
    
    // Make sure context is running
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }

    try {
        switch (soundId) {
            case 'chirp':
                synthChirp(audioContext);
                break;
            case 'applause':
                synthApplause(audioContext);
                break;
            case 'laughter':
                synthLaughter(audioContext);
                break;
            case 'fail':
                synthFail(audioContext);
                break;
            case 'fanfare':
                synthFanfare(audioContext);
                break;
            case 'bassboost':
                synthBassBoost(audioContext);
                break;
            default:
                break;
        }
    } catch (e) {
        console.error('Audio Synthesis Error:', e);
    }
}

// Synthesizer nodes functions
function synthChirp(ctx) {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, now);
    osc.frequency.exponentialRampToValueAtTime(1400, now + 0.08);

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.1);
}

function synthApplause(ctx) {
    const duration = 2.2;
    const sampleRate = ctx.sampleRate;
    const bufferSize = sampleRate * duration;
    const buffer = ctx.createBuffer(1, bufferSize, sampleRate);
    const data = buffer.getChannelData(0);
    
    // Fill white noise
    for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1000;
    filter.Q.value = 1.8;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);

    // Simulate overlapping random hand claps
    const now = ctx.currentTime;
    const clapsCount = 20;
    for (let i = 0; i < clapsCount; i++) {
        const time = i * 0.1 + Math.random() * 0.05;
        gain.gain.linearRampToValueAtTime(0.35, now + time + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, now + time + 0.08);
    }

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    noise.start(now);
    noise.stop(now + duration);
}

function synthLaughter(ctx) {
    const now = ctx.currentTime;
    const laughs = 7;
    for (let i = 0; i < laughs; i++) {
        const startTime = now + i * 0.16;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(380 + Math.random() * 60, startTime);
        osc.frequency.exponentialRampToValueAtTime(200, startTime + 0.12);

        gain.gain.setValueAtTime(0, startTime);
        gain.gain.linearRampToValueAtTime(0.3, startTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.12);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(startTime);
        osc.stop(startTime + 0.15);
    }
}

function synthFail(ctx) {
    const now = ctx.currentTime;
    const notes = [
        { freq: 220, dur: 0.28 },
        { freq: 196, dur: 0.28 },
        { freq: 174, dur: 0.28 },
        { freq: 130, dur: 0.8 }
    ];

    let timeOffset = 0;
    notes.forEach((note, index) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const filter = ctx.createBiquadFilter();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(note.freq, now + timeOffset);

        if (index === notes.length - 1) {
            // Pitch slide down for the sad ending note
            osc.frequency.linearRampToValueAtTime(note.freq * 0.65, now + timeOffset + note.dur);
        }

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(600, now + timeOffset);

        // LFO (wobble) to simulate the wah-wah brass mute shape
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        lfo.frequency.value = 8.5; // Wobble frequency
        lfoGain.gain.value = 250;

        lfo.connect(lfoGain);
        lfoGain.connect(filter.frequency);

        gain.gain.setValueAtTime(0, now + timeOffset);
        gain.gain.linearRampToValueAtTime(0.25, now + timeOffset + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, now + timeOffset + note.dur - 0.02);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);

        lfo.start(now + timeOffset);
        osc.start(now + timeOffset);

        lfo.stop(now + timeOffset + note.dur);
        osc.stop(now + timeOffset + note.dur);

        timeOffset += note.dur - 0.04;
    });
}

function synthFanfare(ctx) {
    const now = ctx.currentTime;
    const notes = [
        { freq: 261.63, start: 0.0, dur: 0.1 },  // C4
        { freq: 329.63, start: 0.1, dur: 0.1 },  // E4
        { freq: 392.00, start: 0.2, dur: 0.1 },  // G4
        { freq: 523.25, start: 0.3, dur: 0.6 }   // C5
    ];

    notes.forEach(note => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const filter = ctx.createBiquadFilter();

        osc.type = 'sawtooth';
        osc.frequency.value = note.freq;

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(900, now + note.start);
        filter.frequency.exponentialRampToValueAtTime(450, now + note.start + note.dur);

        gain.gain.setValueAtTime(0, now + note.start);
        gain.gain.linearRampToValueAtTime(0.18, now + note.start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + note.start + note.dur);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now + note.start);
        osc.stop(now + note.start + note.dur);
    });
}

function synthBassBoost(ctx) {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    const waveShaper = ctx.createWaveShaper();

    // Custom distortion curve generator
    function getCurve(amount) {
        const k = amount;
        const n_samples = 44100;
        const curve = new Float32Array(n_samples);
        const deg = Math.PI / 180;
        for (let i = 0; i < n_samples; ++i) {
            const x = (i * 2) / n_samples - 1;
            curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
        }
        return curve;
    }

    waveShaper.curve = getCurve(120);
    waveShaper.oversample = '4x';

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(130, now);
    osc.frequency.exponentialRampToValueAtTime(32, now + 1.2);

    filter.type = 'lowpass';
    filter.frequency.value = 160;

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.8, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 1.4);

    osc.connect(waveShaper);
    waveShaper.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 1.5);
}
