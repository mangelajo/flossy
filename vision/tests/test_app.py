"""Servicio de visión de producción (app.py): salud, WebSocket y grabaciones para entrenar.

Las cookies y claves las emite la API de Node real (fixture `api`): así se comprueba que Python
entiende exactamente lo que firma Node.
"""
import io
import json
import tarfile

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from conftest import ORIGIN, RECORDINGS

import app as vision

client = TestClient(vision.app)
JPEG = cv2.imencode(".jpg", np.full((360, 480, 3), 128, np.uint8))[1].tobytes()


def ws(cookie, origin=ORIGIN):
    return client.websocket_connect("/ws", headers={"origin": origin, "cookie": cookie})


def test_salud_con_el_modelo_de_zonas_cargado():
    assert client.get("/ws/health").json() == {"ok": True, "zone_model": True, "yolo": False}


# ---------- la cookie de Node, en Python ----------

def test_python_acepta_la_cookie_que_firma_node(people):
    user = vision.auth.user(people["ana"].cookie)
    assert user["name"] == "Ana"


def test_cookie_manipulada_o_ajena_no_vale(people):
    name, value = people["ana"].cookie.split("=", 1)
    payload, mac = value.rsplit(".", 1)
    uid, exp, sv = payload.split(":")
    assert vision.auth.user(f"{name}={uid}:{int(exp) + 1}:{sv}.{mac}") is None
    assert vision.auth.user(f"{name}={people['pepe'].user['id']}:{exp}:{sv}.{mac}") is None
    assert vision.auth.user("") is None
    # dos cookies distintas con el mismo nombre: se rechaza (no se elige una)
    assert vision.auth.user(f"{people['ana'].cookie}; {people['pepe'].cookie.replace(people['pepe'].cookie.split('=')[0], name)}") is None


def test_cerrar_sesion_en_todas_partes_tambien_corta_aqui(api):
    luis = api.signup("Luis")
    old = luis.cookie
    assert vision.auth.user(old)["name"] == "Luis"
    assert luis.call("POST", "/api/logout/all")[0] == 200
    assert vision.auth.user(old) is None


# ---------- WebSocket ----------

def test_websocket_sin_sesion_o_desde_otro_origen_se_cierra(people):
    for cookie, origin in (("", ORIGIN), (people["ana"].cookie, "https://evil.example")):
        with pytest.raises(WebSocketDisconnect) as e:
            with ws(cookie, origin) as conn:
                conn.receive_text()
        assert e.value.code == 4401


def test_sesion_guiada_responde_a_cada_fotograma(people):
    with ws(people["ana"].cookie) as conn:
        conn.send_text(json.dumps({"type": "start", "mode": "brush"}))
        conn.send_bytes(JPEG)
        r = json.loads(conn.receive_text())
    assert r["state"] == "idle" and r["face"] is False          # imagen gris: no hay nadie
    assert r["coach"]["steps"] == 6 and r["coach"]["status"] == "idle"
    assert r["guide"] is None


def test_un_fotograma_roto_no_tumba_la_conexion(people):
    with ws(people["ana"].cookie) as conn:
        conn.send_bytes(b"esto no es un jpeg")
        assert json.loads(conn.receive_text()) == {"error": "bad frame"}
        conn.send_bytes(JPEG)
        assert "state" in json.loads(conn.receive_text())


def test_sin_permiso_no_se_puede_grabar(people):
    with ws(people["pepe"].cookie) as conn:
        conn.send_text(json.dumps({"type": "record", "protocol": "prueba"}))
        assert "permiso" in json.loads(conn.receive_text())["error"]


def test_grabar_guarda_los_fotogramas_etiquetados(people):
    with ws(people["ana"].cookie) as conn:
        conn.send_text(json.dumps({"type": "record", "protocol": "nope"}))
        assert "Protocolo" in json.loads(conn.receive_text())["error"]
        conn.send_text(json.dumps({"type": "record", "protocol": "prueba", "hand": "left"}))
        for _ in range(3):
            conn.send_bytes(JPEG)
            guide = json.loads(conn.receive_text())["guide"]
        conn.send_text(json.dumps({"type": "stop"}))
    assert guide["activity"] == "idle" and guide["frames"] == 3
    meta = json.loads((RECORDINGS / guide["id"] / "meta.json").read_text())
    assert (meta["who"], meta["uid"], meta["hand"], meta["frames"], meta["complete"], meta["source"]) == \
        ("Ana", people["ana"].user["id"], "left", 3, False, "app")
    assert len(list((RECORDINGS / guide["id"] / "img").iterdir())) == 3


# ---------- API de grabaciones (administradores) ----------

@pytest.fixture(scope="module")
def recording(people):
    with ws(people["ana"].cookie) as conn:
        conn.send_text(json.dumps({"type": "record", "protocol": "prueba"}))
        conn.send_bytes(JPEG)
        rec_id = json.loads(conn.receive_text())["guide"]["id"]
    return rec_id


def test_listar_requiere_ser_administrador(api, people, recording):
    assert client.get("/ws/recordings").status_code == 401
    assert client.get("/ws/recordings", headers={"Authorization": "Bearer flossy_falsa"}).status_code == 401
    pepe_key = api.key(people["pepe"])
    assert client.get("/ws/recordings", headers={"Authorization": f"Bearer {pepe_key}"}).status_code == 403
    assert client.get("/ws/recordings", headers={"cookie": people["pepe"].cookie}).status_code == 403

    by_cookie = client.get("/ws/recordings", headers={"cookie": people["ana"].cookie})
    by_key = client.get("/ws/recordings", headers={"X-API-Key": api.key(people["ana"])})
    assert by_cookie.status_code == by_key.status_code == 200
    ids = [r["id"] for r in by_key.json()["recordings"]]
    assert recording in ids
    entry = next(r for r in by_key.json()["recordings"] if r["id"] == recording)
    assert entry["bytes"] > 0 and entry["protocol"] == "prueba"


def test_descargar_un_tar_con_la_grabacion(api, people, recording):
    key = api.key(people["ana"])
    r = client.get(f"/ws/recordings/{recording}.tar", headers={"Authorization": f"Bearer {key}"})
    assert r.status_code == 200
    names = tarfile.open(fileobj=io.BytesIO(r.content)).getnames()
    assert f"{recording}/meta.json" in names and f"{recording}/frames.jsonl" in names


def test_no_se_sale_del_directorio_de_grabaciones(api, people):
    key = {"Authorization": f"Bearer {api.key(people['ana'])}"}
    for bad in ("..%2F..%2Fdata", "..", "no-existe", "a%2Fb"):
        assert client.get(f"/ws/recordings/{bad}.tar", headers=key).status_code == 404, bad
        assert client.delete(f"/ws/recordings/{bad}", headers=key).status_code in (404, 405), bad


def test_borrar_una_grabacion(api, people, recording):
    key = {"Authorization": f"Bearer {api.key(people['ana'])}"}
    pepe = {"Authorization": f"Bearer {api.key(people['pepe'])}"}
    assert client.delete(f"/ws/recordings/{recording}", headers=pepe).status_code == 403
    assert client.delete(f"/ws/recordings/{recording}", headers=key).json() == {"ok": True}
    assert not (RECORDINGS / recording).exists()
    assert client.get(f"/ws/recordings/{recording}.tar", headers=key).status_code == 404
