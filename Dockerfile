# ---------- BASE STAGE (build everything) ----------
FROM python:3.10-slim AS base

WORKDIR /app

# Install system dependencies for audio, PyAV, and Node/Nginx
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    build-essential ffmpeg libavdevice-dev libavfilter-dev libavformat-dev \
    libavcodec-dev libswresample-dev libavutil-dev libsndfile1-dev \
    nginx curl && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install backend Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend code
COPY app/backend ./backend

# ---------- FRONTEND BUILD ----------
WORKDIR /app/frontend
COPY app/frontend/package.json app/frontend/package-lock.json ./
RUN npm ci
COPY app/frontend ./
RUN npm run build

# ---------- FINAL IMAGE ----------
FROM python:3.10-slim

WORKDIR /app

# Install runtime deps only (nginx)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ffmpeg libavdevice-dev libavfilter-dev libavformat-dev \
    libavcodec-dev libswresample-dev libavutil-dev libsndfile1-dev \
    nginx && \
    rm -rf /var/lib/apt/lists/*

# Copy installed Python packages from builder
COPY --from=base /usr/local/lib/python3.10/site-packages /usr/local/lib/python3.10/site-packages
COPY --from=base /usr/local/bin/uvicorn /usr/local/bin/uvicorn
COPY --from=base /usr/local/bin/pip /usr/local/bin/pip

# Copy backend code
COPY --from=base /app/backend /app/backend

# Copy frontend build output to a static path
COPY --from=base /app/frontend/build /app/frontend_build

# Add nginx config
COPY nginx.conf /etc/nginx/nginx.conf

# Expose FastAPI and frontend (nginx) ports
EXPOSE 8001 80

# Entrypoint to launch both backend and frontend
# Nginx runs in foreground; use dumb-init to supervise both in production
CMD service nginx start && uvicorn backend.main:app --host 0.0.0.0 --port 8001
