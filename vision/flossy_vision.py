"""Núcleo de detección de Flossy, compartido por detect.py (local) y server.py (streaming).

  * YOLO (COCO, clase 79 = "toothbrush") para ver el cepillo.
  * MediaPipe FaceLandmarker para localizar la boca.
  * MediaPipe HandLandmarker (2 manos) para ver dónde están los dedos.

Las coordenadas que salen de aquí están en el fotograma SIN espejar, así que la izquierda
de la persona cae a la derecha de la imagen.
"""

import os
import urllib.request
from collections import Counter, deque
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions, vision

# En Docker los modelos van en un volumen: FLOSSY_MODELS=/models.
MODELS = Path(os.environ.get("FLOSSY_MODELS", Path(__file__).parent / "models"))
# Los .task de MediaPipe pueden ir aparte (en la imagen Docker van dentro, no en el volumen).
MP_DIR = Path(os.environ.get("FLOSSY_MEDIAPIPE", MODELS))
MP_MODELS = {
    "hand_landmarker.task": "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
    "face_landmarker.task": "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task",
}
TOOTHBRUSH = 79
MOUTH_LEFT, MOUTH_RIGHT, LIP_TOP, LIP_BOTTOM = 61, 291, 13, 14
FINGERTIPS = (4, 8, 12)  # pulgar, índice, corazón

# Distancias en unidades de "ancho de boca".
NEAR_MOUTH = 1.8
BRUSH_NEAR_MOUTH = 1.5
OSCILLATION_MIN = 0.12
SMOOTH_FRAMES = 15
FRONT_ZONE = 0.6  # |desplazamiento lateral| por debajo de esto = dientes de delante

# Objetivos de una sesión: 2 min de cepillado y 1 min de seda, repartidos en 6 zonas.
BRUSH_TARGET = 120.0
FLOSS_TARGET = 60.0
ZONES = ("sup-izq", "sup-front", "sup-der", "inf-izq", "inf-front", "inf-der")


def ensure_models():
    MP_DIR.mkdir(parents=True, exist_ok=True)
    for name, url in MP_MODELS.items():
        path = MP_DIR / name
        if not path.exists():
            print(f"Descargando {name}…")
            urllib.request.urlretrieve(url, path)


def load_yolo(weights="yolo11n.pt"):
    # Import tardío: ultralytics (y PyTorch) solo están en el grupo "lab"; la imagen de
    # producción no los lleva y funciona sin YOLO.
    from ultralytics import YOLO
    return YOLO(weights)


class Landmarkers:
    """MediaPipe en modo VIDEO exige timestamps crecientes: una instancia por stream."""

    def __init__(self):
        ensure_models()
        self.hands = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(MP_DIR / "hand_landmarker.task")),
            running_mode=vision.RunningMode.VIDEO, num_hands=2))
        self.face = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(MP_DIR / "face_landmarker.task")),
            running_mode=vision.RunningMode.VIDEO, num_faces=1,
            output_facial_transformation_matrixes=True, output_face_blendshapes=True))

    def close(self):
        self.hands.close()
        self.face.close()


def detect(frame_bgr, ts_ms, landmarkers, yolo, conf=0.15):
    """Devuelve (mouth, hands, brushes, raw) en píxeles del fotograma.
    `raw` lleva lo que no usa la heurística pero sirve para grabar datos de entrenamiento."""
    h, w = frame_bgr.shape[:2]
    rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    face_res = landmarkers.face.detect_for_video(mp_img, ts_ms)
    hand_res = landmarkers.hands.detect_for_video(mp_img, ts_ms)
    # YOLO es opcional (FLOSSY_YOLO=0): ve poco el cepillo y es casi la mitad del coste por fotograma.
    yolo_res = yolo.predict(frame_bgr, classes=[TOOTHBRUSH], conf=conf, verbose=False)[0] if yolo else None

    mouth = mouth_geometry(face_res.face_landmarks[0], w, h) if face_res.face_landmarks else None
    hands = [np.array([[p.x * w, p.y * h] for p in lm]) for lm in hand_res.hand_landmarks]
    brushes = [] if yolo_res is None else [
        (tuple(b), float(c)) for b, c in zip(yolo_res.boxes.xyxy.cpu().numpy(), yolo_res.boxes.conf.cpu().numpy())]

    raw = {"head_pose": None, "face_pts": None, "hands": [], "blendshapes": None}
    if face_res.face_blendshapes:
        # 52 coeficientes de expresión (mandíbula, comisuras, mejillas…), en el orden de MediaPipe.
        raw["blendshapes"] = [round(c.score, 3) for c in face_res.face_blendshapes[0]]
    if face_res.facial_transformation_matrixes:
        raw["head_pose"] = head_pose(np.array(face_res.facial_transformation_matrixes[0]))
    if face_res.face_landmarks:
        lm = face_res.face_landmarks[0]
        raw["face_pts"] = {i: [round(lm[i].x, 4), round(lm[i].y, 4), round(lm[i].z, 4)] for i in FACE_KEYPOINTS}
    for lm, hd in zip(hand_res.hand_landmarks, hand_res.handedness):
        raw["hands"].append({"side": hd[0].category_name, "score": round(hd[0].score, 3),
                             "lm": [[round(p.x, 4), round(p.y, 4), round(p.z, 4)] for p in lm]})
    return mouth, hands, brushes, raw


# Boca (comisuras, labios), punta de la nariz, barbilla, ojos (exteriores).
FACE_KEYPOINTS = (61, 291, 13, 14, 0, 17, 1, 152, 33, 263)


def head_pose(m):
    """Matriz 4x4 de MediaPipe -> (pitch, yaw, roll) en grados."""
    r = m[:3, :3]
    pitch = np.degrees(np.arctan2(r[2, 1], r[2, 2]))
    yaw = np.degrees(np.arcsin(-np.clip(r[2, 0], -1, 1)))
    roll = np.degrees(np.arctan2(r[1, 0], r[0, 0]))
    return [round(float(pitch), 1), round(float(yaw), 1), round(float(roll), 1)]


def mouth_geometry(face_landmarks, w, h):
    """Centro de la boca, ancho y eje horizontal de la cara (para corregir la inclinación)."""
    pts = {i: np.array([face_landmarks[i].x * w, face_landmarks[i].y * h]) for i in (MOUTH_LEFT, MOUTH_RIGHT, LIP_TOP, LIP_BOTTOM)}
    center = (pts[MOUTH_LEFT] + pts[MOUTH_RIGHT] + pts[LIP_TOP] + pts[LIP_BOTTOM]) / 4
    axis = pts[MOUTH_RIGHT] - pts[MOUTH_LEFT]
    width = max(float(np.linalg.norm(axis)), 1.0)
    return {"center": center, "width": width, "axis": axis / width}


def to_face_frame(point, mouth):
    """Punto -> coordenadas relativas a la boca, en anchos de boca.
    x > 0 = hacia la izquierda de la persona (derecha de la imagen sin espejar), y > 0 = abajo."""
    d = (point - mouth["center"]) / mouth["width"]
    ax = mouth["axis"]
    return np.array([d @ ax, d @ np.array([-ax[1], ax[0]])])


def box_distance(box, point):
    """Distancia de un punto a un rectángulo (0 si está dentro)."""
    x1, y1, x2, y2 = box
    dx = max(x1 - point[0], 0, point[0] - x2)
    dy = max(y1 - point[1], 0, point[1] - y2)
    return float(np.hypot(dx, dy))


class Classifier:
    """Decide fotograma a fotograma: brush / floss / idle, más una zona aproximada."""

    def __init__(self):
        self.hand_track = deque(maxlen=30)  # posición de la mano en la boca (~1-3 s según fps)
        self.votes = deque(maxlen=SMOOTH_FRAMES)
        self.zone_votes = deque(maxlen=SMOOTH_FRAMES)

    def update(self, mouth, hands, brushes):
        f = {"face": mouth is not None, "hands": len(hands), "brush": len(brushes),
             "brush_dist": None, "hands_near": 0, "osc": 0.0, "raw": "idle", "zone": None}
        if mouth is None:
            self.hand_track.clear()
            self.votes.append("idle")
            return self._smoothed(), None, f

        center, mw = mouth["center"], mouth["width"]
        hand_dists = [min(np.linalg.norm(h[i] - center) for i in FINGERTIPS) / mw for h in hands]
        near_hands = [h for h, d in zip(hands, hand_dists) if d < NEAR_MOUTH]
        f["hands_near"] = len(near_hands)

        near_brush = None
        if brushes:
            dists = [box_distance(b, center) / mw for b, _ in brushes]
            f["brush_dist"] = min(dists)
            if f["brush_dist"] < BRUSH_NEAR_MOUTH:
                near_brush = brushes[int(np.argmin(dists))][0]

        if near_hands:
            h = hands[int(np.argmin(hand_dists))]
            self.hand_track.append(to_face_frame(h[8], mouth))
        else:
            self.hand_track.clear()
        if len(self.hand_track) >= 10:
            f["osc"] = float(np.linalg.norm(np.std(np.array(self.hand_track), axis=0)))

        if len(near_hands) >= 2 and near_brush is None:
            raw = "floss"
        elif near_brush is not None or (near_hands and f["osc"] > OSCILLATION_MIN):
            raw = "brush"
        else:
            raw = "idle"
        f["raw"] = raw
        self.votes.append(raw)

        zone = self._zone(raw, mouth, near_hands, near_brush)
        f["zone"] = zone
        if zone:
            self.zone_votes.append(zone)
        return self._smoothed(), self._smoothed_zone(), f

    def _zone(self, raw, mouth, near_hands, near_brush):
        """Zona APROXIMADA. Lateral: dónde está el cepillo/las manos respecto a la boca.
        Vertical: si la mano está por encima o por debajo de la boca (experimental)."""
        if raw == "brush":
            if near_brush is not None:
                x1, y1, x2, y2 = near_brush
                p = to_face_frame(np.array([(x1 + x2) / 2, (y1 + y2) / 2]), mouth)
            elif near_hands:
                p = to_face_frame(near_hands[0][8], mouth)
            else:
                return None
            side = "front" if abs(p[0]) < FRONT_ZONE else ("izq" if p[0] > 0 else "der")
            vert = "sup" if p[1] < 0 else "inf"
            return f"{vert}-{side}"
        if raw == "floss" and near_hands:
            # Para la seda, la mano que está más metida en la boca marca el lado.
            tips = [to_face_frame(h[8], mouth) for h in near_hands]
            inner = min(tips, key=lambda t: np.linalg.norm(t))
            side = "front" if abs(inner[0]) < FRONT_ZONE / 2 else ("izq" if inner[0] > 0 else "der")
            vert = "sup" if np.mean([t[1] for t in tips]) < 0 else "inf"
            return f"{vert}-{side}"
        return None

    def _smoothed(self):
        return Counter(self.votes).most_common(1)[0][0]

    def _smoothed_zone(self):
        return Counter(self.zone_votes).most_common(1)[0][0] if self.zone_votes else None


class SessionTracker:
    """Acumula tiempos por actividad y por zona y calcula el feedback para el usuario."""

    def __init__(self):
        self.totals = {"brush": 0.0, "floss": 0.0}
        self.zones = {"brush": Counter(), "floss": Counter()}
        self.last_t = None

    def update(self, t, state, zone):
        if self.last_t is not None and state in self.totals:
            dt = min(t - self.last_t, 0.5)  # no contar huecos largos si se corta el stream
            self.totals[state] += dt
            if zone:
                self.zones[state][zone] += dt
        self.last_t = t

    def feedback(self):
        def progress(activity, target):
            per_zone = target / len(ZONES)
            return {z: round(min(self.zones[activity][z] / per_zone, 1.0), 2) for z in ZONES}

        brush_z = progress("brush", BRUSH_TARGET)
        pending = [z for z in ZONES if brush_z[z] < 1.0]
        return {
            "brush": round(self.totals["brush"], 1),
            "floss": round(self.totals["floss"], 1),
            "brush_left": round(max(BRUSH_TARGET - self.totals["brush"], 0), 1),
            "floss_left": round(max(FLOSS_TARGET - self.totals["floss"], 0), 1),
            "brush_zones": brush_z,                         # fracción 0..1 de cada zona
            "floss_zones": progress("floss", FLOSS_TARGET),
            "next_zone": min(pending, key=lambda z: brush_z[z]) if pending else None,
        }
