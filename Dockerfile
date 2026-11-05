# ==============================================================================
# Stage 1: Build frontend client
# ==============================================================================
FROM node:20-alpine AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# ==============================================================================
# Stage 2: Build backend server
# ==============================================================================
FROM node:20-alpine AS server-builder
WORKDIR /app/server
COPY server/package*.json ./
RUN npm install
COPY server/ ./
RUN npm run build

# ==============================================================================
# Stage 3: Production Runtime (Ubuntu 22.04 LTS + Intel VAAPI + Google Chrome)
# ==============================================================================
FROM ubuntu:22.04 AS runner
WORKDIR /app

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    DISPLAY=:99 \
    DISPLAY_NUM=:99 \
    DISPLAY_WIDTH=1280 \
    DISPLAY_HEIGHT=720 \
    FPS=30 \
    VIDEO_BITRATE=1000k \
    VAAPI_DEVICE=/dev/dri/renderD128 \
    LIBVA_DRIVER_NAME=iHD \
    PULSE_SERVER=unix:/tmp/pulse-socket \
    PULSE_SINK=virtual_sink \
    PUBLIC_DIR=/app/server/public

# 1. Install system utilities, repositories, and dependencies
RUN apt-get update -qq && \
    apt-get install -qq -y --no-install-recommends \
        curl \
        gnupg \
        ca-certificates \
        xvfb \
        openbox \
        xdotool \
        wmctrl \
        x11-xserver-utils \
        pulseaudio \
        pulseaudio-utils \
        alsa-utils \
        ffmpeg \
        intel-media-va-driver-non-free \
        vainfo \
        fonts-noto-cjk \
        fonts-noto-color-emoji \
        procps \
        && rm -rf /var/lib/apt/lists/* && \
    sed -i 's|</applications>|  <application class="*">\n    <decor>no</decor>\n    <position force="yes">\n      <x>0</x>\n      <y>0</y>\n    </position>\n    <fullscreen>no</fullscreen>\n    <maximized>no</maximized>\n  </application>\n</applications>|' /etc/xdg/openbox/rc.xml

# 2. Install Node.js 20 LTS
RUN mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list && \
    apt-get update -qq && \
    apt-get install -qq -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# 3. Install Google Chrome Stable
RUN curl -sSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb && \
    apt-get update -qq && \
    apt-get install -qq -y --no-install-recommends /tmp/chrome.deb && \
    rm -f /tmp/chrome.deb && \
    rm -rf /var/lib/apt/lists/*

# 4. Configure PulseAudio for container execution
RUN echo "default-server = unix:/tmp/pulse-socket" > /etc/pulse/client.conf && \
    echo "autospawn = no" >> /etc/pulse/client.conf && \
    echo "default-fragments = 2" > /etc/pulse/daemon.conf && \
    echo "default-fragment-size-msec = 10" >> /etc/pulse/daemon.conf && \
    echo "enable-deferred-volume = no" >> /etc/pulse/daemon.conf && \
    echo "flat-volumes = no" >> /etc/pulse/daemon.conf && \
    echo "exit-idle-time = -1" >> /etc/pulse/daemon.conf && \
    echo "disallow-exit = yes" >> /etc/pulse/daemon.conf && \
    printf 'load-module module-native-protocol-unix socket=/tmp/pulse-socket auth-anonymous=1\nload-module module-native-protocol-tcp auth-anonymous=1 port=4713\nload-module module-null-sink sink_name=virtual_sink rate=48000 channels=2 format=s16le sink_properties=device.description=Virtual_Sink\nset-default-sink virtual_sink\n' > /etc/pulse/tesroid.pa

# 5. Copy built backend server and production dependencies
WORKDIR /app/server
COPY server/package*.json ./
RUN npm install --omit=dev
COPY --from=server-builder /app/server/dist ./dist
COPY server/extension ./extension

# 6. Copy static frontend build into server's public directory
COPY --from=client-builder /app/client/dist ./public

# 7. Create persistent data and profile directory
RUN mkdir -p /data/browser-profile

EXPOSE 8080

CMD ["node", "dist/index.js"]
