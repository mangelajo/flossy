# Servicio de visión (solo CPU, sin GPU). Sin YOLO/PyTorch: la imagen pesa ~1 GB menos y cada
# fotograma cuesta ~40 ms de CPU en vez de ~85.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 wget \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY flossy_vision.py coach.py zones.py app.py ./
# Modelos de MediaPipe dentro de la imagen; el de zonas (zones.joblib) llega por volumen en
# /models, para poder reentrenarlo sin reconstruir.
ENV FLOSSY_MEDIAPIPE=/app/mp-models
RUN mkdir -p /app/mp-models \
 && wget -q -O /app/mp-models/hand_landmarker.task https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task \
 && wget -q -O /app/mp-models/face_landmarker.task https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task
ENV FLOSSY_MODELS=/models DATA_DIR=/data PATH="/app/.venv/bin:$PATH"
EXPOSE 8000
HEALTHCHECK --interval=5m --timeout=5s CMD wget --spider -q "http://127.0.0.1:8000/ws/health" || exit 1
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
