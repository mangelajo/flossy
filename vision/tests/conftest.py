"""Entorno de los tests de visión.

app.py lee DATA_DIR, RECORDINGS_DIR y ORIGIN al importarse, así que se fijan aquí, antes que
nada. La API de Node se arranca de verdad sobre el mismo DATA_DIR: así las cookies y las claves
que usan los tests las firma la API real, que es justo lo que app.py tiene que entender.
"""
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
TMP = Path(tempfile.mkdtemp(prefix="flossy-vision-test-"))
DATA, RECORDINGS = TMP / "data", TMP / "recordings"
DATA.mkdir()
RECORDINGS.mkdir()
ORIGIN = "http://flossy.test"
os.environ.update(DATA_DIR=str(DATA), RECORDINGS_DIR=str(RECORDINGS), ORIGIN=ORIGIN)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Client:
    """Un navegador contra la API de Node: guarda su cookie."""

    def __init__(self, base, addr):
        self.base, self.addr, self.cookie, self.user = base, addr, "", None

    def call(self, method, path, body=None):
        headers = {"Content-Type": "application/json", "Origin": ORIGIN, "X-Forwarded-For": self.addr}
        if self.cookie:
            headers["Cookie"] = self.cookie
        req = urllib.request.Request(self.base + path, method=method, headers=headers,
                                     data=None if body is None else json.dumps(body).encode())
        try:
            with urllib.request.urlopen(req) as r:
                if r.headers.get("Set-Cookie"):
                    self.cookie = r.headers["Set-Cookie"].split(";")[0]
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)


class Api:
    def __init__(self, base):
        self.base, self.n = base, 0

    def client(self):
        self.n += 1
        return Client(self.base, f"10.1.0.{self.n}")

    def signup(self, name):
        c = self.client()
        status, body = c.call("POST", "/api/register/password", {"name": name, "password": f"{name}-contraseña-larga"})
        assert status == 200, body
        c.user = body["user"]
        return c

    def key(self, client):
        status, body = client.call("POST", "/api/keys", {"name": "tests"})
        assert status == 200, body
        return body["secret"]


@pytest.fixture(scope="session")
def api():
    if not shutil.which("node"):
        pytest.skip("hace falta node para arrancar la API")
    port = free_port()
    env = {**os.environ, "PORT": str(port), "DATA_DIR": str(DATA), "ORIGIN": ORIGIN, "RP_ID": "flossy.test", "TRUST_PROXY": "1"}
    proc = subprocess.Popen(["node", "server.js"], cwd=ROOT / "api", env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            urllib.request.urlopen(base + "/api/health")
            break
        except OSError:
            if proc.poll() is not None:
                raise RuntimeError(proc.stdout.read().decode())
            time.sleep(0.05)
    yield Api(base)
    proc.terminate()
    proc.wait()


@pytest.fixture(scope="session")
def people(api):
    """Ana (primera: administradora), Pepe (perfil normal, sin permiso de grabar)."""
    return {"ana": api.signup("Ana"), "pepe": api.signup("Pepe")}


def pytest_sessionfinish(session, exitstatus):
    shutil.rmtree(TMP, ignore_errors=True)
