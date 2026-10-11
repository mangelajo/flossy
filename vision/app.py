"""Servicio de visión de flossy (producción): WebSocket /ws con la sesión guiada en vivo.

Solo acepta conexiones de usuarios con sesión iniciada: verifica la misma cookie firmada que
emite api/server.js, con el mismo secreto (DATA_DIR/secret) y la versión de sesión de db.json
(así "cerrar sesión en todas partes" también corta aquí).

  uv run uvicorn app:app --port 8001   # desarrollo, detrás de vite (8000 es el del laboratorio)

Grabaciones para entrenar: con {"type": "record", "protocol": ...} la sesión sigue un protocolo de
protocol.py y guarda cada fotograma etiquetado en RECORDINGS_DIR/<id>/ (formato de recorder.py).
Solo pueden grabar los administradores y los perfiles con permiso (user.recorder). Los
administradores las listan, descargan (.tar) y borran en /ws/recordings, con su cookie o con una
clave de API suya (fetch_recordings.py las baja a data/recordings para entrenar).

Variables: DATA_DIR (datos de la API, solo lectura), ORIGIN, RECORDINGS_DIR, ADMIN_UIDS,
FLOSSY_MODELS, FLOSSY_YOLO=1 (desactivado por defecto: no está en la imagen de producción).
"""

import asyncio
import hashlib
import hmac
import base64
import json
import os
import re
import shutil
import tarfile
import tempfile
import threading
import time
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

import flossy_vision as fv
from coach import GuidedSession, ZoneModel
from gestures import GestureTracker, middle_finger
from protocol import PROTOCOLS
from recorder import Recorder, geometry

DATA = Path(os.environ.get("DATA_DIR", Path(__file__).parent.parent / ".dev-data"))
ORIGIN = os.environ.get("ORIGIN", "http://localhost:5173").rstrip("/")
COOKIE = "__Host-flossysid" if ORIGIN.startswith("https:") else "flossysid"
USE_YOLO = os.environ.get("FLOSSY_YOLO", "0") in ("1", "true", "yes", "on")
RECORDINGS = Path(os.environ.get("RECORDINGS_DIR", Path(__file__).parent / "data" / "recordings"))
ADMIN_UIDS = {x.strip() for x in os.environ.get("ADMIN_UIDS", "").split(",") if x.strip()}
REC_ID = re.compile(r"^[\w-]{1,80}$")

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

    def key_user(self, secret):
        """Dueño de una clave de API (se guardan como sha256 en hexadecimal, igual que en la API)."""
        try:
            self._load()
        except (OSError, ValueError):
            return None
        digest = hashlib.sha256(secret.encode()).hexdigest()
        key = next((k for k in self._db.get("keys", []) if hmac.compare_digest(k.get("hash", ""), digest)), None)
        user = key and next((u for u in self._db.get("users", []) if u["id"] == key["owner"]), None)
        return None if not user or user.get("disabled") else user


auth = Auth()
is_admin = lambda u: bool(u) and (u.get("admin") is True or u["id"] in ADMIN_UIDS)
can_record = lambda u: is_admin(u) or bool(u.get("recorder"))


def require_admin(request: Request):
    """Administrador por cookie de sesión (desde la app) o por clave de API (scripts)."""
    header = request.headers.get("authorization", "")
    secret = header[7:].strip() if header.startswith("Bearer ") else request.headers.get("x-api-key", "").strip()
    user = auth.key_user(secret) if secret else auth.user(request.headers.get("cookie"))
    if not is_admin(user):
        raise HTTPException(403 if user else 401)
    return user


def recording_dir(rec_id):
    d = RECORDINGS / rec_id
    if not REC_ID.match(rec_id) or not (d / "meta.json").is_file():
        raise HTTPException(404)
    return d


@app.get("/ws/recordings")
def list_recordings(request: Request):
    require_admin(request)
    out = []
    for d in sorted(RECORDINGS.glob("*/meta.json"), reverse=True):
        try:
            meta = json.loads(d.read_text())
        except ValueError:
            continue
        size = sum(f.stat().st_size for f in d.parent.rglob("*") if f.is_file())
        out.append({k: meta.get(k) for k in ("id", "protocol", "who", "uid", "hand", "started", "ended",
                                             "frames", "complete")} | {"bytes": size})
    return {"recordings": out}


@app.get("/ws/recordings/{rec_id}.tar")
async def download_recording(rec_id: str, request: Request):
    require_admin(request)
    d = recording_dir(rec_id)

    def build():
        fd, path = tempfile.mkstemp(suffix=".tar")
        with os.fdopen(fd, "wb") as f, tarfile.open(fileobj=f, mode="w") as tar:
            tar.add(d, arcname=rec_id)  # los JPEG ya van comprimidos: sin gzip
        return path

    path = await asyncio.to_thread(build)
    return FileResponse(path, media_type="application/x-tar", filename=f"{rec_id}.tar",
                        background=BackgroundTask(os.unlink, path))


@app.delete("/ws/recordings/{rec_id}")
def delete_recording(rec_id: str, request: Request):
    require_admin(request)
    shutil.rmtree(recording_dir(rec_id))
    return {"ok": True}


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
        self.recorder = None
        self.gestures = GestureTracker()

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
        state, zone, feats = self.clf.update(mouth, hands, brushes)
        # La peineta: la app contesta con humor (Session.jsx). No cuenta para nada.
        gesture = "middle_finger" if self.gestures.update(ts / 1000, middle_finger(hands, mouth, (w, h))) else None
        coach = self.coach.update(ts / 1000, state, raw, (w, h)) if self.coach else None
        guide = self.record(ts / 1000, jpeg, w, h, state, zone, feats, raw, mouth, hands, brushes) if self.recorder else None
        norm = np.array([w, h])
        return {
            "state": state,
            "coach": coach,
            "guide": guide,
            "gesture": gesture,
            "face": mouth is not None,
            "infer_ms": round((time.perf_counter() - t) * 1000),
            "mouth": None if mouth is None else {
                "c": (mouth["center"] / norm).round(4).tolist(), "r": round(mouth["width"] * fv.NEAR_MOUTH / w, 4)},
            "hands": [(hp / norm).round(4).tolist() for hp in hands],
        }

    def record(self, t, jpeg, w, h, state, zone, feats, raw, mouth, hands, brushes):
        """Guarda el fotograma con la etiqueta del paso que toca; devuelve ese paso para la app."""
        rec = self.recorder
        guide = rec.label(t)
        if guide is None:
            rec.close(complete=True)
            self.recorder = None
            return {"done": True, "id": rec.id, "frames": rec.n}
        rec.write(t, guide, jpeg, {"size": [w, h], "pred": {"state": state, "zone": zone}, "feats": feats,
                                   "raw": raw, "geom": geometry(mouth, hands, brushes)})
        return {**guide, "id": rec.id, "frames": rec.n}

    def stop_recording(self):
        if self.recorder:
            self.recorder.close(complete=False)
            self.recorder = None


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
                elif cmd.get("type") == "record":
                    if not can_record(auth.user(websocket.headers.get("cookie"))):
                        await websocket.send_text(json.dumps({"error": "Tu perfil no tiene permiso para grabar"}))
                        continue
                    if cmd.get("protocol") not in PROTOCOLS:
                        await websocket.send_text(json.dumps({"error": "Protocolo desconocido"}))
                        continue
                    stream.stop_recording()
                    stream.recorder = Recorder(
                        RECORDINGS, cmd["protocol"], True, user["name"], uid=user["id"],
                        hand=cmd.get("hand") if cmd.get("hand") in ("right", "left") else None,
                        source="app", ua=(websocket.headers.get("user-agent") or "")[:200])
                elif cmd.get("type") == "stop":
                    stream.coach = None
                    stream.stop_recording()
            elif msg["type"] == "websocket.disconnect":
                break
    except WebSocketDisconnect:
        pass
    finally:
        stream.stop_recording()
        stream.lms.close()
