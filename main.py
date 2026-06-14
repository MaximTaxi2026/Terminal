import os
import time
import html
import sqlite3
import traceback
import asyncio
from typing import List, Dict, Optional
from fastapi import FastAPI, Request, HTTPException, WebSocket, WebSocketDisconnect, Depends, status
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

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
    # Migration: Add duration column if it doesn't exist yet
    try:
        cursor.execute("ALTER TABLE messages ADD COLUMN duration INTEGER DEFAULT 7")
    except sqlite3.OperationalError:
        # Column already exists
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
            
            # Check if deleted before broadcasting
            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            cursor.execute("SELECT is_deleted FROM messages WHERE id = ?", (msg_id,))
            row = cursor.fetchone()
            conn.close()
            
            if row and row[0] == 0:
                await manager.broadcast({
                    "event": "new_message",
                    "data": msg_data
                })
                duration = msg_data.get("duration", 7)
                # Small buffer to ensure previous animations finished
                await asyncio.sleep(duration + 1.5)
                
            message_queue.task_done()
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"Broadcast worker error: {e}")
            await asyncio.sleep(1)

@app.on_event("startup")
async def startup_event():
    init_db()
    asyncio.create_task(broadcast_worker())


# Models
class AuthRequest(BaseModel):
    password: str

class MessageCreate(BaseModel):
    nickname: str
    color: str
    text: Optional[str] = ""
    image: Optional[str] = ""  # Base64 string
    client_id: str
    token: str
    duration: Optional[int] = 7


# WebSocket Connection Manager
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        async def send_to_conn(conn):
            try:
                await conn.send_json(message)
                return None
            except Exception:
                return conn

        results = await asyncio.gather(*(send_to_conn(c) for c in self.active_connections))
        dead_connections = [r for r in results if r is not None]
        
        for dead in dead_connections:
            self.disconnect(dead)

manager = ConnectionManager()


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
            SELECT id, nickname, color, text, image, timestamp, duration 
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
                "nickname": r["nickname"],
                "color": r["color"],
                "text": r["text"],
                "image": r["image"],
                "timestamp": r["timestamp"],
                "duration": r["duration"]
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
        
        if not clean_text and not msg.image:
            raise HTTPException(status_code=400, detail="Сообщение или фото должно присутствовать")
        
        allowed_colors = ["#00FF41", "#FF003C", "#FFD700", "#BF00FF", "#FFFFFF"]
        if msg.color not in allowed_colors:
            raise HTTPException(status_code=400, detail="Выбран неверный цвет")
        
        # Verify duration
        if msg.duration not in [3, 7, 15]:
            msg.duration = 7
        
        cursor = db.cursor()
        cursor.execute("""
            INSERT INTO messages (nickname, color, text, image, timestamp, client_id, duration)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (clean_nickname, msg.color, clean_text, msg.image, current_time, msg.client_id, msg.duration))
        db.commit()
        msg_id = cursor.lastrowid
        
        rate_limit_store[msg.client_id] = current_time
        
        # Put the message in the server-side queue instead of immediate broadcast
        msg_data = {
            "id": msg_id,
            "nickname": clean_nickname,
            "color": msg.color,
            "text": clean_text,
            "image": msg.image,
            "timestamp": current_time,
            "duration": msg.duration
        }
        await message_queue.put(msg_data)
        
        return {"status": "ok", "message_id": msg_id}
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        return JSONResponse(status_code=500, content={"detail": str(e), "traceback": traceback.format_exc()})

@app.delete("/api/message/{msg_id}")
async def delete_message(msg_id: int, token: str, db: sqlite3.Connection = Depends(get_db)):
    try:
        verify_token(token)
        
        cursor = db.cursor()
        cursor.execute("UPDATE messages SET is_deleted = 1 WHERE id = ?", (msg_id,))
        db.commit()
        
        await manager.broadcast({
            "event": "delete_message",
            "data": {
                "id": msg_id
            }
        })
        return {"status": "ok"}
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
                elif event == "trigger_sound":
                    sound_id = data.get("sound_id")
                    await manager.broadcast({
                        "event": "play_sound",
                        "data": {
                            "sound_id": sound_id
                        }
                    })
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
    port = int(os.environ.get("PORT", 8000))
    print(f"Terminal-092026 server is starting on http://0.0.0.0:{port} ...")
    uvicorn.run("main:app", host="0.0.0.0", port=port, proxy_headers=True, forwarded_allow_ips="*")

