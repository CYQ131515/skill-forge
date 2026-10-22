/**
 * Skill Forge — 从「资料」自动起草能力边界蓝图。
 *
 * 纯确定性启发式：不调用模型，不联网。目标不是替作者做决定，而是把
 * 资料里已经有的结构（标题、章节、编号步骤、触发词、环境变量）翻译成
 * 蓝图字段，作者再在表单里改。所有推断都会在 insights 里标出来。
 */
import { createHash } from 'node:crypto';
import { extensionOf } from './package.js';

const SECTION_RE = /^(#{1,3})\s+(.+?)\s*$/gmu;
const NUMBERED_RE = /^\s*(?:\d+[.、)]|[-*]\s)\s+(.{2,120})$/gmu;
const STANDARD_SECTIONS = new Set([
  '适用场景', '能力边界', '输入与输出', '输入输出', '权限与环境变量', '执行步骤', '步骤',
  '错误码与异常处理', '错误处理', '验收与复现', '验收', '资源', '背景', '维护备注',
  'common failures', 'inputs and outputs', 'permissions', 'steps', 'verification', 'resources',
]);

function stripInline(text) {
  return String(text || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[*_`>#]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function paragraphs(text) {
  const source = String(text || '')
    .replace(/```[\s\S]*?```/gu, '\n\n')
    .replace(/^\s*\|.*\|\s*$/gmu, ' ')
    .replace(/^\s*[-*+]\s+/gmu, ' ')
    .replace(/^\s*\d+[.、)]\s+/gmu, ' ');
  return source
    .split(/\n{2,}/u)
    .map(stripInline)
    .map((line) => line.trim())
    .filter((line) => line.length >= 16 && !/^#{1,6}\s/u.test(line));
}

function headings(text) {
  const out = [];
  for (const match of String(text || '').matchAll(SECTION_RE)) {
    const title = stripInline(match[2]).replace(/[：:]$/u, '').trim();
    if (!title) continue;
    out.push({ level: match[1].length, title });
  }
  return out;
}

function sectionBody(text, names) {
  const source = String(text || '');
  for (const name of names) {
    const regex = new RegExp(`^#{2,4}\\s*${name}[^\\n]*\\n([\\s\\S]*?)(?=^#{2,4}\\s|$)`, 'mu');
    const match = regex.exec(source);
    if (match) {
      const body = stripInline(match[1]);
      if (body) return body;
    }
  }
  return '';
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-{2,}/gu, '-')
    .slice(0, 56);
}

function hashSuffix(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 6);
}

function extractTriggers(texts, title) {
  const found = [];
  const push = (value) => {
    const phrase = stripInline(value).replace(/[。；;，,、]$/u, '').trim();
    if (phrase.length >= 2 && phrase.length <= 24 && !found.includes(phrase)) found.push(phrase);
  };
  for (const text of texts) {
    for (const match of String(text).matchAll(/(?:触发词|触发场景|trigger|when to use)\s*[:：]\s*([^\n]{2,160})/giu)) {
      for (const part of match[1].split(/[、,，;；|/]/u)) push(part);
    }
    for (const match of String(text).matchAll(/`([^`\n]{2,24})`/gu)) push(match[1]);
    for (const match of String(text).matchAll(/\*\*([^*\n]{2,24})\*\*/gu)) push(match[1]);
  }
  if (found.length < 2) {
    for (const part of title.split(/[\s、,，:：/|]+/u)) {
      if (part.length >= 2 && part.length <= 16) push(part);
    }
  }
  return found.slice(0, 6);
}

function detectEnv(texts) {
  const names = new Set();
  for (const text of texts) {
    for (const match of String(text).matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]+)|\[['"]([A-Z][A-Z0-9_]+)['"]\])/gu)) {
      names.add(match[1] || match[2]);
    }
    for (const match of String(text).matchAll(/\$\{([A-Z][A-Z0-9_]{2,})\}/gu)) names.add(match[1]);
  }
  return [...names].slice(0, 6);
}

function pickTitle(materials) {
  for (const material of materials) {
    const match = /^#\s+(.+)$/mu.exec(String(material.text || ''));
    if (match) {
      const title = stripInline(match[1]);
      if (title) return title;
    }
  }
  for (const material of materials) {
    const firstLine = String(material.text || '')
      .split(/\r?\n/u)
      .map((line) => stripInline(line))
      .find((line) => line.length >= 2);
    if (firstLine) return firstLine.slice(0, 48);
  }
  const stem = String(materials[0]?.name || 'new-skill').replace(/\.[^.]+$/u, '');
  return stem.replace(/[-_]+/gu, ' ').slice(0, 48) || '新技能';
}

function pickName(title, materials) {
  const direct = slugify(title);
  if (direct.length >= 3) return direct;
  for (const material of materials) {
    const stem = slugify(String(material.name || '').replace(/\.[^.]+$/u, '').replace(/^skill-?/u, ''));
    if (stem.length >= 3) return stem;
  }
  return `skill-${hashSuffix(title)}`;
}

function inferSteps(texts, materialCount) {
  const steps = [];
  const seen = new Set();
  const push = (title, detail = '') => {
    const cleanTitle = stripInline(title).replace(/^\d+[.、)]\s*/u, '').slice(0, 60);
    if (!cleanTitle || seen.has(cleanTitle) || STANDARD_SECTIONS.has(cleanTitle.toLowerCase())) return;
    seen.add(cleanTitle);
    steps.push({ title: cleanTitle, detail: stripInline(detail).slice(0, 160), command: '' });
  };
  for (const text of texts) {
    const heads = headings(text).filter((item) => item.level >= 2);
    for (const head of heads) push(head.title);
    if (steps.length >= 4) break;
  }
  if (steps.length < 2) {
    for (const text of texts) {
      for (const match of String(text).matchAll(NUMBERED_RE)) push(match[1]);
      if (steps.length >= 4) break;
    }
  }
  if (steps.length < 2) {
    steps.length = 0;
    steps.push({ title: '确认输入与期望产物', detail: `核对资料（${materialCount} 个文件）是否覆盖任务所需信息。`, command: '' });
    steps.push({ title: '按能力边界执行', detail: '严格按本技能的适用场景执行，越界时停止并说明原因。', command: '' });
    steps.push({ title: '自检并交付', detail: '按验收标准检查产物，输出确定性结果与失败时的错误码。', command: '' });
  }
  return steps.slice(0, 8);
}

/**
 * @param {{materials?: Array<{name: string, text?: string}>, idea?: string}} input
 */
export function draftBlueprint(input = {}) {
  const idea = typeof input.idea === 'string' ? input.idea.trim() : '';
  const materials = (Array.isArray(input.materials) ? input.materials : [])
    .filter((item) => item && typeof item.text === 'string' && item.text.trim())
    .map((item) => ({ name: String(item.name || 'notes.md'), text: String(item.text) }))
    .slice(0, 12);
  if (idea) materials.unshift({ name: 'idea.txt', text: idea });
  const texts = materials.map((item) => item.text);
  const allText = texts.join('\n\n');
  const title = pickTitle(materials);
  const name = pickName(title, materials);
  const triggerList = extractTriggers(texts, title);
  const triggers = triggerList.length ? triggerList : [title.slice(0, 16)].filter(Boolean);
  const firstParagraph = paragraphs(allText).find((line) => line.length >= 24) || '';
  const summary = firstParagraph.length >= 24
    ? firstParagraph.slice(0, 280)
    : `把「${title}」相关的资料与流程固化成可复用、可验证的 skill。`;
  const explicitWhen = sectionBody(allText, ['适用场景', '何时使用', 'When to use']);
  const explicitOut = sectionBody(allText, ['不适用', '不解决', 'Out of scope', '不解决的问题']);
  const steps = inferSteps(texts, materials.length);
  const env = detectEnv(texts);
  const hasScript = materials.some((item) => ['.mjs', '.js', '.py', '.sh', '.cjs'].includes(extensionOf(item.name)));
  const triggerText = triggers.join('、');

  const draft = {
    name,
    title,
    description: summary.length >= 24 ? summary : `${summary} 适用场景：${triggerText}。`,
    whenToUse: explicitWhen
      ? explicitWhen.slice(0, 300)
      : `当任务涉及「${title}」，或用户提到 ${triggerText} 时使用本技能。`,
    problem: firstParagraph.slice(0, 300) || `把「${title}」的资料与流程固化成可复用的 skill。`,
    outOfScope: explicitOut
      ? explicitOut.slice(0, 240)
      : `不解决与「${title}」无关的通用任务；不替代其他专用 skill。`,
    triggers: { include: triggers, exclude: [] },
    inputs: [
      { name: 'source', description: `任务输入与相关资料（${materials.length} 份）`, required: true, type: 'file' },
    ],
    outputs: [
      { name: 'skill-package', description: '技能包：SKILL.md + 资源 + 测试规格', required: true, type: 'folder' },
    ],
    permissions: {
      filesystem: 'read',
      network: false,
      shell: hasScript,
      env,
    },
    steps,
    errorCodes: [
      { code: 'E_INPUT', meaning: '输入缺失或格式不符', handling: '指出缺失字段并停止执行' },
      { code: 'E_TIMEOUT', meaning: '执行超过超时限制', handling: '终止并返回超时错误，不重试有副作用的调用' },
    ],
    timeoutMs: 45000,
    resources: {
      scripts: hasScript ? materials.filter((item) => ['.mjs', '.js', '.py', '.sh', '.cjs'].includes(extensionOf(item.name))).map((item) => item.name.split('/').pop()) : [],
      references: materials
        .filter((item) => ['.md', '.mdx', '.txt', '.json', '.yaml', '.yml', '.csv'].includes(extensionOf(item.name)))
        .map((item) => item.name.split('/').pop())
        .slice(0, 12),
      assets: [],
    },
  };

  const insights = {
    materialCount: materials.length,
    chars: allText.length,
    title,
    name,
    nameFallback: !slugify(title),
    triggers,
    headings: headings(allText).map((item) => item.title).slice(0, 12),
    steps: steps.length,
    env,
    hasScript,
  };
  return { draft, insights };
}
