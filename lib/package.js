/**
 * Skill Forge — 打包核心：蓝图 + 上传资料 → 技能包文件集合。
 *
 * 与技能工坊插件保持同一产物结构：
 *   SKILL.md / scripts/* / references/* / assets/* / tests/skill.test.json / studio.json
 *
 * 上传的资料按角色落位：
 *   script    → scripts/<basename>
 *   reference → references/<basename>
 *   asset     → assets/<basename>
 *   test      → tests/<basename>
 * 同名文件以上传内容为准；剩余资源由蓝图生成器补模板。
 */
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateSkillFiles, normalizeBlueprint } from './blueprint.js';
import { scanCatalog } from './catalog.js';
import { EXPORTS_DIR, LIMITS, TMP_DIR, ZIP_DIR } from './config.js';
import { validateSkill } from './validator.js';
import { createZip } from './zip.js';
import { randomId, sha256Bytes } from './util.js';

export const TEXT_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.json', '.jsonc', '.yaml', '.yml', '.js', '.mjs', '.cjs', '.ts',
  '.py', '.sh', '.bash', '.zsh', '.css', '.html', '.htm', '.csv', '.tsv', '.xml', '.toml',
  '.ini', '.cfg', '.conf', '.log', '.env', '.sql', '.rb', '.go', '.rs', '.java', '.kt',
  '.swift', '.lua', '.php', '.vue', '.jsx', '.tsx', '.gitignore', '.dockerfile',
]);

export const SCRIPT_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.py', '.sh', '.bash', '.zsh', '.rb', '.go', '.rs', '.lua', '.php']);
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp', '.ico']);

export function extensionOf(name) {
  const base = path.basename(String(name || ''));
  const index = base.lastIndexOf('.');
  return index > 0 ? base.slice(index).toLowerCase() : '';
}

export function isTextFile(name, buffer) {
  if (TEXT_EXTENSIONS.has(extensionOf(name))) return true;
  if (IMAGE_EXTENSIONS.has(extensionOf(name))) return false;
  if (!buffer || buffer.length === 0) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const byte of sample) {
    if (byte === 0) return false;
  }
  return true;
}

/** 只保留文件名，去掉路径与危险字符。 */
export function safeBaseName(name) {
  const base = String(name || '')
    .replace(/\\/gu, '/')
    .split('/')
    .pop()
    .replace(/[\u0000-\u001f<>:"|?*]/gu, '-')
    .replace(/\s+/gu, '-')
    .replace(/^[.\-]+/u, '')
    .trim();
  return base || `file-${randomId()}`;
}

function uniqueName(name, used) {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const ext = extensionOf(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let index = 2;
  while (used.has(`${stem}-${index}${ext}`)) index += 1;
  const next = `${stem}-${index}${ext}`;
  used.add(next);
  return next;
}

export function classifyRole(name, explicit) {
  const allowed = ['script', 'reference', 'asset', 'test'];
  if (allowed.includes(explicit)) return explicit;
  const ext = extensionOf(name);
  if (SCRIPT_EXTENSIONS.has(ext)) return 'script';
  if (['.md', '.mdx', '.txt', '.json', '.yaml', '.yml', '.csv', '.tsv', '.xml', '.pdf'].includes(ext)) return 'reference';
  return 'asset';
}

/** 输入上传项 → 可写文件。支持 {b64} 或 {text}。 */
export function decodeUpload(item) {
  if (!item || typeof item !== 'object') return null;
  const name = safeBaseName(item.name || item.path || 'file');
  let buffer;
  if (typeof item.text === 'string' && item.encoding !== 'base64') {
    buffer = Buffer.from(item.text, 'utf8');
  } else if (typeof item.b64 === 'string' || typeof item.data === 'string') {
    const raw = item.b64 || item.data;
    try {
      buffer = Buffer.from(raw, 'base64');
    } catch {
      buffer = Buffer.from(String(raw), 'utf8');
    }
  } else {
    buffer = Buffer.alloc(0);
  }
  const role = classifyRole(name, item.role);
  return {
    name,
    role,
    buffer,
    bytes: buffer.length,
    text: isTextFile(name, buffer) ? buffer.toString('utf8') : null,
    binary: !isTextFile(name, buffer),
  };
}

export const ROLE_DIR = { script: 'scripts', reference: 'references', asset: 'assets', test: 'tests' };
export const ROLE_KIND = { script: 'script', reference: 'reference', asset: 'asset', test: 'test' };

export function targetForRole(role, name, used) {
  return `${ROLE_DIR[role]}/${uniqueName(name, used)}`;
}

function collectResources(uploads) {
  const resources = { scripts: [], references: [], assets: [], tests: [] };
  const used = new Set();
  const placed = uploads.map((upload) => {
    const target = targetForRole(upload.role, upload.name, used);
    const relative = target.slice(target.indexOf('/') + 1);
    if (upload.role === 'script') resources.scripts.push(relative);
    else if (upload.role === 'reference') resources.references.push(relative);
    else if (upload.role === 'asset') resources.assets.push(relative);
    else resources.tests.push(relative);
    return { ...upload, target };
  });
  return { placed, resources };
}

function fileKind(relativePath) {
  if (relativePath === 'SKILL.md') return 'doc';
  if (relativePath === 'studio.json') return 'manifest';
  if (relativePath.startsWith('scripts/')) return 'script';
  if (relativePath.startsWith('references/')) return 'reference';
  if (relativePath.startsWith('assets/')) return 'asset';
  if (relativePath.startsWith('tests/')) return 'test';
  return 'other';
}

function isExecutableScript(relativePath, buffer) {
  return relativePath.startsWith('scripts/') && buffer.subarray(0, 2).toString('utf8') === '#!';
}

function serializeFile(relativePath, buffer) {
  const text = isTextFile(relativePath, buffer) ? buffer.toString('utf8') : null;
  return {
    path: relativePath,
    bytes: buffer.length,
    kind: fileKind(relativePath),
    sha256: sha256Bytes(buffer),
    binary: text === null,
    text: text !== null && buffer.length <= 512 * 1024 ? text : null,
    executable: isExecutableScript(relativePath, buffer),
  };
}

function normalizeOptions(options) {
  const raw = options && typeof options === 'object' ? options : {};
  return {
    generateScript: raw.generateScript !== false,
    note: typeof raw.note === 'string' ? raw.note.slice(0, 500) : '',
  };
}

/**
 * 组装技能包（纯内存，不落盘）。
 * @returns {{ok: boolean, errors: Array, warnings: Array, blueprint: object, files: Array, buffers: Map, skillMarkdown: string, stats: object}}
 */
export function composePackage(input = {}) {
  const errors = [];
  const warnings = [];
  const options = normalizeOptions(input.options);
  const rawFiles = Array.isArray(input.files) ? input.files : [];
  if (rawFiles.length > LIMITS.maxUploadFiles) {
    errors.push({ code: 'UP001', level: 'error', message: `资料文件超过上限（${LIMITS.maxUploadFiles} 个）` });
  }
  const decoded = rawFiles.map(decodeUpload).filter(Boolean);
  const totalBytes = decoded.reduce((sum, item) => sum + item.bytes, 0);
  if (totalBytes > LIMITS.maxUploadTotalBytes) {
    errors.push({ code: 'UP002', level: 'error', message: `资料总大小超过上限（${Math.round(LIMITS.maxUploadTotalBytes / 1024 / 1024)} MB）` });
  }
  const bigFile = decoded.find((item) => item.bytes > LIMITS.maxUploadFileBytes);
  if (bigFile) {
    errors.push({ code: 'UP003', level: 'error', message: `单个文件超过上限：${bigFile.name}` });
  }

  const { placed, resources } = collectResources(decoded);
  const rawBlueprint = input.blueprint && typeof input.blueprint === 'object' ? input.blueprint : {};
  const scriptName = resources.scripts[0] || rawBlueprint.scriptName || `${rawBlueprint.name || 'skill'}.mjs`;
  const bpInput = {
    ...rawBlueprint,
    scriptName,
    resources: {
      scripts: [...resources.scripts],
      references: [...resources.references],
      assets: [...resources.assets],
    },
  };

  if (options.generateScript && resources.scripts.length === 0) {
    bpInput.resources.scripts.push(scriptName);
  }

  const normalized = normalizeBlueprint(bpInput);
  errors.push(...normalized.errors);
  warnings.push(...normalized.warnings);
  const blueprint = normalized.blueprint;
  if (errors.length) {
    return { ok: false, errors, warnings, blueprint, files: [], buffers: new Map(), skillMarkdown: '', stats: null };
  }

  const buffers = new Map();
  for (const [filePath, content] of generateSkillFiles(blueprint)) {
    buffers.set(filePath, Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'));
  }

  // 上传资料覆盖模板；自定义测试规格直接替换
  let customTest = false;
  for (const upload of placed) {
    buffers.set(upload.target, upload.buffer);
    if (upload.role === 'test' && upload.target.endsWith('skill.test.json')) customTest = true;
  }

  // 用户自带脚本时，不臆造命令行用例（参数只有作者知道），保留触发用例。
  if (resources.scripts.length > 0 && !customTest) {
    const specPath = 'tests/skill.test.json';
    try {
      const spec = JSON.parse(buffers.get(specPath)?.toString('utf8') || '{}');
      spec.commands = [];
      spec.notes = [...(Array.isArray(spec.notes) ? spec.notes : []), '检测到作者自带脚本：命令用例需按脚本真实参数补充。'];
      buffers.set(specPath, Buffer.from(`${JSON.stringify(spec, null, 2)}\n`, 'utf8'));
      warnings.push({ code: 'PKG001', level: 'warn', message: '已保留作者自带脚本，测试规格未自动生成命令用例（需按真实参数补充）' });
    } catch {
      /* 生成器输出的 JSON 必定合法，忽略 */
    }
  }
  if (customTest) {
    warnings.push({ code: 'PKG002', level: 'warn', message: '使用了作者提供的测试规格，触发/命令用例以文件为准' });
  }

  // SKILL.md 引用的 assets 已经由 blueprint.renderSkillBody 写入；这里只确保文件数统计一致。
  const files = [...buffers.entries()]
    .map(([filePath, buffer]) => serializeFile(filePath, buffer))
    .sort((a, b) => a.path.localeCompare(b.path));
  const stats = {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    scripts: files.filter((file) => file.kind === 'script').length,
    references: files.filter((file) => file.kind === 'reference').length,
    assets: files.filter((file) => file.kind === 'asset').length,
    tests: files.filter((file) => file.kind === 'test').length,
    uploads: placed.length,
    customFiles: placed.map((upload) => ({ name: upload.name, role: upload.role, target: upload.target, bytes: upload.bytes })),
  };
  return {
    ok: true,
    errors: [],
    warnings,
    blueprint,
    files,
    buffers,
    skillMarkdown: buffers.get('SKILL.md')?.toString('utf8') || '',
    stats,
  };
}

function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** 落盘到导出目录，校验并生成 zip。 */
export async function writePackage(pkg, { date = new Date() } = {}) {
  if (!pkg?.ok) throw new Error('技能包未通过组装，不能落盘');
  ensureDir(EXPORTS_DIR);
  ensureDir(ZIP_DIR);
  const safeName = safeBaseName(pkg.blueprint.name);
  const buildId = `${safeName}-${timestamp(date)}-${randomId().replace(/[^a-z0-9]/gu, '')}`;
  const dir = path.join(EXPORTS_DIR, buildId);
  ensureDir(dir);

  for (const [relativePath, buffer] of pkg.buffers) {
    const absolute = path.join(dir, relativePath);
    if (!isInside(dir, absolute)) continue;
    ensureDir(path.dirname(absolute));
    writeFileSync(absolute, buffer, { mode: isExecutableScript(relativePath, buffer) ? 0o755 : 0o644 });
  }

  let catalog = null;
  try {
    catalog = scanCatalog({});
  } catch {
    catalog = null;
  }
  let validation;
  try {
    validation = await validateSkill(dir, {
      catalog,
      expectedName: pkg.blueprint.name,
      studioManaged: true,
    });
  } catch (error) {
    validation = {
      ok: false,
      name: pkg.blueprint.name,
      path: dir,
      errors: [{ code: 'VAL500', level: 'error', message: `校验器异常：${error.message}` }],
      warnings: [],
      stats: pkg.stats,
      summary: '校验器异常',
    };
  }

  const zipBuffer = createZip(
    [...pkg.buffers.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([relativePath, buffer]) => ({
        name: `${pkg.blueprint.name}/${relativePath}`,
        data: buffer,
        date,
        executable: isExecutableScript(relativePath, buffer),
      })),
  );
  const zipPath = path.join(ZIP_DIR, `${buildId}.zip`);
  writeFileSync(zipPath, zipBuffer);

  return {
    buildId,
    dir,
    zipPath,
    zipName: `${pkg.blueprint.name}.zip`,
    zipBytes: zipBuffer.length,
    zipUrl: `/api/download/${encodeURIComponent(buildId)}`,
    validation,
    files: pkg.files,
    stats: pkg.stats,
  };
}

/** 预览：可选写入临时目录做真实校验（node --check 等），随后清理。 */
export async function previewPackage(input, { validate = false } = {}) {
  const pkg = composePackage(input);
  if (!pkg.ok) return { ...pkg, validation: null };
  if (!validate) return { ...pkg, validation: null };

  ensureDir(TMP_DIR);
  const dir = path.join(TMP_DIR, `preview-${randomId()}`);
  ensureDir(dir);
  try {
    for (const [relativePath, buffer] of pkg.buffers) {
      const absolute = path.join(dir, relativePath);
      ensureDir(path.dirname(absolute));
      writeFileSync(absolute, buffer, { mode: isExecutableScript(relativePath, buffer) ? 0o755 : 0o644 });
    }
    let catalog = null;
    try {
      catalog = scanCatalog({});
    } catch {
      catalog = null;
    }
    const validation = await validateSkill(dir, {
      catalog,
      expectedName: pkg.blueprint.name,
      studioManaged: true,
    });
    return { ...pkg, validation };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function readExportZip(buildId) {
  if (!/^[A-Za-z0-9._-]+$/u.test(buildId)) return null;
  const zipPath = path.join(ZIP_DIR, `${buildId}.zip`);
  if (!isInside(ZIP_DIR, zipPath) || !existsSync(zipPath)) return null;
  return { zipPath, size: statSync(zipPath).size };
}
