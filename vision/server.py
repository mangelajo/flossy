"""Prototipo de detección en tiempo real desde el móvil.

El navegador manda fotogramas JPEG por WebSocket; el servidor responde con la detección
(coordenadas normalizadas) y el feedback de la sesión. Hay un solo fotograma en vuelo
a la vez: el cliente no manda el siguiente hasta recibir la respuesta, así la latencia
no se acumula aunque el servidor vaya más lento que la cámara.

  uv run server.py                 # http://localhost:8000 (la cámara funciona en localhost)
  uv run server.py --https         # https://<ip-del-mac>:8443 para probar desde el móvil

Modo grabación guiada: el cliente manda {"type": "record_start", "protocol": ..., "save_images": bool}
y a partir de ahí cada fotograma se guarda en data/recordings/<id>/ etiquetado con el paso del
protocolo (ver protocol.py). Analiza las grabaciones con `uv run analyze.py`.
"""

import argparse
import asyncio
import json
import socket
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

import flossy_vision as fv
from coach import GuidedSession, ZoneModel
from protocol import PROTOCOLS, Guide

HERE = Path(__file__).parent
RECORDINGS = HERE / "data" / "recordings"
app = FastAPI()
yolo = fv.load_yolo()
yolo_lock = threading.Lock()  # el predictor de ultralytics no es thread-safe
zone_model = ZoneModel()


@app.get("/")
def index():
    return FileResponse(HERE / "static" / "index.html")


@app.get("/protocols")
def protocols():
    return {k: {"title": v["title"], "seconds": sum(st[2] for st in v["steps"])} for k, v in PROTOCOLS.items()}


@app.post("/upload/{rec_id}")
async def upload_video(rec_id: str, request: Request, offset_ms: float = 0):
    """Vídeo completo grabado en el móvil (MediaRecorder). offset_ms = cuánto antes del primer
    fotograma etiquetado empezó a grabar el móvil, para alinear vídeo y etiquetas."""
    folder = RECORDINGS / rec_id
    if "/" in rec_id or ".." in rec_id or not folder.is_dir():
        raise HTTPException(404)
    ext = "mp4" if "mp4" in request.headers.get("content-type", "") else "webm"
    body = await request.body()
    (folder / f"video.{ext}").write_bytes(body)
    meta = json.loads((folder / "meta.json").read_text())
    meta["video"] = {"file": f"video.{ext}", "offset_ms": offset_ms, "bytes": len(body)}
    (folder / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    return {"ok": True, "bytes": len(body)}


class Recorder:
    """Guarda cada fotograma etiquetado: frames.jsonl (+ img/NNNNN.jpg si save_images)."""

    def __init__(self, protocol, save_images, who):
        self.guide = Guide(protocol)
        self.save_images = save_images
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        self.id = f"{stamp}_{who or 'anon'}_{protocol}"
        self.dir = RECORDINGS / self.id
        (self.dir / "img").mkdir(parents=True, exist_ok=True)
        (self.dir / "meta.json").write_text(json.dumps({
            "id": self.id, "protocol": protocol, "who": who, "started": stamp, "save_images": save_images,
            "steps": self.guide.steps}, ensure_ascii=False, indent=1))
        self.log = open(self.dir / "frames.jsonl", "w")
        self.t0 = None
        self.n = 0

    def label(self, t):
        if self.t0 is None:
            self.t0 = t
        return self.guide.at(t - self.t0)

    def write(self, t, label, jpeg, record):
        if self.save_images:
            (self.dir / "img" / f"{self.n:05d}.jpg").write_bytes(jpeg)
        self.log.write(json.dumps({"i": self.n, "t": round(t - self.t0, 3), "label": label, **record}) + "\n")
        self.n += 1

    def close(self):
        self.log.close()


class Stream:
    def __init__(self):
        self.lms = fv.Landmarkers()
        self.clf = fv.Classifier()
        self.tracker = fv.SessionTracker()
        self.t0 = time.monotonic()
        self.last_ts = -1
        self.recorder = None
        self.coach = None

    def process(self, jpeg: bytes):
        frame = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            return {"error": "bad frame"}
        h, w = frame.shape[:2]
        ts = max(int((time.monotonic() - self.t0) * 1000), self.last_ts + 1)
        self.last_ts = ts

        t = time.perf_counter()
        with yolo_lock:
            mouth, hands, brushes, raw = fv.detect(frame, ts, self.lms, yolo)
        state, zone, feats = self.clf.update(mouth, hands, brushes)
        self.tracker.update(ts / 1000, state, zone)
        norm = np.array([w, h])

        guide = None
        if self.recorder:
            guide = self.recorder.label(ts / 1000)
            if guide is None:
                guide = {"done": True, "id": self.recorder.id, "frames": self.recorder.n}
                self.recorder.close()
                self.recorder = None
            else:
                guide["id"] = self.recorder.id
                self.recorder.write(ts / 1000, guide, jpeg, {
                    "size": [w, h], "pred": {"state": state, "zone": zone}, "feats": feats, "raw": raw,
                    "geom": self.geometry(mouth, hands, brushes)})

        coach = self.coach.update(ts / 1000, state, raw, (w, h)) if self.coach else None

        return {
            "guide": guide,
            "coach": coach,
            "state": state,
            "zone": zone,
            "feedback": self.tracker.feedback(),
            "debug": {**feats, "infer_ms": round((time.perf_counter() - t) * 1000), "size": [w, h]},
            "mouth": None if mouth is None else {
                "c": (mouth["center"] / norm).round(4).tolist(),
                "r": round(mouth["width"] * fv.NEAR_MOUTH / w, 4),
            },
            "hands": [(hp / norm).round(4).tolist() for hp in hands],
            "brushes": [{"box": (np.array(b) / np.tile(norm, 2)).round(4).tolist(), "conf": round(c, 2)} for b, c in brushes],
        }


    @staticmethod
    def geometry(mouth, hands, brushes):
        """Posiciones en coordenadas de la cara (anchos de boca), lo útil para separar zonas."""
        if mouth is None:
            return None
        ff = lambda p: fv.to_face_frame(np.asarray(p, float), mouth).round(3).tolist()
        return {
            "mouth_w": round(mouth["width"], 1),
            "hands": [{"tips": [ff(hp[i]) for i in fv.FINGERTIPS], "wrist": ff(hp[0])} for hp in hands],
            "brushes": [{"c": ff([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]), "p1": ff(b[:2]), "p2": ff(b[2:]),
                         "conf": round(c, 2)} for b, c in brushes],
        }

    def start_recording(self, protocol, save_images, who):
        if self.recorder:
            self.recorder.close()
        self.recorder = Recorder(protocol, save_images, who)
        self.tracker = fv.SessionTracker()

    def stop_recording(self):
        if self.recorder:
            self.recorder.close()
            self.recorder = None


@app.websocket("/ws")
async def ws(websocket: WebSocket):
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
                if cmd.get("type") == "reset":
                    stream.tracker = fv.SessionTracker()
                elif cmd.get("type") == "record_start" and cmd.get("protocol") in PROTOCOLS:
                    who = "".join(ch for ch in str(cmd.get("who", ""))[:20] if ch.isalnum())
                    stream.start_recording(cmd["protocol"], bool(cmd.get("save_images")), who)
                elif cmd.get("type") == "record_stop":
                    stream.stop_recording()
                elif cmd.get("type") == "guided_start":
                    zone_model.reload()  # por si se ha reentrenado con zones.py
                    if not zone_model.ready:
                        await websocket.send_text(json.dumps({"error": "No hay modelo: ejecuta uv run zones.py"}))
                        continue
                    acts = {"brush": ("brush",), "floss": ("floss",)}.get(cmd.get("what"), ("brush", "floss"))
                    stream.coach = GuidedSession(zone_model, acts)
                elif cmd.get("type") == "guided_stop":
                    stream.coach = None
            elif msg["type"] == "websocket.disconnect":
                break
    except WebSocketDisconnect:
        pass
    finally:
        stream.stop_recording()
        stream.lms.close()


def self_signed_cert():
    cert, key = HERE / "models" / "cert.pem", HERE / "models" / "key.pem"
    if not cert.exists():
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "365",
                        "-subj", "/CN=flossy-dev", "-keyout", str(key), "-out", str(cert)], check=True,
                       capture_output=True)
    return str(cert), str(key)


def local_ip():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--https", action="store_true", help="certificado autofirmado para probar desde el móvil")
    ap.add_argument("--port", type=int)
    args = ap.parse_args()
    if args.https:
        port = args.port or 8443
        cert, key = self_signed_cert()
        print(f"\n  Abre en el móvil: https://{local_ip()}:{port}  (acepta el aviso del certificado)\n")
        uvicorn.run(app, host="0.0.0.0", port=port, ssl_certfile=cert, ssl_keyfile=key)
    else:
        uvicorn.run(app, host="127.0.0.1", port=args.port or 8000)
