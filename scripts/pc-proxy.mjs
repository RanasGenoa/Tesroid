import http from 'node:http';
import net from 'node:net';

const TARGET_HOST = process.env.TARGET_HOST || '127.0.0.1';
const TARGET_PORT = parseInt(process.env.TARGET_PORT || '9001', 10);
const LISTEN_PORT = parseInt(process.env.LISTEN_PORT || '9001', 10);

const server = http.createServer((req, res) => {
  const options = {
    host: TARGET_HOST,
    port: TARGET_PORT,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${TARGET_HOST}:${TARGET_PORT}`,
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('[PC-Proxy] Request error:', err.message);
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Proxy connection error to target host (${TARGET_HOST}:${TARGET_PORT}): ${err.message}`);
  });

  req.pipe(proxyReq);
});

server.on('upgrade', (req, clientSocket, head) => {
  const targetSocket = net.connect(TARGET_PORT, TARGET_HOST, () => {
    targetSocket.write(
      `${req.method} ${req.url} HTTP/1.1\r\n` +
      Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n') +
      '\r\n\r\n'
    );
    if (head && head.length > 0) {
      targetSocket.write(head);
    }
    clientSocket.pipe(targetSocket).pipe(clientSocket);
  });

  targetSocket.on('error', (err) => {
    console.warn('[PC-Proxy] WebSocket upgrade error:', err.message);
    clientSocket.destroy();
  });

  clientSocket.on('error', () => {
    targetSocket.destroy();
  });
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log('========================================================');
  console.log(`🚀 Tesroid PC Test Proxy running at http://localhost:${LISTEN_PORT}`);
  console.log(`🔗 Forwarding all traffic to target server (http://${TARGET_HOST}:${TARGET_PORT})`);
  console.log('🔒 Chrome will treat http://localhost as a Secure Context!');
  console.log('========================================================');
});
