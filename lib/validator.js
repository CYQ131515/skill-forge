/**
 * Skill Studio — SKILL.md 与资源校验。
 *
 * 校验的是“可上线契约”，不是文风：
 *   frontmatter → 章节 → 输入输出 → 权限/环境变量 → 步骤 → 错误码/超时 →
 *   资源引用 → 脚本语法 → 密钥泄露 → 与现有技能的重叠 → 测试规格。
 * 每条问题都有稳定错误码，页面与工具都按错误码展示。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { CATALOG_DESCRIPTION_MAX, LIMITS } from './config.js';
import { findSecretLiterals } from './blueprint.js';
import { isSkillName, parseFrontmatter } from './frontmatter.js';
import { descriptionQuality, descriptionSimilarity } from './router.js';
import { readTextSafe, walkFiles } from './util.js';

const SECTION_SPECS = [
  { key: 'whenToUse', label: '适用场景', aliases: ['适用场景', '何时使用', 'When to use'], required: true },
  { key: 'boundary', label: '能力边界', aliases: ['能力边界', 'Capability boundary', 'Boundary'], required: false },
  { key: 'io', label: '输入与输出', aliases: ['输入与输出', '输入输出', 'Inputs and outputs', 'Input/Output'], required: true },
  { key: 'permissions', label: '权限与环境变量', aliases: ['权限与环境变量', '权限', 'Permissions'], required: true },
  { key: 'steps', label: '执行步骤', aliases: ['执行步骤', '步骤', 'Steps', 'Workflow'], required: true },
  { key: 'errors', label: '错误码与异常处理', aliases: ['错误码与异常处理', '错误处理', 'Errors', 'Error handling'], required: true },
  { key: 'verification', label: '验收与复现', aliases: ['验收与复现', '验收', 'Verification'], required: false },
];

const TIMEOUT_RE = /(超时|timeout|time out|deadline)/iu;
const STEPS_RE = /^###\s*\d+[.、]\s*\S+/gmu;

function sectionMap(body) {
  const map = new Map();
  const headings = [];
  const regex = /^(#{2,3})\s+(.+?)\s*$/gmu;
  let match;
  while ((match = regex.exec(body)) !== null) {
    headings.push({ level: match[1].length, title: match[2].trim(), index: match.index });
  }
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i];
    if (heading.level !== 2) continue;
    const start = heading.index;
    const end = headings.slice(i + 1).find((next) => next.level <= 2)?.index ?? body.length;
    map.set(heading.title, body.slice(start, end));
  }
  return map;
}

function findSection(map, spec) {
  for (const [title, content] of map) {
    if (spec.aliases.some((alias) => title.toLowerCase() === alias.toLowerCase() || title.includes(alias))) {
      return content;
    }
  }
  return '';
}

function isSectionEmpty(content) {
  const stripped = String(content || '')
    .split('\n')
    .slice(1)
    .join('\n')
    .replace(/```[\s\S]*?```/gu, '')
    .replace(/[#>*`\-\s|:：]/gu, '');
  return stripped.length < 8;
}

function collectEnvUsage(text) {
  const names = new Set();
  for (const match of String(text || '').matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/gu)) names.add(match[1]);
  for (const match of String(text || '').matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]/gu)) names.add(match[1]);
  for (const match of String(text || '').matchAll(/os\.environ(?:\.get)?[\[(]\s*['"]([A-Z][A-Z0-9_]+)['"]/gu)) names.add(match[1]);
  // shell 风格的 $VAR 只在有明显环境变量形状时计入（含下划线或 ${...}），避免把模板字符串 ${JSON...} 误判。
  for (const match of String(text || '').matchAll(/\$\{([A-Z][A-Z0-9_]{2,})\}/gu)) names.add(match[1]);
  for (const match of String(text || '').matchAll(/\$([A-Z][A-Z0-9_]*_[A-Z0-9_]+)\b/gu)) names.add(match[1]);
  return names;
}

function normalizeDeclaredEnv(metadata) {
  const raw = metadata?.env;
  const names = new Set();
  if (typeof raw === 'string') {
    for (const part of raw.split(/[,，、]/u)) {
      const name = part.trim().replace(/[=：:].*$/u, '').trim();
      if (name) names.add(name);
    }
  }
  return names;
}

function parseDeclaredEnvFromBody(body) {
  const names = new Set();
  const section = /##\s*权限与环境变量[\s\S]*?(?=^##\s|$)/mu.exec(body)?.[0] || '';
  for (const match of section.matchAll(/`([A-Z][A-Z0-9_]{1,})`/gu)) names.add(match[1]);
  return names;
}

function checkResourceRefs(dir, body) {
  const errors = [];
  const refs = new Set();
  for (const match of String(body || '').matchAll(/`((?:scripts|references|assets|tests)\/[A-Za-z0-9._/-]+)`/gu)) {
    refs.add(match[1]);
  }
  for (const rel of refs) {
    const absolute = path.join(dir, rel);
    if (!existsSync(absolute)) {
      errors.push({ code: 'RES001', level: 'error', message: `正文引用的资源不存在：${rel}` });
    }
  }
  return { errors, refs: [...refs] };
}

function checkCodeFences(body) {
  const fenceCount = (String(body || '').match(/^```/gmu) || []).length;
  return fenceCount % 2 === 0
    ? null
    : { code: 'DOC005', level: 'error', message: '代码围栏数量为奇数，正文结构不完整' };
}

function checkTestSpec(dir) {
  const file = path.join(dir, 'tests', 'skill.test.json');
  if (!existsSync(file)) {
    return { errors: [], warnings: [{ code: 'TST001', level: 'warn', message: '缺少 tests/skill.test.json，无法做触发与复现验收' }], spec: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return {
      errors: [{ code: 'TST002', level: 'error', message: `tests/skill.test.json 不是合法 JSON：${error.message}` }],
      warnings: [],
      spec: null,
    };
  }
  const errors = [];
  const warnings = [];
  const cases = Array.isArray(parsed?.trigger?.cases) ? parsed.trigger.cases : null;
  if (!cases) errors.push({ code: 'TST002', level: 'error', message: '测试规格缺少 trigger.cases 数组' });
  else if (cases.length < 2) warnings.push({ code: 'TST003', level: 'warn', message: '触发用例少于 2 条，无法覆盖正负例' });
  if (!Array.isArray(parsed?.commands) || parsed.commands.length === 0) {
    warnings.push({ code: 'TST004', level: 'warn', message: '没有命令用例，执行可复现性未被验证' });
  }
  return { errors, warnings, spec: parsed };
}

async function nodeCheck(file) {
  const node = process.env.DSH_SKILL_STUDIO_NODE || process.execPath;
  const electron = Boolean(process.versions.electron);
  return new Promise((resolve) => {
    const child = spawn(node, ['--check', file], {
      env: { ...process.env, ...(electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, message: 'node --check 超时' });
    }, 10_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, message: String(error.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, message: stderr.trim().slice(0, 500) || `退出码 ${code}` });
    });
  });
}

/**
 * 校验一个技能目录。
 * @param {string} dir 技能目录（含 SKILL.md）
 * @param {{catalog?: object, expectedName?: string, strict?: boolean}} options
 */
export async function validateSkill(dir, options = {}) {
  const errors = [];
  const warnings = [];
  const stats = { files: 0, bytes: 0, scripts: 0, references: 0 };
  const skillFile = path.join(dir, 'SKILL.md');
  if (!existsSync(skillFile)) {
    return {
      ok: false,
      name: options.expectedName || path.basename(dir),
      errors: [{ code: 'FM001', level: 'error', message: '目录里没有 SKILL.md' }],
      warnings,
      stats,
    };
  }
  let text;
  try {
    const stat = statSync(skillFile);
    if (stat.size > LIMITS.maxBodyBytes) {
      errors.push({ code: 'FM008', level: 'error', message: `SKILL.md 超过 ${LIMITS.maxBodyBytes} 字节` });
    }
    text = readFileSync(skillFile, 'utf8');
  } catch (error) {
    return {
      ok: false,
      name: options.expectedName || path.basename(dir),
      errors: [{ code: 'FM001', level: 'error', message: `读取 SKILL.md 失败：${error.message}` }],
      warnings,
      stats,
    };
  }
  const parsed = parseFrontmatter(text);
  if (!parsed.ok) {
    return {
      ok: false,
      name: options.expectedName || path.basename(dir),
      errors: [{ code: 'FM001', level: 'error', message: parsed.error }],
      warnings,
      stats,
    };
  }
  const fm = parsed.data || {};
  const body = parsed.body || '';
  const name = typeof fm.name === 'string' ? fm.name.trim() : '';
  const description = typeof fm.description === 'string' ? fm.description.trim() : '';
  const whenToUse = typeof fm.whenToUse === 'string' ? fm.whenToUse.trim() : '';
  const metadata = fm.metadata && typeof fm.metadata === 'object' ? fm.metadata : {};
  stats.bytes = Buffer.byteLength(text);

  if (!name) errors.push({ code: 'FM003', level: 'error', message: 'frontmatter 缺少 name' });
  else if (!isSkillName(name)) errors.push({ code: 'FM002', level: 'error', message: `name 不是合法 kebab-case：${name}` });
  if (!description) errors.push({ code: 'FM004', level: 'error', message: 'frontmatter 缺少 description' });
  else {
    if (description.length < LIMITS.minDescription) {
      errors.push({ code: 'FM005', level: 'error', message: `description 只有 ${description.length} 字符（至少 ${LIMITS.minDescription}）` });
    }
    if (description.length > CATALOG_DESCRIPTION_MAX) {
      errors.push({ code: 'FM006', level: 'error', message: `description ${description.length} 字符，超过 catalog 上限 ${CATALOG_DESCRIPTION_MAX}` });
    }
    for (const issue of descriptionQuality(description, triggerFromMetadata(metadata))) {
      const target = issue.level === 'error' ? errors : warnings;
      target.push({ code: issue.code, level: issue.level, message: issue.message });
    }
  }
  for (const key of ['disable-model-invocation', 'user-invocable']) {
    if (fm[key] !== undefined && typeof fm[key] !== 'boolean') {
      errors.push({ code: 'FM007', level: 'error', message: `${key} 必须是布尔值` });
    }
  }
  const expected = options.expectedName || path.basename(dir);
  if (name && expected && name !== expected && existsSync(path.join(dir, 'SKILL.md'))) {
    warnings.push({ code: 'FM009', level: 'warn', message: `目录名 ${expected} 与 frontmatter name ${name} 不一致` });
  }
  if (name && options.studioManaged && !existsSync(path.join(dir, 'studio.json'))) {
    warnings.push({ code: 'META001', level: 'warn', message: '缺少 studio.json（非 Skill Studio 生成，无法精确还原蓝图）' });
  }

  // 章节
  const sections = sectionMap(body);
  for (const spec of SECTION_SPECS) {
    const content = findSection(sections, spec);
    if (!content) {
      const level = spec.required ? 'error' : 'warn';
      const code = spec.required ? 'DOC001' : 'DOC002';
      (level === 'error' ? errors : warnings).push({
        code,
        level,
        message: `缺少章节「${spec.label}」`,
      });
      continue;
    }
    if (isSectionEmpty(content)) {
      warnings.push({ code: 'DOC003', level: 'warn', message: `章节「${spec.label}」内容为空` });
    }
  }
  const whenSection = findSection(sections, SECTION_SPECS[0]);
  if (!whenSection && whenToUse) warnings.push({ code: 'DOC006', level: 'warn', message: 'frontmatter 有 whenToUse，但正文缺少「适用场景」' });
  const stepsSection = findSection(sections, SECTION_SPECS[4]);
  if (stepsSection) {
    const stepCount = (stepsSection.match(STEPS_RE) || []).length;
    if (stepCount < 2) errors.push({ code: 'DOC003', level: 'error', message: `执行步骤只有 ${stepCount} 步（至少 2 步）` });
    if (stepCount > LIMITS.maxSteps) warnings.push({ code: 'DOC007', level: 'warn', message: `执行步骤 ${stepCount} 步，可能承担了过多职责` });
  }
  if (!TIMEOUT_RE.test(body)) errors.push({ code: 'DOC004', level: 'error', message: '缺少超时兜底说明' });
  const ioSection = findSection(sections, SECTION_SPECS[2]);
  if (ioSection) {
    if (!/(输入|Input)/iu.test(ioSection)) errors.push({ code: 'IO001', level: 'error', message: '「输入与输出」缺少输入说明' });
    if (!/(输出|Output)/iu.test(ioSection)) errors.push({ code: 'IO002', level: 'error', message: '「输入与输出」缺少输出说明' });
  }
  const boundarySection = findSection(sections, SECTION_SPECS[1]);
  if (boundarySection) {
    if (!/(不解决|不适用|不做|Out of scope)/iu.test(boundarySection)) {
      warnings.push({ code: 'DOC008', level: 'warn', message: '「能力边界」没有写“不解决什么”，职责可能不清' });
    }
  }

  const fenceIssue = checkCodeFences(body);
  if (fenceIssue) errors.push(fenceIssue);

  // 资源引用与脚本
  const resourceRefs = checkResourceRefs(dir, body);
  errors.push(...resourceRefs.errors);
  const allFiles = walkFiles(dir);
  stats.files = allFiles.length;
  const scripts = allFiles.filter((file) => /(^|\/)scripts\/[^/]+\.(?:mjs|js|py|sh)$/u.test(file));
  stats.scripts = scripts.length;
  const references = allFiles.filter((file) => /(^|\/)references\/[^/]+$/u.test(file));
  stats.references = references.length;
  for (const script of scripts) {
    const rel = path.relative(dir, script).split(path.sep).join('/');
    if (/\.(?:mjs|js)$/u.test(script)) {
      const result = await nodeCheck(script);
      if (!result.ok) errors.push({ code: 'RES002', level: 'error', message: `脚本语法错误（${rel}）：${result.message}` });
    }
    const content = readTextSafe(script) || '';
    if (content.startsWith('#!')) {
      try {
        if ((statSync(script).mode & 0o111) === 0) {
          warnings.push({ code: 'RES003', level: 'warn', message: `脚本带 shebang 但没有执行权限：${rel}` });
        }
      } catch {
        /* ignore */
      }
    }
  }

  // 密钥与环境变量
  const declaredEnv = new Set([...normalizeDeclaredEnv(metadata), ...parseDeclaredEnvFromBody(body)]);
  const usedEnv = new Set();
  for (const file of allFiles) {
    const content = readTextSafe(file);
    if (!content) continue;
    const rel = path.relative(dir, file).split(path.sep).join('/');
    const secrets = findSecretLiterals(content);
    for (const hit of secrets) {
      errors.push({ code: hit.code, level: 'error', message: `疑似密钥字面量（${rel}，${hit.label}）` });
    }
    for (const envName of collectEnvUsage(content)) usedEnv.add(envName);
    if (/^\s*[A-Z][A-Z0-9_]{2,}\s*=\s*\S{8,}\s*$/mu.test(content) && /\.(?:env|sh|mjs|js|json|md)$/u.test(file)) {
      errors.push({ code: 'SEC008', level: 'error', message: `环境变量被写入了具体值（${rel}），密钥必须只在运行时注入` });
    }
  }
  for (const envName of usedEnv) {
    if (!declaredEnv.has(envName)) {
      errors.push({ code: 'SEC003', level: 'error', message: `脚本使用了未声明的环境变量 ${envName}` });
    }
  }
  for (const envName of declaredEnv) {
    if (!usedEnv.has(envName) && scripts.length > 0) {
      warnings.push({ code: 'SEC004', level: 'warn', message: `声明了环境变量 ${envName}，但脚本没有读取它` });
    }
  }

  // 与现有技能的关系
  const catalog = options.catalog?.skills || [];
  for (const other of catalog) {
    if (!other.valid || other.name === name) continue;
    const similarity = descriptionSimilarity(description, other.description);
    if (similarity >= 0.55) {
      warnings.push({
        code: 'OVL002',
        level: 'warn',
        message: `description 与 ${other.name} 相似度 ${similarity.toFixed(2)}，存在误触风险`,
      });
    }
  }
  if (options.catalog) {
    const sameName = options.catalog.skills.find((skill) => skill.name === name);
    if (sameName && sameName.path !== path.join(dir, 'SKILL.md')) {
      warnings.push({
        code: 'OVL001',
        level: 'warn',
        message: `仓库里已有同名技能：${sameName.path}（发布后会按根目录优先级遮蔽）`,
      });
    }
  }

  const testSpec = checkTestSpec(dir);
  errors.push(...testSpec.errors);
  warnings.push(...testSpec.warnings);

  return {
    ok: errors.length === 0,
    name: name || expected,
    path: dir,
    errors,
    warnings,
    stats,
    sections: [...sections.keys()],
    summary: errors.length
      ? `❌ ${errors.length} 个错误 / ${warnings.length} 个警告`
      : `✅ 校验通过（${warnings.length} 个警告）`,
  };
}

function triggerFromMetadata(metadata) {
  const include = [];
  const exclude = [];
  const raw = typeof metadata?.triggers === 'string' ? metadata.triggers : '';
  for (const part of raw.split(/[；;]/u)) {
    const match = /^(触发|不触发)[：:]\s*(.*)$/u.exec(part.trim());
    if (!match) continue;
    const items = match[2].split(/[、,，]/u).map((item) => item.trim()).filter((item) => item && item !== '—' && item !== '无');
    if (match[1] === '触发') include.push(...items);
    else exclude.push(...items);
  }
  return { include, exclude };
}
