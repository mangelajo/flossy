"""Rasgos para el clasificador de zonas: el reflejo (diestros <-> zurdos) tiene que ser exacto."""
import numpy as np

import zones as zn


def test_reflejar_dos_veces_deja_todo_igual(monkeypatch):
    for use_bs in (False, True):
        monkeypatch.setattr(zn, "USE_BS", use_bs)
        perm, signs = zn.mirror_transform()
        x = np.random.default_rng(0).normal(size=len(perm))
        once = x[perm] * signs
        assert not np.allclose(once, x)
        assert np.allclose(once[perm] * signs, x)


def test_reflejar_cambia_izquierda_por_derecha_en_las_etiquetas(monkeypatch):
    monkeypatch.setattr(zn, "USE_BS", False)
    n = len(zn.mirror_transform()[0])
    X = np.zeros((3, n))
    _, y = zn.mirror(X, np.array(["sup-izq", "inf-der", "sup-front"]))
    assert list(y) == ["sup-der", "inf-izq", "sup-front"]


def test_ventanas_media_y_desviacion(monkeypatch):
    monkeypatch.setattr(zn, "WINDOW_S", 1.0)
    seq = [[0.0], [2.0], [4.0], [100.0]]
    out = zn.windowed(seq, [0.0, 0.2, 0.4, 5.0])
    assert out.shape == (4, 2)
    assert np.allclose(out[1], [2.0, np.std([0, 2, 4])])   # los tres primeros caen en la misma ventana
    assert np.allclose(out[3], [100.0, 0.0])               # el último va solo


def test_sin_cara_no_hay_rasgos():
    assert zn.frame_features({"raw": {"face_pts": []}, "size": [480, 360]}) is None
