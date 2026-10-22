/**
 * Skill Studio — 触发路由模拟器。
 *
 * 真实的 skill 路由由模型读取 catalog（只有 name + description）后决定；
 * 这里用确定性的词面匹配做回归模拟：重点不是“替代模型”，而是把
 * description 的可区分度、正例召回、负例误触量化成可比较的指标。
 *
 * 因此评分只使用 name + description（与 catalog 渲染一致），不使用
 * whenToUse、metadata 等模型看不到的字段；metadata 里的“不触发”短语
 * 只作为负向惩罚。
 */

const EN_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'from', 'at', 'as',
  'is', 'are', 'be', 'this', 'that', 'these', 'those', 'use', 'using', 'used', 'when', 'user',
  'users', 'it', 'its', 'or', 'not', 'for', 'you', 'your', 'we', 'our', 'they', 'their', 'can',
  'will', 'should', 'may', 'task', 'tasks', 'example', 'etc',
]);

const ZH_STOP_BIGRAMS = new Set([
  '使用', '用于', '可以', '需要', '进行', '通过', '一个', '这个', '那个', '以及', '或者', '并且',
  '我们', '你们', '他们', '如果', '因为', '所以', '但是', '然后', '已经', '没有', '不是', '就是',
  '什么', '怎么', '如何', '时候', '问题', '功能', '支持', '提供', '帮助', '相关', '进行',
]);

const CJK_RE = /[\u4e00-\u9fff]+/gu;
const EN_RE = /[a-z][a-z0-9_-]{1,}/gu;

function collectTerms(text, out, weightSink) {
  const source = String(text || '').toLowerCase();
  for (const match of source.matchAll(EN_RE)) {
    const word = match[0];
    if (EN_STOPWORDS.has(word) || word.length < 2) continue;
    addTerm(out, word, weightSink);
  }
  for (const match of source.matchAll(CJK_RE)) {
    const run = match[0];
    if (run.length <= 6) addTerm(out, run, weightSink);
    for (let size = 2; size <= 3; size += 1) {
      for (let index = 0; index + size <= run.length; index += 1) {
        const gram = run.slice(index, index + size);
        if (ZH_STOP_BIGRAMS.has(gram)) continue;
        addTerm(out, gram, weightSink);
      }
    }
  }
}

function addTerm(out, term, weightSink) {
  if (!out.has(term)) {
    out.set(term, 1);
    if (weightSink) weightSink.push(term);
  } else {
    out.set(term, out.get(term) + 1);
  }
}

/** 把文本切成检索词（英文词 + 中文 2/3-gram）。 */
export function tokenize(text) {
  const terms = new Map();
  collectTerms(text, terms);
  return terms;
}

export function tokenizeList(text) {
  return [...tokenize(text).keys()];
}

function skillText(skill) {
  return `${String(skill.name || '').replace(/-/gu, ' ')} ${skill.description || ''}`;
}

/** 解析 metadata.triggers 字符串（"触发：a、b；不触发：c"）。 */
export function parseTriggerMetadata(metadata) {
  const value = typeof metadata?.triggers === 'string' ? metadata.triggers : '';
  const include = [];
  const exclude = [];
  for (const part of value.split(/[；;]/u)) {
    const match = /^(触发|不触发)[：:]\s*(.*)$/u.exec(part.trim());
    if (!match) continue;
    const items = match[2]
      .split(/[、,，]/u)
      .map((item) => item.trim())
      .filter((item) => item && item !== '—' && item !== '无');
    if (match[1] === '触发') include.push(...items);
    else exclude.push(...items);
  }
  return { include, exclude };
}

export function buildIndex(skills) {
  const docs = skills.map((skill) => new Set(tokenizeList(skillText(skill))));
  const df = new Map();
  for (const doc of docs) {
    for (const term of doc) df.set(term, (df.get(term) || 0) + 1);
  }
  return { df, total: skills.length };
}

function idf(term, index) {
  const dfValue = index.df.get(term) || 0;
  return 1 + Math.log((index.total + 1) / (dfValue + 1));
}

/**
 * 短语覆盖率：把触发短语切成检索词，看 prompt 覆盖了多大比例。
 * 直接子串命中视为满覆盖；短短语（单词）降低权重，避免“灰度”这类泛词误触。
 */
function phraseCoverage(promptTerms, promptLower, phrase, index) {
  const normalized = String(phrase || '').trim().toLowerCase();
  if (normalized.length < 2) return 0;
  if (promptLower.includes(normalized)) return 1;
  const terms = tokenizeList(normalized);
  if (terms.length === 0) return 0;
  let total = 0;
  let hit = 0;
  for (const term of terms) {
    const weight = idf(term, index) * Math.max(1, term.length);
    total += weight;
    if (promptTerms.has(term)) hit += weight;
  }
  if (total === 0) return 0;
  const coverage = hit / total;
  const specificity = Math.min(1, 0.55 + 0.12 * terms.length);
  return coverage * specificity;
}

/** 给单个技能打分（0..1）。 */
export function scoreSkill(prompt, skill, index) {
  const promptTerms = tokenize(prompt);
  const promptTermSet = new Set(promptTerms.keys());
  const docTerms = new Set(tokenizeList(skillText(skill)));
  const triggers = parseTriggerMetadata(skill.metadata);
  let totalWeight = 0;
  let matchedWeight = 0;
  let matched = 0;
  for (const [term, count] of promptTerms) {
    const weight = idf(term, index) * Math.min(2, count);
    totalWeight += weight;
    if (docTerms.has(term)) {
      matchedWeight += weight;
      matched += 1;
    }
  }
  const lowerPrompt = String(prompt || '').toLowerCase();
  let phraseScore = 0;
  for (const phrase of triggers.include) {
    phraseScore = Math.max(phraseScore, phraseCoverage(promptTermSet, lowerPrompt, phrase, index));
  }
  let penalty = 0;
  for (const phrase of triggers.exclude) {
    if (phrase.length >= 2 && lowerPrompt.includes(phrase.toLowerCase())) penalty += 0.45;
  }
  const base = totalWeight > 0 ? matchedWeight / totalWeight : 0;
  const lengthPenalty = (skill.description || '').length > 500 ? 0.1 : 0;
  const score = triggers.include.length
    ? Math.max(base * 0.92, phraseScore * 0.7 + base * 0.3)
    : base * 0.92;
  return {
    score: Math.max(0, Math.min(1, score - penalty - lengthPenalty)),
    matched,
    terms: matched,
    phraseScore: Number(phraseScore.toFixed(3)),
  };
}

/** 对 prompt 排序所有技能。 */
export function rankSkills(prompt, skills) {
  const index = buildIndex(skills);
  const ranked = skills
    .map((skill) => ({ name: skill.name, ...scoreSkill(prompt, skill, index) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return ranked;
}

/**
 * 模拟一次路由。
 * @returns {{name: string|null, score: number, ranked: Array, reason: string}}
 */
export function route(prompt, skills, options = {}) {
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 0.22;
  const margin = Number.isFinite(options.margin) ? options.margin : 0.04;
  if (!skills || skills.length === 0) return { name: null, score: 0, ranked: [], reason: 'empty-catalog' };
  const ranked = rankSkills(prompt, skills);
  const top = ranked[0];
  if (!top || top.score < minScore) {
    return { name: null, score: top?.score || 0, ranked, reason: 'below-min-score' };
  }
  const second = ranked[1];
  if (second && top.score - second.score < margin) {
    return { name: top.name, score: top.score, ranked, reason: 'ambiguous-margin' };
  }
  return { name: top.name, score: top.score, ranked, reason: 'ok' };
}

/**
 * 评估触发用例。
 * cases: [{prompt, expect: string|null, note?}]
 *  - expect 为字符串：必须路由到该技能；
 *  - expect 为 null：必须不路由到被测技能（路由到别的技能也算通过）。
 */
export function evaluateTriggerCases(cases, skills, testSkillName, options = {}) {
  const results = [];
  let passed = 0;
  for (const item of Array.isArray(cases) ? cases : []) {
    const prompt = String(item?.prompt || '').trim();
    if (!prompt) {
      results.push({ prompt, expect: item?.expect ?? null, actual: null, pass: false, reason: 'empty-prompt', score: 0 });
      continue;
    }
    const routed = route(prompt, skills, options);
    const expect = item?.expect ?? null;
    const pass = expect === null ? routed.name !== testSkillName : routed.name === expect;
    if (pass) passed += 1;
    results.push({
      prompt,
      expect,
      actual: routed.name,
      score: Number(routed.score.toFixed(4)),
      pass,
      reason: routed.reason,
      note: item?.note || '',
    });
  }
  const total = results.length;
  return { total, passed, accuracy: total === 0 ? 0 : passed / total, results };
}

/** 描述相似度（Jaccard），用于重叠检测。 */
export function descriptionSimilarity(a, b) {
  const left = new Set(tokenizeList(a));
  const right = new Set(tokenizeList(b));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const term of left) if (right.has(term)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

/** description 质量提示：返回 [{code, message, level}]。 */
export function descriptionQuality(description, triggers = { include: [], exclude: [] }) {
  const issues = [];
  const text = String(description || '').trim();
  if (text.length < 24) issues.push({ code: 'TRIG001', level: 'error', message: 'description 过短，无法支撑路由' });
  if (text.length > 500) issues.push({ code: 'TRIG002', level: 'error', message: `description ${text.length} 字符，超过 catalog 上限 500，会被截断` });
  if (!/(use when|use for|when|用于|当|适用|触发)/iu.test(text)) {
    issues.push({ code: 'TRIG003', level: 'warn', message: 'description 缺少触发语境词（Use when / 用于 / 当…）' });
  }
  const include = triggers.include || [];
  if (include.length) {
    const lower = text.toLowerCase();
    const covered = include.filter((phrase) => phrase.length >= 2 && lower.includes(phrase.toLowerCase()));
    if (covered.length === 0) {
      issues.push({ code: 'TRIG004', level: 'error', message: '没有任何触发词出现在 description 里，模型无法据此路由' });
    } else if (covered.length < Math.ceil(include.length / 2)) {
      issues.push({ code: 'TRIG005', level: 'warn', message: `仅 ${covered.length}/${include.length} 个触发词出现在 description 里` });
    }
  }
  const generic = /^(help|assist|handle|process|manage|do|处理|帮助|管理)[\s\S]*$/iu.test(text) && text.length < 40;
  if (generic) issues.push({ code: 'TRIG006', level: 'warn', message: 'description 过于泛化，容易与其它 skill 误触' });
  return issues;
}
