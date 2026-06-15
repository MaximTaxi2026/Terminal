/**
 * TERMINAL-092026 // Core Javascript Logic
 * Handles Authentication, WS connection, image compression, and Web Audio API synth
 */

// Shared State
function safeRenderText(text) {
    if (text === null || text === undefined) return '';
    let str = '';
    if (typeof text === 'object') {
        console.warn("safeRenderText got an object:", text);
        try {
            str = JSON.stringify(text);
        } catch(e) {
            str = '[object Object]';
        }
    } else {
        str = String(text);
    }
    // Escape HTML to prevent broken DOM layout and injection
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

let authToken = '';
let wsClient = null;
let clientUUID = getOrCreateUUID();
let audioContext = null;
let messagesState = [];
let pendingMessages = new Map();
let lastSeq = parseInt(localStorage.getItem('lastSeq')) || 0;
let currentServerRunId = localStorage.getItem('serverRunId');
let isDrawingMode = false;
let drawColor = '#00FF41';
let guestDrawCtx = null;

// Page Initialization Guards
let guestPageInitialized = false;
let broadcastPageInitialized = false;
let adminPageInitialized = false;

// Page Detectors
const isGuest = document.getElementById('nickname-input') !== null;
const isBroadcast = document.getElementById('feed') !== null;
const isAdmin = document.getElementById('admin-feed') !== null;

// Initialize on Load
document.addEventListener('DOMContentLoaded', () => {
    if (isBroadcast) {
        // Проектор: работаем без пароля
        authToken = "092026";
        const mainContent = document.getElementById('main-content');
        if (mainContent) mainContent.style.display = 'block';
        initPage();
    } else {
        // Отправитель и Админка: жесткая блокировка
        const lockScreen = document.getElementById('lock-screen');
        const mainContent = document.getElementById('main-content');
        
        if (mainContent) mainContent.style.display = 'none';
        if (lockScreen) lockScreen.style.display = 'flex';
        
        // Поддержка сессии без перезахода
        const savedToken = sessionStorage.getItem('auth_token');
        if (savedToken) {
            authToken = savedToken;
            fetch(`/api/verify?token=${authToken}`)
                .then(res => res.json())
                .then(data => {
                    if (data.status === 'ok') {
                        unlock();
                    } else {
                        sessionStorage.removeItem('auth_token');
                        setupAuth();
                    }
                })
                .catch(() => setupAuth());
        } else {
            setupAuth();
        }
    }
});

// --- 1. Authentication System ---
function unlock() {
    const lockScreen = document.getElementById('lock-screen');
    const mainContent = document.getElementById('main-content');
    if (lockScreen) {
        lockScreen.style.opacity = '0';
        lockScreen.style.transition = 'opacity 0.3s ease';
        setTimeout(() => {
            lockScreen.style.display = 'none';
            if (mainContent) mainContent.style.display = 'block';
            initPage();
        }, 300);
    } else {
        if (mainContent) mainContent.style.display = 'block';
        initPage();
    }
}

function setupAuth() {
    const passwordInput = document.getElementById('password-input');
    const authBtn = document.getElementById('auth-btn');
    const authError = document.getElementById('auth-error');

    const attemptAuth = async () => {
        const password = passwordInput.value.trim ? passwordInput.value.trim() : passwordInput.value;
        if (!password) {
            authError.textContent = 'ВВЕДИТЕ КЛЮЧ ДОСТУПА';
            return;
        }

        const prevText = authBtn.textContent;
        authBtn.disabled = true;
        authBtn.textContent = 'ПРОВЕРКА...';

        try {
            const response = await fetch('/api/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });

            if (response.ok) {
                const data = await response.json();
                authToken = data.token;
                sessionStorage.setItem('auth_token', authToken);
                unlock();
            } else {
                const err = await response.json();
                authError.textContent = err.detail || 'КЛЮЧ ОТКЛОНЕН';
                triggerInputGlitch(passwordInput);
                authBtn.textContent = prevText;
                authBtn.disabled = false;
            }
        } catch (e) {
            authError.textContent = 'ОШИБКА СОЕДИНЕНИЯ С СЕРВЕРОМ';
            authBtn.textContent = prevText;
            authBtn.disabled = false;
        }
    };

    if (authBtn) authBtn.addEventListener('click', attemptAuth);
    if (passwordInput) passwordInput.addEventListener('keypress', (e) => {
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
let pongTimeout = null;
let heartbeatInterval = null;
let reconnectTimeout = null;

function setupWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?token=${authToken}`;
    
    const statusText = document.getElementById('status-text');
    const statusDot = document.getElementById('status-dot');

    wsClient = new WebSocket(wsUrl);

    wsClient.onopen = () => {
        console.log('WS Connected');
        if (statusText) statusText.textContent = 'ПОДКЛЮЧЕНО';
        if (statusDot) {
            statusDot.className = 'status-dot';
        }
        
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        
        // Robust Heartbeat mechanism (15s ping for Render)
        heartbeatInterval = setInterval(() => {
            if (wsClient && wsClient.readyState === WebSocket.OPEN) {
                wsClient.send(JSON.stringify({ event: 'ping' }));
                
                if (pongTimeout) clearTimeout(pongTimeout);
                pongTimeout = setTimeout(() => {
                    console.warn('Heartbeat timeout (no pong), forcing reconnect...');
                    wsClient.close();
                }, 5000);
            }
        }, 15000);
        } else if (isAdmin) {
            loadHistory(appendMessageToAdmin);
        }
    };

    wsClient.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            
            if (message.event === 'pong') {
                if (pongTimeout) clearTimeout(pongTimeout);
                return; // Heartbeat handled successfully
            }
            
            handleWebSocketEvent(message);
        } catch (e) {
            console.error('WS parsing error:', e);
        }
    };

    wsClient.onclose = () => {
        console.log('WS Disconnected');
        if (statusText) statusText.textContent = 'ОТКЛЮЧЕНО (ПОВТОР...)';
        if (statusDot) {
            statusDot.className = 'status-dot disconnected';
        }
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (pongTimeout) clearTimeout(pongTimeout);
        
        // Prevent multiple simultaneous reconnects
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(setupWebSocket, 2000);
    };

    wsClient.onerror = (err) => {
        console.error('Подробная ошибка WS:', err);
    };
}

function handleWebSocketEvent(message) {
    const { event, data } = message;

    if (event === 'init') {
        const newRunId = data.server_run_id;
        if (currentServerRunId && currentServerRunId !== newRunId) {
            console.warn('[SYNC] Server restarted! Clearing local state and reloading...');
            localStorage.setItem('serverRunId', newRunId);
            localStorage.setItem('lastSeq', '0');
            window.location.reload();
            return;
        }
        
        currentServerRunId = newRunId;
        localStorage.setItem('serverRunId', newRunId);
        
        if (lastSeq > 0) {
            // Replay missed events
            console.log(`[SYNC] Fetching missed events since seq=${lastSeq}...`);
            fetch(`/api/events?last_id=${lastSeq}&token=${authToken}`)
                .then(r => r.json())
                .then(events => {
                    if (events.length > 0) {
                        console.log(`[REPLAY] Applying ${events.length} missed events.`);
                        events.forEach(entry => {
                            if (entry.seq > lastSeq) {
                                lastSeq = entry.seq;
                                localStorage.setItem('lastSeq', lastSeq.toString());
                            }
                            // Call recursively but without _seq so it doesn't double-trigger updates
                            handleWebSocketEvent({ event: entry.event, data: entry.data });
                        });
                    }
                })
                .catch(e => console.error('[REPLAY] Failed to fetch events:', e));
        } else {
            // First load
            if (isBroadcast) {
                loadHistory((msg) => {
                    const now = Date.now() / 1000;
                    const elapsed = now - msg.timestamp;
                    const remaining = msg.duration - elapsed;
                    if (remaining > 0) {
                        const originalDuration = msg.duration;
                        msg.duration = remaining;
                        appendMessageToBroadcast(msg);
                        msg.duration = originalDuration;
                    }
                });
            } else if (isAdmin) {
                loadHistory(appendMessageToAdmin);
            }
        }
        return;
    }

    // Обновляем счётчик — для replay при переподключении
    if (message._seq && message._seq > lastSeq) {
        lastSeq = message._seq;
        localStorage.setItem('lastSeq', lastSeq.toString());
    }

    if (isGuest) {
        if (event === 'message_confirmed') {
            const msgId = data.message_id;
            if (pendingMessages.has(msgId)) {
                pendingMessages.delete(msgId);
                console.log(`[DISPLAYED] Message ${msgId} successfully displayed.`);
                const container = document.getElementById('notification-container');
                if (container) {
                    showNotification('СИГНАЛ УСПЕШНО ВЫВЕДЕН В ЭФИР!');
                }
            }
        } else if (event === 'draw_start' || event === 'draw_move' || event === 'draw_end' || event === 'draw_clear') {
            handleClientDraw(event, data);
        }
        return; // Guest page ignores all other broadcast events!
    }

    if (isAdmin) {
        if (event === 'new_message') {
            messagesState.push(data);
            appendMessageToAdmin(data);
        } else if (event === 'delete_message') {
            removeMessageFromDOM(data.id);
        }
        return; // Admin page only handles message history and deletions!
    }

    // Broadcast (Projector) and other display clients process everything!
    if (event === 'new_message') {
        messagesState.push(data);
        appendMessageToBroadcast(data);
        if (wsClient && wsClient.readyState === WebSocket.OPEN) {
            wsClient.send(JSON.stringify({ event: 'broadcast_ack', message_id: data.message_id, server_id: data.id }));
        }
    } else if (event === 'emoji') {
        showEmojiOverlay(data.emoji);
    } else if (event === 'delete_message') {
        removeMessageFromDOM(data.id);
    } else if (event === 'play_sound') {
        playSynthesizedSound(data.sound_id);
    } else if (event === 'draw_start' || event === 'draw_move' || event === 'draw_end' || event === 'draw_clear') {
        handleClientDraw(event, data);
    } else if (event === 'remote_video_control') {
        handleRemoteVideoControl(data);
    } else if (event === 'remote_ui_control') {
        handleRemoteUI(data.action);
    } else if (event === 'remote_zoom_control') {
        updateZoom(data.action);
    }
}

// --- 4. Guest / Mobile Sender Code ---
let selectedColor = '#00FF41'; // Default neon green
let compressedImageBase64 = '';

function initGuestPage() {
    if (guestPageInitialized) return;
    guestPageInitialized = true;

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
    let uploadedVideoFile = null;
    photoInput.addEventListener('change', (e) => {
        const file = e.target && e.target.files ? e.target.files[0] : null;
        if (!file) return;

        if (file.type.startsWith('video/')) {
            uploadLabel.textContent = 'ОБРАБОТКА ВИДЕО...';
            uploadedVideoFile = file;
            
            const url = URL.createObjectURL(file);
            const videoPreviewVid = document.getElementById('video-preview-vid');
            if(videoPreviewVid) {
                videoPreviewVid.src = url;
                videoPreviewVid.style.display = 'block';
            }
            
            const photoPreviewImg = document.getElementById('photo-preview-img');
            if(photoPreviewImg) photoPreviewImg.style.display = 'none';
            if(photoPreviewImg) photoPreviewImg.src = '';
            compressedImageBase64 = '';
            
            photoPreviewContainer.style.display = 'block';
            clearPhotoBtn.style.display = 'inline-block';
            uploadLabel.style.display = 'none';
            return;
        }

        if (!file.type.startsWith('image/')) {
            showNotification('Файл должен быть изображением или видео!', true);
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
                const videoPreviewVid = document.getElementById('video-preview-vid');
                if(videoPreviewVid) videoPreviewVid.style.display = 'none';
                photoPreviewImg.style.display = 'block';
                uploadedVideoFile = null;
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
        uploadedVideoFile = null;
        const videoPreviewVid = document.getElementById('video-preview-vid');
        if(videoPreviewVid) {
            videoPreviewVid.style.display = 'none';
            videoPreviewVid.src = '';
        }
        if(photoPreviewImg) photoPreviewImg.style.display = 'none';
        photoInput.value = '';
        compressedImageBase64 = '';
        photoPreviewImg.src = '';
        photoPreviewContainer.style.display = 'none';
        clearPhotoBtn.style.display = 'none';
        uploadLabel.style.display = 'inline';
        uploadLabel.textContent = '📎 НАЖМИТЕ ДЛЯ ВЫБОРА ФОТО';
    };
    clearPhotoBtn.addEventListener('click', clearPhoto);

    // Draw Mode Toggle
    const toggleDrawBtn = document.getElementById('toggle-draw-btn');
    const drawContainer = document.getElementById('draw-container');
    const drawCanvas = document.getElementById('draw-canvas');
    let isDrawing = false;
    
    if (toggleDrawBtn) {
        toggleDrawBtn.addEventListener('click', () => {
            isDrawingMode = !isDrawingMode;
            if (isDrawingMode) {
                toggleDrawBtn.textContent = '🎨 РЕЖИМ РИСОВАНИЯ: ВКЛ';
                toggleDrawBtn.style.color = 'var(--neon-green)';
                toggleDrawBtn.style.borderColor = 'var(--neon-green)';
                drawContainer.style.display = 'block';
                initDrawCanvas();
            } else {
                toggleDrawBtn.textContent = '🎨 РЕЖИМ РИСОВАНИЯ: ВЫКЛ';
                toggleDrawBtn.style.color = 'var(--neon-blue)';
                toggleDrawBtn.style.borderColor = 'var(--neon-blue)';
                drawContainer.style.display = 'none';
                if (wsClient && wsClient.readyState === WebSocket.OPEN) {
                    wsClient.send(JSON.stringify({
                        event: 'draw_clear',
                        data: { client_id: clientUUID }
                    }));
                }
            }
        });
    }
    
    function initDrawCanvas() {
        const dpr = window.devicePixelRatio || 1;
        drawCanvas.width = drawCanvas.offsetWidth * dpr;
        drawCanvas.height = drawCanvas.offsetHeight * dpr;
        guestDrawCtx = drawCanvas.getContext('2d');
        guestDrawCtx.scale(dpr, dpr);
        guestDrawCtx.lineCap = 'round';
        guestDrawCtx.lineJoin = 'round';
        drawCanvas.style.touchAction = 'none';
        
        if (!drawCanvas._listenersRegistered) {
            drawCanvas._listenersRegistered = true;
            
            window.addEventListener('resize', () => {
                if (!drawCanvas) return;
                const dpr = window.devicePixelRatio || 1;
                drawCanvas.width = drawCanvas.offsetWidth * dpr;
                drawCanvas.height = drawCanvas.offsetHeight * dpr;
                if (guestDrawCtx) {
                    guestDrawCtx.scale(dpr, dpr);
                    guestDrawCtx.lineCap = 'round';
                    guestDrawCtx.lineJoin = 'round';
                }
            });
            
            let lastSendTime = 0;

            const sendDrawEvent = (type, normX, normY) => {
                if (wsClient && wsClient.readyState === WebSocket.OPEN) {
                    wsClient.send(JSON.stringify({
                        event: type,
                        data: {
                            client_id: clientUUID,
                            x: normX,
                            y: normY,
                            color: selectedColor
                        }
                    }));
                }
            };

            const getCoords = (e) => {
                const rect = drawCanvas.getBoundingClientRect();
                const clientX = e.touches ? e.touches[0].clientX : e.clientX;
                const clientY = e.touches ? e.touches[0].clientY : e.clientY;
                return {
                    normX: (clientX - rect.left) / rect.width,
                    normY: (clientY - rect.top) / rect.height
                };
            };

            const startDraw = (e) => {
                if (e.cancelable) e.preventDefault();
                isDrawing = true;
                const coords = getCoords(e);
                sendDrawEvent('draw_start', coords.normX, coords.normY);
            };

            const moveDraw = (e) => {
                if (!isDrawing) return;
                e.preventDefault();
                const coords = getCoords(e);
                
                const now = Date.now();
                if (now - lastSendTime > 30) { 
                    sendDrawEvent('draw_move', coords.normX, coords.normY);
                    lastSendTime = now;
                }
            };

            const endDraw = () => {
                if (isDrawing) {
                    isDrawing = false;
                    sendDrawEvent('draw_end', 0, 0);
                }
            };

            drawCanvas.addEventListener('mousedown', startDraw);
            drawCanvas.addEventListener('mousemove', moveDraw);
            drawCanvas.addEventListener('mouseup', endDraw);
            drawCanvas.addEventListener('mouseout', endDraw);
            
            drawCanvas.addEventListener('touchstart', startDraw, {passive: false});
            drawCanvas.addEventListener('touchmove', moveDraw, {passive: false});
            drawCanvas.addEventListener('touchend', endDraw);
        }
    }
    
    document.getElementById('clear-canvas-btn')?.addEventListener('click', () => {
        if (wsClient && wsClient.readyState === WebSocket.OPEN) {
            wsClient.send(JSON.stringify({
                event: 'draw_clear',
                data: { client_id: clientUUID }
            }));
        }
    });

    // Form Submit Update
    sendBtn.addEventListener('click', async () => {
        const nickname = nicknameInput.value.trim();
        const text = messageInput.value.trim();
        const image = (photoPreviewContainer.style.display !== 'none' && photoPreviewImg.src && photoPreviewImg.src.startsWith('data:')) ? photoPreviewImg.src : '';

        if (!nickname) {
            showNotification('Введите ваш никнейм!', true);
            return;
        }

        if (!text && !image && !uploadedVideoFile && !isDrawingMode) {
            showNotification('Напишите сообщение или добавьте медиа!', true);
            return;
        }

        localStorage.setItem('terminal_nick', nickname);
        sendBtn.disabled = true;
        sendBtn.textContent = 'ОТПРАВКА СИГНАЛА...';

        const activeDurationBtn = document.querySelector('.duration-btn.active');
        const secondsAttr = activeDurationBtn ? activeDurationBtn.getAttribute('data-seconds') : '7';
        
        let displayMode = 'temporary';
        let duration = 7;
        
        if (secondsAttr === 'persistent') {
            displayMode = 'persistent';
            duration = 0;
        } else {
            displayMode = 'temporary';
            duration = parseInt(secondsAttr) || 7;
        }

        let videoUrl = '';
        if (uploadedVideoFile) {
            sendBtn.textContent = 'ОБРАБОТКА ВИДЕО...';
            const formData = new FormData();
            formData.append('file', uploadedVideoFile);
            formData.append('token', authToken);
            
            try {
                const upRes = await fetch('/api/upload/video', { method: 'POST', body: formData });
                if (upRes.ok) {
                    const upData = await upRes.json();
                    videoUrl = upData.video_url;
                } else {
                    showNotification('Ошибка загрузки видео!', true);
                    sendBtn.disabled = false;
                    sendBtn.textContent = 'ОТПРАВИТЬ СИГНАЛ';
                    return;
                }
            } catch(e) {
                showNotification('Сбой сети при загрузке видео!', true);
                sendBtn.disabled = false;
                sendBtn.textContent = 'ОТПРАВИТЬ СИГНАЛ';
                return;
            }
        }

        const messageId = clientUUID + '-' + Date.now();
        pendingMessages.set(messageId, { time: Date.now() });
        const type = videoUrl ? 'video' : 'text';

        try {
            const response = await fetch('/api/message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    nickname, color: selectedColor, text, image, video_url: videoUrl,
                    client_id: clientUUID, token: authToken, duration, message_id: messageId,
                    display_mode: displayMode, type
                })
            });

            if (response.ok) {
                showNotification('СИГНАЛ ОТПРАВЛЕН В ЭФИР!');
                messageInput.value = '';
                clearPhoto();
                
                // Reset hide/show remote button if it was in show state
                const hideBtn = document.getElementById('hide-btn');
                if (hideBtn && hideBtn.getAttribute('data-state') === 'hidden') {
                    hideBtn.setAttribute('data-state', 'visible');
                    hideBtn.textContent = '❌ СКРЫТЬ';
                    hideBtn.style.color = 'var(--acid-red)';
                    hideBtn.style.borderColor = 'var(--acid-red)';
                }
                
                let cooldown = 5;
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
                showNotification('Ошибка при отправке!', true);
                sendBtn.disabled = false;
                sendBtn.textContent = 'ОТПРАВИТЬ СИГНАЛ';
            }
        } catch (e) {
            showNotification('Ошибка связи с сервером!', true);
            sendBtn.disabled = false;
            sendBtn.textContent = 'ОТПРАВИТЬ СИГНАЛ';
        }
    });

    // Remote Control Buttons
    document.querySelectorAll('.remote-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const cmd = btn.getAttribute('data-cmd');
            if (wsClient && wsClient.readyState === WebSocket.OPEN) {
                wsClient.send(JSON.stringify({
                    event: 'remote_video_control',
                    data: { command: cmd }
                }));
                showNotification(`КОМАНДА ${cmd.toUpperCase()} ОТПРАВЛЕНА`);
            } else {
                showNotification('НЕТ СОЕДИНЕНИЯ С ЭФИРОМ', true);
            }
        });
    });

    // Hide UI Button
    const hideBtn = document.getElementById('hide-btn');
    if (hideBtn) {
        hideBtn.addEventListener('click', () => {
            let state = hideBtn.getAttribute('data-state') || 'visible';
            let action = 'hide';
            if (state === 'visible') {
                hideBtn.setAttribute('data-state', 'hidden');
                hideBtn.textContent = '👁️ ПОКАЗАТЬ';
                hideBtn.style.color = 'var(--neon-green)';
                hideBtn.style.borderColor = 'var(--neon-green)';
                action = 'hide';
            } else {
                hideBtn.setAttribute('data-state', 'visible');
                hideBtn.textContent = '❌ СКРЫТЬ';
                hideBtn.style.color = 'var(--acid-red)';
                hideBtn.style.borderColor = 'var(--acid-red)';
                action = 'show';
            }
            if (wsClient && wsClient.readyState === WebSocket.OPEN) {
                wsClient.send(JSON.stringify({
                    event: 'remote_ui_control',
                    data: { action: action }
                }));
                showNotification(`КОМАНДА ${action.toUpperCase()} ОТПРАВЛЕНА`);
            } else {
                showNotification('НЕТ СОЕДИНЕНИЯ С ЭФИРОМ', true);
            }
        });
    }

    // Zoom Buttons
    document.querySelectorAll('.zoom-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.getAttribute('data-zoom');
            if (wsClient && wsClient.readyState === WebSocket.OPEN) {
                wsClient.send(JSON.stringify({
                    event: 'remote_zoom_control',
                    data: { action: action }
                }));
                showNotification(`МАСШТАБ: ${action.toUpperCase()}`);
            } else {
                showNotification('НЕТ СОЕДИНЕНИЯ С ЭФИРОМ', true);
            }
        });
    });

    // Emoji Buttons (with 250ms client-side throttle)
    let lastEmojiTime = 0;
    document.querySelectorAll('.emoji-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const now = Date.now();
            if (now - lastEmojiTime < 250) {
                return; // Throttle fast clicks
            }
            lastEmojiTime = now;
            const emoji = btn.getAttribute('data-emoji');
            if (wsClient && wsClient.readyState === WebSocket.OPEN) {
                wsClient.send(JSON.stringify({
                    event: 'emoji',
                    data: { emoji: emoji }
                }));
            } else {
                showNotification('НЕТ СОЕДИНЕНИЯ С ЭФИРОМ', true);
            }
        });
    });
}

// --- 5. Broadcast / Projector Screen Code ---
function initBroadcastPage() {
    if (broadcastPageInitialized) return;
    broadcastPageInitialized = true;

    // Attempt to initialize audio context immediately
    initAudioContext();

    // Silently activate or resume the audio context on the first user interaction anywhere on the page
    window.addEventListener('click', () => {
        initAudioContext();
    }, { once: true });
}



function setupCustomVideoPlayer(card) {
    const player = card.querySelector('.custom-video-player');
    if (!player) return;

    const video = player.querySelector('.message-video');
    const controls = player.querySelector('.custom-video-controls');
    const playPauseBtn = player.querySelector('.play-pause-btn');
    const progressContainer = player.querySelector('.vid-progress-container');
    const progressBar = player.querySelector('.vid-progress-bar');
    const timeDisplay = player.querySelector('.vid-time');
    const muteBtn = player.querySelector('.mute-btn');

    video.volume = 0.5;

    const togglePlay = (e) => {
        if (e) e.stopPropagation();
        if (video.paused) {
            video.play().catch(err => console.log('Autoplay error:', err));
            playPauseBtn.textContent = '⏸';
        } else {
            video.pause();
            playPauseBtn.textContent = '⏵';
        }
        resetControlsTimeout();
    };

    playPauseBtn.addEventListener('click', togglePlay);
    video.addEventListener('click', togglePlay);

    muteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        video.muted = !video.muted;
        muteBtn.textContent = video.muted ? '🔇' : '🔊';
        muteBtn.style.color = video.muted ? 'var(--acid-red)' : 'var(--neon-green)';
        resetControlsTimeout();
    });

    let isDraggingProgress = false;
    let lastSeekTimeUpdate = 0;

    const updateProgressVisuals = (clientX) => {
        const rect = progressContainer.getBoundingClientRect();
        let pos = (clientX - rect.left) / rect.width;
        pos = Math.max(0, Math.min(1, pos));
        progressBar.style.width = `${pos * 100}%`;
        
        const seekTime = pos * video.duration || 0;
        const curMins = Math.floor(seekTime / 60).toString().padStart(2, '0');
        const curSecs = Math.floor(seekTime % 60).toString().padStart(2, '0');
        timeDisplay.textContent = `${curMins}:${curSecs}`;
        return pos;
    };

    const seek = (clientX, force = false) => {
        const pos = updateProgressVisuals(clientX);
        const now = Date.now();
        if (force || now - lastSeekTimeUpdate > 150) {
            video.currentTime = pos * video.duration || 0;
            lastSeekTimeUpdate = now;
        }
        resetControlsTimeout();
    };

    video.addEventListener('timeupdate', () => {
        if (!isDraggingProgress) {
            const percent = (video.currentTime / video.duration) * 100 || 0;
            progressBar.style.width = `${percent}%`;

            const curMins = Math.floor(video.currentTime / 60).toString().padStart(2, '0');
            const curSecs = Math.floor(video.currentTime % 60).toString().padStart(2, '0');
            timeDisplay.textContent = `${curMins}:${curSecs}`;
        }
    });

    progressContainer.addEventListener('mousedown', (e) => {
        isDraggingProgress = true;
        seek(e.clientX);
        
        const onMouseMove = (moveEvent) => {
            seek(moveEvent.clientX);
        };
        
        const onMouseUp = (upEvent) => {
            isDraggingProgress = false;
            seek(upEvent.clientX, true);
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };
        
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
    });

    progressContainer.addEventListener('touchstart', (e) => {
        isDraggingProgress = true;
        if (e.touches && e.touches.length > 0) {
            seek(e.touches[0].clientX);
        }
        
        const onTouchMove = (moveEvent) => {
            if (moveEvent.touches && moveEvent.touches.length > 0) {
                seek(moveEvent.touches[0].clientX);
            }
        };
        
        const onTouchEnd = (endEvent) => {
            isDraggingProgress = false;
            if (endEvent.changedTouches && endEvent.changedTouches.length > 0) {
                seek(endEvent.changedTouches[0].clientX, true);
            }
            window.removeEventListener('touchmove', onTouchMove);
            window.removeEventListener('touchend', onTouchEnd);
        };
        
        window.addEventListener('touchmove', onTouchMove, { passive: true });
        window.addEventListener('touchend', onTouchEnd);
    }, { passive: true });

    let controlsTimeout;
    const showControls = () => {
        controls.classList.add('visible');
        resetControlsTimeout();
    };

    const hideControls = () => {
        if (!video.paused) {
            controls.classList.remove('visible');
        }
    };

    const resetControlsTimeout = () => {
        clearTimeout(controlsTimeout);
        controlsTimeout = setTimeout(hideControls, 2500);
    };

    player.addEventListener('mousemove', showControls);
    player.addEventListener('touchstart', showControls, { passive: true });
    
    showControls();
}

function getAdaptiveFontSize(text) {
    if (!text) return '5rem';
    const len = text.length;
    let size = 7.0 - 0.0129 * (len - 10);
    size = Math.max(3.5, Math.min(7.0, size));
    return `${size.toFixed(2)}rem`;
}

let currentZoom = 1.0;
function updateZoom(command) {
    if (command === 'zoom-in') {
        currentZoom += 0.1;
    } else if (command === 'zoom-out') {
        currentZoom = Math.max(0.1, currentZoom - 0.1);
    } else if (command === 'zoom-reset') {
        currentZoom = 1.0;
    }
    document.body.style.setProperty('--zoom-factor', currentZoom);
    console.log(`[ZOOM] Zoom set to: ${currentZoom}`);
}



let isIdleState = false;

function handleRemoteUI(action) {
    const activeCard = document.querySelector('#feed .message-card');
    const drawCanvas = document.getElementById('broadcast-draw-canvas');
    const emojiContainer = document.getElementById('emoji-overlay-container');

    if (action === 'hide') {
        isIdleState = true;
        if (activeCard) {
            activeCard.classList.add('hidden-active');
            const video = activeCard.querySelector('video');
            if (video) video.pause();
        }
        if (drawCanvas) drawCanvas.style.opacity = '0';
        if (emojiContainer) emojiContainer.style.opacity = '0';
    } else if (action === 'show') {
        isIdleState = false;
        if (activeCard) {
            activeCard.classList.remove('hidden-active');
            const video = activeCard.querySelector('video');
            if (video) video.play().catch(err => console.log(err));
        }
        if (drawCanvas) drawCanvas.style.opacity = '1';
        if (emojiContainer) emojiContainer.style.opacity = '1';
    }
}



function cleanupVideoOnServer(videoUrl) {
    if (!videoUrl) return;
    let relativeUrl = videoUrl;
    if (videoUrl.includes('/static/uploads/')) {
        relativeUrl = '/static/uploads/' + videoUrl.split('/static/uploads/')[1];
    }
    if (!relativeUrl.startsWith('/static/uploads/')) return;

    console.log(`[VIDEO UNUSED] Notifying WS about video: ${relativeUrl}`);
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({
            event: 'video_ended',
            video_url: relativeUrl
        }));
    }
}

function appendMessageToBroadcast(msg) {
    if (document.getElementById(`msg-${msg.id}`)) return;
    const feed = document.getElementById('feed');
    
    if (typeof isIdleState !== 'undefined') {
        isIdleState = false;
        const drawCanvas = document.getElementById('broadcast-draw-canvas');
        const emojiContainer = document.getElementById('emoji-overlay-container');
        if (drawCanvas) drawCanvas.style.opacity = '1';
        if (emojiContainer) emojiContainer.style.opacity = '1';
    }
    if (!feed) return;
    
    // Clear all existing message cards to display only the single most recent active message
    const existingCards = feed.querySelectorAll('.message-card');
    existingCards.forEach(c => {
        if (isBroadcast) {
            const videoEl = c.querySelector('video');
            if (videoEl && videoEl.src) {
                cleanupVideoOnServer(videoEl.getAttribute('src') || videoEl.src);
            }
        }
        c.remove();
    });

    const card = document.createElement('div');
    card.className = 'message-card new-entry';
    if (msg.video_url || msg.image) {
        card.classList.add('has-media');
    }
    card.id = `msg-${msg.id}`;
    card.style.borderLeftColor = msg.color;

    const timeStr = formatTimestamp(msg.timestamp);

    let mediaHtml = '';
    if (msg.video_url) {
        mediaHtml = `
            <div class="custom-video-player" style="margin-top: 15px;">
                <video class="message-video" src="${msg.video_url}" autoplay loop></video>
                <div class="custom-video-controls">
                    <button class="vid-btn play-pause-btn">⏸</button>
                    <div class="vid-progress-container">
                        <div class="vid-progress-bar"></div>
                    </div>
                    <span class="vid-time">00:00</span>
                    <button class="vid-btn mute-btn">🔊</button>
                </div>
            </div>
        `;
    } else if (msg.image) {
        mediaHtml = `
            <div class="message-image-container">
                <img class="message-image" src="${msg.image}" alt="Загруженное фото">
            </div>
        `;
    }

    let modeIcon = msg.display_mode === 'persistent' ? '📌' : '⏱️';

    card.innerHTML = `
        <div class="message-header">
            <span class="message-nickname" style="color: ${msg.color}; text-shadow: 0 0 5px ${msg.color};">> ${safeRenderText(msg.nickname)} ${modeIcon}</span>
            <span class="message-time">${timeStr}</span>
        </div>
        <div class="message-content">
            <div class="message-text" style="--base-font-size: ${getAdaptiveFontSize(msg.text)} !important;">${safeRenderText(msg.text)}</div>
            ${mediaHtml}
        </div>
    `;

    feed.appendChild(card);
    playSynthesizedSound('chirp');

    setTimeout(() => { card.classList.remove('new-entry'); }, 50);

    if (msg.video_url) {
        setupCustomVideoPlayer(card);
    }

    if (msg.display_mode !== 'persistent') {
        const duration = msg.duration || 7;
        setTimeout(() => {
            card.classList.add('hidden-card');
            setTimeout(() => {
                if (isBroadcast) {
                    const videoEl = card.querySelector('video');
                    if (videoEl && videoEl.src) {
                        cleanupVideoOnServer(videoEl.getAttribute('src') || videoEl.src);
                    }
                }
                card.remove();
            }, 500);
        }, duration * 1000);
    }
}



// --- 6. Admin Panel Code ---
function initAdminPage() {
    if (adminPageInitialized) return;
    adminPageInitialized = true;

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
    if (document.getElementById(`msg-${msg.id}`)) return;
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
                <span style="color: ${msg.color}; font-weight: bold;">${safeRenderText(msg.nickname)}</span> 
                <span style="color: #666; margin-left: 10px;">${timeStr}</span>
                <span style="margin-left: 10px;">${hasPhoto}</span>
            </div>
            <div class="admin-message-content">${safeRenderText(msg.text)}</div>
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
            if (isBroadcast) {
                const videoEl = card.querySelector('video');
                if (videoEl && videoEl.src) {
                    cleanupVideoOnServer(videoEl.getAttribute('src') || videoEl.src);
                }
            }
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

// --- Drawing System (Unified Broadcast & Guest) ---
let broadcastCtx = null;
let broadcastDrawings = new Map();
let guestDrawings = new Map();

function initBroadcastDrawCanvas() {
    const canvas = document.getElementById('broadcast-draw-canvas');
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    broadcastCtx = canvas.getContext('2d');
    broadcastCtx.lineCap = 'round';
    broadcastCtx.lineJoin = 'round';
    
    window.addEventListener('resize', () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        if (broadcastCtx) {
            broadcastCtx.lineCap = 'round';
            broadcastCtx.lineJoin = 'round';
        }
    });
}

function handleClientDraw(event, data) {
    if (typeof isIdleState !== 'undefined' && isIdleState) return;

    // 1. Draw on Broadcast Canvas (if present)
    const bCanvas = document.getElementById('broadcast-draw-canvas');
    if (bCanvas) {
        if (!broadcastCtx) initBroadcastDrawCanvas();
        if (broadcastCtx) {
            drawOnCanvas(bCanvas, broadcastCtx, broadcastDrawings, event, data, bCanvas.width, bCanvas.height, 4, 10);
        }
    }

    // 2. Draw on Guest/Sender Canvas (if present and initialized)
    const gCanvas = document.getElementById('draw-canvas');
    if (gCanvas && guestDrawCtx) {
        drawOnCanvas(gCanvas, guestDrawCtx, guestDrawings, event, data, gCanvas.offsetWidth, gCanvas.offsetHeight, 3, 5);
    }
}

function drawOnCanvas(canvas, ctx, stateMap, event, data, width, height, lineWidth, shadowBlur) {
    if (event === 'draw_clear') {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        stateMap.clear();
        return;
    }

    const { client_id, x, y, color } = data;
    const px = x * width;
    const py = y * height;

    if (event === 'draw_start') {
        stateMap.set(client_id, { lastX: px, lastY: py });
    } else if (event === 'draw_move') {
        const state = stateMap.get(client_id);
        if (state) {
            ctx.beginPath();
            ctx.moveTo(state.lastX, state.lastY);
            ctx.lineTo(px, py);
            ctx.strokeStyle = color;
            ctx.lineWidth = lineWidth;
            ctx.shadowBlur = shadowBlur;
            ctx.shadowColor = color;
            ctx.stroke();
            
            state.lastX = px;
            state.lastY = py;
        }
    } else if (event === 'draw_end') {
        stateMap.delete(client_id);
    }
}

function handleRemoteVideoControl(data) {
    const video = document.querySelector('.custom-video-player video');
    if (!video) return;
    
    const playPauseBtn = document.querySelector('.custom-video-player .play-pause-btn');
    const muteBtn = document.querySelector('.custom-video-player .mute-btn');
    const command = data.command;

    if (command === 'play') {
        video.play().catch(err => console.log(err));
        if (playPauseBtn) playPauseBtn.textContent = '⏸';
    } else if (command === 'pause') {
        video.pause();
        if (playPauseBtn) playPauseBtn.textContent = '⏵';
    } else if (command === 'mute') {
        video.muted = true;
        if (muteBtn) {
            muteBtn.textContent = '🔇';
            muteBtn.style.color = 'var(--acid-red)';
        }
    } else if (command === 'unmute') {
        video.muted = false;
        if (muteBtn) {
            muteBtn.textContent = '🔊';
            muteBtn.style.color = 'var(--neon-green)';
        }
    } else if (command === 'seek-back' || command === 'seek-forward') {
        if (video._targetSeekTime === undefined) {
            video._targetSeekTime = video.currentTime;
        }
        
        if (command === 'seek-back') {
            video._targetSeekTime = Math.max(0, video._targetSeekTime - 5);
        } else {
            video._targetSeekTime = Math.min(video.duration || 0, video._targetSeekTime + 5);
        }
        
        // Update visuals immediately
        const progressBar = document.querySelector('.custom-video-player .vid-progress-bar');
        const timeDisplay = document.querySelector('.custom-video-player .vid-time');
        if (progressBar && video.duration) {
            const percent = (video._targetSeekTime / video.duration) * 100;
            progressBar.style.width = `${percent}%`;
        }
        if (timeDisplay) {
            const curMins = Math.floor(video._targetSeekTime / 60).toString().padStart(2, '0');
            const curSecs = Math.floor(video._targetSeekTime % 60).toString().padStart(2, '0');
            timeDisplay.textContent = `${curMins}:${curSecs}`;
        }
        
        // Debounce actual setting of currentTime to 150ms to prevent range request lag
        if (video._seekTimeout) {
            clearTimeout(video._seekTimeout);
        }
        
        video._seekTimeout = setTimeout(() => {
            video.currentTime = video._targetSeekTime;
            delete video._targetSeekTime;
            delete video._seekTimeout;
        }, 150);
    }
}


let activeEmojiParticles = 0;
const MAX_EMOJI_PARTICLES = 30;

function showEmojiOverlay(emoji) {
    if (typeof isIdleState !== 'undefined' && isIdleState) return;
    if (activeEmojiParticles >= MAX_EMOJI_PARTICLES) {
        console.warn("[EMOJI] Spark limit reached, ignoring event to protect performance.");
        return;
    }
    
    let container = document.getElementById('emoji-overlay-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'emoji-overlay-container';
        container.style.position = 'fixed';
        container.style.top = '0';
        container.style.left = '0';
        container.style.width = '100vw';
        container.style.height = '100vh';
        container.style.pointerEvents = 'none';
        container.style.zIndex = '99999';
        container.style.overflow = 'hidden';
        document.body.appendChild(container);
    }

    activeEmojiParticles++;

    const el = document.createElement('div');
    el.className = 'emoji-particle';
    el.textContent = emoji;
    
    const startX = 10 + Math.random() * 80;
    el.style.left = `${startX}vw`;
    el.style.bottom = '-10vh';
    
    const duration = 2.5 + Math.random() * 1.5;
    const scale = 1.0 + Math.random() * 1.5;
    el.style.animationDuration = `${duration}s`;
    el.style.transform = `scale(${scale})`;
    
    container.appendChild(el);
    
    setTimeout(() => {
        el.remove();
        activeEmojiParticles = Math.max(0, activeEmojiParticles - 1);
    }, duration * 1000);
}
