# Servicio de visión (solo CPU, sin GPU). Sin YOLO/PyTorch: la imagen pesa ~1 GB menos y cada
# fotograma cuesta ~40 ms de CPU en vez de ~85.
# Capas de lo que menos cambia a lo que más: modelos de MediaPipe, dependencias, clasificador
# de zonas (cambia al reentrenar) y por último el código.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libegl1 libgles2 libglib2.0-0 wget \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Modelos versionados con git LFS en vision/models/. Se puede montar otro zones.joblib en
# /app/models para probarlo sin reconstruir.
COPY models/*.task ./models/
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY models/*.joblib ./models/
COPY flossy_vision.py coach.py zones.py app.py ./
ENV FLOSSY_MODELS=/app/models DATA_DIR=/data PATH="/app/.venv/bin:$PATH"
EXPOSE 8000
HEALTHCHECK --interval=5m --timeout=5s CMD wget --spider -q "http://127.0.0.1:8000/ws/health" || exit 1
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
