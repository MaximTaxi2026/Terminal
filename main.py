import os
import time
import html
import sqlite3
import traceback
import asyncio
from typing import List, Dict, Optional
from fastapi import FastAPI, Request, HTTPException, WebSocket, WebSocketDisconnect, Depends, status, UploadFile, File, Form
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import shutil
import uuid
from collections import deque

# Robust path resolution relative to this file
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "database.db")
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")

PASSWORD_HASH = "092026"
RATE_LIMIT_SECONDS = 4.0

app = FastAPI(title="Terminal-092026 Web Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Rate limit memory store: {client_id: last_post_time}
rate_limit_store: Dict[str, float] = {}

# Ensure static and templates folders exist relative to main.py
os.makedirs(STATIC_DIR, exist_ok=True)
os.makedirs(os.path.join(STATIC_DIR, "css"), exist_ok=True)
os.makedirs(os.path.join(STATIC_DIR, "js"), exist_ok=True)
UPLOAD_DIR = os.path.join(STATIC_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(TEMPLATES_DIR, exist_ok=True)

# Mount static files safely using absolute paths
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# Templates using absolute path
templates = Jinja2Templates(directory=TEMPLATES_DIR)


# Exception details middleware to return traceback on HTTP 500
@app.middleware("http")
async def catch_exceptions_middleware(request: Request, call_next):
    try:
        return await call_next(request)
    except Exception as e:
        tb = traceback.format_exc()
        return PlainTextResponse(
            f"INTERNAL SERVER ERROR (500)\n\n"
            f"Exception: {str(e)}\n\n"
            f"Traceback:\n{tb}",
            status_code=500
        )


# Database Initialization with multithreading support and automatic schema migration
def get_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()

def init_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nickname TEXT NOT NULL,
            color TEXT NOT NULL,
            text TEXT,
            image TEXT,
            timestamp REAL NOT NULL,
            client_id TEXT NOT NULL,
            is_deleted INTEGER DEFAULT 0
        )
    """)
    # Migration: Add multiple columns if they don't exist yet
    columns_to_add = {
        "duration": "INTEGER DEFAULT 7",
        "message_id": "TEXT",
        "display_mode": "TEXT DEFAULT 'temporary'",
        "video_url": "TEXT",
        "type": "TEXT DEFAULT 'text'"
    }
    for col, dtype in columns_to_add.items():
        try:
            cursor.execute(f"ALTER TABLE messages ADD COLUMN {col} {dtype}")
        except sqlite3.OperationalError:
            pass
    conn.commit()
    conn.close()

# Run DB initialization on startup
# Global message queue for server-side FIFO processing
message_queue = asyncio.Queue()

async def broadcast_worker():
    while True:
        try:
            msg_data = await message_queue.get()
            msg_id = msg_data["id"]

            # WAL mode ensures we read the freshest commit from any connection
            conn = sqlite3.connect(DB_PATH)
            conn.execute("PRAGMA journal_mode=WAL")
            cursor = conn.cursor()
            cursor.execute("SELECT is_deleted FROM messages WHERE id = ?", (msg_id,))
            row = cursor.fetchone()
            conn.close()

            if row and row[0] == 0:
                await push_event("new_message", msg_data)
                print(f"[BROADCAST] Message {msg_id} (Client ID: {msg_data.get('message_id')}) sent to broadcast screen.")

            message_queue.task_done()
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"Broadcast worker error: {e}")
            await asyncio.sleep(1)

def is_video_file_active(video_url: str) -> bool:
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        # 1. Check if the latest message on the broadcast screen has this video_url and is still active
        cursor.execute("""
            SELECT video_url, display_mode, timestamp, duration FROM messages 
            WHERE is_deleted = 0 
            ORDER BY id DESC 
            LIMIT 1
        """)
        row = cursor.fetchone()
        if row:
            latest_video_url, display_mode, timestamp, duration = row
            if latest_video_url == video_url:
                if display_mode == 'temporary':
                    current_time = time.time()
                    if timestamp + duration > current_time:
                        conn.close()
                        return True
                else:
                    # Persistent messages stay active until deleted or replaced
                    conn.close()
                    return True
            
        # 2. Check if there is any temporary message with this video_url that is still within its duration
        current_time = time.time()
        cursor.execute("""
            SELECT id FROM messages 
            WHERE video_url = ? 
              AND is_deleted = 0 
              AND display_mode = 'temporary' 
              AND (timestamp + duration) > ?
        """, (video_url, current_time))
        active_temp = cursor.fetchone()
        
        conn.close()
        return active_temp is not None
    except Exception as e:
        print(f"Error checking active video state: {e}")
        return False

async def cleanup_video_file(video_url: str, delay: float = 0.0, force: bool = False):
    if delay > 0:
        await asyncio.sleep(delay)
    try:
        # Protect active file: check if it is still being displayed on the broadcast screen
        # unless force is True (e.g. video ended, message deleted/replaced)
        if not force and is_video_file_active(video_url):
            return

        if video_url.startswith("/static/uploads/"):
            filename = video_url.replace("/static/uploads/", "")
            filename = os.path.basename(filename)
            filepath = os.path.join(UPLOAD_DIR, filename)
            if os.path.exists(filepath):
                os.remove(filepath)
                print(f"VIDEO_CLEANED: {filename}")
    except Exception as e:
        print(f"Error cleaning video file {video_url}: {e}")

@app.on_event("startup")
async def startup_event():
    init_db()
    asyncio.create_task(broadcast_worker())
    # Clean up uploads directory on startup to ensure zero persistence across sessions
    try:
        if os.path.exists(UPLOAD_DIR):
            for filename in os.listdir(UPLOAD_DIR):
                filepath = os.path.join(UPLOAD_DIR, filename)
                if os.path.isfile(filepath):
                    os.remove(filepath)
            print("[STARTUP] Cleaned uploads directory.")
    except Exception as e:
        print(f"[STARTUP] Error cleaning uploads: {e}")


# Models
class AuthRequest(BaseModel):
    password: str

class MessageCreate(BaseModel):
    nickname: str
    color: str
    text: Optional[str] = ""
    image: Optional[str] = ""  # Base64 string
    video_url: Optional[str] = ""
    client_id: str
    token: str
    duration: Optional[int] = 7
    message_id: str
    display_mode: Optional[str] = "temporary"
    type: Optional[str] = "text"


# WebSocket Connection Manager
class ConnectionManager:
    def __init__(self):
        self.active_connections: set = set()  # set: нет дубликатов

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.add(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.discard(websocket)  # discard: нет KeyError

    async def broadcast(self, message: dict):
        connections = list(self.active_connections)  # Снимок — устраняем race condition

        async def send_to_conn(conn):
            try:
                await conn.send_json(message)
                return None
            except Exception:
                return conn

        results = await asyncio.gather(*(send_to_conn(c) for c in connections))
        dead_connections = [r for r in results if r is not None]

        for dead in dead_connections:
            self.disconnect(dead)

manager = ConnectionManager()

# --- Global Event Log (Source of Truth) ---
# Все события эфира хранятся здесь; клиенты могут запросить пропущенные по seq
_event_seq: int = 0
_event_log: deque = deque(maxlen=500)  # Хранит последние 500 событий

async def push_event(event_type: str, data: dict) -> dict:
    """Единая точка входа для всех broadcast-событий.
    Записывает событие в лог с порядковым номером и рассылает клиентам."""
    global _event_seq
    _event_seq += 1
    entry = {
        "seq": _event_seq,
        "event": event_type,
        "data": data,
        "ts": time.time()
    }
    _event_log.append(entry)
    await manager.broadcast({"event": event_type, "data": data, "_seq": _event_seq})
    return entry


# Authentication Dependency
def verify_token(token: str):
    if token != PASSWORD_HASH:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Неверный пароль авторизации"
        )
    return token


# HTML Template Routes with try-except safety
@app.get("/", response_class=HTMLResponse)
async def get_index(request: Request):
    try:
        return templates.TemplateResponse(request, "index.html")
    except Exception as e:
        tb = traceback.format_exc()
        return HTMLResponse(
            content=f"<h3>Ошибка рендеринга шаблона index.html</h3><pre>{tb}</pre>",
            status_code=500
        )

@app.get("/broadcast", response_class=HTMLResponse)
async def get_broadcast(request: Request):
    try:
        return templates.TemplateResponse(request, "broadcast.html")
    except Exception as e:
        tb = traceback.format_exc()
        return HTMLResponse(
            content=f"<h3>Ошибка рендеринга шаблона broadcast.html</h3><pre>{tb}</pre>",
            status_code=500
        )

@app.get("/admin", response_class=HTMLResponse)
async def get_admin(request: Request):
    try:
        return templates.TemplateResponse(request, "admin.html")
    except Exception as e:
        tb = traceback.format_exc()
        return HTMLResponse(
            content=f"<h3>Ошибка рендеринга шаблона admin.html</h3><pre>{tb}</pre>",
            status_code=500
        )


# API Routes with try-except safety
@app.get("/api/verify")
async def verify_token_endpoint(token: str):
    try:
        verify_token(token)
        return {"status": "ok"}
    except HTTPException as e:
        raise e
    except Exception as e:
        return JSONResponse(status_code=500, content={"detail": str(e), "traceback": traceback.format_exc()})
@app.post("/api/auth")
async def api_auth(req: AuthRequest):
    try:
        if req.password == PASSWORD_HASH:
            return {"status": "ok", "token": PASSWORD_HASH}
        raise HTTPException(status_code=400, detail="Неверный пароль")
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        return JSONResponse(status_code=500, content={"detail": str(e), "traceback": traceback.format_exc()})

@app.get("/api/history")
async def get_history(token: str, db: sqlite3.Connection = Depends(get_db)):
    try:
        verify_token(token)
        cursor = db.cursor()
        cursor.execute("""
            SELECT id, nickname, color, text, image, video_url, timestamp, duration, message_id, display_mode, type 
            FROM messages 
            WHERE is_deleted = 0 
            ORDER BY id DESC 
            LIMIT 50
        """)
        rows = cursor.fetchall()
        
        messages = []
        for r in rows:
            messages.append({
                "id": r["id"],
                "message_id": r["message_id"],
                "nickname": r["nickname"],
                "color": r["color"],
                "text": r["text"],
                "image": r["image"],
                "video_url": r["video_url"],
                "timestamp": r["timestamp"],
                "duration": r["duration"],
                "display_mode": r["display_mode"],
                "type": r["type"]
            })
        messages.reverse()
        return messages
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        return JSONResponse(status_code=500, content={"detail": str(e), "traceback": traceback.format_exc()})

@app.post("/api/message")
async def create_message(msg: MessageCreate, db: sqlite3.Connection = Depends(get_db)):
    try:
        verify_token(msg.token)
        
        if not msg.client_id or len(msg.client_id) < 5:
            raise HTTPException(status_code=400, detail="Неверный идентификатор устройства")
        
        current_time = time.time()
        last_post_time = rate_limit_store.get(msg.client_id, 0.0)
        if current_time - last_post_time < RATE_LIMIT_SECONDS:
            remaining = int(RATE_LIMIT_SECONDS - (current_time - last_post_time))
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Слишком частые сообщения. Подождите {remaining} сек."
            )
        
        clean_nickname = html.escape(msg.nickname.strip())
        clean_text = html.escape(msg.text.strip()) if msg.text else ""
        
        if not clean_nickname:
            raise HTTPException(status_code=400, detail="Никнейм не может быть пустым")
        
        if not clean_text and not msg.image and not msg.video_url:
            raise HTTPException(status_code=400, detail="Сообщение, фото или видео должно присутствовать")
        
        allowed_colors = ["#00FF41", "#FF003C", "#FFD700", "#BF00FF", "#FFFFFF"]
        if msg.color not in allowed_colors:
            raise HTTPException(status_code=400, detail="Выбран неверный цвет")
        
        # Verify duration
        if msg.duration not in [3, 7, 15]:
            msg.duration = 7
        
        cursor = db.cursor()
        cursor.execute("""
            INSERT INTO messages (nickname, color, text, image, timestamp, client_id, duration, message_id, display_mode, video_url, type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (clean_nickname, msg.color, clean_text, msg.image, current_time, msg.client_id, msg.duration, msg.message_id, msg.display_mode, msg.video_url, msg.type))
        db.commit()
        msg_id = cursor.lastrowid
        
        rate_limit_store[msg.client_id] = current_time
        
        # Put the message in the server-side queue instead of immediate broadcast
        msg_data = {
            "id": msg_id,
            "message_id": msg.message_id,
            "nickname": clean_nickname,
            "color": msg.color,
            "text": clean_text,
            "image": msg.image,
            "video_url": msg.video_url,
            "timestamp": current_time,
            "duration": msg.duration,
            "display_mode": msg.display_mode,
            "type": msg.type
        }
        await message_queue.put(msg_data)
        print(f"[QUEUED] Message {msg.message_id} (Server ID: {msg_id}) added to queue.")
        
        if msg.video_url:
            delay = msg.duration if msg.display_mode != "persistent" else 300
            asyncio.create_task(cleanup_video_file(msg.video_url, delay, force=False))
            
        return {"status": "ok", "message_id": msg.message_id, "server_id": msg_id, "state": "RECEIVED_ACK"}
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        return JSONResponse(status_code=500, content={"detail": str(e), "traceback": traceback.format_exc()})

@app.delete("/api/message/{msg_id}")
async def delete_message(msg_id: int, token: str, db: sqlite3.Connection = Depends(get_db)):
    try:
        verify_token(token)
        
        cursor = db.cursor()
        cursor.execute("SELECT video_url FROM messages WHERE id = ?", (msg_id,))
        row = cursor.fetchone()
        video_url = row[0] if row else None
        
        cursor.execute("UPDATE messages SET is_deleted = 1 WHERE id = ?", (msg_id,))
        db.commit()
        
        await push_event("delete_message", {"id": msg_id})
        
        if video_url:
            asyncio.create_task(cleanup_video_file(video_url, 0.0, force=True))
            
        return {"status": "ok"}
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        return JSONResponse(status_code=500, content={"detail": str(e), "traceback": traceback.format_exc()})

@app.post("/api/upload/video")
async def upload_video(file: UploadFile = File(...), token: str = Form(...)):
    try:
        verify_token(token)
        if not file.content_type.startswith("video/"):
            raise HTTPException(status_code=400, detail="Разрешены только видео файлы")
            
        # Max size check is generally better via middleware, but fast check by content reading
        # We read chunk to disk
        ext = file.filename.split('.')[-1]
        if ext.lower() not in ['mp4', 'webm', 'mov']:
            ext = 'mp4'
            
        file_id = str(uuid.uuid4())
        filename = f"{file_id}.{ext}"
        filepath = os.path.join(UPLOAD_DIR, filename)
        
        with open(filepath, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        video_url = f"/static/uploads/{filename}"
        asyncio.create_task(cleanup_video_file(video_url, 120.0, force=False))
        return {"status": "ok", "video_url": video_url}
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        return JSONResponse(status_code=500, content={"detail": str(e), "traceback": traceback.format_exc()})


@app.api_route("/health", methods=["GET", "HEAD"])
def health():
    return PlainTextResponse("ok")


@app.get("/api/events")
async def get_events(last_id: int = 0, token: str = ""):
    """Возвращает все события с seq > last_id для replay при переподключении."""
    try:
        verify_token(token)
        missed = [e for e in _event_log if e["seq"] > last_id]
        return missed
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        return JSONResponse(status_code=500, content={"detail": str(e), "traceback": traceback.format_exc()})


# WebSocket Endpoint with error catching
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str):
    try:
        try:
            verify_token(token)
        except HTTPException:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return

        await manager.connect(websocket)
        try:
            while True:
                data = await websocket.receive_json()
                event = data.get("event")
                
                if event == "ping":
                    await websocket.send_json({"event": "pong"})
                elif event == "broadcast_ack":
                    # Логируем подтверждение — double-broadcast убран
                    msg_id = data.get("message_id")
                    print(f"[DISPLAYED] Message {msg_id} acknowledged by broadcast screen.")
                elif event in ["draw_start", "draw_move", "draw_end", "draw_clear", "remote_video_control", "remote_ui_control", "remote_zoom_control", "emoji"]:
                    await push_event(event, data.get("data"))
                elif event == "video_ended":
                    video_url = data.get("video_url")
                    if video_url:
                        asyncio.create_task(cleanup_video_file(video_url, 0.0, force=True))
                    await push_event("video_ended", {"video_url": video_url})
                elif event == "trigger_sound":
                    sound_id = data.get("sound_id")
                    await push_event("play_sound", {"sound_id": sound_id})
        except WebSocketDisconnect:
            manager.disconnect(websocket)
        except Exception:
            manager.disconnect(websocket)
    except Exception as e:
        print(f"WS Exception: {str(e)}")
        traceback.print_exc()


if __name__ == "__main__":
    import uvicorn
    init_db()
    port = 8000
    print(f"Terminal-092026 server is starting on http://127.0.0.1:{port} ...")
    uvicorn.run("main:app", host="127.0.0.1", port=port, proxy_headers=True, forwarded_allow_ips="*")

