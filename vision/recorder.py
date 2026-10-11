"""Grabaciones guiadas para entrenar: lo comparten el laboratorio (server.py) y la app (app.py).

Cada grabación es una carpeta <raíz>/<id>/ con:
  meta.json     protocolo, pasos, quién, mano dominante, fotogramas, si se completó
  frames.jsonl  un fotograma por línea: etiqueta del protocolo + detección (raw, feats, geom)
  img/NNNNN.jpg el JPEG tal como llegó (si save_images)
Es el formato que leen analyze.py y zones.py.
"""

import json
from datetime import datetime

import numpy as np

import flossy_vision as fv
from protocol import Guide


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


class Recorder:
    """Guarda cada fotograma etiquetado con el paso del protocolo que toca en ese instante."""

    def __init__(self, root, protocol, save_images=True, who="", **extra):
        self.guide = Guide(protocol)
        self.save_images = save_images
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        who = "".join(ch for ch in str(who)[:20] if ch.isalnum())
        self.id = f"{stamp}_{who or 'anon'}_{protocol}"
        self.dir = root / self.id
        (self.dir / "img").mkdir(parents=True, exist_ok=True)
        self.meta = {"id": self.id, "protocol": protocol, "who": who, "started": stamp,
                     "save_images": save_images, "steps": self.guide.steps, **extra}
        self._write_meta()
        self.log = open(self.dir / "frames.jsonl", "w")
        self.t0 = None
        self.n = 0

    def _write_meta(self):
        (self.dir / "meta.json").write_text(json.dumps(self.meta, ensure_ascii=False, indent=1))

    def label(self, t):
        """Paso del protocolo en el instante t (segundos), o None si ya ha terminado."""
        if self.t0 is None:
            self.t0 = t
        return self.guide.at(t - self.t0)

    def write(self, t, label, jpeg, record):
        if self.save_images:
            (self.dir / "img" / f"{self.n:05d}.jpg").write_bytes(jpeg)
        self.log.write(json.dumps({"i": self.n, "t": round(t - self.t0, 3), "label": label, **record}) + "\n")
        self.n += 1

    def close(self, complete=False):
        if self.log.closed:
            return
        self.log.close()
        self.meta.update(frames=self.n, complete=complete, ended=datetime.now().strftime("%Y%m%d-%H%M%S"))
        self._write_meta()
