import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 9001;

function parsePort(raw, name, allowZero = false) {
  if (raw === undefined || raw === "") {
    return DEFAULT_PORT;
  }
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid ${name}: ${trimmed}`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  const min = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > 65_535) {
    throw new Error(`Out of range ${name}: ${trimmed}`);
  }
  return parsed;
}

function hasWhitespaceOrControl(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function parseTargetSpec(rawTarget, rawPort) {
  const trimmed = String(rawTarget ?? "").trim();
  if (trimmed.length === 0 || hasWhitespaceOrControl(trimmed)) {
    throw new Error("TARGET_HOST (or --target <host[:port]>) is required");
  }

  let host = trimmed;
  let portSpec = rawPort;

  const colonIdx = trimmed.lastIndexOf(":");
  if (colonIdx > 0 && !trimmed.includes("]")) {
    host = trimmed.slice(0, colonIdx);
    if (portSpec === undefined || portSpec === "") {
      portSpec = trimmed.slice(colonIdx + 1);
    }
  }

  if (host.length === 0) {
    throw new Error("Target host must not be empty");
  }

  return {
    targetHost: host,
    targetPort: parsePort(portSpec, "TARGET_PORT", false),
  };
}

export function parseProxyConfig(
  env = process.env,
  argv = process.argv.slice(2),
  allowZero = false,
) {
  let cliTarget;
  let cliListenPort;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--target" && i + 1 < argv.length) {
      cliTarget = argv[i + 1];
      i += 1;
    } else if (arg === "--port" && i + 1 < argv.length) {
      cliListenPort = argv[i + 1];
      i += 1;
    }
  }

  const { targetHost, targetPort } = parseTargetSpec(cliTarget ?? env.TARGET_HOST, env.TARGET_PORT);
  const listenPort = parsePort(
    cliListenPort ?? env.LISTEN_PORT ?? env.PORT,
    "LISTEN_PORT",
    allowZero,
  );

  return {
    listenHost: "127.0.0.1",
    listenPort,
    targetHost,
    targetPort,
  };
}

function buildUpgradeRequestHead(req) {
  const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/${req.httpVersion}`];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const key = req.rawHeaders[i];
    const value = req.rawHeaders[i + 1];
    if (key !== undefined && value !== undefined) {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("", "");
  return Buffer.from(lines.join("\r\n"), "latin1");
}

// Spec: docs/specs/09-deploy-infra.md#2.5
export function createPcProxyServer(config) {
  const server = http.createServer((req, res) => {
    const upstreamReq = http.request(
      {
        hostname: config.targetHost,
        port: config.targetPort,
        method: req.method,
        path: req.url ?? "/",
        headers: {
          ...req.headers,
          host: `${config.targetHost}:${config.targetPort}`,
        },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );

    upstreamReq.on("error", (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      }
      if (!res.writableEnded) {
        res.end(
          JSON.stringify({
            error: "Upstream connection failed",
            detail: error.message,
          }),
        );
      }
    });

    req.pipe(upstreamReq);
  });

  server.on("upgrade", (req, clientSocket, head) => {
    clientSocket.setNoDelay(true);
    const upstreamSocket = net.connect(config.targetPort, config.targetHost, () => {
      upstreamSocket.setNoDelay(true);
      upstreamSocket.write(buildUpgradeRequestHead(req));
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });

    const closeBoth = () => {
      if (!clientSocket.destroyed) {
        clientSocket.destroy();
      }
      if (!upstreamSocket.destroyed) {
        upstreamSocket.destroy();
      }
    };

    upstreamSocket.on("error", closeBoth);
    clientSocket.on("error", closeBoth);
    upstreamSocket.on("close", closeBoth);
    clientSocket.on("close", closeBoth);
  });

  return server;
}

const isDirectEntry =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectEntry) {
  const config = parseProxyConfig();
  const server = createPcProxyServer(config);

  server.listen(config.listenPort, config.listenHost, () => {
    console.log(
      `Tesroid local proxy listening on http://${config.listenHost}:${config.listenPort} -> ${config.targetHost}:${config.targetPort}`,
    );
  });

  const shutdown = () => {
    server.close(() => {
      process.exit(0);
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
