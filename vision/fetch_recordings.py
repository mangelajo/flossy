"""Descarga las grabaciones de entrenamiento del servidor a data/recordings/ (las que falten).

  FLOSSY_KEY=flossy_… uv run fetch_recordings.py https://flossy.ajo.es
  uv run fetch_recordings.py https://flossy.ajo.es --key flossy_… --incomplete

La clave es una clave de API (Ajustes → Claves de API) de un administrador. Por defecto solo baja
las grabaciones completas; --incomplete baja también las que se pararon a medias. Después:
uv run analyze.py para revisarlas y uv run zones.py para reentrenar.
"""

import argparse
import json
import os
import shutil
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

RECORDINGS = Path(__file__).parent / "data" / "recordings"


def get(url, key):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": f"Bearer {key}"}), timeout=60)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("server", help="p. ej. https://flossy.ajo.es")
    ap.add_argument("--key", default=os.environ.get("FLOSSY_KEY"), help="clave de API de administrador (o FLOSSY_KEY)")
    ap.add_argument("--incomplete", action="store_true", help="bajar también las grabaciones incompletas")
    args = ap.parse_args()
    if not args.key:
        sys.exit("Falta la clave: --key o FLOSSY_KEY")
    base = args.server.rstrip("/")

    try:
        with get(f"{base}/ws/recordings", args.key) as r:
            recs = json.load(r)["recordings"]
    except urllib.error.HTTPError as e:
        sys.exit(f"El servidor responde {e.code}: ¿es una clave de un administrador?")

    RECORDINGS.mkdir(parents=True, exist_ok=True)
    todo = [r for r in recs if (r.get("complete") or args.incomplete) and not (RECORDINGS / r["id"] / "meta.json").exists()]
    print(f"{len(recs)} en el servidor, {len(todo)} por descargar")
    for r in todo:
        print(f"  {r['id']} · {r.get('frames')} fotogramas · {r['bytes'] / 1e6:.0f} MB… ", end="", flush=True)
        with tempfile.TemporaryDirectory(dir=RECORDINGS) as tmp:
            with get(f"{base}/ws/recordings/{urllib.parse.quote(r['id'])}.tar", args.key) as resp, \
                    tarfile.open(fileobj=resp, mode="r|") as tar:
                tar.extractall(tmp, filter="data")
            shutil.move(Path(tmp) / r["id"], RECORDINGS / r["id"])
        print("ok")


if __name__ == "__main__":
    main()
