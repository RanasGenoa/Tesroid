# syntax=docker/dockerfile:1

FROM --platform=linux/amd64 node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/

RUN npm ci

COPY shared ./shared
COPY server ./server
COPY client ./client

RUN npm run build && npm prune --omit=dev

FROM --platform=linux/amd64 ubuntu:24.04 AS runtime

ARG INSTALL_CHROME=false
ARG CLOUDFLARED_VERSION=2026.11.1
ARG CLOUDFLARED_SHA256=97bb3b02d23a5980fc9c15a1a270e692da1923f103f920d5b16d4931d5ab55e7

ENV DEBIAN_FRONTEND=noninteractive

# Block systemd and udev packages so older host NAS kernels do not hit unsupported syscalls.
RUN printf '%s\n' \
  'Package: systemd systemd-sysv systemd-standalone-sysusers systemd-standalone-tmpfiles libpam-systemd dbus-user-session udev' \
  'Pin: release *' \
  'Pin-Priority: -1' \
  > /etc/apt/preferences.d/no-systemd

RUN set -eux; \
  if [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then \
    sed -i 's/^Components: main$/Components: main universe multiverse/' /etc/apt/sources.list.d/ubuntu.sources; \
    sed -i 's/^Components: main restricted$/Components: main restricted universe multiverse/' /etc/apt/sources.list.d/ubuntu.sources; \
  fi; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    locales \
    procps \
    tzdata \
    tini \
    dbus-x11 \
    xvfb \
    openbox \
    wmctrl \
    x11-xserver-utils \
    pulseaudio \
    pulseaudio-utils \
    alsa-utils \
    ffmpeg \
    libva2 \
    libva-drm2 \
    intel-media-va-driver-non-free \
    i965-va-driver-shaders \
    mesa-va-drivers \
    libdrm-amdgpu1 \
    vainfo \
    libpci3 \
    pciutils \
    fonts-noto-cjk \
    fonts-noto-color-emoji; \
  mkdir -p /etc/apt/keyrings; \
  curl --proto '=https' --tlsv1.2 -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg; \
  printf 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main\n' \
    > /etc/apt/sources.list.d/nodesource.list; \
  apt-get update; \
  apt-get install -y --no-install-recommends nodejs; \
  node -v | grep -q '^v22\.'; \
  locale-gen ja_JP.UTF-8 en_US.UTF-8; \
  rm -rf /var/lib/apt/lists/*

# Keep /etc/libva.conf comment-only so runtime GPU detection and explicit env vars take precedence.
RUN printf '%s\n' \
  '# /etc/libva.conf - Tesroid intentionally leaves this file comment-only.' \
  '# Runtime GPU probing and explicit environment settings control driver selection.' \
  > /etc/libva.conf

RUN mkdir -p /etc/pulse && printf '%s\n' \
  'load-module module-null-sink sink_name=virtual_sink rate=48000 channels=2 format=s16le sink_properties=device.description=Tesroid_Virtual_Sink' \
  'set-default-sink virtual_sink' \
  'set-sink-mute virtual_sink 0' \
  'set-sink-volume virtual_sink 65536' \
  'load-module module-native-protocol-unix auth-anonymous=1 socket=/tmp/pulse-socket' \
  > /etc/pulse/tesroid.pa

RUN mkdir -p /etc/xdg/openbox && printf '%s\n' \
  '<?xml version="1.0" encoding="UTF-8"?>' \
  '<openbox_config xmlns="http://openbox.org/3.4/rc">' \
  '  <applications>' \
  '    <application class="*">' \
  '      <decor>no</decor>' \
  '      <position force="yes"><x>0</x><y>0</y></position>' \
  '      <maximized>no</maximized>' \
  '      <fullscreen>no</fullscreen>' \
  '    </application>' \
  '  </applications>' \
  '</openbox_config>' \
  > /etc/xdg/openbox/rc.xml

RUN set -eux; \
  curl --proto '=https' --tlsv1.2 -fsSL \
    "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64" \
    -o /usr/local/bin/cloudflared; \
  echo "${CLOUDFLARED_SHA256}  /usr/local/bin/cloudflared" | sha256sum -c -; \
  chmod 0755 /usr/local/bin/cloudflared

RUN set -eux; \
  if [ "${INSTALL_CHROME}" = "true" ]; then \
    tmp_dir="$(mktemp -d)"; \
    trap 'rm -rf "${tmp_dir}"' EXIT; \
    deb_file="${tmp_dir}/google-chrome-stable_current_amd64.deb"; \
    curl --proto '=https' --tlsv1.2 -fsSL \
      https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
      -o "${deb_file}"; \
    dpkg-deb --info "${deb_file}" >/dev/null; \
    pkg_name="$(dpkg-deb --field "${deb_file}" Package)"; \
    pkg_arch="$(dpkg-deb --field "${deb_file}" Architecture)"; \
    [ "${pkg_name}" = "google-chrome-stable" ]; \
    [ "${pkg_arch}" = "amd64" ]; \
    apt-get update; \
    apt-get install -y --no-install-recommends "${deb_file}"; \
    rm -rf /var/lib/apt/lists/*; \
  fi

WORKDIR /app

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/shared/package.json ./shared/
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/server/package.json ./server/
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/dist ./client/dist

COPY docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod 0755 /app/docker/entrypoint.sh && mkdir -p /data

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    DISPLAY=:99 \
    LOCALE=ja-JP \
    TZ=Asia/Tokyo \
    ENCODER_MODE=auto \
    BUFFER_HOLD_EXPIRE_MINUTES=10 \
    TINI_KILL_PROCESS_GROUP=1

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-8080}/api/health" >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
