FROM node:22-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    cmake \
    g++ \
    make \
    git \
    curl \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git /tmp/whisper.cpp \
    && cd /tmp/whisper.cpp \
    && cmake -B build \
    && cmake --build build -j$(nproc) \
    && cp build/bin/whisper-cli /usr/local/bin/whisper-cpp \
    && rm -rf /tmp/whisper.cpp

RUN mkdir -p /usr/local/share/whisper \
    && curl -L -o /usr/local/share/whisper/ggml-base.bin \
       https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build && npm prune --omit=dev

RUN mkdir -p data groups store

ENV WHISPER_MODEL=/usr/local/share/whisper/ggml-base.bin

CMD ["node", "dist/index.js"]
