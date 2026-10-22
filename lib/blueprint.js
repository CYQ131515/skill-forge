/**
 * Skill Studio — 能力边界蓝图（blueprint）与 SKILL.md 生成。
 *
 * 一个蓝图就是一份“单一职责”契约：
 *   问题 / 触发 / 不触发 / 输入 / 输出 / 权限 / 步骤 / 错误码 / 超时 / 验收。
 * 生成器只接受经过归一化与校验的蓝图；任何密钥字面量都会被拒绝。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { asString, asStringArray, isPlainObject, timeIso } from './util.js';
import { isSkillName, parseFrontmatter, renderSkillFile } from './frontmatter.js';

export const BLUEPRINT_VERSION = 1;
export const DEFAULT_TIMEOUT_MS = 45_000;
export const ERROR_CODES = {
  BP001: '技能名不合法（必须 kebab-case）',
  BP002: 'description 缺失或过短',
  BP003: 'whenToUse 缺失',
  BP004: '问题或“不解决问题”缺失',
  BP005: '触发条件为空',
  BP006: '输入未声明',
  BP007: '输出未声明',
  BP008: '权限边界缺失',
  BP009: '执行步骤少于 2 步',
  BP010: '错误码未声明',
  BP011: '超时时间不合法',
  BP012: '检测到疑似密钥字面量（密钥只能走环境变量）',
  BP013: '环境变量声明里出现了具体值',
  BP014: '重叠声明指向自身',
  BP015: 'description 与现有技能过于相似（职责重叠）',
  BP016: '同一字段重复声明',
};

const SECRET_PATTERNS = [
  { code: 'SEC001', label: 'OpenAI/DeepSeek 风格密钥', re: /\bsk-[A-Za-z0-9]{16,}\b/u },
  { code: 'SEC002', label: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/u },
  { code: 'SEC003', label: 'GitHub Token', re: /\bghp_[A-Za-z0-9]{20,}\b/u },
  { code: 'SEC004', label: 'Slack Token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u },
  { code: 'SEC005', label: '私钥', re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/u },
  {
    code: 'SEC006',
    label: '疑似硬编码密钥赋值',
    re: /\b(?:api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['"][^'"\s]{8,}['"]/iu,
  },
  { code: 'SEC007', label: 'Bearer 令牌', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/u },
];

/** 在任意文本里找疑似密钥；返回 [{code,label,match}]。 */
export function findSecretLiterals(text) {
  const source = String(text ?? '');
  const hits = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.re.test(source)) hits.push({ code: pattern.code, label: pattern.label });
  }
  return hits;
}

function normalizePermission(value) {
  const raw = isPlainObject(value) ? value : {};
  const filesystem = ['none', 'read', 'write'].includes(raw.filesystem) ? raw.filesystem : 'none';
  return {
    filesystem,
    network: raw.network === true,
    shell: raw.shell === true,
    env: asStringArray(raw.env).map((item) => item.replace(/[=：:].*$/u, '').trim()).filter(Boolean),
  };
}

function normalizeInputs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') {
        const [name, ...rest] = item.split(/[：:—–-]{1,2}/u);
        return { name: name.trim(), description: rest.join('—').trim(), required: true, type: 'string' };
      }
      if (!isPlainObject(item)) return null;
      const name = asString(item.name || item.key).trim();
      if (!name) return null;
      return {
        name,
        description: asString(item.description || item.desc || '').trim(),
        required: item.required !== false,
        type: asString(item.type || 'string').trim() || 'string',
      };
    })
    .filter(Boolean);
}

function normalizeOutputs(value) {
  return normalizeInputs(value).map(({ required, ...rest }) => rest);
}

function normalizeSteps(value) {
  const list = Array.isArray(value) ? value : [];
  const steps = [];
  for (const item of list) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (!trimmed) continue;
      const [title, ...detail] = trimmed.split(/[：:]/u);
      steps.push({ title: title.trim(), detail: detail.join('：').trim(), command: '' });
      continue;
    }
    if (!isPlainObject(item)) continue;
    const title = asString(item.title || item.name || '').trim();
    const detail = asString(item.detail || item.description || item.text || '').trim();
    const command = asString(item.command || '').trim();
    if (!title && !detail && !command) continue;
    steps.push({ title: title || `步骤 ${steps.length + 1}`, detail, command });
  }
  return steps;
}

function normalizeErrorCodes(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of list) {
    if (typeof item === 'string') {
      const match = /^([A-Za-z][A-Za-z0-9_]{1,15})\s*[:：]\s*(.*)$/u.exec(item.trim());
      if (!match) continue;
      out.push({ code: match[1], meaning: match[2].trim(), handling: '' });
      continue;
    }
    if (!isPlainObject(item)) continue;
    const code = asString(item.code || '').trim();
    if (!code) continue;
    out.push({
      code,
      meaning: asString(item.meaning || item.description || '').trim(),
      handling: asString(item.handling || item.action || '').trim(),
    });
  }
  return out;
}

function normalizeOverlaps(value) {
  const list = Array.isArray(value) ? value : [];
  return list
    .map((item) => {
      if (typeof item === 'string') return { skill: item.trim(), note: '' };
      if (!isPlainObject(item)) return null;
      const skill = asString(item.skill || item.name || '').trim();
      if (!skill) return null;
      return { skill, note: asString(item.note || item.reason || '').trim() };
    })
    .filter(Boolean);
}

function normalizeResources(value) {
  const raw = isPlainObject(value) ? value : {};
  const scripts = asStringArray(raw.scripts);
  const references = asStringArray(raw.references);
  const assets = asStringArray(raw.assets);
  return { scripts, references, assets };
}

function normalizeTriggers(value, fallbackInclude) {
  const raw = isPlainObject(value) ? value : {};
  const include = asStringArray(raw.include || fallbackInclude);
  const exclude = asStringArray(raw.exclude);
  return { include, exclude };
}

/** 归一化任意输入为蓝图；不抛异常，问题放进 errors。 */
export function normalizeBlueprint(input) {
  const raw = isPlainObject(input) ? input : {};
  const errors = [];
  const warnings = [];
  const name = asString(raw.name).trim();
  let description = asString(raw.description).replace(/\s+/gu, ' ').trim();
  const whenToUse = asString(raw.whenToUse || raw.when_to_use).trim();
  const problem = asString(raw.problem || raw.解决的问题).trim();
  const outOfScope = asString(raw.outOfScope || raw.out_of_scope || raw.不解决).trim();
  const title = asString(raw.title).trim() || name;
  const timeoutMs = Number(raw.timeoutMs || raw.timeout_ms || DEFAULT_TIMEOUT_MS);
  const permissions = normalizePermission(raw.permissions);
  const inputs = normalizeInputs(raw.inputs);
  const outputs = normalizeOutputs(raw.outputs);
  const steps = normalizeSteps(raw.steps);
  const errorCodes = normalizeErrorCodes(raw.errorCodes || raw.errors);
  const overlaps = normalizeOverlaps(raw.overlaps);
  const resources = normalizeResources(raw.resources);
  const triggers = normalizeTriggers(raw.triggers, raw.triggerInclude || raw.trigger_include);
  const version = Math.max(1, Number.parseInt(raw.version, 10) || 1);

  // catalog 只渲染 name + description，因此触发词必须出现在 description 里，
  // 否则模型没有依据路由。缺少时自动补一句（不超上限的前提下）。
  if (triggers.include.length > 0 && description) {
    const lower = description.toLowerCase();
    const missing = triggers.include.filter((phrase) => phrase.length >= 2 && !lower.includes(phrase.toLowerCase()));
    const triggerSentenceRe = /触发场景：([^。]*)。/gu;
    const triggerSentences = [...description.matchAll(triggerSentenceRe)];
    // 缺失触发词要补；历史上重复叠加的「触发场景：…。」也要合并，避免越保存越长。
    if (missing.length > 0 || triggerSentences.length > 1) {
      const existingPhrases = triggerSentences
        .flatMap((match) => match[1].split(/[、,，]/u))
        .map((item) => item.trim())
        .filter(Boolean);
      const base = description.replace(triggerSentenceRe, ' ').replace(/\s+/gu, ' ').trim();
      const merged = [...new Set([...existingPhrases, ...triggers.include])];
      const suffix = `触发场景：${merged.join('、')}。`;
      const joiner = base && !/[。！？；;，,]$/u.test(base) ? ' ' : '';
      if (base.length + suffix.length + joiner.length <= 500) {
        description = `${base}${joiner}${suffix}`.replace(/\s+/gu, ' ').trim();
        if (missing.length > 0) {
          warnings.push({ code: 'BPW01', field: 'description', message: `已自动把触发词补进 description：${missing.join('、')}` });
        }
      } else if (missing.length > 0) {
        warnings.push({ code: 'BPW02', field: 'description', message: 'description 已达 500 字符上限，触发词无法自动补入，请手工精简' });
      }
    }
  }

  if (!isSkillName(name)) errors.push({ code: 'BP001', field: 'name', message: ERROR_CODES.BP001 });
  if (description.length < 24) errors.push({ code: 'BP002', field: 'description', message: ERROR_CODES.BP002 });
  if (!whenToUse) errors.push({ code: 'BP003', field: 'whenToUse', message: ERROR_CODES.BP003 });
  if (!problem || !outOfScope) errors.push({ code: 'BP004', field: 'problem/outOfScope', message: ERROR_CODES.BP004 });
  if (triggers.include.length === 0) errors.push({ code: 'BP005', field: 'triggers.include', message: ERROR_CODES.BP005 });
  if (inputs.length === 0) errors.push({ code: 'BP006', field: 'inputs', message: ERROR_CODES.BP006 });
  if (outputs.length === 0) errors.push({ code: 'BP007', field: 'outputs', message: ERROR_CODES.BP007 });
  if (permissions.filesystem === 'none' && !permissions.network && !permissions.shell && permissions.env.length === 0) {
    errors.push({ code: 'BP008', field: 'permissions', message: ERROR_CODES.BP008 });
  }
  if (steps.length < 2) errors.push({ code: 'BP009', field: 'steps', message: ERROR_CODES.BP009 });
  if (errorCodes.length === 0) errors.push({ code: 'BP010', field: 'errorCodes', message: ERROR_CODES.BP010 });
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) {
    errors.push({ code: 'BP011', field: 'timeoutMs', message: ERROR_CODES.BP011 });
  }
  if (overlaps.some((item) => item.skill === name)) errors.push({ code: 'BP014', field: 'overlaps', message: ERROR_CODES.BP014 });
  for (const envName of permissions.env) {
    if (/[=\s]/u.test(envName)) {
      errors.push({ code: 'BP013', field: 'permissions.env', message: `${ERROR_CODES.BP013}：${envName}` });
    }
  }
  const secretSource = JSON.stringify({
    name,
    description,
    whenToUse,
    problem,
    outOfScope,
    triggers,
    inputs,
    outputs,
    steps,
    errorCodes,
    resources,
  });
  const secrets = findSecretLiterals(secretSource);
  for (const hit of secrets) {
    errors.push({ code: 'BP012', field: 'blueprint', message: `${ERROR_CODES.BP012}（${hit.label}）` });
  }

  const blueprint = {
    version,
    name,
    title,
    description,
    whenToUse,
    problem,
    outOfScope,
    triggers,
    inputs,
    outputs,
    permissions,
    overlaps,
    steps,
    errorCodes,
    timeoutMs: Math.round(timeoutMs),
    resources,
    tests: isPlainObject(raw.tests) ? raw.tests : {},
    scriptName: asString(raw.scriptName || `${name}.mjs`).replace(/[^A-Za-z0-9._-]/gu, '-'),
    createdAt: asString(raw.createdAt) || timeIso(),
  };
  if (secrets.length > 0) return { blueprint: redactSecrets(blueprint), errors, warnings };
  return { blueprint, errors, warnings };
}

/** 递归把疑似密钥值替换为 [REDACTED]，保证错误信息与返回对象都不回显原文。 */
export function redactSecrets(value) {
  if (typeof value === 'string') {
    let out = value;
    for (const pattern of SECRET_PATTERNS) out = out.replace(pattern.re, '[REDACTED]');
    return out;
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactSecrets(item);
    return out;
  }
  return value;
}

function bulletList(items, render) {
  if (!items || items.length === 0) return '- 无';
  return items.map((item) => `- ${render(item)}`).join('\n');
}

const FS_LABEL = { none: '不访问文件', read: '只读', write: '可写' };

/** 生成 SKILL.md 正文（不含 frontmatter）。 */
export function renderSkillBody(bp) {
  const triggerLine = bp.triggers.include.length ? bp.triggers.include.join('、') : '（未声明）';
  const excludeLine = bp.triggers.exclude.length ? bp.triggers.exclude.join('、') : '（未声明）';
  const overlapLine = bp.overlaps.length
    ? bp.overlaps.map((item) => `\`${item.skill}\`${item.note ? `（${item.note}）` : ''}`).join('、')
    : '无';
  const envLine = bp.permissions.env.length
    ? bp.permissions.env.map((key) => `\`${key}\``).join('、')
    : '无';
  const steps = bp.steps
    .map((step, index) => {
      const head = `### ${index + 1}. ${step.title}`;
      const lines = [head];
      if (step.detail) lines.push('', step.detail);
      if (step.command) lines.push('', '```bash', step.command, '```');
      return lines.join('\n');
    })
    .join('\n\n');
  const errors = bp.errorCodes.length
    ? [
        '| 错误码 | 含义 | 处理 |',
        '|---|---|---|',
        ...bp.errorCodes.map((item) => `| \`${item.code}\` | ${item.meaning || '—'} | ${item.handling || '—'} |`),
      ].join('\n')
    : '- 无';
  const inputs = bulletList(bp.inputs, (item) => `\`${item.name}\`（${item.type}${item.required ? '，必填' : '，可选'}）：${item.description || '—'}`);
  const outputs = bulletList(bp.outputs, (item) => `\`${item.name}\`（${item.type}）：${item.description || '—'}`);
  const resourceLines = [];
  if (bp.resources.scripts.length) resourceLines.push(`- 脚本：${bp.resources.scripts.map((name) => `\`scripts/${name}\``).join('、')}`);
  if (bp.resources.references.length) {
    resourceLines.push(`- 参考资料：${bp.resources.references.map((name) => `\`references/${name}\``).join('、')}`);
  }
  if (bp.resources.assets?.length) {
    resourceLines.push(`- 附加资源：${bp.resources.assets.map((name) => `\`assets/${name}\``).join('、')}`);
  }
  resourceLines.push('- 测试规格：`tests/skill.test.json`');

  return `# ${bp.title}

## 适用场景

${bp.whenToUse}

- 触发词：${triggerLine}
- 不触发：${excludeLine}

## 能力边界

- 解决的问题：${bp.problem}
- 不解决的问题（交给其他 skill）：${bp.outOfScope}
- 与现有 skill 的关系：${overlapLine}

## 输入与输出

### 输入

${inputs}

### 输出

${outputs}

## 权限与环境变量

- 文件系统：${FS_LABEL[bp.permissions.filesystem] || bp.permissions.filesystem}
- 网络：${bp.permissions.network ? '需要' : '不需要'}
- Shell：${bp.permissions.shell ? '需要' : '不需要'}
- 环境变量：${envLine}

> 密钥只从环境变量读取，绝不写进 SKILL.md、脚本、测试或日志。

## 执行步骤

${steps}

## 错误码与异常处理

${errors}

- 超时兜底：单次执行超过 ${bp.timeoutMs} ms 时终止并返回超时错误，不重试有副作用的外部调用。

## 验收与复现

- 触发验收：\`tests/skill.test.json\` 中的正例必须命中本技能，负例必须不命中；准确率门槛见测试规格。
- 执行验收：脚本用例正常 / 异常 / 边界各至少 1 条，且同一用例连续运行两次输出一致（可复现）。
- 复现命令：

\`\`\`bash
node scripts/${bp.scriptName} --input "示例输入"
\`\`\`

## 资源

${resourceLines.join('\n')}
`;
}

export function renderSkillFrontmatter(bp) {
  const trimEnd = (value) => String(value || '').replace(/[。；;，,]+$/u, '');
  const metadata = {
    version: String(bp.version),
    studio: 'skill-studio',
    boundary: `解决：${trimEnd(bp.problem)}；不解决：${trimEnd(bp.outOfScope)}`,
    triggers: `触发：${bp.triggers.include.join('、') || '—'}；不触发：${bp.triggers.exclude.join('、') || '—'}`,
    permissions: `文件系统=${bp.permissions.filesystem}；网络=${bp.permissions.network ? '是' : '否'}；Shell=${bp.permissions.shell ? '是' : '否'}`,
    timeout_ms: String(bp.timeoutMs),
  };
  if (bp.permissions.env.length) metadata.env = bp.permissions.env.join(',');
  if (bp.overlaps.length) metadata.overlaps = bp.overlaps.map((item) => item.skill).join(',');
  const frontmatter = {
    name: bp.name,
    description: bp.description,
    whenToUse: bp.whenToUse,
    metadata,
  };
  return frontmatter;
}

export function renderSkillMarkdown(bp) {
  return renderSkillFile(renderSkillFrontmatter(bp), renderSkillBody(bp));
}

/** 生成脚本模板：确定性、无密钥、正常/异常/边界三种退出码。 */
export function renderScriptTemplate(bp) {
  const title = bp.title.replace(/\*\//gu, '');
  return `#!/usr/bin/env node
/**
 * ${title} — 可复现脚本骨架（由 Skill Studio 生成）。
 *
 * 用法：
 *   node scripts/${bp.scriptName} --input "文本" [--json]
 *
 * 约定：
 *   - 成功退出码 0；参数错误退出码 2；运行错误退出码 1；
 *   - 输出必须是确定性的（不含时间、随机数、绝对路径），方便二次运行比对；
 *   - 密钥只从环境变量读取，绝不写入本文件。
 */
import { createHash } from 'node:crypto';

const EXIT = { ok: 0, args: 2, runtime: 1 };

function emit(value) {
  process.stdout.write(\`\${JSON.stringify(value, null, 2)}\\n\`);
}

function fail(code, message) {
  emit({ ok: false, code, message });
  process.exit(code === 'E_ARGS' ? EXIT.args : EXIT.runtime);
}

function parseArgs(argv) {
  const parsed = { input: undefined, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input' || arg === '-i') {
      parsed.input = argv[index + 1];
      index += 1;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else {
      fail('E_ARGS', \`未知参数：\${arg}\`);
    }
  }
  return parsed;
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.help) {
  emit({ ok: true, usage: 'node ${bp.scriptName} --input <text>' });
  process.exit(EXIT.ok);
}
if (typeof parsed.input !== 'string') fail('E_ARGS', '缺少 --input');
if (parsed.input.length > 20000) fail('E_ARGS', '输入过长（上限 20000 字符）');

const digest = createHash('sha256').update(parsed.input, 'utf8').digest('hex');
emit({ ok: true, length: parsed.input.length, sha256: digest });
process.exit(EXIT.ok);
`;
}

/** 生成参考资料模板。 */
export function renderReferenceTemplate(bp) {
  return `# ${bp.title} · 参考资料

## 背景

${bp.problem}

## 适用与不适用

- 适用：${bp.whenToUse}
- 不适用：${bp.outOfScope}

## 输入输出

- 输入：${bp.inputs.map((item) => item.name).join('、') || '—'}
- 输出：${bp.outputs.map((item) => item.name).join('、') || '—'}

## 常见失败模式

${bp.errorCodes.map((item) => `- \`${item.code}\`：${item.meaning}`).join('\n')}

## 维护备注

- 修改本技能后必须重跑 \`tests/skill.test.json\`；
- 触发词变化必须同步更新 description 与触发用例；
- 密钥通过环境变量传入（${bp.permissions.env.join('、') || '无'}），不得写入任何文件。
`;
}

/** 默认测试规格：正例 / 负例 / 脚本正常、异常、边界 + 二次运行可复现。 */
export function renderTestSpec(bp) {
  const provided = isPlainObject(bp.tests) ? bp.tests : {};
  const providedTrigger = Array.isArray(provided.trigger?.cases) ? provided.trigger.cases : [];
  const providedCommands = Array.isArray(provided.commands) ? provided.commands : [];
  const defaultTriggerCases = [
    ...bp.triggers.include.map((phrase) => ({ prompt: phrase, expect: bp.name, note: '正例（触发词）' })),
    ...bp.triggers.exclude.map((phrase) => ({ prompt: phrase, expect: null, note: '负例（不触发）' })),
  ];
  const triggerCases = providedTrigger.length ? providedTrigger : defaultTriggerCases;
  const defaultCommands = bp.resources.scripts.length
    ? [
        {
          name: 'normal',
          argv: ['node', `scripts/${bp.scriptName}`, '--input', 'hello skill'],
          timeoutMs: bp.timeoutMs,
          expect: { exitCode: 0, stdoutContains: '"ok": true' },
          reproducible: true,
        },
        {
          name: 'missing-arg',
          argv: ['node', `scripts/${bp.scriptName}`],
          timeoutMs: bp.timeoutMs,
          expect: { exitCode: 2, stdoutContains: '"code": "E_ARGS"' },
          reproducible: true,
        },
        {
          name: 'boundary-empty',
          argv: ['node', `scripts/${bp.scriptName}`, '--input', ''],
          timeoutMs: bp.timeoutMs,
          expect: { exitCode: 0, stdoutContains: '"length": 0' },
          reproducible: true,
        },
      ]
    : [];
  const commands = providedCommands.length ? providedCommands : defaultCommands;
  return {
    version: 1,
    skill: bp.name,
    trigger: {
      minAccuracy: Number(provided.trigger?.minAccuracy) || 0.8,
      minScore: Number(provided.trigger?.minScore) || 0.22,
      cases: triggerCases,
    },
    commands,
    generatedAt: timeIso(),
  };
}

export function generateSkillFiles(bp) {
  const files = new Map();
  files.set('SKILL.md', renderSkillMarkdown(bp));
  files.set('tests/skill.test.json', `${JSON.stringify(renderTestSpec(bp), null, 2)}\n`);
  if (bp.resources.references.length) {
    for (const name of bp.resources.references) {
      files.set(`references/${name}`, renderReferenceTemplate(bp));
    }
  }
  if (bp.resources.scripts.length) {
    for (const name of bp.resources.scripts) {
      if (name.endsWith('.js') || name.endsWith('.mjs')) files.set(`scripts/${name}`, renderScriptTemplate(bp));
    }
  }
  files.set('studio.json', `${JSON.stringify({ version: BLUEPRINT_VERSION, blueprint: bp, generatedAt: timeIso() }, null, 2)}\n`);
  return files;
}

/** 依据输入直接生成文件集合；供 scaffold、测试与页面预览复用。 */
export function buildSkillPackage(input) {
  const { blueprint, errors, warnings } = normalizeBlueprint(input);
  if (errors.length) return { ok: false, errors, warnings, blueprint };
  return { ok: true, errors: [], warnings, blueprint, files: generateSkillFiles(blueprint) };
}

/**
 * 从技能目录还原蓝图：优先读 studio.json；否则尽力从 SKILL.md 解析，
 * 便于编辑仓库里已有的技能。解码失败字段留空并标记 derived。
 */
export function readBlueprintFromSkill(skillDir) {
  const studioFile = path.join(skillDir, 'studio.json');
  if (existsSync(studioFile)) {
    try {
      const parsed = JSON.parse(readFileSync(studioFile, 'utf8'));
      if (parsed?.blueprint?.name) return { ok: true, blueprint: parsed.blueprint, derived: false };
    } catch {
      /* fall through */
    }
  }
  const skillFile = path.join(skillDir, 'SKILL.md');
  let text = '';
  try {
    text = readFileSync(skillFile, 'utf8');
  } catch {
    return { ok: false, error: 'SKILL.md 不存在' };
  }
  const parsed = parseFrontmatter(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const body = parsed.body || '';
  const section = (heading) => {
    const regex = new RegExp(`^##\\s*${heading}[\\s\\S]*?(?=^##\\s|$)`, 'mu');
    return regex.exec(body)?.[0] || '';
  };
  const bullet = (block, label) => {
    const match = new RegExp(`^-\\s*${label}[：:]\\s*(.*)$`, 'mu').exec(block);
    return match ? match[1].trim() : '';
  };
  const boundary = section('能力边界');
  const triggerBlock = section('适用场景');
  const triggerWords = bullet(triggerBlock, '触发词');
  const excludeWords = bullet(triggerBlock, '不触发');
  const splitWords = (value) =>
    value && !/^（未声明）$/u.test(value) && value !== '无'
      ? value.split(/[、,，]/u).map((item) => item.trim()).filter(Boolean)
      : [];
  const steps = [];
  for (const match of body.matchAll(/^###\s*\d+\.\s*(.+)$/gmu)) steps.push({ title: match[1].trim(), detail: '', command: '' });
  const fm = parsed.data || {};
  const metadata = isPlainObject(fm.metadata) ? fm.metadata : {};
  const input = {
    name: asString(fm.name),
    title: (body.match(/^#\s+(.+)$/mu)?.[1] || asString(fm.name)).trim(),
    description: asString(fm.description),
    whenToUse: asString(fm.whenToUse || metadata.whenToUse),
    problem: bullet(boundary, '解决的问题'),
    outOfScope: bullet(boundary, '不解决的问题（交给其他 skill）') || bullet(boundary, '不解决的问题'),
    triggers: { include: splitWords(triggerWords), exclude: splitWords(excludeWords) },
    inputs: asStringArray(metadata.inputs),
    outputs: asStringArray(metadata.outputs),
    permissions: (() => {
      const value = asString(metadata.permissions);
      const env = asString(metadata.env).split(',').map((item) => item.trim()).filter(Boolean);
      return {
        filesystem: /可写/u.test(value) ? 'write' : /只读/u.test(value) ? 'read' : 'none',
        network: /网络=是/u.test(value),
        shell: /Shell=是/u.test(value),
        env,
      };
    })(),
    steps,
    errorCodes: [],
    timeoutMs: Number(metadata.timeout_ms) || DEFAULT_TIMEOUT_MS,
    resources: {
      scripts: existsSync(path.join(skillDir, 'scripts'))
        ? readDirNames(path.join(skillDir, 'scripts')).filter((name) => /\.(?:mjs|js|py|sh)$/u.test(name))
        : [],
      references: existsSync(path.join(skillDir, 'references')) ? readDirNames(path.join(skillDir, 'references')) : [],
    },
  };
  const normalized = normalizeBlueprint(input);
  return { ok: true, blueprint: normalized.blueprint, derived: true, issues: normalized.errors };
}

function readDirNames(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
