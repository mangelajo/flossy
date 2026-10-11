"""Clasificador de zonas entrenado con las grabaciones guiadas.

  uv run zones.py            # extrae features, evalúa y guarda models/zones.joblib

Features por fotograma (todo en coordenadas de la cara: origen en la boca, unidades = ancho
de boca, x > 0 = izquierda de la persona, y > 0 = abajo):
  * para la mano "principal" (la más cercana a la boca) y la "secundaria": muñeca, nudillo del
    índice, puntas de pulgar/índice/corazón, y los ángulos de la mano (muñeca→nudillo medio,
    nudillo índice→meñique) y del dedo índice;
  * orientación de la cabeza y apertura de la boca;
  * los 52 "blendshapes" de MediaPipe (mandíbula, comisuras, mejillas…): al cepillar las muelas
    de un lado se deforma la mejilla/comisura de ese lado. Para grabaciones antiguas se calculan
    a partir de img/ y se guardan en blendshapes.npz.
Luego se agregan en ventanas de ~1 s (media y desviación) para capturar el movimiento.

Evaluación honesta: se entrena con unas grabaciones y se prueba con otra distinta
(leave-one-recording-out). Probar dentro de la misma grabación engaña, porque cada zona es
un bloque continuo y fotogramas vecinos se parecen demasiado.
"""

import json
from collections import Counter
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import confusion_matrix

import flossy_vision as fv

HERE = Path(__file__).parent
RECORDINGS = HERE / "data" / "recordings"
ZONES = ["sup-izq", "sup-front", "sup-der", "inf-izq", "inf-front", "inf-der"]
HAND_POINTS = {"wrist": 0, "thumb": 4, "idx_mcp": 5, "idx": 8, "mid": 12}
WINDOW_S = 1.0  # segundos: la ventana va por tiempo porque el fps varía entre grabaciones


def mouth_frame(face_pts, size):
    w, h = size
    p = {int(k): np.array([v[0] * w, v[1] * h]) for k, v in face_pts.items()}
    center = (p[61] + p[291] + p[13] + p[14]) / 4
    axis = p[291] - p[61]
    width = max(np.linalg.norm(axis), 1.0)
    axis = axis / width
    rot = np.array([axis, [-axis[1], axis[0]]])
    opening = np.linalg.norm(p[14] - p[13]) / width
    return center, width, rot, opening


def angle(v):
    return np.arctan2(v[1], v[0])


def hand_features(lm, size, center, width, rot):
    w, h = size
    pts = (np.array([[x * w, y * h] for x, y, _ in lm]) - center) / width @ rot.T
    f = {k: pts[i] for k, i in HAND_POINTS.items()}
    out = []
    for k in HAND_POINTS:
        out += list(f[k])
    # Ángulos como sen/cos para que no salten de -pi a pi.
    for a in (angle(pts[9] - pts[0]), angle(pts[17] - pts[5]), angle(pts[8] - pts[5])):
        out += [np.sin(a), np.cos(a)]
    return out, float(np.linalg.norm(pts[8]))


N_HAND = len(HAND_POINTS) * 2 + 6


def frame_features(fr, bs=None):
    raw = fr["raw"]
    if not raw["face_pts"]:
        return None
    center, width, rot, opening = mouth_frame(raw["face_pts"], fr["size"])
    hands = [hand_features(hd["lm"], fr["size"], center, width, rot) for hd in raw["hands"]]
    hands.sort(key=lambda x: x[1])  # la más cercana a la boca primero
    feats = []
    for i in range(2):
        feats += hands[i][0] if i < len(hands) else [0.0] * N_HAND
        feats.append(1.0 if i < len(hands) else 0.0)
    pose = raw["head_pose"] or [0, 0, 0]
    feats += [pose[0] / 30, pose[1] / 30, pose[2] / 30, opening]
    if USE_BS:
        if bs is None:
            return None
        feats += list(bs)
    return np.array(feats, float)


def blendshapes(d, frames):
    """Blendshapes por fotograma (i -> vector de 52). De raw si la grabación ya los trae;
    si no, se calculan una vez con las imágenes guardadas y se cachean."""
    if frames and frames[0]["raw"].get("blendshapes") is not None:
        return {fr["i"]: fr["raw"]["blendshapes"] for fr in frames if fr["raw"].get("blendshapes")}
    cache = d / "blendshapes.npz"
    if cache.exists():
        z = np.load(cache)
        return dict(zip(z["idx"].tolist(), z["bs"]))
    if not (d / "img").is_dir():
        return {}
    import cv2
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision
    print(f"  calculando blendshapes de {d.name}…")
    lm = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(fv.MP_DIR / "face_landmarker.task")),
        running_mode=vision.RunningMode.VIDEO, num_faces=1, output_face_blendshapes=True))
    idx, out = [], []
    for fr in frames:
        img = cv2.imread(str(d / "img" / f"{fr['i']:05d}.jpg"))
        if img is None:
            continue
        res = lm.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(img, cv2.COLOR_BGR2RGB)),
                                  int(fr["t"] * 1000))
        if res.face_blendshapes:
            idx.append(fr["i"])
            out.append([c.score for c in res.face_blendshapes[0]])
    lm.close()
    np.savez(cache, idx=np.array(idx), bs=np.array(out, np.float32))
    return dict(zip(idx, np.array(out, np.float32)))


# Nombres de los 52 blendshapes en el orden en que los devuelve MediaPipe.
BS_NAMES = ["_neutral", "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight",
            "cheekPuff", "cheekSquintLeft", "cheekSquintRight", "eyeBlinkLeft", "eyeBlinkRight", "eyeLookDownLeft",
            "eyeLookDownRight", "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight",
            "eyeLookUpLeft", "eyeLookUpRight", "eyeSquintLeft", "eyeSquintRight", "eyeWideLeft", "eyeWideRight",
            "jawForward", "jawLeft", "jawOpen", "jawRight", "mouthClose", "mouthDimpleLeft", "mouthDimpleRight",
            "mouthFrownLeft", "mouthFrownRight", "mouthFunnel", "mouthLeft", "mouthLowerDownLeft",
            "mouthLowerDownRight", "mouthPressLeft", "mouthPressRight", "mouthPucker", "mouthRight",
            "mouthRollLower", "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper", "mouthSmileLeft",
            "mouthSmileRight", "mouthStretchLeft", "mouthStretchRight", "mouthUpperUpLeft", "mouthUpperUpRight",
            "noseSneerLeft", "noseSneerRight"]


def bs_mirror_perm():
    """Al reflejar, cada blendshape xxxLeft pasa a ser xxxRight y viceversa (y mouthLeft <-> mouthRight)."""
    def swap(n):
        for a, b in (("Left", "Right"), ("Right", "Left")):
            if n.endswith(a):
                return n[: -len(a)] + b
        return n
    return [BS_NAMES.index(swap(n)) for n in BS_NAMES]


def windowed(seq, times):
    """Media y desviación en una ventana centrada de WINDOW_S: capta posición y movimiento."""
    X, t = np.array(seq), np.array(times)
    lo = np.searchsorted(t, t - WINDOW_S / 2)
    hi = np.searchsorted(t, t + WINDOW_S / 2, side="right")
    return np.array([np.concatenate([X[a:b].mean(0), X[a:b].std(0)]) for a, b in zip(lo, hi)])


def mirror_transform():
    """(permutación, signos) para reflejar la escena (izq <-> der) sobre [medias, desviaciones].
    Cambian de signo las x de cada punto, el coseno de cada ángulo, el yaw y el roll; los
    blendshapes izquierdos y derechos se intercambian. Las desviaciones nunca cambian de signo."""
    hand = []
    for _ in HAND_POINTS:
        hand += [-1, 1]
    hand += [1, -1] * 3 + [1]  # sen/cos de 3 ángulos + flag de presencia
    signs = hand * 2 + [1, -1, -1, 1]  # pitch, yaw, roll, apertura
    perm = list(range(len(signs)))
    if USE_BS:
        perm += [len(signs) + j for j in bs_mirror_perm()]
        signs += [1] * len(BS_NAMES)
    n = len(signs)
    return np.array(perm + [n + j for j in perm]), np.array(signs + [1] * n, float)


MIRROR_ZONE = {"izq": "der", "der": "izq", "front": "front"}


def mirror(X, y):
    """Aumento de datos: la misma grabación vista en espejo, con las zonas izq/der intercambiadas.
    Así el modelo funciona igual con quien cepilla con la derecha, con la izquierda o alternando."""
    ym = np.array([f"{z.split('-')[0]}-{MIRROR_ZONE[z.split('-')[1]]}" for z in y])
    perm, signs = mirror_transform()
    return X[:, perm] * signs, ym


def base_zone(zone):
    """Las grabaciones antiguas tenían cara (ext/int/mast): sup-izq-ext -> sup-izq."""
    return "-".join(zone.split("-")[:2]) if zone else None


def load_recordings():
    data = []
    for d in sorted(RECORDINGS.glob("*")):
        if not (d / "frames.jsonl").exists():
            continue
        frames = [json.loads(line) for line in (d / "frames.jsonl").open()]
        # Las features se calculan sobre la secuencia continua (las ventanas no cruzan huecos
        # de cara no detectada porque esos fotogramas se descartan antes).
        bs = blendshapes(d, frames) if USE_BS else {}
        rows = [(fr, frame_features(fr, bs.get(fr["i"]))) for fr in frames]
        rows = [(fr, x) for fr, x in rows if x is not None]
        if not rows:
            continue
        X = windowed([x for _, x in rows], [fr["t"] for fr, _ in rows])
        labels = [(fr["label"]["activity"], base_zone(fr["label"]["zone"]), fr["label"]["phase"]) for fr, _ in rows]
        data.append({"id": d.name, "X": X, "labels": labels})
    return data


def subset(rec, activity):
    idx = [i for i, (a, z, ph) in enumerate(rec["labels"]) if a == activity and ph == "main" and z in ZONES]
    return rec["X"][idx], np.array([rec["labels"][i][1] for i in idx])


def smooth(pred, k=12):
    """Voto mayoritario en ~2 s, como haría la app en vivo."""
    return np.array([Counter(pred[max(0, i - k): i + 1]).most_common(1)[0][0] for i in range(len(pred))])


def evaluate(data, activity):
    recs = [r for r in data if len(subset(r, activity)[1])]
    print(f"\n### {activity}: {len(recs)} grabaciones con datos")
    if len(recs) < 2:
        print("  Hace falta al menos 2 grabaciones para evaluar con una grabación no vista.")
        return
    for test in recs:
        train = [r for r in recs if r is not test]
        Xtr = np.vstack([subset(r, activity)[0] for r in train])
        ytr = np.concatenate([subset(r, activity)[1] for r in train])
        if AUGMENT:
            Xm, ym = mirror(Xtr, ytr)
            Xtr, ytr = np.vstack([Xtr, Xm]), np.concatenate([ytr, ym])
        Xte, yte = subset(test, activity)
        clf = RandomForestClassifier(n_estimators=300, min_samples_leaf=5, n_jobs=-1, random_state=0).fit(Xtr, ytr)
        pred = clf.predict(Xte)
        sm = smooth(pred)
        # Modo guiado: ¿la zona pedida es compatible con lo que se ve? (prob. media en ~2 s ≥ umbral)
        proba = clf.predict_proba(Xte)
        k = 12
        proba = np.array([proba[max(0, i - k): i + 1].mean(0) for i in range(len(proba))])
        cls = list(clf.classes_)
        ok_true = np.mean([proba[i, cls.index(z)] >= VERIFY_T for i, z in enumerate(yte)])
        wrong = [(i, z) for i, real in enumerate(yte) for z in cls if z != real]
        ok_wrong = np.mean([proba[i, cls.index(z)] >= VERIFY_T for i, z in wrong])
        print(f"  [guiado] zona pedida = real → confirma {ok_true:.0%} · zona pedida ≠ real → confirma (error) {ok_wrong:.0%}")
        side = lambda z: z.split("-")[1]
        arch = lambda z: z.split("-")[0]
        print(f"  test={test['id']}: zona {np.mean(pred == yte):.0%} (suavizado {np.mean(sm == yte):.0%}) · "
              f"lado {np.mean([side(a) == side(b) for a, b in zip(sm, yte)]):.0%} · "
              f"arriba/abajo {np.mean([arch(a) == arch(b) for a, b in zip(sm, yte)]):.0%}")
        present = [z for z in ZONES if z in set(yte) | set(sm)]
        cm = confusion_matrix(yte, sm, labels=present)
        print("    real \\ pred  " + " ".join(f"{z:>9}" for z in present))
        for z, row in zip(present, cm):
            print(f"    {z:12} " + " ".join(f"{v:9d}" for v in row))


AUGMENT = True
VERIFY_T = 0.2
USE_BS = True


def main():
    global AUGMENT, USE_BS
    import sys
    if "--no-bs" in sys.argv:
        USE_BS = False
    data = load_recordings()
    # Fuera de la evaluación: "prueba" (pocos segundos) y el protocolo antiguo de 16 zonas.
    data = [r for r in data if "prueba" not in r["id"] and r["id"] != "20261011-160322_MiguelAngel_cepillado"]
    print("Grabaciones:", ", ".join(r["id"] for r in data))
    import sys
    if "--compare" in sys.argv:
        AUGMENT = False
        print("\n======== SIN espejo ========")
        for activity in ("brush", "floss"):
            evaluate(data, activity)
        AUGMENT = True
        print("\n======== CON espejo ========")
    for activity in ("brush", "floss"):
        evaluate(data, activity)

    # Modelo final con todo, para usarlo en el servidor más adelante.
    models = {}
    for activity in ("brush", "floss"):
        parts = [subset(r, activity) for r in data]
        X = np.vstack([p[0] for p in parts if len(p[1])])
        y = np.concatenate([p[1] for p in parts if len(p[1])])
        Xm, ym = mirror(X, y)
        X, y = np.vstack([X, Xm]), np.concatenate([y, ym])
        models[activity] = RandomForestClassifier(n_estimators=300, min_samples_leaf=5, n_jobs=-1, random_state=0).fit(X, y)
        print(f"\nModelo final {activity}: {len(y)} ventanas · {dict(Counter(y))}")
    joblib.dump({"models": models, "window_s": WINDOW_S, "blendshapes": USE_BS}, fv.MODELS / "zones.joblib")


if __name__ == "__main__":
    main()
