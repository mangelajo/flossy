"""Protocolos de grabación guiada: la app pide cada zona y etiqueta los fotogramas con ella.

Cada paso es (actividad, zona, segundos, instrucción). Los primeros GRACE segundos de cada
paso se etiquetan como fase "transition" (el usuario está cambiando de zona) para poder
descartarlos al entrenar.

Zonas (6): arcada (sup/inf) - sector (izq/front/der), iguales para cepillado y seda.
"izq"/"der" son la izquierda/derecha DE LA PERSONA.
"""

GRACE = 2.0

ARCADA = {"sup": "arriba", "inf": "abajo"}
SECTOR = {"izq": "a tu izquierda", "front": "en el centro", "der": "a tu derecha"}
ZONES = [(a, s) for a in ("sup", "inf") for s in ("izq", "front", "der")]


def step(activity, arcada, sector, secs):
    verb = "Cepilla" if activity == "brush" else "Seda"
    return (activity, f"{arcada}-{sector}", secs, f"{verb} {ARCADA[arcada]} {SECTOR[sector]}")


START = [("idle", None, 5, "Mírate a la cámara, sin cepillar")]
END = [("idle", None, 5, "Deja el cepillo y mira a la cámara")]

BRUSH = [step("brush", a, s, 20) for a, s in ZONES]   # 6 × 20 s = 2 min
FLOSS = [step("floss", a, s, 10) for a, s in ZONES]   # 6 × 10 s = 1 min

PROTOCOLS = {
    "cepillado": {"title": "Cepillado (6 zonas × 20 s)", "steps": START + BRUSH + END},
    "seda": {"title": "Seda (6 zonas × 10 s)", "steps": START + FLOSS + END},
    "completo": {"title": "Cepillado + seda",
                 "steps": START + BRUSH + [("idle", None, 10, "Deja el cepillo y coge la seda")] + FLOSS + END},
    "prueba": {"title": "Prueba rápida del sistema",
               "steps": [("idle", None, 3, "Mírate a la cámara"), step("brush", "sup", "izq", 4),
                         step("floss", "sup", "front", 4)]},
}


class Guide:
    """Dice qué paso toca en cada instante de la grabación."""

    def __init__(self, name):
        self.name = name
        self.steps = PROTOCOLS[name]["steps"]
        self.total = sum(s[2] for s in self.steps)

    def at(self, t):
        """t = segundos desde el inicio. Devuelve None cuando el protocolo ha terminado."""
        start = 0.0
        for i, (activity, zone, secs, text) in enumerate(self.steps):
            if t < start + secs:
                elapsed = t - start
                nxt = self.steps[i + 1][3] if i + 1 < len(self.steps) else None
                return {
                    "step": i, "steps": len(self.steps), "activity": activity, "zone": zone, "text": text,
                    "phase": "transition" if elapsed < GRACE and activity != "idle" else "main",
                    "remaining": round(start + secs - t, 1), "duration": secs, "next": nxt,
                    "total_left": round(self.total - t, 1),
                }
            start += secs
        return None
