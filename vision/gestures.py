"""Gestos «extra» durante la sesión. De momento uno: el dedo corazón (la peineta), para que la app
responda con humor. No cuenta para nada: ni progreso, ni sesión guardada.

La regla usa los 21 puntos de mano de MediaPipe. Comprobada con las grabaciones de casa: detecta
el gesto y no salta con la seda (los dedos enrollados en el hilo se parecen mucho), porque exige
que el dedo apunte hacia arriba y que la mano esté lejos de la boca.
"""

import numpy as np

# (nudillo MCP, articulación PIP, punta) de cada dedo.
FINGERS = {"index": (5, 6, 8), "middle": (9, 10, 12), "ring": (13, 14, 16), "pinky": (17, 18, 20)}
HOLD_S = 0.5       # tiene que mantenerse este tiempo para contar
COOLDOWN_S = 8.0   # y después no vuelve a saltar hasta pasado este tiempo
FAR_FROM_MOUTH = 2.5  # anchos de boca
UP_MARGIN = 0.03   # fracción de la altura del fotograma


def _extended(hand, mcp, pip, tip):
    wrist = hand[0]
    return (np.linalg.norm(hand[tip] - wrist) > 1.15 * np.linalg.norm(hand[pip] - wrist)
            and np.linalg.norm(hand[tip] - hand[mcp]) > 0.6 * np.linalg.norm(hand[mcp] - wrist))


def middle_finger(hands, mouth, size):
    """¿Alguna mano hace la peineta? hands: arrays 21×2 en píxeles; mouth: dict con center/width
    (o None si no se ve la cara); size: (ancho, alto) del fotograma."""
    for hand in hands:
        hand = np.asarray(hand, float)
        ext = {name: _extended(hand, *idx) for name, idx in FINGERS.items()}
        if not ext["middle"] or ext["index"] or ext["ring"] or ext["pinky"]:
            continue
        if hand[12][1] >= hand[9][1] - UP_MARGIN * size[1]:   # tiene que apuntar hacia arriba
            continue
        if mouth is not None and np.linalg.norm(hand[9] - mouth["center"]) <= FAR_FROM_MOUTH * mouth["width"]:
            continue
        return True
    return False


class GestureTracker:
    """Convierte «se ve el gesto en este fotograma» en un aviso único: salta cuando lleva HOLD_S
    seguidos y luego descansa COOLDOWN_S."""

    def __init__(self):
        self.since = None
        self.last_fired = None

    def update(self, t, seen):
        if not seen:
            self.since = None
            return False
        if self.since is None:
            self.since = t
        if t - self.since < HOLD_S:
            return False
        if self.last_fired is not None and t - self.last_fired < COOLDOWN_S:
            return False
        self.last_fired = t
        return True
