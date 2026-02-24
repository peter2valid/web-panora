# ═══════════════════════════════════════════════
# Viewora Backend — Production Docker Image
# Python 3.11 · FastAPI · OpenCV · Hugin
# Multi-worker: gunicorn + uvicorn workers
# ═══════════════════════════════════════════════
FROM python:3.11-slim-bookworm

# Install system dependencies
# hugin-tools: pto_gen, cpfind, autooptimiser, nona, pano_modify
# enblend:     tile blending
# libgl1:      OpenCV headless requirement
# curl:        healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
  hugin-tools \
  enblend \
  libgl1 \
  libglib2.0-0 \
  libsm6 \
  libxrender1 \
  libxext6 \
  curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps (cached layer — only re-runs if requirements change)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source
COPY main.py .

# Create persistent data dirs
RUN mkdir -p uploads outputs

# Expose API port
EXPOSE 8000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD curl -sf http://localhost:8000/health || exit 1

# Production: gunicorn manages multiple uvicorn worker processes.
# WEB_CONCURRENCY env var lets Railway/Render override worker count at runtime.
# Default: 2 workers (safe for 1–2 vCPU hosts); set WEB_CONCURRENCY=4 for 4-vCPU.
CMD gunicorn main:app \
  --workers ${WEB_CONCURRENCY:-2} \
  --worker-class uvicorn.workers.UvicornWorker \
  --bind 0.0.0.0:8000 \
  --timeout 360 \
  --graceful-timeout 30 \
  --keep-alive 5 \
  --access-logfile - \
  --error-logfile -
