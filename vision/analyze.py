"""Analiza las grabaciones guiadas de data/recordings/.

  uv run analyze.py                 # resumen de todas las grabaciones
  uv run analyze.py ID [ID…]        # solo esas
  uv run analyze.py ID --replay     # además genera replay.mp4 con detecciones y etiqueta

Para cada zona (solo fase "main", sin los segundos de transición) muestra:
  * con qué frecuencia se detectan cara / manos / cepillo, y si la heurística acierta la actividad;
  * dónde está el cepillo y la punta del índice en coordenadas de la cara (anchos de boca;
    x > 0 = izquierda de la persona, y > 0 = abajo), y su dispersión;
  * cuánto se mueve la mano (desviación típica de la trayectoria) y la orientación de la cabeza.
Si dos zonas tienen medias parecidas y dispersión grande, con esas señales no se pueden separar.
"""

import argparse
import json
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np

RECORDINGS = Path(__file__).parent / "data" / "recordings"


def load(rec_dir):
    meta = json.loads((rec_dir / "meta.json").read_text())
    frames = [json.loads(line) for line in (rec_dir / "frames.jsonl").open()]
    return meta, frames


def nearest_tip(geom):
    """Punta del índice de la mano más cercana a la boca."""
    if not geom or not geom["hands"]:
        return None
    tips = [h["tips"][1] for h in geom["hands"]]
    return min(tips, key=lambda t: np.hypot(*t))


def best_brush(geom):
    if not geom or not geom["brushes"]:
        return None
    return max(geom["brushes"], key=lambda b: b["conf"])["c"]


def fmt_xy(points):
    if not points:
        return "      —      "
    a = np.array(points)
    m, s = a.mean(0), a.std(0)
    return f"{m[0]:+.2f}±{s[0]:.2f} {m[1]:+.2f}±{s[1]:.2f}"


def summarize(frames):
    groups = defaultdict(list)
    for f in frames:
        lb = f["label"]
        if lb["phase"] == "main":
            groups[(lb["step"], lb["activity"], lb["zone"] or "-")].append(f)

    print(f"{'paso':>4} {'actividad':9} {'zona':16} {'n':>4} {'cara':>5} {'mano':>5} {'2man':>5} {'cepi':>5} {'acierto':>7}"
          f"  {'cepillo x,y (media±std)':24}  {'índice x,y (media±std)':24}  {'mov':>5}  {'pitch/yaw':>11}")
    for (step, act, zone), fs in sorted(groups.items()):
        n = len(fs)
        pct = lambda cond: f"{100 * sum(1 for f in fs if cond(f)) / n:4.0f}%"
        brush_pts = [p for f in fs if (p := best_brush(f["geom"])) is not None]
        tip_pts = [p for f in fs if (p := nearest_tip(f["geom"])) is not None]
        motion = float(np.linalg.norm(np.array(tip_pts).std(0))) if len(tip_pts) > 5 else float("nan")
        poses = np.array([f["raw"]["head_pose"] for f in fs if f["raw"]["head_pose"]])
        pose = f"{poses[:, 0].mean():+4.0f}/{poses[:, 1].mean():+4.0f}" if len(poses) else "—"
        print(f"{step:4d} {act:9} {zone:16} {n:4d} {pct(lambda f: f['feats']['face'])} "
              f"{pct(lambda f: f['feats']['hands_near'] >= 1)} {pct(lambda f: f['feats']['hands_near'] >= 2)} "
              f"{pct(lambda f: f['feats']['brush'] > 0)} {pct(lambda f: f['pred']['state'] == act):>7}"
              f"  {fmt_xy(brush_pts):24}  {fmt_xy(tip_pts):24}  {motion:5.2f}  {pose:>11}")


def replay(rec_dir, frames):
    """Vídeo con las detecciones y la etiqueta del protocolo encima, a partir de img/."""
    imgs = sorted((rec_dir / "img").glob("*.jpg"))
    if not imgs:
        print("  (sin fotogramas guardados: graba con 'Guardar fotogramas' activado)")
        return
    by_i = {f["i"]: f for f in frames}
    first = cv2.imread(str(imgs[0]))
    h, w = first.shape[:2]
    duration = frames[-1]["t"] - frames[0]["t"] if len(frames) > 1 else 1
    fps = max(len(frames) / max(duration, 1e-3), 1)
    out = rec_dir / "replay.mp4"
    writer = cv2.VideoWriter(str(out), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h + 60))
    for path in imgs:
        f = by_i.get(int(path.stem))
        img = cv2.imread(str(path))
        if f is None or img is None:
            continue
        for hand in f["raw"]["hands"]:
            for x, y, _ in hand["lm"]:
                cv2.circle(img, (int(x * w), int(y * h)), 2, (0, 255, 0), -1)
        canvas = np.zeros((h + 60, w, 3), np.uint8)
        canvas[:h] = cv2.flip(img, 1)  # en espejo, como se veía en el móvil
        lb, pred = f["label"], f["pred"]
        color = (0, 165, 255) if lb["phase"] == "transition" else (255, 255, 255)
        cv2.putText(canvas, f"{lb['activity']} {lb['zone'] or ''} ({lb['phase']})", (8, h + 22),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 1)
        cv2.putText(canvas, f"pred: {pred['state']} {pred['zone'] or ''}  t={f['t']:.1f}s", (8, h + 48),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (180, 180, 180), 1)
        writer.write(canvas)
    writer.release()
    print(f"  replay → {out}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--replay", action="store_true")
    args = ap.parse_args()

    dirs = [RECORDINGS / i for i in args.ids] if args.ids else sorted(p for p in RECORDINGS.glob("*") if p.is_dir())
    if not dirs:
        raise SystemExit(f"No hay grabaciones en {RECORDINGS}")
    for d in dirs:
        meta, frames = load(d)
        dur = frames[-1]["t"] if frames else 0
        video = meta.get("video")
        print(f"\n=== {meta['id']} · {len(frames)} fotogramas · {dur:.0f} s · {len(frames) / max(dur, 1):.1f} fps"
              + (f" · vídeo {video['file']} ({video['bytes'] / 1e6:.1f} MB, offset {video['offset_ms']:.0f} ms)" if video else ""))
        if frames:
            summarize(frames)
        if args.replay:
            replay(d, frames)


if __name__ == "__main__":
    main()
