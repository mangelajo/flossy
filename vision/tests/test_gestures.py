"""Peineta: con una mano sintética (21 puntos en píxeles), nunca con imágenes reales."""
import numpy as np
import pytest

from gestures import COOLDOWN_S, HOLD_S, GestureTracker, middle_finger

SIZE = (480, 360)
X = {"index": 270, "middle": 290, "ring": 310, "pinky": 330}
BASE = {"index": 5, "middle": 9, "ring": 13, "pinky": 17}


def hand(extended=(), down=False):
    """Mano con la muñeca en (300, 400) y los dedos hacia arriba; los de `extended` estirados,
    el resto doblados. down=True la pone cabeza abajo."""
    pts = np.zeros((21, 2))
    pts[0] = (300, 400)
    pts[1:5] = [(285, 385), (270, 370), (262, 355), (258, 345)]       # pulgar, recogido
    for name, x in X.items():
        b = BASE[name]
        if name in extended:
            pts[b:b + 4] = [(x, 320), (x, 290), (x, 270), (x, 250)]
        else:
            pts[b:b + 4] = [(x, 320), (x, 300), (x, 318), (x, 335)]   # la punta vuelve hacia la palma
    if down:
        pts[:, 1] = 800 - pts[:, 1]
    return pts


FAR_MOUTH = {"center": np.array([300.0, 150.0]), "width": 40.0}
NEAR_MOUTH = {"center": np.array([290.0, 300.0]), "width": 40.0}   # la mano en la boca: la seda


def test_la_peineta_lejos_de_la_boca():
    assert middle_finger([hand(["middle"])], FAR_MOUTH, SIZE)


def test_basta_con_que_la_haga_una_de_las_dos_manos():
    assert middle_finger([hand(), hand(["middle"])], FAR_MOUTH, SIZE)


def test_pegada_a_la_boca_no_cuenta_porque_es_como_se_coge_la_seda():
    assert not middle_finger([hand(["middle"])], NEAR_MOUTH, SIZE)


@pytest.mark.parametrize("extended", [(), ("index", "middle", "ring", "pinky"), ("index",), ("index", "middle")])
def test_otras_posturas_no_son_la_peineta(extended):
    assert not middle_finger([hand(extended)], FAR_MOUTH, SIZE)


def test_con_el_dedo_hacia_abajo_no_cuenta():
    assert not middle_finger([hand(["middle"], down=True)], None, SIZE)


def test_sin_cara_se_juzga_solo_la_mano():
    assert middle_finger([hand(["middle"])], None, SIZE)
    assert not middle_finger([], None, SIZE)


def run(tracker, seen, start, seconds, step=0.1):
    fired, t = [], start
    while t < start + seconds - 1e-9:
        if tracker.update(t, seen):
            fired.append(round(t, 1))
        t += step
    return fired, t


def test_avisa_una_vez_si_se_mantiene_medio_segundo():
    tr = GestureTracker()
    fired, _ = run(tr, True, 0, 3)
    assert fired == [HOLD_S]


def test_un_gesto_fugaz_no_avisa():
    tr = GestureTracker()
    fired, t = run(tr, True, 0, HOLD_S - 0.1)
    assert fired == []
    fired, t = run(tr, False, t, 0.2)
    fired, _ = run(tr, True, t, HOLD_S - 0.1)        # al cortarse, vuelve a contar desde cero
    assert fired == []


def test_despues_de_avisar_descansa_unos_segundos():
    tr = GestureTracker()
    first, t = run(tr, True, 0, 1)
    _, t = run(tr, False, t, 1)
    again, t = run(tr, True, t, 2)                    # lo repite enseguida: no avisa
    assert first == [HOLD_S] and again == []
    _, t = run(tr, False, t, COOLDOWN_S)
    later, _ = run(tr, True, t, 1)                    # pasado el descanso, sí
    assert len(later) == 1
