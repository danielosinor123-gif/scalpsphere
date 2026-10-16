#!/usr/bin/env node
/**
 * Frontend dev server — static files + a same-origin /api proxy.
 *
 *   node frontend/serve.mjs            → http://127.0.0.1:8080
 *   SS_PORT=9000 node frontend/serve.mjs
 *   SS_API_TARGET=http://127.0.0.1:4000 node frontend/serve.mjs
 *
 * WHY A PROXY
 * -----------
 * The backend uses httpOnly session cookies with SameSite=Strict. The cleanest
 * way to run the admin UI in development WITHOUT touching the backend is to
 * serve the static files and the API from the SAME origin, which is exactly
 * what this does: the browser talks only to this server, and /api/* is piped to
 * the backend. No CORS configuration, no cookie headaches.
 *
 * In production you do not need this file at all: point nginx (or any web
 * server) at the frontend/ directory and proxy /api to the backend — see
 * backend/docs/DEPLOYMENT_HOSTINGER.md section 3.8. This script is development
 * tooling only; it is intentionally dependency-free.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SS_PORT ?? 8080);
const HOST = process.env.SS_HOST ?? '127.0.0.1';
const API_TARGET = new URL(process.env.SS_API_TARGET ?? 'http://127.0.0.1:4000');

// Access log — dev tooling: lets you see whether a request from another device
// (e.g. a phone on the same WiFi) actually reaches this machine. That cleanly
// separates "traffic never arrived" (router isolation, wrong network, wrong
// URL) from "arrived but failed".
const LOG_DIR = path.join(HERE, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'access.log');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function logAccess(req) {
  const line = `${new Date().toISOString()}  ${req.socket.remoteAddress ?? '?'}  ${req.method}  ${req.url}\n`;
  fs.appendFile(LOG_FILE, line, () => {});
  // Echo remote (non-loopback) requests so a phone attempt is visible on stdout too.
  const remote = req.socket.remoteAddress ?? '';
  if (!remote.includes('127.0.0.1') && !remote.includes('::1')) {
    console.log(`[access] ${remote} ${req.method} ${req.url}`);
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...extra });
  res.end(body);
}

function serveStatic(req, res) {
  // Only GET/HEAD for static assets; everything else is a 405.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed');
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host ?? 'localhost'}`).pathname);
  } catch {
    return send(res, 400, 'Bad Request');
  }

  // Directory traversal guard: resolve inside frontend/ only.
  let filePath = path.normalize(path.join(HERE, urlPath === '/' ? 'index.html' : urlPath));
  if (!filePath.startsWith(HERE)) {
    return send(res, 403, 'Forbidden');
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    // SPA-ish fallback so /users deep links still land on the shell.
    filePath = path.join(HERE, 'index.html');
    if (!fs.existsSync(filePath)) return send(res, 404, 'Not Found');
  }

  const ext = path.extname(filePath).toLowerCase();
  const body = req.method === 'HEAD' ? undefined : fs.readFileSync(filePath);
  return send(res, 200, body, MIME[ext] ?? 'application/octet-stream', {
    'Cache-Control': 'no-store',
  });
}

function proxyApi(req, res) {
  const target = new URL(req.url, API_TARGET);

  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers['accept-encoding']; // avoid compressed bodies we do not decode

  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      path: target.pathname + target.search,
      method: req.method,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    // The backend is down. Answer with the same JSON envelope shape the backend
    // itself uses, so the UI's error handling shows one consistent message.
    if (!res.headersSent) {
      send(
        res,
        502,
        JSON.stringify({
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: `Cannot reach the API at ${API_TARGET.origin}. Is the backend running?`,
          },
        }),
        'application/json; charset=utf-8',
      );
    } else {
      res.end();
    }
    console.error(`[proxy] ${req.method} ${req.url} -> ${err.message}`);
  });

  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  if (req.url === '/__dev/ping') return send(res, 200, 'ok');
  if (req.url.startsWith('/api/')) return proxyApi(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`ScalpSphere admin UI  →  http://${HOST}:${PORT}`);
  console.log(`Proxying /api/*       →  ${API_TARGET.origin}`);
  console.log('Start the backend first:  cd backend && npm run dev');
});
