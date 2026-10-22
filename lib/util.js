/**
 * Skill Studio — 通用工具：摘要、目录复制、可复现归一化、串行锁。
 *
 * 这些函数不依赖 Cordis，也不读插件状态，因此可以在单元测试里直接使用。
 */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_SCAN_FILES = 500;

export function sha256Text(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 对目录内容做稳定摘要：按相对路径排序，混合路径与内容。 */
export function digestDir(dir) {
  if (!existsSync(dir)) return null;
  const files = walkFiles(dir)
    .map((file) => path.relative(dir, file).split(path.sep).join('/'))
    .sort();
  const hash = createHash('sha256');
  for (const rel of files) {
    const absolute = path.join(dir, rel);
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(absolute));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** 列出目录下的普通文件（不跟随符号链接目录），深度受限。 */
export function walkFiles(root, { maxFiles = MAX_SCAN_FILES, depth = 6 } = {}) {
  const out = [];
  const visit = (dir, level) => {
    if (level > depth || out.length >= maxFiles) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        visit(absolute, level + 1);
      } else if (entry.isFile()) {
        out.push(absolute);
      }
    }
  };
  visit(root, 0);
  return out;
}

export function readTextSafe(file, maxBytes = MAX_FILE_BYTES) {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buffer = readFileSync(file);
    if (buffer.includes(0)) return null;
    return buffer.toString('utf8');
  } catch {
    return null;
  }
}

/** 原子写入文本：先写临时文件，再 rename 覆盖目标。 */
export function writeFileAtomic(file, content, { mode } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  if (mode === undefined) writeFileSync(temp, content, 'utf8');
  else writeFileSync(temp, content, { encoding: 'utf8', mode });
  try {
    renameSync(temp, file);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      /* ignore */
    }
    throw error;
  }
}

/** 原子写入 JSON。 */
export function writeJson(file, value) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function copyDir(from, to) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, {
    recursive: true,
    dereference: false,
    filter: (source) => {
      const base = path.basename(source);
      return base !== 'node_modules' && base !== '.git';
    },
  });
}

export function removeDir(target) {
  rmSync(target, { recursive: true, force: true });
}

/** 把一次输出里的临时路径、时间戳归一化，便于二次运行比较。 */
export function normalizeOutput(text, { skillDir, extraDirs = [] } = {}) {
  let out = String(text ?? '');
  const dirs = [skillDir, ...extraDirs].filter(Boolean);
  for (const dir of dirs) {
    const escaped = String(dir).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    out = out.replace(new RegExp(escaped, 'gu'), '<SKILL_DIR>');
  }
  out = out.replace(/\/tmp\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*/gu, '<TMP>');
  out = out.replace(/\/private\/var\/[^\s"'`]+/gu, '<TMP>');
  out = out.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/gu, '<TIME>');
  out = out.replace(/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\b/gu, '<TIME>');
  out = out.replace(/\bpid[=: ]\d+\b/giu, 'pid=<PID>');
  return out.replace(/\s+$/u, '');
}

export function timeIso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

export function truncate(text, limit = 4000) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…（已截断 ${value.length - limit} 字符）`;
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
}

export function asString(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return fallback;
  return String(value);
}

export function asStringArray(value) {
  if (Array.isArray(value)) return value.map((item) => asString(item).trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/\r?\n|；|;/u)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

/** 按 key 串行执行异步任务，避免同一技能的测试/发布相互踩踏。 */
const locks = new Map();

export async function withLock(key, task) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  locks.set(key, previous.then(() => current));
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

export function safeFileStem(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'skill';
}

export function randomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
