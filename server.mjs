#!/usr/bin/env node
/**
 * Skill Forge — 本地应用入口（零依赖）。
 *
 *   node server.mjs            # http://127.0.0.1:4318
 *   SKILL_FORGE_PORT=5000 node server.mjs
 *
 * 只监听回环地址；所有文件操作都发生在 ~/Documents/技能工坊 下。
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import {
  APP_NAME,
  APP_TITLE,
  APP_VERSION,
  DATA_DIR,
  EXPORTS_DIR,
  LIMITS,
  PUBLIC_DIR,
  ZIP_DIR,
  pathSummary,
} from './lib/config.js';
import { draftBlueprint } from './lib/draft.js';
import { importSkillPackage } from './lib/importer.js';
import { composePackage, previewPackage, readExportZip, writePackage } from './lib/package.js';
import { scanCatalog } from './lib/catalog.js';

const HOST = process.env.SKILL_FORGE_HOST || '127.0.0.1';
const BASE_PORT = Number(process.env.SKILL_FORGE_PORT || 4318);
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, status, value) {
  if (res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function errorPayload(error) {
  return {
    ok: false,
    code: error?.code || 'FORGE_ERROR',
    error: String(error?.message || error),
    details: error?.details || null,
  };
}

function sendFile(req, res, filePath) {
  const stat = statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-store',
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

function safeStaticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relative = decoded.replace(/^\/+/u, '');
  const absolute = path.join(PUBLIC_DIR, relative);
  const rel = path.relative(PUBLIC_DIR, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return absolute;
}

function loadSampleBlueprint() {
  const samplePath = path.join(PUBLIC_DIR, '..', 'samples', 'bundled-skill-studio.studio.json');
  try {
    const parsed = JSON.parse(readFileSync(samplePath, 'utf8'));
    return parsed?.blueprint || null;
  } catch {
    return null;
  }
}

function openInFinder(target) {
  const resolved = path.resolve(target);
  const allowed = [EXPORTS_DIR, ZIP_DIR, DATA_DIR].some((root) => {
    const rel = path.relative(root, resolved);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  if (!allowed) throw Object.assign(new Error('只能打开应用导出目录下的路径'), { status: 403 });
  if (!existsSync(resolved)) throw Object.assign(new Error('路径不存在'), { status: 404 });
  return new Promise((resolve, reject) => {
    execFile('open', [resolved], (error) => (error ? reject(error) : resolve(true)));
  });
}

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/^\/api/u, '').replace(/\/+$/u, '') || '/';
  const method = (req.method || 'GET').toUpperCase();

  if (method === 'GET' && (route === '/health' || route === '/meta')) {
    let catalog = null;
    try {
      catalog = scanCatalog({});
    } catch {
      catalog = null;
    }
    sendJson(res, 200, {
      ok: true,
      app: { name: APP_NAME, title: APP_TITLE, version: APP_VERSION, node: process.version },
      paths: pathSummary(),
      limits: {
        maxUploadFiles: LIMITS.maxUploadFiles,
        maxUploadFileBytes: LIMITS.maxUploadFileBytes,
        maxUploadTotalBytes: LIMITS.maxUploadTotalBytes,
        minDescription: LIMITS.minDescription,
        maxDescription: LIMITS.maxDescription,
      },
      skills: catalog
        ? catalog.roots.map((root) => ({
            id: root.id,
            dir: root.dir,
            exists: root.exists,
            count: root.count || 0,
          }))
        : [],
      sample: loadSampleBlueprint(),
      catalogSkills: catalog
        ? catalog.skills.filter((skill) => skill.valid).map((skill) => ({ name: skill.name, description: skill.description }))
        : [],
    });
    return;
  }

  if (method === 'GET' && route.startsWith('/download/')) {
    const buildId = decodeURIComponent(route.slice('/download/'.length));
    const found = readExportZip(buildId);
    if (!found) {
      sendJson(res, 404, { ok: false, error: '压缩包不存在或已过期' });
      return;
    }
    const skillName = buildId.replace(/-\d{8}-\d{6}-[a-z0-9]+$/u, '') || 'skill';
    const asciiName = `${skillName.replace(/[^A-Za-z0-9._-]/gu, '-')}.zip`;
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': found.size,
      'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(`${skillName}.zip`)}`,
      'cache-control': 'no-store',
    });
    createReadStream(found.zipPath).pipe(res);
    return;
  }

  if (method !== 'POST') {
    sendJson(res, 405, { ok: false, error: `不支持的请求：${method} ${url.pathname}` });
    return;
  }

  const body = await readBody(req);

  if (route === '/draft') {
    const result = draftBlueprint(body);
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  if (route === '/import') {
    let result;
    try {
      result = importSkillPackage(body.files);
    } catch (error) {
      result = { ok: false, error: String(error?.message || error) };
    }
    sendJson(res, result.ok ? 200 : 400, { ...result });
    return;
  }

  if (route === '/preview') {
    const pkg = await previewPackage(body, { validate: body.validate === true });
    const payload = {
      ok: pkg.ok,
      errors: pkg.errors,
      warnings: pkg.warnings,
      blueprint: pkg.blueprint,
      files: pkg.files,
      stats: pkg.stats,
      skillMarkdown: pkg.skillMarkdown,
      validation: pkg.validation,
    };
    sendJson(res, pkg.ok ? 200 : 422, payload);
    return;
  }

  if (route === '/build') {
    const pkg = composePackage(body);
    if (!pkg.ok) {
      sendJson(res, 422, { ok: false, errors: pkg.errors, warnings: pkg.warnings, blueprint: pkg.blueprint });
      return;
    }
    const saved = await writePackage(pkg);
    sendJson(res, 200, { ok: true, ...saved, warnings: [...pkg.warnings, ...(saved.validation?.warnings || [])] });
    return;
  }

  if (route === '/open') {
    const opened = await openInFinder(String(body.path || ''));
    sendJson(res, 200, { ok: opened });
    return;
  }

  sendJson(res, 404, { ok: false, error: `未知接口：${route}` });
}

function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${HOST}`);
    try {
      if (url.pathname.startsWith('/api/') || url.pathname === '/api') {
        await handleApi(req, res, url);
        return;
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        sendFile(req, res, path.join(PUBLIC_DIR, 'index.html'));
        return;
      }
      if (url.pathname === '/favicon.ico') {
        for (const name of ['favicon.ico', 'favicon.png', 'favicon.svg']) {
          const icon = path.join(PUBLIC_DIR, name);
          if (existsSync(icon)) {
            sendFile(req, res, icon);
            return;
          }
        }
        res.writeHead(204);
        res.end();
        return;
      }
      const staticPath = safeStaticPath(url.pathname);
      if (staticPath && existsSync(staticPath) && statSync(staticPath).isFile()) {
        sendFile(req, res, staticPath);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (error) {
      const status = error?.status || 500;
      if (!res.headersSent) sendJson(res, status, errorPayload(error));
      else res.end();
    }
  });
}

function listenWithFallback(port, attempt = 0) {
  const server = createApp();
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && attempt < 12) {
      listenWithFallback(port + 1, attempt + 1);
      return;
    }
    console.error(`[skill-forge] 启动失败：${error.message}`);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    mkdirSync(EXPORTS_DIR, { recursive: true });
    mkdirSync(ZIP_DIR, { recursive: true });
    console.log(`\n  ${APP_NAME} · ${APP_TITLE}  v${APP_VERSION}`);
    console.log(`  → http://${HOST}:${port}`);
    console.log(`  导出目录：${EXPORTS_DIR}\n`);
  });
}

listenWithFallback(BASE_PORT);
