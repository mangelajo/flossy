from protocol import GRACE, PROTOCOLS, ZONES, Guide


def test_protocolos_cubren_las_seis_zonas():
    for name in ("cepillado", "seda"):
        zones = [z for act, z, *_ in PROTOCOLS[name]["steps"] if act != "idle"]
        assert sorted(zones) == sorted(f"{a}-{s}" for a, s in ZONES)
    completo = [(a, z) for a, z, *_ in PROTOCOLS["completo"]["steps"] if a != "idle"]
    assert len(completo) == 12


def test_duraciones():
    assert Guide("cepillado").total == 5 + 6 * 20 + 5
    assert Guide("seda").total == 5 + 6 * 10 + 5
    assert Guide("prueba").total == 11


def test_paso_en_cada_instante_y_fase_de_transicion():
    g = Guide("prueba")  # idle 3 s, cepillado arriba-izq 4 s, seda arriba-centro 4 s
    assert g.at(0)["activity"] == "idle"
    assert g.at(0)["phase"] == "main"            # los pasos idle no tienen transición
    s = g.at(3.5)
    assert (s["step"], s["activity"], s["zone"], s["phase"]) == (1, "brush", "sup-izq", "transition")
    assert g.at(3 + GRACE + 0.1)["phase"] == "main"
    assert g.at(3.5)["next"] == g.steps[2][3]
    assert g.at(10.9)["next"] is None
    assert round(g.at(5)["remaining"], 1) == 2.0


def test_termina_al_acabar_el_ultimo_paso():
    g = Guide("prueba")
    assert g.at(10.99) is not None
    assert g.at(11) is None
