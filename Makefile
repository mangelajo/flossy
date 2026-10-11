# flossy: tareas habituales. `make` (o `make help`) las lista.
#
# Valores locales (servidor, clave…) en local.mk, que no va a git. Por ejemplo:
#   FLOSSY_SERVER = https://flossy.example.com
#   FLOSSY_KEY_FILE = ~/.flossy-key        # fichero con una clave de API de administrador
-include local.mk

FLOSSY_SERVER ?=
FLOSSY_KEY_FILE ?= ~/.flossy-key
FLOSSY_KEY ?= $(shell cat $(FLOSSY_KEY_FILE) 2>/dev/null)
COMPOSE ?= docker compose
BUILD_COMPOSE = $(COMPOSE) -f docker-compose.yml -f docker-compose.build.yml

.DEFAULT_GOAL := help
.PHONY: help install dev api vision frontend lab test test-api test-vision test-frontend e2e fetch analyze train build images up down logs pull

help: ## Lista las tareas
	@awk 'BEGIN {FS = ":.*## "} /^[a-z-]+:.*## / {printf "  \033[36mmake %-10s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

## --- Desarrollo ---------------------------------------------------------------

install: ## Instala dependencias (npm de api y frontend, uv de vision) y baja los modelos (LFS)
	git lfs pull
	cd api && npm ci
	cd frontend && npm ci && npx playwright install chromium
	cd vision && uv sync

dev: ## Arranca api (:3000), visión (:8001) y frontend (:5173) a la vez; Ctrl-C para todo
	@echo "flossy en http://localhost:5173 (datos en .dev-data/)"
	@trap 'kill 0' INT TERM; \
	  (cd api && npm run dev) & \
	  (cd vision && DATA_DIR=../.dev-data uv run uvicorn app:app --port 8001) & \
	  (cd frontend && npm run dev) & \
	  wait

api: ## Solo la API (:3000)
	cd api && npm run dev

vision: ## Solo el servicio de visión (:8001)
	cd vision && DATA_DIR=../.dev-data uv run uvicorn app:app --port 8001 --reload

frontend: ## Solo el frontend (vite, :5173)
	cd frontend && npm run dev

lab: ## Laboratorio de grabación con HTTPS para el móvil (vision/server.py)
	cd vision && uv run server.py --https

test: test-api test-vision test-frontend ## Tests de API, visión y frontend, y compila el frontend
	cd frontend && npx vite build --logLevel warn

test-frontend: ## Tests del frontend (Vitest + Testing Library)
	cd frontend && npm test

e2e: ## De punta a punta con Playwright (levanta API, visión y frontend en otros puertos)
	cd frontend && npm run e2e

test-api: ## Tests de la API (node:test)
	cd api && npm test

test-vision: ## Tests del servicio de visión (pytest; arranca la API de Node)
	cd vision && uv run --no-dev --group test pytest -q

build: ## Compila el frontend (frontend/dist)
	cd frontend && npx vite build

## --- Entrenamiento --------------------------------------------------------------

fetch: ## Baja del servidor las grabaciones nuevas (FLOSSY_SERVER + clave en FLOSSY_KEY_FILE)
	@test -n "$(FLOSSY_SERVER)" || { echo "Falta FLOSSY_SERVER (p. ej. en local.mk)"; exit 1; }
	@test -n "$(FLOSSY_KEY)" || { echo "Falta la clave: ponla en $(FLOSSY_KEY_FILE) o en FLOSSY_KEY"; exit 1; }
	cd vision && FLOSSY_KEY=$(FLOSSY_KEY) uv run fetch_recordings.py $(FLOSSY_SERVER)

analyze: ## Resumen por zona de las grabaciones locales
	cd vision && uv run analyze.py

train: fetch ## Baja las grabaciones nuevas y reentrena el modelo de zonas (vision/models/zones.joblib)
	cd vision && uv run zones.py
	@git diff --quiet -- vision/models/zones.joblib || \
	  printf "\nModelo nuevo. Para publicarlo: git commit vision/models/zones.joblib && git push (CI construye la imagen)\n"

## --- Docker ---------------------------------------------------------------------

up: ## Arranca flossy con las imágenes publicadas: http://localhost:8080
	$(COMPOSE) up -d
	@echo "flossy en http://localhost:$${WEB_PORT:-8080}"

pull: ## Baja las últimas imágenes publicadas
	$(COMPOSE) pull

images: ## Construye las imágenes desde el código y arranca con ellas
	$(BUILD_COMPOSE) up -d --build

down: ## Para los contenedores
	$(COMPOSE) --profile https down

logs: ## Logs de los contenedores
	$(COMPOSE) logs -f --tail=100
