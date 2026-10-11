"""Sesión guiada: la barra de una zona solo sube mientras se confirma que estás en ella."""
import pytest

import zones as zn
from coach import BRUSH_PER_ZONE, FLOSS_PER_ZONE, VERIFY_T, GuidedSession


class FakeModel:
    bundle = {"window_s": 1.0, "models": {}}


@pytest.fixture
def session():
    s = GuidedSession(FakeModel(), ("brush", "floss"))
    s.probs = None                                   # lo que "ve" el clasificador de zonas
    s.live.update = lambda t, raw, size, activity: s.probs
    return s


def sure(zone):
    return {z: (0.9 if z == zone else 0.02) for z in zn.ZONES}


def run(s, state, seconds, start=0.0, step=0.1):
    out, t = None, start
    while t < start + seconds - 1e-9:
        out = s.update(t, state, {}, (480, 360))
        t += step
    return out, t


def test_empieza_por_la_primera_zona_de_cepillado(session):
    r = session.update(0, "idle", {}, (480, 360))
    assert (r["step"], r["steps"], r["activity"], r["zone"], r["status"]) == (0, 12, "brush", zn.ZONES[0], "idle")
    assert r["text"].startswith("Cepilla")


def test_actividad_equivocada_y_zona_comprobandose(session):
    assert session.update(0, "floss", {}, (480, 360))["status"] == "wrong_activity"
    assert session.update(0.1, "brush", {}, (480, 360))["status"] == "checking"   # aún sin probabilidades


def test_la_barra_solo_sube_en_la_zona_pedida(session):
    session.probs = sure(zn.ZONES[3])                       # está en otra zona
    r, t = run(session, "brush", 3)
    assert r["status"] == "wrong_zone"
    assert r["guess"] == zn.ZONES[3]
    assert r["progress"]["brush"][zn.ZONES[0]] == 0

    session.probs = sure(zn.ZONES[0])
    r, _ = run(session, "brush", 5, start=t)
    assert r["status"] == "ok"
    assert r["progress"]["brush"][zn.ZONES[0]] == pytest.approx(5 / BRUSH_PER_ZONE, abs=0.02)


def test_el_umbral_de_confirmacion(session):
    session.probs = {z: (VERIFY_T if z == zn.ZONES[0] else 0.1) for z in zn.ZONES}
    assert run(session, "brush", 1)[0]["status"] == "ok"
    session.probs = {z: (VERIFY_T - 0.01 if z == zn.ZONES[0] else 0.1) for z in zn.ZONES}
    assert run(session, "brush", 1, start=1)[0]["status"] == "wrong_zone"


def test_una_pausa_larga_no_cuenta_como_cepillado(session):
    session.probs = sure(zn.ZONES[0])
    session.update(0, "brush", {}, (480, 360))
    r = session.update(30, "brush", {}, (480, 360))        # 30 s sin fotogramas: cuenta 0,5 s como mucho
    assert r["progress"]["brush"][zn.ZONES[0]] == pytest.approx(0.5 / BRUSH_PER_ZONE, abs=1e-3)


def test_completa_las_doce_zonas_y_termina(session):
    t = 0.0
    for activity, zone in session.plan:
        session.probs = sure(zone)
        per = BRUSH_PER_ZONE if activity == "brush" else FLOSS_PER_ZONE
        r, t = run(session, activity, per + 0.5, start=t)
    assert r["done"] is True
    assert r["left"] == {"brush": 0, "floss": 0}
    assert all(v == 1 for zs in r["progress"].values() for v in zs.values())
    assert session.update(t + 1, "idle", {}, (480, 360))["status"] == "done"


def test_solo_cepillado(session):
    s = GuidedSession(FakeModel(), ("brush",))
    assert s.update(0, "idle", {"face_pts": []}, (480, 360))["steps"] == 6
