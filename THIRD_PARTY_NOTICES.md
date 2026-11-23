# Third-Party Notices & Disclaimers

Tesroid incorporates or interacts with open-source and third-party components. This document provides license notices, attributions, and important redistribution guidelines.

---

## 1. Trademark Disclaimer

- **Tesla** is a registered trademark of Tesla, Inc.
- **Google Chrome** and **YouTube** are trademarks of Google LLC.
- **Cloudflare** and **Cloudflare Tunnel** are trademarks or registered trademarks of Cloudflare, Inc.

Tesroid is an independent open-source project and is **not** affiliated with, endorsed by, or sponsored by Tesla, Inc., Google LLC, Cloudflare, Inc., or any of their affiliates.

---

## 2. Container Build-Time Third-Party Software (`Dockerfile`)

This repository distributes **source code and build definitions (`Dockerfile`) only** and does **not** distribute pre-built container images or proprietary binaries.

When you build the container image locally (`docker compose build` / `docker build`), the `Dockerfile` downloads and installs the following packages from official upstream repositories:

1. **Google Chrome Stable** (`google-chrome-stable`)
   - Downloaded directly from `https://dl.google.com/linux/direct/` during local image build (`INSTALL_CHROME=true`, default) or at container startup (`docker/entrypoint.sh`) when using the pre-built base image (`INSTALL_CHROME=false`).
   - Governed by the [Google Chrome Terms of Service](https://www.google.com/chrome/terms/).
   - **Important Redistribution Notice**: Because Google Chrome is proprietary software, **do not publish or redistribute pre-built Docker images built with `INSTALL_CHROME=true` to public registries** (such as public Docker Hub or GHCR) without authorization. Official pre-built images are built with `INSTALL_CHROME=false` so that Google Chrome is not included in the distributed image.
2. **cloudflared** (`cloudflared-linux-amd64`)
   - Downloaded directly from `https://github.com/cloudflare/cloudflared/releases/` during image build.
   - Licensed under the **Apache License 2.0** (`https://github.com/cloudflare/cloudflared/blob/master/LICENSE`).
3. **Ubuntu 24.04 System Packages & VA-API Drivers** (`ffmpeg`, `xvfb`, `openbox`, `xdotool`, `wmctrl`, `x11-xserver-utils`, `pulseaudio`, `pulseaudio-utils`, `alsa-utils`, `libva2`, `libva-drm2`, `intel-media-va-driver-non-free`, `i965-va-driver-shaders`, `mesa-va-drivers`, `libdrm-amdgpu1`, `vainfo`, `libpci3`, `pciutils`, `locales`, `curl`, `gnupg`, `ca-certificates`, `procps`, `fonts-noto-cjk`, `fonts-noto-color-emoji`, `nodejs`)
   - Installed via `apt-get` from official Ubuntu 24.04 (`main`, `universe`, `multiverse`, `noble-updates`) and NodeSource repositories under their respective open-source and upstream distribution licenses (MIT, X11, BSD, LGPL/GPL, SIL Open Font License 1.1, Mesa/gallium MIT licenses, and Intel Media Driver / `i965-va-driver-shaders` licenses).
4. **Windows / WSL2 Host Runtime Libraries (Runtime Bind-Mount Only)**
   - When running on Windows (Docker Desktop for Windows or WSL2 via `docker-compose.windows.yml`), `/usr/lib/wsl` (including Microsoft DirectX / DXCore WSL runtime libraries and vendor-specific GPU WSL user-mode drivers) is bind-mounted read-only from the user's host OS at container runtime and is **not** bundled or redistributed in Tesroid container images.

---

## 3. NPM Dependencies

Direct runtime and development dependencies specified in `server/package.json` and `client/package.json`:

| Package | License |
| :--- | :--- |
| `fastify` | MIT |
| `@fastify/static` | MIT |
| `@fastify/websocket` | MIT |
| `ws` | MIT |
| `bcryptjs` | MIT |
| `vite` | MIT |
| `vitest` | MIT |
| `tsx` | MIT |
| `typescript` | Apache-2.0 |

---

## 4. Inline SVG Icons (`client/src/views/icons.ts`)

Inline SVG icon paths in `client/src/views/icons.ts` are derived from **Feather Icons** (MIT) and **Lucide Icons** (ISC).

### Feather Icons & Lucide Icons License Notice

```text
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

```text
MIT License (Feather Icons)

Copyright (c) 2013-2023 Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
