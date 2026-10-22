/**
 * Skill Studio — SKILL.md frontmatter 的最小 YAML 子集读写。
 *
 * 只支持 DSH skill 实际会出现的形态：标量、一层/多层映射、标量数组、
 * `|` 与 `>` 块文本。不引入 YAML 依赖，保证插件零依赖、可离线测试。
 * 无法识别的语法按错误返回，绝不猜测。
 */

const KEY_RE = /^([A-Za-z0-9_.-][A-Za-z0-9_.-]*):(?:[ \t]+(.*))?$/u;
const LIST_RE = /^-[ \t]?(.*)$/u;

function stripComment(value) {
  // 仅在空白后的 # 视为注释，且值不是引号开头时。
  const index = value.search(/[ \t]#/u);
  if (index >= 0) return value.slice(0, index).trimEnd();
  return value;
}

function parseScalar(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/gu, "'");
  }
  const value = stripComment(trimmed);
  if (value === '') return '';
  if (/^(true|yes|on)$/iu.test(value)) return true;
  if (/^(false|no|off)$/iu.test(value)) return false;
  if (/^-?\d+$/u.test(value)) return Number.parseInt(value, 10);
  if (/^-?\d+\.\d+$/u.test(value)) return Number.parseFloat(value);
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => parseScalar(item.trim()));
  }
  return value;
}

function splitFrontmatter(text) {
  const source = String(text ?? '').replace(/^\uFEFF/u, '');
  const lines = source.split(/\r?\n/u);
  if (lines.length === 0 || lines[0].trim() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  return {
    frontmatterText: lines.slice(1, end).join('\n'),
    body: lines.slice(end + 1).join('\n').replace(/^\n+/u, ''),
    bodyLineOffset: end + 1,
  };
}

/** 解析 frontmatter 文本为对象；失败时抛出带位置信息的错误。 */
export function parseYamlSubset(frontmatterText) {
  const lines = String(frontmatterText ?? '').split(/\r?\n/u);
  let index = 0;

  const fail = (message) => {
    throw new Error(`frontmatter 第 ${index + 1} 行：${message}`);
  };

  const indentOf = (line) => {
    const match = /^( *)(\S.*)$/u.exec(line);
    if (!match) return { indent: -1, content: '' };
    return { indent: match[1].length, content: match[2] };
  };

  const skipBlank = () => {
    while (index < lines.length) {
      const trimmed = lines[index].trim();
      if (trimmed === '' || trimmed.startsWith('#')) index += 1;
      else break;
    }
  };

  const parseBlock = (minIndent) => {
    skipBlank();
    if (index >= lines.length) return undefined;
    const first = indentOf(lines[index]);
    if (first.indent < minIndent) return undefined;
    const indent = first.indent;
    const isList = LIST_RE.test(first.content);
    if (isList) {
      const array = [];
      while (index < lines.length) {
        skipBlank();
        if (index >= lines.length) break;
        const current = indentOf(lines[index]);
        if (current.indent < indent) break;
        if (current.indent !== indent || !LIST_RE.test(current.content)) break;
        const itemRaw = LIST_RE.exec(current.content)[1];
        index += 1;
        if (itemRaw.trim() === '') {
          const nested = parseBlock(indent + 1);
          array.push(nested === undefined ? null : nested);
          continue;
        }
        const nestedKey = KEY_RE.exec(itemRaw.trim());
        if (nestedKey) {
          // 列表项是映射：把当前行进位后递归解析比较麻烦，这里支持 "- key: value" 的简单映射。
          const object = {};
          const inlineValue = nestedKey[2];
          object[nestedKey[1]] = inlineValue === undefined || inlineValue.trim() === '' ? '' : parseScalar(inlineValue);
          array.push(object);
          continue;
        }
        array.push(parseScalar(itemRaw));
      }
      return array;
    }

    const object = {};
    while (index < lines.length) {
      skipBlank();
      if (index >= lines.length) break;
      const current = indentOf(lines[index]);
      if (current.indent < indent) break;
      if (current.indent !== indent) fail(`缩进不一致（期望 ${indent} 空格）`);
      const match = KEY_RE.exec(current.content);
      if (!match) fail(`无法识别的行：${current.content}`);
      const key = match[1];
      const rawValue = match[2] === undefined ? '' : match[2];
      index += 1;

      if (rawValue.trim() === '') {
        const nested = parseBlock(indent + 1);
        object[key] = nested === undefined ? '' : nested;
        continue;
      }
      if (/^[|>][+-]?$/u.test(rawValue.trim())) {
        const folded = rawValue.trim().startsWith('>');
        const blockLines = [];
        while (index < lines.length) {
          const line = lines[index];
          if (line.trim() === '') {
            blockLines.push('');
            index += 1;
            continue;
          }
          const blockIndent = /^( *)/u.exec(line)[1].length;
          if (blockIndent <= indent) break;
          blockLines.push(line.slice(Math.min(blockIndent, indent + 2)));
          index += 1;
        }
        object[key] = folded ? blockLines.join(' ').trim() : blockLines.join('\n').trim();
        continue;
      }
      object[key] = parseScalar(rawValue);
    }
    return object;
  };

  const result = parseBlock(0);
  skipBlank();
  if (index < lines.length) fail(`多余内容：${lines[index]}`);
  return result === undefined ? {} : result;
}

/** 解析整份 SKILL.md；没有 frontmatter 时返回 error。 */
export function parseFrontmatter(text) {
  const split = splitFrontmatter(text);
  if (!split) return { ok: false, error: '缺少 --- frontmatter --- 区块', data: null, body: String(text ?? '') };
  try {
    const data = parseYamlSubset(split.frontmatterText);
    return { ok: true, data, body: split.body, frontmatterText: split.frontmatterText };
  } catch (error) {
    return { ok: false, error: String(error?.message || error), data: null, body: split.body };
  }
}

const QUOTE_SAFE = /^[A-Za-z0-9_./@+-]+(?:\s+[A-Za-z0-9_./@+-]+)*$/u;

function formatScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value ?? '');
  if (text === '') return '""';
  if (/^(true|false|yes|no|on|off|null|-?\d+(?:\.\d+)?)$/iu.test(text)) return JSON.stringify(text);
  if (/^[|>{}\[\]&*!%@`#]/u.test(text) || /[:#\n\r\t]/u.test(text) || /^\s|\s$/u.test(text)) {
    return JSON.stringify(text);
  }
  if (!QUOTE_SAFE.test(text)) return JSON.stringify(text);
  return text;
}

/** 序列化为 frontmatter 文本（不含 --- 分隔行）。 */
export function serializeYamlSubset(value, indent = 0) {
  const pad = ' '.repeat(indent);
  const lines = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== null && typeof item === 'object') {
        const nested = serializeYamlSubset(item, indent + 2);
        const [firstLine, ...rest] = nested.split('\n');
        lines.push(`${pad}- ${firstLine.trimStart()}`);
        for (const line of rest) lines.push(line);
      } else {
        lines.push(`${pad}- ${formatScalar(item)}`);
      }
    }
    return lines.join('\n');
  }
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (item !== null && typeof item === 'object') {
      lines.push(`${pad}${key}:`);
      lines.push(serializeYamlSubset(item, indent + 2));
    } else {
      lines.push(`${pad}${key}: ${formatScalar(item)}`);
    }
  }
  return lines.join('\n');
}

export function renderSkillFile(frontmatter, body) {
  const head = serializeYamlSubset(frontmatter);
  const trimmedBody = String(body ?? '').replace(/^\n+/u, '').replace(/\s+$/u, '');
  return `---\n${head}\n---\n\n${trimmedBody}\n`;
}

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function isSkillName(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64 && SKILL_NAME_RE.test(value);
}
