"""Flossy – banco de pruebas de detección en local (webcam o vídeo).

Uso:
  uv run detect.py                     # webcam 0
  uv run detect.py --source video.mp4  # vídeo grabado
  uv run detect.py --source clip.mp4 --headless --out anotado.mp4 --csv features.csv
Teclas: q = salir, r = resetear contadores.
"""

import argparse
import csv
import time

import cv2

import flossy_vision as fv

LABELS = {"brush": "CEPILLANDO", "floss": "SEDA DENTAL", "idle": "-"}
COLORS = {"brush": (0, 200, 0), "floss": (0, 165, 255), "idle": (128, 128, 128)}


def draw(frame, mouth, hands, brushes, state, zone, feats, fb):
    h, w = frame.shape[:2]
    if mouth is not None:
        c = tuple(mouth["center"].astype(int))
        cv2.circle(frame, c, int(mouth["width"] * fv.NEAR_MOUTH), (255, 200, 0), 1)
    for hpts in hands:
        for p in hpts:
            cv2.circle(frame, tuple(p.astype(int)), 2, (0, 255, 0), -1)
        for i in fv.FINGERTIPS:
            cv2.circle(frame, tuple(hpts[i].astype(int)), 5, (0, 255, 255), -1)
    for (x1, y1, x2, y2), cf in brushes:
        cv2.rectangle(frame, (int(x1), int(y1)), (int(x2), int(y2)), (255, 0, 255), 2)
        cv2.putText(frame, f"cepillo {cf:.2f}", (int(x1), int(y1) - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 0, 255), 1)

    cv2.rectangle(frame, (0, 0), (w, 70), (0, 0, 0), -1)
    cv2.putText(frame, f"{LABELS[state]}  {zone or ''}", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.9, COLORS[state], 2)
    cv2.putText(frame, f"cepillo {fb['brush']:5.1f}s (faltan {fb['brush_left']:.0f})  seda {fb['floss']:5.1f}s",
                (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)
    dbg = f"manos={feats['hands']} cerca={feats['hands_near']} osc={feats['osc']:.2f} raw={feats['raw']}"
    cv2.putText(frame, dbg, (10, h - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="0", help="índice de cámara o ruta a vídeo")
    ap.add_argument("--yolo", default="yolo11n.pt")
    ap.add_argument("--conf", type=float, default=0.15, help="umbral YOLO (el cepillo sale con poca confianza)")
    ap.add_argument("--out", help="guardar vídeo anotado")
    ap.add_argument("--csv", help="guardar features por frame")
    ap.add_argument("--headless", action="store_true", help="sin ventana (para procesar vídeos)")
    args = ap.parse_args()

    yolo = fv.load_yolo(args.yolo)
    lms = fv.Landmarkers()
    src = int(args.source) if args.source.isdigit() else args.source
    cap = cv2.VideoCapture(src)
    if not cap.isOpened():
        raise SystemExit(f"No se puede abrir {args.source} (¿permiso de cámara para la terminal?)")
    fps_in = cap.get(cv2.CAP_PROP_FPS) or 30
    is_file = not isinstance(src, int)
    writer, csv_file, csv_writer = None, (open(args.csv, "w", newline="") if args.csv else None), None

    clf, tracker = fv.Classifier(), fv.SessionTracker()
    t_start, frame_idx = time.monotonic(), 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        ts_ms = int(frame_idx * 1000 / fps_in) if is_file else int((time.monotonic() - t_start) * 1000)
        mouth, hands, brushes, _ = fv.detect(frame, ts_ms, lms, yolo, args.conf)
        state, zone, feats = clf.update(mouth, hands, brushes)
        tracker.update(ts_ms / 1000, state, zone)
        fb = tracker.feedback()

        if not is_file:
            frame = cv2.flip(frame, 1)  # espejo solo para mostrar; la detección usa el original
            mouth, hands, brushes = mirror(frame.shape[1], mouth, hands, brushes)
        draw(frame, mouth, hands, brushes, state, zone, feats, fb)

        if args.out:
            if writer is None:
                writer = cv2.VideoWriter(args.out, cv2.VideoWriter_fourcc(*"mp4v"), fps_in, frame.shape[1::-1])
            writer.write(frame)
        if csv_file:
            row = {"t": round(ts_ms / 1000, 3), "state": state, **feats}
            if csv_writer is None:
                csv_writer = csv.DictWriter(csv_file, fieldnames=list(row))
                csv_writer.writeheader()
            csv_writer.writerow(row)

        if not args.headless:
            cv2.imshow("flossy", frame)
            key = cv2.waitKey(1) & 0xFF
            if key == ord("q"):
                break
            if key == ord("r"):
                tracker = fv.SessionTracker()
        frame_idx += 1

    cap.release()
    if writer:
        writer.release()
    if csv_file:
        csv_file.close()
    cv2.destroyAllWindows()
    fb = tracker.feedback()
    print(f"Total cepillado: {fb['brush']:.1f}s · seda: {fb['floss']:.1f}s · cuadrantes: {fb['brush_quadrants']}")


def mirror(w, mouth, hands, brushes):
    if mouth is not None:
        mouth = {**mouth, "center": mouth["center"] * [-1, 1] + [w, 0]}
    hands = [h * [-1, 1] + [w, 0] for h in hands]
    brushes = [((w - x2, y1, w - x1, y2), c) for (x1, y1, x2, y2), c in brushes]
    return mouth, hands, brushes


if __name__ == "__main__":
    main()
