"""Sesión guiada en vivo: la app pide cada zona y su barra solo sube mientras el sistema
confirma que estás haciendo la actividad pedida EN esa zona.

  * La actividad (cepillo / seda / nada) sale de la heurística de flossy_vision.Classifier.
  * La zona la confirma el clasificador entrenado con las grabaciones (zones.py -> models/zones.joblib):
    no tiene que adivinar entre 6 zonas, solo decir si lo que ve es compatible con la pedida.
"""

import time
from collections import deque

import joblib
import numpy as np

import flossy_vision as fv
import zones as zn

MODEL_PATH = fv.MODELS / "zones.joblib"
BRUSH_PER_ZONE = 20.0
FLOSS_PER_ZONE = 10.0
SMOOTH_S = 2.0  # media de probabilidades en los últimos ~2 s
VERIFY_T = zn.VERIFY_T

ZONE_NAMES = {"sup-izq": "arriba a tu izquierda", "sup-front": "arriba en el centro", "sup-der": "arriba a tu derecha",
              "inf-izq": "abajo a tu izquierda", "inf-front": "abajo en el centro", "inf-der": "abajo a tu derecha"}


class ZoneModel:
    """Carga models/zones.joblib y lo recarga si se reentrena (cambia el fichero)."""

    def __init__(self):
        self.bundle, self.mtime = None, None
        self.reload()

    def reload(self):
        if not MODEL_PATH.exists():
            return
        mtime = MODEL_PATH.stat().st_mtime
        if mtime != self.mtime:
            self.bundle, self.mtime = joblib.load(MODEL_PATH), mtime
            # Un solo fotograma por llamada: repartirlo entre núcleos cuesta más de lo que ahorra
            # (26 ms con n_jobs=-1 frente a 7 ms con 1), y en el servidor cada stream ya va en su hilo.
            for m in self.bundle["models"].values():
                m.n_jobs = 1
            zn.USE_BS = self.bundle.get("blendshapes", False)
            print(f"Modelo de zonas cargado ({time.ctime(mtime)})")

    @property
    def ready(self):
        return self.bundle is not None


class LiveZones:
    """Ventana deslizante de features (igual que en el entrenamiento) -> probabilidad por zona."""

    def __init__(self, model):
        self.model = model
        self.window_s = model.bundle.get("window_s", zn.WINDOW_S)
        self.feats = deque()   # (t, vector)
        self.probs = deque()   # (t, activity, {zona: p})

    def update(self, t, raw, size, activity):
        x = zn.frame_features({"raw": raw, "size": size}, raw.get("blendshapes"))
        if x is not None:
            self.feats.append((t, x))
        while self.feats and self.feats[0][0] < t - self.window_s:
            self.feats.popleft()
        while self.probs and self.probs[0][0] < t - SMOOTH_S:
            self.probs.popleft()
        if activity not in ("brush", "floss") or len(self.feats) < 3:
            return None
        X = np.array([v for _, v in self.feats])
        clf = self.model.bundle["models"][activity]
        p = clf.predict_proba(np.concatenate([X.mean(0), X.std(0)])[None])[0]
        self.probs.append((t, activity, dict(zip(clf.classes_, p))))
        recent = [pr for _, a, pr in self.probs if a == activity]
        return {z: float(np.mean([pr.get(z, 0) for pr in recent])) for z in zn.ZONES}


class GuidedSession:
    """Cepillado: 6 zonas × 20 s confirmados. Seda: 6 zonas × 10 s confirmados."""

    def __init__(self, model, activities=("brush", "floss")):
        self.live = LiveZones(model)
        self.plan = [(a, z) for a in activities for z in zn.ZONES]
        self.progress = {a: {z: 0.0 for z in zn.ZONES} for a in ("brush", "floss")}
        self.i = 0
        self.last_t = None

    def target(self, activity):
        return BRUSH_PER_ZONE if activity == "brush" else FLOSS_PER_ZONE

    def update(self, t, state, raw, size):
        dt = 0.0 if self.last_t is None else min(t - self.last_t, 0.5)
        self.last_t = t
        if self.i >= len(self.plan):
            return self.report("done", None, None)

        activity, zone = self.plan[self.i]
        probs = self.live.update(t, raw, size, state)
        if state != activity:
            status = "idle" if state == "idle" else "wrong_activity"
        elif probs is None:
            status = "checking"
        elif probs[zone] >= VERIFY_T:
            status = "ok"
        else:
            status = "wrong_zone"

        if status == "ok":
            self.progress[activity][zone] += dt
            if self.progress[activity][zone] >= self.target(activity):
                self.progress[activity][zone] = self.target(activity)
                self.i += 1
        return self.report(status, probs, activity)

    def report(self, status, probs, activity):
        cur = self.plan[self.i] if self.i < len(self.plan) else None
        guess = max(probs, key=probs.get) if probs else None
        verb = {"brush": "Cepilla", "floss": "Seda"}
        return {
            "step": self.i, "steps": len(self.plan), "done": cur is None, "status": status,
            "activity": cur[0] if cur else None, "zone": cur[1] if cur else None,
            "text": f"{verb[cur[0]]} {ZONE_NAMES[cur[1]]}" if cur else "¡Terminado! Muy bien",
            "p": round(probs[cur[1]], 2) if probs and cur else None,
            "guess": guess, "guess_name": ZONE_NAMES.get(guess),
            "progress": {a: {z: round(v / self.target(a), 3) for z, v in zs.items()} for a, zs in self.progress.items()},
            "left": {a: round(sum(self.target(a) - v for v in zs.values()), 1) for a, zs in self.progress.items()},
        }
