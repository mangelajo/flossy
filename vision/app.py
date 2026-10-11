"""Servicio de visión de flossy (producción): WebSocket /ws con la sesión guiada en vivo.

Solo acepta conexiones de usuarios con sesión iniciada: verifica la misma cookie firmada que
emite api/server.js, con el mismo secreto (DATA_DIR/secret) y la versión de sesión de db.json
(así "cerrar sesión en todas partes" también corta aquí).

  uv run uvicorn app:app --port 8001   # desarrollo, detrás de vite (8000 es el del laboratorio)

Variables: DATA_DIR (datos de la API, solo lectura), ORIGIN, FLOSSY_MODELS, FLOSSY_YOLO=1 (desactivado por defecto: no está en la imagen de producción).
El laboratorio para grabar y analizar sigue siendo server.py.
"""

import asyncio
import hashlib
import hmac
import base64
import json
import os
import threading
import time
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

import flossy_vision as fv
from coach import GuidedSession, ZoneModel

DATA = Path(os.environ.get("DATA_DIR", Path(__file__).parent.parent / ".dev-data"))
ORIGIN = os.environ.get("ORIGIN", "http://localhost:5173").rstrip("/")
COOKIE = "__Host-flossysid" if ORIGIN.startswith("https:") else "flossysid"
USE_YOLO = os.environ.get("FLOSSY_YOLO", "0") in ("1", "true", "yes", "on")

app = FastAPI()
yolo = fv.load_yolo() if USE_YOLO else None
yolo_lock = threading.Lock()
zone_model = ZoneModel()
fv.ensure_models()


class Auth:
    """Verificación de la cookie de sesión de la API (HMAC-SHA256, base64url sin relleno)."""

    def __init__(self):
        self._db, self._mtime, self._secret = None, None, None

    def _load(self):
        if self._secret is None:
            self._secret = (DATA / "secret").read_text().strip().encode()
        mtime = (DATA / "db.json").stat().st_mtime
        if mtime != self._mtime:
            self._db, self._mtime = json.loads((DATA / "db.json").read_text()), mtime

    def user(self, cookie_header):
        vals = [c.split("=", 1)[1].strip() for c in (cookie_header or "").split(";")
                if "=" in c and c.split("=", 1)[0].strip() == COOKIE]
        if not vals or any(v != vals[0] for v in vals):
            return None
        token = vals[0]
        payload, _, mac = token.rpartition(".")
        try:
            self._load()
        except (OSError, ValueError):
            return None
        expect = base64.urlsafe_b64encode(hmac.new(self._secret, payload.encode(), hashlib.sha256).digest()).rstrip(b"=")
        if not payload or not hmac.compare_digest(mac.encode(), expect):
            return None
        uid, exp, ver = (payload.split(":") + ["", "", ""])[:3]
        if not exp.isdigit() or int(exp) < time.time() * 1000:
            return None
        user = next((u for u in self._db.get("users", []) if u["id"] == uid), None)
        if not user or user.get("disabled") or str(user.get("sv", 0)) != ver:
            return None
        return user


auth = Auth()


@app.get("/ws/health")
def health():
    return {"ok": True, "zone_model": zone_model.ready, "yolo": USE_YOLO}


class Stream:
    def __init__(self):
        self.lms = fv.Landmarkers()
        self.clf = fv.Classifier()
        self.t0 = time.monotonic()
        self.last_ts = -1
        self.coach = None

    def process(self, jpeg: bytes):
        frame = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            return {"error": "bad frame"}
        h, w = frame.shape[:2]
        ts = max(int((time.monotonic() - self.t0) * 1000), self.last_ts + 1)
        self.last_ts = ts
        t = time.perf_counter()
        if yolo is not None:
            with yolo_lock:
                mouth, hands, brushes, raw = fv.detect(frame, ts, self.lms, yolo)
        else:
            mouth, hands, brushes, raw = fv.detect(frame, ts, self.lms, None)
        state, _, feats = self.clf.update(mouth, hands, brushes)
        coach = self.coach.update(ts / 1000, state, raw, (w, h)) if self.coach else None
        norm = np.array([w, h])
        return {
            "state": state,
            "coach": coach,
            "face": mouth is not None,
            "infer_ms": round((time.perf_counter() - t) * 1000),
            "mouth": None if mouth is None else {
                "c": (mouth["center"] / norm).round(4).tolist(), "r": round(mouth["width"] * fv.NEAR_MOUTH / w, 4)},
            "hands": [(hp / norm).round(4).tolist() for hp in hands],
        }


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    # Mismo origen obligatorio: un WebSocket no tiene CORS y lleva las cookies (CSWSH).
    origin = (websocket.headers.get("origin") or "").rstrip("/")
    user = auth.user(websocket.headers.get("cookie"))
    if origin != ORIGIN or user is None:
        await websocket.close(code=4401)
        return
    await websocket.accept()
    stream = await asyncio.to_thread(Stream)
    try:
        while True:
            msg = await websocket.receive()
            if msg.get("bytes"):
                result = await asyncio.to_thread(stream.process, msg["bytes"])
                await websocket.send_text(json.dumps(result))
            elif msg.get("text"):
                cmd = json.loads(msg["text"])
                if cmd.get("type") == "start":
                    zone_model.reload()
                    if not zone_model.ready:
                        await websocket.send_text(json.dumps({"error": "El servidor no tiene modelo de zonas"}))
                        continue
                    acts = {"brush": ("brush",), "floss": ("floss",)}.get(cmd.get("mode"), ("brush", "floss"))
                    stream.coach = GuidedSession(zone_model, acts)
                elif cmd.get("type") == "stop":
                    stream.coach = None
            elif msg["type"] == "websocket.disconnect":
                break
    except WebSocketDisconnect:
        pass
    finally:
        stream.lms.close()
