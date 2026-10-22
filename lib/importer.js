/**
 * Skill Forge — 导入已有技能包。
 *
 * 用户把现成的技能目录（含 SKILL.md）拖进来时：
 *   1. 落一份到临时目录；
 *   2. 复用技能工坊的 readBlueprintFromSkill（优先 studio.json，其次解析 SKILL.md）；
 *   3. 把资源文件读回内存，作为「资料」继续在应用里编辑与重新打包。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeBlueprint, readBlueprintFromSkill } from './blueprint.js';
import { TMP_DIR } from './config.js';
import { classifyRole, decodeUpload, safeBaseName } from './package.js';

function normalizeRel(value) {
  return String(value || '')
    .replace(/\\/gu, '/')
    .replace(/^\/+/u, '')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

function stripSharedRoot(entries) {
  if (entries.length < 2) return entries;
  const firsts = new Set(entries.map((entry) => entry.rel.split('/')[0]));
  if (firsts.size !== 1) return entries;
  const [root] = firsts;
  if (!entries.every((entry) => entry.rel.includes('/'))) return entries;
  if (root === 'scripts' || root === 'references' || root === 'assets' || root === 'tests') return entries;
  return entries.map((entry) => ({ ...entry, rel: entry.rel.split('/').slice(1).join('/') }));
}

function roleForRelative(relative) {
  if (relative.startsWith('scripts/')) return 'script';
  if (relative.startsWith('references/')) return 'reference';
  if (relative.startsWith('assets/')) return 'asset';
  if (relative.startsWith('tests/')) return 'test';
  if (/^SKILL\.md$/iu.test(relative) || /^studio\.json$/iu.test(relative)) return 'skip';
  return classifyRole(path.basename(relative), undefined);
}

/**
 * @param {Array<{name?: string, path?: string, b64?: string, text?: string}>} files
 */
export function importSkillPackage(files) {
  const source = Array.isArray(files) ? files : [];
  const rawEntries = source
    .map((item) => {
      const decoded = decodeUpload(item);
      if (!decoded) return null;
      const rel = normalizeRel(item.path || item.name || decoded.name) || safeBaseName(decoded.name);
      return { ...decoded, rel };
    })
    .filter(Boolean);
  if (rawEntries.length === 0) return { ok: false, error: '没有收到文件' };

  const entries = stripSharedRoot(rawEntries);
  const skillEntry = entries.find((entry) => /^SKILL\.md$/iu.test(entry.rel));
  if (!skillEntry) {
    return {
      ok: false,
      error: '没有找到 SKILL.md。请把技能目录（含 SKILL.md）整体拖进来，或先手动填写蓝图。',
      files: entries.map((entry) => ({ name: entry.name, path: entry.rel })),
    };
  }

  mkdirSync(TMP_DIR, { recursive: true });
  const dir = mkdtempSync(path.join(TMP_DIR, 'import-'));
  try {
    for (const entry of entries) {
      const absolute = path.join(dir, entry.rel);
      const relative = path.relative(dir, absolute);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, entry.buffer);
    }
    const restored = readBlueprintFromSkill(dir);
    let blueprint = restored.blueprint || null;
    let issues = restored.issues || [];
    if (blueprint) {
      const normalized = normalizeBlueprint(blueprint);
      blueprint = normalized.blueprint;
      const merged = [...issues, ...normalized.errors];
      issues = [...new Map(merged.map((item) => [`${item.code}|${item.field || ''}|${item.message}`, item])).values()];
    }
    const uploads = entries
      .map((entry) => {
        const role = roleForRelative(entry.rel);
        if (role === 'skip') return null;
        return {
          name: entry.name,
          path: entry.rel,
          role,
          bytes: entry.bytes,
          binary: entry.binary,
          b64: entry.buffer.toString('base64'),
        };
      })
      .filter(Boolean);
    return {
      ok: Boolean(restored.ok),
      error: restored.ok ? '' : restored.error || '解析 SKILL.md 失败',
      blueprint,
      derived: Boolean(restored.derived),
      issues,
      uploads,
      skillMarkdown: entries.find((entry) => entry.rel === skillEntry.rel)?.buffer.toString('utf8') || '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
