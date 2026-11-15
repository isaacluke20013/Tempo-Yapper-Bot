FROM node:22-bookworm-slim
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/tempo-python
ENV PATH="/opt/tempo-python/bin:${PATH}"
WORKDIR /app
COPY requirements-music.txt ./
RUN pip install --no-cache-dir -r requirements-music.txt
COPY . .
CMD ["npm", "start"]
