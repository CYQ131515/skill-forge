/**
 * Skill Studio — 技能仓库扫描。
 *
 * 与 @deepseek-ai/dsh-skill-filesystem 的发现规则保持一致：
 *   <root>/<name>/SKILL.md 或 <root>/<name>.md，只扫一层。
 * 同名的候选按 root rank 排序，rank 小者胜出；落选者记录为 shadowed。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { catalogRoots } from './config.js';
import { parseFrontmatter } from './frontmatter.js';

const MAX_SKILLS_PER_ROOT = 500;

function readDirEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** 读取单个技能目录（bundle）或平铺 .md 文件。 */
export function readSkillAt(targetPath) {
  const skillFile = targetPath.endsWith('.md') ? targetPath : path.join(targetPath, 'SKILL.md');
  let text;
  try {
    const stat = statSync(skillFile);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('SKILL.md 不存在或过大');
    text = readFileSync(skillFile, 'utf8');
  } catch (error) {
    return { ok: false, error: String(error?.message || error), skillFile };
  }
  const parsed = parseFrontmatter(text);
  if (!parsed.ok) return { ok: false, error: parsed.error, skillFile, text };
  const fm = parsed.data || {};
  const name = typeof fm.name === 'string' ? fm.name.trim() : '';
  const description = typeof fm.description === 'string' ? fm.description.trim() : '';
  if (!name) return { ok: false, error: 'frontmatter 缺少 name', skillFile, text, frontmatter: fm, body: parsed.body };
  if (!description) {
    return { ok: false, error: 'frontmatter 缺少 description', skillFile, text, frontmatter: fm, body: parsed.body };
  }
  return {
    ok: true,
    name,
    description,
    whenToUse: typeof fm.whenToUse === 'string' ? fm.whenToUse.trim() : '',
    metadata: fm.metadata && typeof fm.metadata === 'object' ? fm.metadata : {},
    frontmatter: fm,
    body: parsed.body,
    text,
    skillFile,
    dir: targetPath.endsWith('.md') ? path.dirname(targetPath) : targetPath,
  };
}

/** 找到一个技能的目录（有目录包优先，其次平铺文件）。 */
export function locateSkill(name, roots) {
  for (const root of roots) {
    const bundle = path.join(root.dir, name);
    if (existsSync(path.join(bundle, 'SKILL.md'))) return { ...root, kind: 'bundle', path: bundle };
    const flat = path.join(root.dir, `${name}.md`);
    if (existsSync(flat)) return { ...root, kind: 'file', path: flat };
  }
  return null;
}

export function discoverRoot(root) {
  const candidates = [];
  if (!root?.dir) return { root: { ...root, exists: false }, candidates };
  let entries;
  try {
    if (!statSync(root.dir).isDirectory()) return { root: { ...root, exists: false }, candidates };
    entries = readDirEntries(root.dir);
  } catch {
    return { root: { ...root, exists: false }, candidates };
  }
  for (const entry of entries) {
    if (candidates.length >= MAX_SKILLS_PER_ROOT) break;
    let target = null;
    if (entry.isDirectory()) {
      const skillFile = path.join(root.dir, entry.name, 'SKILL.md');
      if (existsSync(skillFile)) target = path.join(root.dir, entry.name);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      target = path.join(root.dir, entry.name);
    }
    if (!target) continue;
    const parsed = readSkillAt(target);
    if (!parsed.ok) {
      candidates.push({
        name: path.basename(target).replace(/\.md$/u, ''),
        description: '',
        valid: false,
        error: parsed.error,
        path: target,
        rootId: root.id,
        source: root.source,
        rank: root.rank,
      });
      continue;
    }
    const dirName = entry.isDirectory() ? entry.name : entry.name.replace(/\.md$/u, '');
    candidates.push({
      name: parsed.name,
      description: parsed.description,
      whenToUse: parsed.whenToUse,
      metadata: parsed.metadata,
      valid: true,
      path: target,
      dirName,
      nameMismatch: dirName !== parsed.name,
      rootId: root.id,
      source: root.source,
      rank: root.rank,
      body: parsed.body,
      text: parsed.text,
    });
  }
  return { root: { ...root, exists: true, count: candidates.length }, candidates };
}

/** 扫描所有根，返回按 rank 去重后的目录。 */
export function scanCatalog({ projectRoot, userRoot } = {}) {
  const roots = catalogRoots({ projectRoot, userRoot });
  const rootViews = [];
  const byName = new Map();
  const warnings = [];
  for (const root of roots) {
    const { root: view, candidates } = discoverRoot(root);
    rootViews.push(view);
    for (const candidate of candidates) {
      const existing = byName.get(candidate.name);
      if (!existing) {
        byName.set(candidate.name, { ...candidate, shadowed: [] });
      } else if (candidate.rank < existing.rank) {
        byName.set(candidate.name, { ...candidate, shadowed: [...existing.shadowed, pick(existing)] });
      } else {
        existing.shadowed.push(pick(candidate));
      }
      if (candidate.valid && candidate.nameMismatch) {
        warnings.push({ code: 'CAT001', message: `目录名 ${candidate.dirName} 与 frontmatter name ${candidate.name} 不一致` });
      }
    }
  }
  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { skills, roots: rootViews, warnings };
}

function pick(candidate) {
  return {
    name: candidate.name,
    path: candidate.path,
    rootId: candidate.rootId,
    source: candidate.source,
    rank: candidate.rank,
    valid: candidate.valid,
    error: candidate.error,
  };
}

/**
 * 构造供路由/测试使用的技能列表：仓库扫描结果 + 可选的覆盖项
 * （例如暂存区里尚未发布的技能）。覆盖项按同名替换。
 */
export function buildRoutingSkills({ projectRoot, userRoot, extraSkill } = {}) {
  const scanned = scanCatalog({ projectRoot, userRoot });
  const list = scanned.skills
    .filter((skill) => skill.valid)
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse || '',
      metadata: skill.metadata || {},
      source: skill.source,
      rank: skill.rank,
    }));
  if (extraSkill?.name) {
    const index = list.findIndex((item) => item.name === extraSkill.name);
    const entry = {
      name: extraSkill.name,
      description: extraSkill.description || '',
      whenToUse: extraSkill.whenToUse || '',
      metadata: extraSkill.metadata || {},
      source: extraSkill.source || 'staged',
      rank: extraSkill.rank ?? 0,
    };
    if (index >= 0) list[index] = entry;
    else list.push(entry);
  }
  return { skills: list, catalog: scanned };
}

/** 从技能目录读取 body（用于校验）。 */
export function readSkillBody(skillDir) {
  const skillFile = path.join(skillDir, 'SKILL.md');
  try {
    return readFileSync(skillFile, 'utf8');
  } catch {
    return null;
  }
}
