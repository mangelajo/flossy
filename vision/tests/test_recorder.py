import json

import numpy as np

from recorder import Recorder, geometry


def test_graba_meta_fotogramas_e_imagenes(tmp_path):
    rec = Recorder(tmp_path, "prueba", True, "Lucía Pérez!", uid="u1", hand="left")
    assert rec.id.endswith("_LucíaPérez_prueba")      # nombre sin espacios ni símbolos
    for i, t in enumerate((10.0, 10.1, 10.2)):
        label = rec.label(t)
        rec.write(t, label, b"jpeg%d" % i, {"size": [480, 360]})
    rec.close(complete=False)

    d = tmp_path / rec.id
    meta = json.loads((d / "meta.json").read_text())
    assert (meta["protocol"], meta["uid"], meta["hand"], meta["frames"], meta["complete"]) == ("prueba", "u1", "left", 3, False)
    frames = [json.loads(line) for line in (d / "frames.jsonl").open()]
    assert [f["t"] for f in frames] == [0.0, 0.1, 0.2]          # tiempos relativos al primero
    assert frames[0]["label"]["activity"] == "idle"
    assert (d / "img" / "00002.jpg").read_bytes() == b"jpeg2"


def test_cerrar_dos_veces_no_rompe_nada(tmp_path):
    rec = Recorder(tmp_path, "prueba", False, "x")
    rec.close(complete=True)
    rec.close(complete=False)
    assert json.loads((tmp_path / rec.id / "meta.json").read_text())["complete"] is True


def test_label_devuelve_none_al_acabar_el_protocolo(tmp_path):
    rec = Recorder(tmp_path, "prueba", False, "x")
    assert rec.label(100.0)["step"] == 0
    assert rec.label(111.0) is None


def test_geometry_sin_cara_es_none_y_con_cara_usa_anchos_de_boca():
    assert geometry(None, [], []) is None
    mouth = {"center": np.array([100.0, 100.0]), "width": 20.0, "axis": np.array([1.0, 0.0])}
    hand = np.zeros((21, 2)) + [120.0, 100.0]
    g = geometry(mouth, [hand], [])
    assert g["mouth_w"] == 20.0
    assert len(g["hands"]) == 1 and len(g["hands"][0]["tips"]) == 3
