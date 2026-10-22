/**
 * Skill Forge — 引导式技能制作台（原生 ES module，零构建）。
 *
 * 流程：首页 → 01 投入资料 → 02 能力边界 → 03 锻造生成 → 04 导出交付。
 * 每一步完成后才解锁下一步；右侧 OUTPUT 全程实时预览。
 */

const API = '/api';
const STORAGE_KEY = 'skillforge:draft:v2';
const STEP_COUNT = 4;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const ROLE_LABEL = { script: '脚本', reference: '参考', asset: '资源', test: '测试' };
const ROLE_DIR = { script: 'scripts', reference: 'references', asset: 'assets', test: 'tests' };
const TYPE_OPTIONS = ['string', 'file', 'folder', 'number', 'boolean'];
const CORE_FIELDS = 12;

const STEP_META = [
  {
    title: '投入资料',
    desc: '把制作这个 skill 需要的文件拖进来；也可以先跳过，下一步手动填写边界。',
    next: '下一步：能力边界',
    back: '返回首页',
  },
  {
    title: '能力边界',
    desc: '只解决一件事。这些字段会写进 SKILL.md，也是校验与路由的依据；补齐后进入生成。',
    next: '下一步：锻造生成',
    back: '上一步',
  },
  {
    title: '锻造生成',
    desc: '生成 SKILL.md、资源、测试规格与 studio.json，并跑一遍上线契约校验。',
    next: '下一步：导出交付',
    back: '上一步',
  },
  {
    title: '导出交付',
    desc: '技能包已经写好，下载 ZIP 或打开导出目录；也可以再做一个。',
    next: '再做一个',
    back: '上一步',
  },
];

const EMPTY_OUTPUT = {
  1: { title: '资料会变成什么', text: '文档会进 references/，脚本会进 scripts/，其他进 assets/。下一步会自动起草能力边界。' },
  2: { title: '等待生成', text: '填写左侧能力边界后，这里会实时出现 SKILL.md 预览。' },
  3: { title: '等待锻造', text: '点左侧「锻造技能包」，这里会显示文件树、校验结果和完整源码。' },
  4: { title: '技能包已生成', text: '可以查看文件与校验结果，或回到导出区下载 ZIP。' },
};

function defaultBlueprint() {
  return {
    name: '',
    title: '',
    description: '',
    whenToUse: '',
    problem: '',
    outOfScope: '',
    triggers: { include: [], exclude: [] },
    inputs: [{ name: 'source', type: 'file', description: '任务输入与原始资料' }],
    outputs: [{ name: 'skill-package', type: 'folder', description: '技能包（SKILL.md + 资源 + 测试规格）' }],
    permissions: { filesystem: 'read', network: false, shell: false, env: [] },
    steps: [
      { title: '确认输入与期望产物', detail: '核对资料是否覆盖任务所需信息，缺失时按错误码返回。', command: '' },
      { title: '按能力边界执行', detail: '严格按适用场景执行；越界时停止并说明原因。', command: '' },
    ],
    errorCodes: [
      { code: 'E_INPUT', meaning: '输入缺失或格式不符', handling: '指出缺失字段并停止执行' },
      { code: 'E_TIMEOUT', meaning: '执行超过超时限制', handling: '终止并返回超时错误，不重试有副作用的调用' },
    ],
    timeoutMs: 45000,
    version: 1,
    scriptName: '',
    overlaps: [],
  };
}

const state = {
  meta: null,
  view: 'welcome',
  step: 1,
  unlocked: 1,
  blueprint: defaultBlueprint(),
  files: [],
  preview: null,
  validation: null,
  build: null,
  tab: 'preview',
  selectedFile: 'SKILL.md',
  busy: false,
  genScript: true,
  ready: false,
  filesBytes: 0,
  autoPreviewDisabled: false,
  touched: new Set(),
  savedAt: 0,
  hasStoredDraft: false,
  homeDir: '',
};

let previewTimer = null;
let saveTimer = null;
let activePreviewToken = 0;

/* ---------------- utilities ---------------- */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

function displayPath(value) {
  const text = String(value || '');
  const home = state.homeDir;
  if (home && text.startsWith(home)) return `~${text.slice(home.length)}`;
  return text;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function base64FromBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function textFromB64(b64) {
  try {
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

const TEXT_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.json', '.jsonc', '.yaml', '.yml', '.js', '.mjs', '.cjs', '.ts',
  '.py', '.sh', '.bash', '.zsh', '.css', '.html', '.htm', '.csv', '.tsv', '.xml', '.toml',
  '.ini', '.cfg', '.conf', '.log', '.env', '.sql', '.rb', '.go', '.rs', '.java', '.kt',
  '.swift', '.lua', '.php', '.vue', '.jsx', '.tsx',
]);
const SCRIPT_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.py', '.sh', '.bash', '.zsh', '.rb', '.go', '.rs', '.lua', '.php']);

function extOf(name) {
  const base = String(name || '').toLowerCase();
  const index = base.lastIndexOf('.');
  return index > 0 ? base.slice(index) : '';
}

function autoRole(name) {
  const ext = extOf(name);
  if (SCRIPT_EXTENSIONS.has(ext)) return 'script';
  if (['.md', '.mdx', '.txt', '.json', '.yaml', '.yml', '.csv', '.tsv', '.xml'].includes(ext)) return 'reference';
  return 'asset';
}

function isTextName(name) {
  return TEXT_EXTENSIONS.has(extOf(name));
}

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/* ---------------- toast ---------------- */
function toast(message, { tone = 'info', timeout = 3800 } = {}) {
  const icons = { ok: '#i-check', err: '#i-warn', warn: '#i-warn', info: '#i-spark' };
  const wrap = $('#toast-wrap');
  const node = document.createElement('div');
  node.className = 'toast';
  node.dataset.tone = tone;
  node.innerHTML = `<svg><use href="${icons[tone] || icons.info}"/></svg><span>${escapeHtml(message)}</span>`;
  wrap.append(node);
  while (wrap.children.length > 3) wrap.firstElementChild.remove();
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 240);
  }, timeout);
}

/* ---------------- path + binding ---------------- */
function getPath(object, path) {
  return path.split('.').reduce((current, key) => (current == null ? undefined : current[key]), object);
}

function setPath(object, path, value) {
  const parts = path.split('.');
  let current = object;
  for (const key of parts.slice(0, -1)) {
    if (current[key] == null || typeof current[key] !== 'object') current[key] = {};
    current = current[key];
  }
  current[parts.at(-1)] = value;
}

function bindScalars() {
  $$('[data-bind]').forEach((element) => {
    const path = element.dataset.bind;
    element.addEventListener('input', () => {
      setPath(state.blueprint, path, element.value);
      state.touched.add(path);
      onBlueprintChanged();
    });
  });
  $$('[data-bind-list]').forEach((element) => {
    const path = element.dataset.bindList;
    element.addEventListener('input', () => {
      const list = element.value.split(/[、,，;；\n]/u).map((item) => item.trim()).filter(Boolean);
      setPath(state.blueprint, path, list);
      state.touched.add(path);
      onBlueprintChanged();
    });
  });
}

function syncForm() {
  $$('[data-bind]').forEach((element) => {
    const value = getPath(state.blueprint, element.dataset.bind);
    element.value = value ?? '';
  });
  $$('[data-bind-list]').forEach((element) => {
    const value = getPath(state.blueprint, element.dataset.bindList);
    element.value = Array.isArray(value) ? value.join('、') : value ?? '';
  });
  $('#f-network').checked = Boolean(state.blueprint.permissions?.network);
  $('#f-shell').checked = Boolean(state.blueprint.permissions?.shell);
  $('#f-timeout').value = Math.max(1, Math.round((state.blueprint.timeoutMs || 45000) / 1000));
  $('#f-version').value = state.blueprint.version || 1;
  $('#f-gen-script').checked = state.genScript;
  $$('#seg-filesystem button').forEach((button) => {
    button.dataset.active = String(button.dataset.value === (state.blueprint.permissions?.filesystem || 'none'));
  });
  renderRows();
  updateReadiness();
}

/* ---------------- repeatable rows ---------------- */
function emptyRowHint(text) {
  return `<div class="file-empty">${escapeHtml(text)}</div>`;
}

function ioRow(item, index) {
  const typeOptions = TYPE_OPTIONS.map(
    (type) => `<option value="${type}"${(item.type || 'string') === type ? ' selected' : ''}>${type}</option>`,
  ).join('');
  return `<div class="row row-io" data-index="${index}">
    <input class="input" data-field="name" value="${escapeHtml(item.name || '')}" placeholder="名称，例如 source">
    <select class="input" data-field="type">${typeOptions}</select>
    <button class="icon-btn" type="button" data-remove title="删除"><svg><use href="#i-trash"/></svg></button>
    <input class="input row-desc" data-field="description" value="${escapeHtml(item.description || '')}" placeholder="一句话说明">
  </div>`;
}

function renderRows() {
  const { inputs, outputs, steps, errorCodes } = state.blueprint;
  $('#rows-inputs').innerHTML = inputs.length ? inputs.map(ioRow).join('') : emptyRowHint('还没有输入，点下面添加');
  $('#rows-outputs').innerHTML = outputs.length ? outputs.map(ioRow).join('') : emptyRowHint('还没有输出，点下面添加');
  $('#rows-steps').innerHTML = steps.length
    ? steps.map((step, index) => `<div class="row step-row" data-index="${index}">
        <span class="row-index mono">${String(index + 1).padStart(2, '0')}</span>
        <div class="step-main">
          <div class="step-line">
            <input class="input" data-field="title" value="${escapeHtml(step.title || '')}" placeholder="步骤标题">
            <input class="input" data-field="detail" value="${escapeHtml(step.detail || '')}" placeholder="这一步做什么、注意什么">
          </div>
          <input class="input mono" data-field="command" value="${escapeHtml(step.command || '')}" placeholder="可选：可复现命令，例如 node scripts/x.mjs --input hi">
        </div>
        <button class="icon-btn" type="button" data-remove title="删除"><svg><use href="#i-trash"/></svg></button>
      </div>`).join('')
    : emptyRowHint('至少需要 2 个步骤');
  $('#rows-errors').innerHTML = errorCodes.length
    ? errorCodes.map((item, index) => `<div class="row row-err" data-index="${index}">
        <input class="input mono" data-field="code" value="${escapeHtml(item.code || '')}" placeholder="E_CODE">
        <input class="input" data-field="meaning" value="${escapeHtml(item.meaning || '')}" placeholder="含义">
        <input class="input err-handling" data-field="handling" value="${escapeHtml(item.handling || '')}" placeholder="如何处理">
        <button class="icon-btn" type="button" data-remove title="删除"><svg><use href="#i-trash"/></svg></button>
      </div>`).join('')
    : emptyRowHint('至少声明一个错误码');
}

function bindRowContainer(selector, listKey) {
  const container = $(selector);
  container.addEventListener('input', (event) => {
    const row = event.target.closest('.row');
    if (!row) return;
    const field = event.target.dataset.field;
    if (!field) return;
    state.blueprint[listKey][Number(row.dataset.index)][field] = event.target.value;
    state.touched.add(listKey);
    onBlueprintChanged({ skipRows: true });
  });
  container.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove]');
    if (!button) return;
    const row = button.closest('.row');
    state.blueprint[listKey].splice(Number(row.dataset.index), 1);
    state.touched.add(listKey);
    renderRows();
    onBlueprintChanged({ skipRows: true });
  });
}

function bindAddButtons() {
  $$('[data-add]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.add;
      if (key === 'inputs') state.blueprint.inputs.push({ name: '', type: 'string', description: '' });
      if (key === 'outputs') state.blueprint.outputs.push({ name: '', type: 'string', description: '' });
      if (key === 'steps') state.blueprint.steps.push({ title: '', detail: '', command: '' });
      if (key === 'errorCodes') state.blueprint.errorCodes.push({ code: '', meaning: '', handling: '' });
      state.touched.add(key);
      renderRows();
      onBlueprintChanged({ skipRows: true });
      $$(`#rows-${key} .row`).at(-1)?.querySelector('input')?.focus();
    });
  });
}

/* ---------------- readiness ---------------- */
function readinessChecks() {
  const bp = state.blueprint;
  const fs = bp.permissions?.filesystem;
  const missing = [];
  const check = (ok, label) => {
    if (!ok) missing.push(label);
    return ok;
  };
  const score = [
    check(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(bp.name || ''), '技能名'),
    check(Boolean((bp.title || '').trim()), '显示标题'),
    check((bp.description || '').length >= 24 && (bp.description || '').length <= 500, '一句话描述（≥24 字符）'),
    check(Boolean((bp.whenToUse || '').trim()), '适用场景'),
    check(Boolean((bp.problem || '').trim()), '解决的问题'),
    check(Boolean((bp.outOfScope || '').trim()), '不解决什么'),
    check((bp.triggers?.include || []).length > 0, '触发词'),
    check((bp.inputs || []).length > 0, '输入'),
    check((bp.outputs || []).length > 0, '输出'),
    check((fs && fs !== 'none') || bp.permissions?.network || bp.permissions?.shell || (bp.permissions?.env || []).length, '权限边界'),
    check((bp.steps || []).length >= 2, '至少 2 个步骤'),
    check((bp.errorCodes || []).length > 0, '错误码'),
  ].filter(Boolean).length;
  return { score, missing };
}

function updateReadiness() {
  const { score, missing } = readinessChecks();
  const nameValid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(state.blueprint.name || '');
  const hint = $('#hint-name');
  if (!state.blueprint.name) {
    hint.textContent = '小写字母、数字、连字符；会作为安装目录名。';
    hint.removeAttribute('data-tone');
  } else if (!nameValid) {
    hint.textContent = '必须是 kebab-case：小写字母/数字，用 - 连接。';
    hint.dataset.tone = 'err';
  } else {
    hint.textContent = `将安装为 ~/.agents/skills/${state.blueprint.name}`;
    hint.dataset.tone = 'ok';
  }
  const description = state.blueprint.description || '';
  const counter = $('#desc-counter');
  counter.textContent = `${description.length} / 500`;
  counter.dataset.tone = description.length > 0 && description.length < 24 ? 'warn' : 'none';
  $('#hint-desc').textContent =
    description.length > 0 && description.length < 24
      ? `还差 ${24 - description.length} 个字符达到最小长度`
      : 'catalog 只渲染 name + description；触发词必须能在这段话里被看到。';
  return { score, missing };
}

/* ---------------- view / step chrome ---------------- */
function setView(view) {
  state.view = view;
  $('#view-welcome').classList.toggle('hidden', view !== 'welcome');
  $('#view-wizard').classList.toggle('hidden', view !== 'wizard');
  $('#shell').classList.toggle('is-wizard', view === 'wizard');
  $('#topbar-progress').classList.toggle('hidden', view !== 'wizard');
  $('#btn-home').classList.toggle('hidden', view !== 'wizard');
  if (view === 'welcome') renderResume();
}

function renderResume() {
  const bar = $('#resume-bar');
  const bp = state.blueprint;
  const hasContent = Boolean((bp.name || '').trim() || (bp.title || '').trim() || (bp.description || '').trim());
  const hasSomething = hasContent || state.files.length > 0 || Boolean(state.build);
  if (!state.hasStoredDraft || !hasSomething || state.view !== 'welcome') {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  $('#resume-name').textContent = bp.name || bp.title || `${state.files.length} 个资料`;
  const when = state.savedAt ? new Date(state.savedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '';
  $('#resume-meta').textContent = `第 ${state.step} 步${when ? ` · 保存于 ${when}` : ''}`;
}

function goStep(step, { force = false } = {}) {
  const target = Math.min(STEP_COUNT, Math.max(1, Number(step) || 1));
  if (!force && target > state.unlocked) {
    toast('先完成当前步骤，再进入下一步', { tone: 'warn' });
    return;
  }
  state.step = target;
  state.unlocked = Math.max(state.unlocked, target);
  state.preview && (state.tab = state.tab);
  setView('wizard');
  updateStepChrome();
  renderOutputEmptyMode();
  if (target === 2) {
    syncForm();
    if (hasContent()) runPreview({ validate: true });
  }
  if (target === 3) {
    renderBuildResult();
    if (!state.build && hasContent()) runPreview({ validate: true });
  }
  if (target === 4) {
    updateExportUi();
    setTab('files');
  }
  $('#stage-body').scrollTop = 0;
  closeDrawer();
  scheduleSave();
  renderResume();
}

function updateStepChrome() {
  const meta = STEP_META[state.step - 1];
  $('#stage-kicker').textContent = `STEP 0${state.step} / 04`;
  $('#stage-title').textContent = meta.title;
  $('#stage-desc').textContent = meta.desc;
  $('#topbar-step-label').textContent = `STEP ${state.step} / ${STEP_COUNT}`;
  $('#topbar-progress-fill').style.width = `${(state.step / STEP_COUNT) * 100}%`;
  $('#nav-progress-fill').style.width = `${(state.step / STEP_COUNT) * 100}%`;
  $$('[data-step-screen]').forEach((el) => el.classList.toggle('hidden', Number(el.dataset.stepScreen) !== state.step));

  const { score, missing } = updateReadiness();
  const validation = state.build?.validation || state.validation;
  const errors = validation?.errors?.length ?? 0;
  const warnings = validation?.warnings?.length ?? 0;
  const badge = $('#stage-badge');
  if (state.step === 1) {
    badge.textContent = `${state.files.length} 个文件 · ${formatBytes(state.filesBytes)}`;
    badge.dataset.tone = state.files.length ? 'ok' : 'none';
  } else if (state.step === 2) {
    badge.textContent = `${score} / ${CORE_FIELDS} 完整度`;
    badge.dataset.tone = missing.length ? (score >= 8 ? 'warn' : 'err') : 'ok';
  } else if (state.step === 3) {
    badge.textContent = state.build ? `已生成 · ${errors} 错误 / ${warnings} 警告` : '待生成';
    badge.dataset.tone = state.build ? (errors ? 'warn' : 'ok') : 'none';
  } else {
    badge.textContent = state.build ? (errors ? `${errors} 个错误` : '已通过校验') : '未生成';
    badge.dataset.tone = state.build ? (errors ? 'warn' : 'ok') : 'none';
  }

  const railButtons = $$('.rail-step');
  railButtons.forEach((button) => {
    const n = Number(button.dataset.stepGo);
    button.classList.toggle('is-active', n === state.step);
    button.classList.toggle('is-done', n < state.step || (n === 2 && !missing.length));
    button.classList.toggle('is-locked', n > state.unlocked);
  });
  $$('#mobile-steps button').forEach((button) => {
    const n = Number(button.dataset.stepGo);
    button.dataset.active = String(n === state.step);
    button.dataset.done = String(n < state.step);
    button.dataset.locked = String(n > state.unlocked);
  });

  const action = $('#stage-action');
  const actionLabel = action.querySelector('span');
  if (state.step === 2) {
    action.classList.remove('hidden');
    actionLabel.textContent = '从资料重新起草';
    action.disabled = !state.files.some((file) => file.text);
  } else {
    action.classList.add('hidden');
  }

  const buildLabel = $('#btn-build')?.querySelector('span');
  if (buildLabel) buildLabel.textContent = state.build ? '重新生成' : '锻造技能包';

  const missingBox = $('#missing-box');
  if (state.step === 2 && missing.length) {
    missingBox.classList.remove('hidden');
    $('#missing-list').innerHTML = missing.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  } else {
    missingBox.classList.add('hidden');
  }

  const back = $('#btn-back');
  back.querySelector('span').textContent = meta.back;
  const next = $('#btn-next');
  next.querySelector('span').textContent = meta.next;
  let disabled = false;
  let hint = '';
  let tone = '';
  if (state.step === 1) {
    hint = state.files.length ? `已投入 ${state.files.length} 个文件 · ${formatBytes(state.filesBytes)}，可以继续` : '没有资料也能继续，下一步手动填边界';
    tone = state.files.length ? 'ok' : '';
  } else if (state.step === 2) {
    if (missing.length) {
      disabled = true;
      hint = `还差 ${missing.length} 项：${missing.slice(0, 3).join('、')}${missing.length > 3 ? '…' : ''}`;
      tone = 'warn';
    } else {
      hint = '边界完整，可以生成';
      tone = 'ok';
    }
  } else if (state.step === 3) {
    if (!state.build) {
      disabled = true;
      hint = '先生成技能包，再进入导出';
    } else {
      hint = errors ? `已生成，但有 ${errors} 个校验错误，建议返回修改` : '生成成功，可以导出';
      tone = errors ? 'warn' : 'ok';
    }
  } else {
    hint = state.build ? `ZIP ${state.build.zipName} · ${formatBytes(state.build.zipBytes)}` : '还没有生成技能包';
    tone = state.build ? 'ok' : 'warn';
  }
  next.disabled = disabled || state.busy;
  const hintNode = $('#nav-hint');
  hintNode.textContent = hint;
  hintNode.dataset.tone = tone;
}

function hasContent() {
  return Boolean((state.blueprint.name || '').trim() || (state.blueprint.title || '').trim() || (state.blueprint.description || '').trim());
}

/* ---------------- preview ---------------- */
function wireFiles() {
  return state.files.map((file) => ({ name: file.name, role: file.role, b64: file.b64 }));
}

function payload(validate) {
  return JSON.stringify({
    blueprint: state.blueprint,
    files: wireFiles(),
    options: { generateScript: state.genScript },
    validate,
  });
}

function setOutputState(kind, text) {
  const node = $('#output-state');
  node.dataset.state = kind;
  node.textContent = text;
}

async function runPreview({ validate = true, silent = true } = {}) {
  if (!state.ready) return;
  if (!hasContent()) {
    state.preview = null;
    state.validation = null;
    renderOutput();
    return;
  }
  const token = ++activePreviewToken;
  setOutputState('busy', 'COMPILING');
  try {
    const response = await fetch(`${API}/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload(validate),
    });
    const data = await response.json();
    if (token !== activePreviewToken) return;
    state.preview = data;
    state.validation = data.validation || null;
    if (!(data.ok && data.files?.some((file) => file.path === state.selectedFile))) {
      state.selectedFile = 'SKILL.md';
    }
    renderOutput();
    renderBuildResult();
    updateStepChrome();
    if (!data.ok && !silent) toast(`组装失败：${(data.errors || [])[0]?.message || '检查表单'}`, { tone: 'err' });
  } catch (error) {
    if (token !== activePreviewToken) return;
    setOutputState('err', 'OFFLINE');
    toast(`预览失败：${error.message}`, { tone: 'err' });
  }
}

const schedulePreview = debounce(() => {
  if (state.filesBytes > 6 * 1024 * 1024) {
    if (!state.autoPreviewDisabled) {
      state.autoPreviewDisabled = true;
      toast('资料较大，已关闭自动预览；点「只校验」手动刷新。', { tone: 'warn' });
    }
    return;
  }
  if (state.view === 'wizard' && state.step >= 2) runPreview({ validate: true });
}, 750);

function onBlueprintChanged({ skipRows = false, skipPreview = false } = {}) {
  updateReadiness();
  updateStepChrome();
  scheduleSave();
  if (!skipPreview) schedulePreview();
}

/* ---------------- materials ---------------- */
function roleTarget(file) {
  return `${ROLE_DIR[file.role] || 'assets'}/${file.name}`;
}

function renderFiles() {
  const list = $('#file-list');
  if (!state.files.length) {
    list.innerHTML = '<div class="file-empty">还没有资料。没有资料也能继续，下一步手动填写能力边界；有资料时「从资料自动起草」会更快。</div>';
    return;
  }
  list.innerHTML = state.files
    .map((file) => {
      const icon = file.role === 'script' ? '#i-terminal' : file.role === 'asset' ? '#i-package' : file.role === 'test' ? '#i-shield' : '#i-file';
      const options = Object.entries(ROLE_LABEL)
        .map(([value, label]) => `<option value="${value}"${file.role === value ? ' selected' : ''}>${label}</option>`)
        .join('');
      return `<div class="file-item" data-id="${file.id}">
        <div class="file-icon" data-role="${file.role}"><svg><use href="${icon}"/></svg></div>
        <div class="file-copy">
          <span class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
          <span class="file-meta">${formatBytes(file.bytes)}${file.binary ? ' · 二进制' : ' · 文本'} · <span class="file-target">${escapeHtml(roleTarget(file))}</span></span>
        </div>
        <div class="file-role"><select data-action="role" aria-label="文件角色">${options}</select></div>
        <button class="icon-btn" type="button" data-action="remove" title="移除"><svg><use href="#i-trash"/></svg></button>
      </div>`;
    })
    .join('');
}

function updateMaterialsUi() {
  state.filesBytes = state.files.reduce((sum, file) => sum + file.bytes, 0);
  const hasText = state.files.some((file) => file.text);
  $('#btn-draft').disabled = !hasText;
  $('#materials-hint').textContent = state.files.length
    ? `共 ${state.files.length} 个文件，${formatBytes(state.filesBytes)}；可改角色或移除。`
    : '自动分配：脚本 → scripts/，文档 → references/，其他 → assets/';
  updateStepChrome();
}

async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  for (const file of files) {
    if (state.files.length >= 40) {
      toast('资料最多 40 个文件', { tone: 'warn' });
      break;
    }
    if (file.size > 4 * 1024 * 1024) {
      toast(`「${file.name}」超过 4 MB，已跳过`, { tone: 'warn' });
      continue;
    }
    const buffer = await file.arrayBuffer();
    const b64 = base64FromBuffer(buffer);
    const text = isTextName(file.name) ? new TextDecoder('utf-8', { fatal: false }).decode(buffer) : null;
    state.files.push({
      id: crypto.randomUUID ? crypto.randomUUID() : `f-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: file.name.replace(/\s+/gu, '-'),
      role: autoRole(file.name),
      b64,
      bytes: file.size,
      text,
      binary: text === null,
    });
  }
  renderFiles();
  updateMaterialsUi();
  state.autoPreviewDisabled = false;
  scheduleSave();
  schedulePreview();
}

function addPastedMaterial() {
  const textarea = $('#paste-text');
  const text = textarea.value.trim();
  if (!text) {
    toast('先粘贴一段资料', { tone: 'warn' });
    return;
  }
  const buffer = new TextEncoder().encode(text).buffer;
  state.files.push({
    id: crypto.randomUUID ? crypto.randomUUID() : `f-${Date.now()}`,
    name: `notes-${state.files.length + 1}.md`,
    role: 'reference',
    b64: base64FromBuffer(buffer),
    bytes: buffer.byteLength,
    text,
    binary: false,
  });
  textarea.value = '';
  renderFiles();
  updateMaterialsUi();
  scheduleSave();
  schedulePreview();
  toast('已加入资料', { tone: 'ok' });
}

async function readEntry(entry, prefix, out, depth = 0) {
  if (out.length >= 80 || depth > 6) return;
  if (entry.isFile) {
    try {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ file, path: `${prefix}${entry.name}` });
    } catch {
      /* 跳过不可读文件 */
    }
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  const children = await new Promise((resolve) => {
    const all = [];
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (!batch.length) {
          resolve(all);
          return;
        }
        all.push(...batch);
        readBatch();
      }, () => resolve(all));
    };
    readBatch();
  });
  for (const child of children) await readEntry(child, `${prefix}${entry.name}/`, out, depth + 1);
}

async function filesFromDataTransfer(dataTransfer) {
  const items = [...(dataTransfer?.items || [])];
  const entries = items.map((item) => {
    try {
      return item.webkitGetAsEntry?.();
    } catch {
      return null;
    }
  });
  if (entries.some(Boolean)) {
    const out = [];
    for (const entry of entries) if (entry) await readEntry(entry, '', out);
    if (out.length) return out;
  }
  return [...(dataTransfer?.files || [])].map((file) => ({ file, path: file.name }));
}

function bindMaterials() {
  const dropzone = $('#dropzone');
  const input = $('#file-input');
  dropzone.addEventListener('click', () => input.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    addFiles(files);
  });
  ['dragenter', 'dragover'].forEach((type) =>
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('dragover');
    }),
  );
  ['dragleave', 'drop'].forEach((type) =>
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      if (type === 'dragleave' && dropzone.contains(event.relatedTarget)) return;
      dropzone.classList.remove('dragover');
    }),
  );
  dropzone.addEventListener('drop', async (event) => {
    const dropped = await filesFromDataTransfer(event.dataTransfer);
    if (!dropped.length) return;
    const looksLikeSkill = dropped.some((item) => /(^|\/)SKILL\.md$/iu.test(item.path));
    if (looksLikeSkill) {
      importSkillEntries(dropped);
      return;
    }
    addFiles(dropped.map((item) => item.file));
  });
  $('#file-list').addEventListener('change', (event) => {
    const select = event.target.closest('[data-action="role"]');
    if (!select) return;
    const id = select.closest('.file-item').dataset.id;
    const file = state.files.find((item) => item.id === id);
    if (!file) return;
    file.role = select.value;
    renderFiles();
    updateMaterialsUi();
    scheduleSave();
    schedulePreview();
  });
  $('#file-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-action="remove"]');
    if (!button) return;
    const id = button.closest('.file-item').dataset.id;
    state.files = state.files.filter((item) => item.id !== id);
    renderFiles();
    updateMaterialsUi();
    scheduleSave();
    schedulePreview();
  });
  $('#btn-add-paste').addEventListener('click', addPastedMaterial);
}

/* ---------------- draft / import / example ---------------- */
async function runDraft({ advance = false, quiet = false } = {}) {
  const materials = state.files.filter((file) => file.text).map((file) => ({ name: file.name, text: file.text }));
  if (!materials.length) {
    toast('没有可读的文本资料；先添加 md / txt / 代码文件', { tone: 'warn' });
    return false;
  }
  const button = state.step === 1 ? $('#btn-draft') : $('#stage-action');
  setBusy(button, true, '起草中');
  try {
    const response = await fetch(`${API}/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ materials }),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || '起草失败');
    const draft = data.draft;
    const current = state.blueprint;
    const next = {
      ...current,
      ...draft,
      triggers: { include: [...(draft.triggers?.include || [])], exclude: [...(draft.triggers?.exclude || [])] },
      permissions: { ...current.permissions, ...(draft.permissions || {}) },
    };
    for (const path of state.touched) {
      const value = getPath(current, path);
      if (value !== undefined) setPath(next, path, JSON.parse(JSON.stringify(value)));
    }
    state.blueprint = next;
    syncForm();
    updateReadiness();
    updateStepChrome();
    scheduleSave();
    if (!quiet) {
      toast(
        `已按 ${materials.length} 份资料起草：${data.insights?.triggers?.length || 0} 个触发词、${data.insights?.steps || 0} 个步骤`,
        { tone: 'ok' },
      );
    }
    if (advance) goStep(2, { force: true });
    return true;
  } catch (error) {
    toast(`起草失败：${error.message}`, { tone: 'err' });
    return false;
  } finally {
    setBusy(button, false);
  }
}

function applyBlueprint(blueprint) {
  const normalized = {
    ...defaultBlueprint(),
    ...blueprint,
    triggers: { include: [], exclude: [], ...(blueprint.triggers || {}) },
    permissions: { filesystem: 'none', network: false, shell: false, env: [], ...(blueprint.permissions || {}) },
    inputs: (blueprint.inputs || []).map((item) => ({ ...item })),
    outputs: (blueprint.outputs || []).map((item) => ({ ...item })),
    steps: (blueprint.steps || []).map((item) => ({ ...item })),
    errorCodes: (blueprint.errorCodes || []).map((item) => ({ ...item })),
    overlaps: (blueprint.overlaps || []).map((item) => (typeof item === 'string' ? item : item.skill)).filter(Boolean),
  };
  state.blueprint = normalized;
  state.touched.clear();
  syncForm();
  updateReadiness();
  updateStepChrome();
  scheduleSave();
}

async function importSkill(inputFiles) {
  const files = [...inputFiles];
  const entries = files.map((file) => ({ file, path: file.webkitRelativePath || file.name }));
  return importSkillEntries(entries);
}

async function importSkillEntries(entries) {
  if (!entries.length) return false;
  const payloadFiles = [];
  for (const { file, path: relativePath } of entries) {
    const buffer = await file.arrayBuffer();
    payloadFiles.push({ name: file.name, path: relativePath || file.webkitRelativePath || file.name, b64: base64FromBuffer(buffer) });
  }
  const button = $('#btn-import');
  setBusy(button, true, '解析中');
  try {
    const response = await fetch(`${API}/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: payloadFiles }),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || '解析失败');
    state.blueprint = defaultBlueprint();
    state.files = [];
    state.preview = null;
    state.validation = null;
    state.build = null;
    state.touched.clear();
    applyBlueprint(data.blueprint);
    state.files = (data.uploads || []).map((item, index) => ({
      id: `import-${index}-${Date.now()}`,
      name: item.name,
      role: item.role || autoRole(item.name),
      b64: item.b64,
      bytes: item.bytes,
      text: isTextName(item.name) ? textFromB64(item.b64) : null,
      binary: !isTextName(item.name),
    }));
    renderFiles();
    updateMaterialsUi();
    state.unlocked = Math.max(state.unlocked, 2);
    goStep(2, { force: true });
    await runPreview({ validate: true });
    const issueCount = (data.issues || []).length;
    toast(
      `已导入「${data.blueprint?.name}」：${data.derived ? '从 SKILL.md 解析' : '从 studio.json 还原'}，${state.files.length} 个资源${issueCount ? `；${issueCount} 个字段待补` : ''}`,
      { tone: issueCount ? 'warn' : 'ok' },
    );
    scheduleSave();
    return true;
  } catch (error) {
    toast(`导入失败：${error.message}`, { tone: 'err' });
    return false;
  } finally {
    setBusy(button, false);
  }
}

function loadExample({ quiet = false } = {}) {
  const sample = state.meta?.sample;
  if (!sample) {
    toast('没有内置示例', { tone: 'warn' });
    return;
  }
  resetProject({ persist: false });
  applyBlueprint(JSON.parse(JSON.stringify(sample)));
  state.unlocked = Math.max(state.unlocked, 2);
  goStep(2, { force: true });
  runPreview({ validate: true });
  scheduleSave();
  if (!quiet) toast('已载入内置示例「skill-studio」', { tone: 'ok' });
}

/* ---------------- output rendering ---------------- */
function currentFiles() {
  return state.preview?.files || state.build?.files || [];
}

function currentSkillMarkdown() {
  const files = currentFiles();
  const skill = files.find((file) => file.path === 'SKILL.md');
  return skill?.text || state.preview?.skillMarkdown || '';
}

function dedupeIssues(list) {
  const seen = new Set();
  return (list || []).filter((item) => {
    const key = `${item.code}|${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function issueLists() {
  const validation = state.validation || state.build?.validation || null;
  const errors = dedupeIssues([...(validation?.errors || []), ...(state.preview?.errors || [])]);
  const warnings = dedupeIssues([...(validation?.warnings || []), ...(state.preview?.warnings || []), ...(state.build?.warnings || [])]);
  return { validation, errors, warnings };
}

function renderOutputEmptyMode() {
  if (currentFiles().length) return;
  if (state.tab !== 'preview') return;
  const info = EMPTY_OUTPUT[state.step] || EMPTY_OUTPUT[1];
  const body = $('#output-body');
  if (!body.querySelector('.output-empty')) return;
  body.innerHTML = `<div class="output-empty">
    <div class="empty-grid" aria-hidden="true"></div>
    <div class="empty-orb large"><svg><use href="#i-spark"/></svg></div>
    <h3>${escapeHtml(info.title)}</h3>
    <p>${escapeHtml(info.text)}</p>
  </div>`;
}

function renderOutput() {
  const files = currentFiles();
  const { validation, errors, warnings } = issueLists();
  const errorCount = errors.length;
  const warnCount = warnings.length;
  $('#tab-count-files').textContent = files.length;
  $('#tab-count-files').dataset.tone = files.length ? 'ok' : 'none';
  const checkNode = $('#tab-count-check');
  checkNode.textContent = errorCount + warnCount;
  checkNode.dataset.tone = errorCount ? 'err' : warnCount ? 'warn' : 'ok';
  $('#sb-ready').textContent = errorCount ? `${errorCount} 个错误待修` : warnings.length ? `可生成 · ${warnCount} 个警告` : files.length ? '校验通过' : '就绪';
  $('#sb-ready').dataset.tone = errorCount ? 'err' : files.length ? 'ok' : 'none';
  if (files.length) setOutputState(errorCount ? 'err' : 'ok', errorCount ? 'CHECK FAILED' : 'READY');
  updateStats(validation, errors, warnings);
  updateExportUi();
  renderOutputBody();
  renderOutputEmptyMode();
}

function updateStats(validation, errors, warnings) {
  const files = currentFiles();
  const bytes = files.reduce((sum, file) => sum + (file.bytes || 0), 0);
  $('#gen-files').textContent = files.length || '—';
  $('#gen-bytes').textContent = files.length ? formatBytes(bytes) : '—';
  $('#gen-errors').textContent = files.length || validation ? errors.length : '—';
  $('#gen-warnings').textContent = files.length || validation ? warnings.length : '—';
  $('#output-summary').textContent = files.length
    ? `${errors.length} ERR · ${warnings.length} WARN · ${files.length} FILES · ${formatBytes(bytes)}`
    : 'NO OUTPUT';
}

function updateExportUi() {
  const build = state.build;
  $('#export-empty').classList.toggle('hidden', Boolean(build));
  $('#export-result').classList.toggle('hidden', !build);
  if (!build) {
    $('#btn-download-icon').classList.add('hidden');
    return;
  }
  $('#export-name').textContent = build.zipName;
  $('#export-meta').textContent = `${build.files?.length || 0} files · ${formatBytes(build.zipBytes)} · ${build.validation?.ok ? '校验通过' : `${build.validation?.errors?.length || 0} errors`}`;
  $('#export-path').textContent = displayPath(build.dir);
  $('#export-hint').textContent = `ZIP 解压后是 ${build.zipName.replace(/\.zip$/u, '')}/ 目录，可直接放进 ~/.agents/skills 或项目 .agents/skills。`;
  $('#btn-download').href = build.zipUrl;
  $('#btn-download-icon').href = build.zipUrl;
  $('#btn-download-icon').classList.remove('hidden');
}

function renderOutputBody() {
  const body = $('#output-body');
  if (state.tab === 'check') {
    renderCheck(body);
    return;
  }
  const files = currentFiles();
  if (!files.length) {
    const { errors } = issueLists();
    if (errors.length) {
      body.innerHTML = `<div class="check-list">${errors.map((item) => checkItem(item)).join('')}</div>`;
      setOutputState('err', 'INCOMPLETE');
      return;
    }
    const info = EMPTY_OUTPUT[state.step] || EMPTY_OUTPUT[1];
    body.innerHTML = `<div class="output-empty">
      <div class="empty-grid" aria-hidden="true"></div>
      <div class="empty-orb large"><svg><use href="#i-spark"/></svg></div>
      <h3>${escapeHtml(info.title)}</h3>
      <p>${escapeHtml(info.text)}</p>
    </div>`;
    return;
  }
  if (state.tab === 'preview') {
    const source = currentSkillMarkdown();
    const frontmatterMatch = /^---\n([\s\S]*?)\n---\n?/u.exec(source);
    const bodySource = frontmatterMatch ? source.slice(frontmatterMatch[0].length) : source;
    body.innerHTML = `<div class="md">${renderMarkdown(bodySource)}</div>`;
    return;
  }
  if (state.tab === 'source') {
    const selected = files.find((file) => file.path === state.selectedFile) || files[0];
    state.selectedFile = selected.path;
    body.innerHTML = `<div class="code-wrap">
      <div class="code-bar"><span class="file-chip">${escapeHtml(selected.path)}</span><span>${formatBytes(selected.bytes)}</span>${selected.binary ? '<span>二进制文件不展示内容</span>' : ''}</div>
      ${selected.binary ? '<div class="file-empty">这是二进制文件，不展示内容。</div>' : renderCode(selected.text || '')}
    </div>`;
    return;
  }
  if (state.tab === 'files') {
    body.innerHTML = renderTree(files);
    return;
  }
  renderCheck(body);
}

function kindIcon(kind) {
  return { doc: '#i-file', manifest: '#i-shield', script: '#i-terminal', reference: '#i-file', asset: '#i-package', test: '#i-shield', other: '#i-file' }[kind] || '#i-file';
}

function renderTree(files) {
  const order = ['', 'scripts', 'references', 'assets', 'tests'];
  const groups = new Map();
  for (const file of files) {
    const parts = file.path.split('/');
    const dir = parts.length > 1 ? parts[0] : '';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(file);
  }
  const sorted = [...groups.entries()].sort((a, b) => {
    const ai = order.indexOf(a[0]);
    const bi = order.indexOf(b[0]);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  return `<div class="tree">${sorted
    .map(
      ([dir, items]) => `<div class="tree-group">
        <div class="tree-group-title"><svg><use href="#i-folder"/></svg>${dir ? `${dir}/` : 'skill root'}</div>
        ${items
          .map(
            (file) => `<button class="tree-file" type="button" data-file="${escapeHtml(file.path)}" data-active="${state.selectedFile === file.path}">
              <svg><use href="${kindIcon(file.kind)}"/></svg>
              <span>${escapeHtml(file.path.split('/').slice(1).join('/') || file.path)}</span>
              <span class="size">${formatBytes(file.bytes)}</span>
            </button>`,
          )
          .join('')}
      </div>`,
    )
    .join('')}</div>`;
}

function checkItem(item) {
  const level = item.level || 'error';
  return `<div class="check-item" data-level="${level}">
    <span class="code-tag">${escapeHtml(item.code || 'ISSUE')}</span>
    <p>${escapeHtml(item.message || '')}</p>
  </div>`;
}

function renderCheck(body) {
  if (!state.validation && !state.build?.validation && !state.preview) {
    body.innerHTML = '<div class="check-empty">生成一次预览或技能包后，这里会跑一遍真实校验：frontmatter、章节契约、脚本语法、密钥扫描、测试规格。</div>';
    return;
  }
  const { validation, errors, warnings } = issueLists();
  const passed = validation ? validation.ok : errors.length === 0;
  const stats = validation?.stats || state.preview?.stats;
  body.innerHTML = `
    <div class="check-summary" data-tone="${passed ? 'ok' : 'err'}">
      <span class="icon"><svg><use href="${passed ? '#i-check' : '#i-warn'}"/></svg></span>
      <div>
        <b>${passed ? '上线契约校验通过' : `${errors.length} 个错误需要修复`}</b>
        <span>${warnings.length} 个警告 · ${validation ? '真实校验（node --check / 密钥扫描 / 章节契约）' : '蓝图预检'}</span>
      </div>
    </div>
    <div class="check-list">
      ${errors.length || warnings.length ? [...errors, ...warnings].map((item) => checkItem(item)).join('') : '<div class="check-empty">没有发现问题。触发用例、命令用例与可复现性都在 tests/skill.test.json 里。</div>'}
    </div>
    ${
      stats
        ? `<div class="check-stats">
            <div class="stat"><span class="stat-label">文件</span><b class="mono">${stats.files ?? '—'}</b></div>
            <div class="stat"><span class="stat-label">脚本</span><b class="mono">${stats.scripts ?? '—'}</b></div>
            <div class="stat"><span class="stat-label">参考资料</span><b class="mono">${stats.references ?? '—'}</b></div>
          </div>`
        : ''
    }`;
}

function renderCode(text) {
  const lines = escapeHtml(text).split('\n');
  return `<pre class="code">${lines.map((line) => `<span class="line">${line || ' '}</span>`).join('')}</pre>`;
}

function renderBuildResult() {
  const node = $('#build-result');
  const fix = $('#btn-fix-back');
  const build = state.build;
  if (!build) {
    node.dataset.tone = '';
    node.innerHTML = `<div class="build-result-empty">
      <span class="build-orb"><svg><use href="#i-spark"/></svg></span>
      <div><b>还没有生成</b><p>点上面的「锻造技能包」。右侧会实时显示 SKILL.md 预览，生成后可以查看完整文件树与校验报告。</p></div>
    </div>`;
    fix.classList.add('hidden');
    return;
  }
  const { errors, warnings } = issueLists();
  const tone = errors.length ? 'err' : warnings.length ? 'warn' : 'ok';
  node.dataset.tone = tone;
  const issues = [...errors, ...warnings].slice(0, 8);
  node.innerHTML = `<div class="build-summary">
    <span class="icon"><svg><use href="${tone === 'ok' ? '#i-check' : '#i-warn'}"/></svg></span>
    <div>
      <b>${tone === 'ok' ? '技能包已生成并通过校验' : `技能包已生成，有 ${errors.length} 个错误 / ${warnings.length} 个警告`}</b>
      <p>${build.files?.length || 0} 个文件 · ZIP ${formatBytes(build.zipBytes)} · ${build.validation?.ok ? '可以导出' : '可以先导出，再回来修'}</p>
    </div>
  </div>
  ${
    issues.length
      ? `<div class="build-issues">${issues.map((item) => `<div class="issue" data-level="${item.level || 'error'}"><span class="code-tag">${escapeHtml(item.code || 'ISSUE')}</span><span>${escapeHtml(item.message || '')}</span></div>`).join('')}</div>`
      : ''
  }`;
  fix.classList.toggle('hidden', errors.length === 0);
}

/* ---------------- tiny markdown renderer ---------------- */
function renderInline(text) {
  let value = text;
  value = value.replace(/`([^`]+)`/gu, (_, code) => `<code>${code}</code>`);
  value = value.replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>');
  value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gu, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return value;
}

function renderMarkdown(source) {
  const lines = String(source || '').replace(/\r\n/gu, '\n').split('\n');
  const out = [];
  let index = 0;
  const isTableSeparator = (line) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/u.test(line) && line.includes('-');
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.startsWith('```')) {
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
    if (heading) {
      out.push(`<h${heading[1].length}>${renderInline(escapeHtml(heading[2]))}</h${heading[1].length}>`);
      index += 1;
      continue;
    }
    if (/^\s*\|/u.test(line) && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const parseRow = (row) => row.trim().replace(/^\||\|$/gu, '').split('|').map((cell) => escapeHtml(cell.trim()));
      const head = parseRow(line);
      index += 2;
      const rows = [];
      while (index < lines.length && /^\s*\|/u.test(lines[index])) {
        rows.push(parseRow(lines[index]));
        index += 1;
      }
      out.push(`<table><thead><tr>${head.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^\s*[-*]\s+/u.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/u.test(lines[index])) {
        items.push(renderInline(escapeHtml(lines[index].replace(/^\s*[-*]\s+/u, ''))));
        index += 1;
      }
      out.push(`<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>`);
      continue;
    }
    if (/^\s*\d+[.、)]\s+/u.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+[.、)]\s+/u.test(lines[index])) {
        items.push(renderInline(escapeHtml(lines[index].replace(/^\s*\d+[.、)]\s+/u, ''))));
        index += 1;
      }
      out.push(`<ol>${items.map((item) => `<li>${item}</li>`).join('')}</ol>`);
      continue;
    }
    if (/^\s*>\s?/u.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>\s?/u.test(lines[index])) {
        quote.push(renderInline(escapeHtml(lines[index].replace(/^\s*>\s?/u, ''))));
        index += 1;
      }
      out.push(`<blockquote>${quote.join('<br>')}</blockquote>`);
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/u.test(line)) {
      out.push('<hr>');
      index += 1;
      continue;
    }
    const paragraph = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].startsWith('```') &&
      !/^(#{1,3})\s+/u.test(lines[index]) &&
      !/^\s*[-*]\s+/u.test(lines[index]) &&
      !/^\s*\d+[.、)]\s+/u.test(lines[index]) &&
      !/^\s*\||^\s*>/u.test(lines[index]) &&
      !/^\s*(---|\*\*\*)\s*$/u.test(lines[index])
    ) {
      paragraph.push(renderInline(escapeHtml(lines[index])));
      index += 1;
    }
    out.push(`<p>${paragraph.join('<br>')}</p>`);
  }
  return out.join('\n');
}

/* ---------------- build / export ---------------- */
function setBusy(button, busy, label) {
  if (!button) return;
  button.classList.toggle('is-busy', Boolean(busy));
  button.disabled = Boolean(busy);
  if (busy) {
    if (!button.dataset.label) button.dataset.label = button.innerHTML;
    if (label) button.innerHTML = `<span>${escapeHtml(label)}…</span>`;
  } else if (button.dataset.label) {
    button.innerHTML = button.dataset.label;
    delete button.dataset.label;
  }
}

function genLog(lines) {
  $('#gen-log').textContent = lines.join('\n');
}

async function buildPackage() {
  if (state.busy || !state.ready) return;
  if (state.step < 3) {
    if (state.step === 2) {
      const { missing } = readinessChecks();
      if (missing.length) {
        toast(`先补齐：${missing.slice(0, 3).join('、')}`, { tone: 'warn' });
        return;
      }
      goStep(3, { force: true });
    } else {
      return;
    }
  }
  state.busy = true;
  const button = $('#btn-build');
  setBusy(button, true, '锻造中');
  updateStepChrome();
  setOutputState('busy', 'FORGING');
  genLog(['// compose blueprint …', '// render SKILL.md / scripts / tests …', '// validate contract …']);
  try {
    const response = await fetch(`${API}/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload(false),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      const message = (data.errors || []).map((item) => `${item.code} ${item.message}`).join('\n') || data.error || '生成失败';
      genLog(['// build rejected', ...message.split('\n').map((line) => `// ${line}`)]);
      setOutputState('err', 'REJECTED');
      state.preview = { ...(state.preview || {}), errors: data.errors || [], warnings: data.warnings || [] };
      state.validation = null;
      state.build = null;
      renderOutput();
      renderBuildResult();
      updateStepChrome();
      toast('蓝图未通过组装，检查能力边界字段', { tone: 'err' });
      return;
    }
    state.build = data;
    state.preview = {
      ok: true,
      files: data.files,
      stats: data.stats,
      errors: data.validation?.errors || [],
      warnings: data.validation?.warnings || [],
      skillMarkdown: data.files.find((file) => file.path === 'SKILL.md')?.text || '',
      blueprint: state.blueprint,
    };
    state.validation = data.validation;
    state.selectedFile = 'SKILL.md';
    state.unlocked = Math.max(state.unlocked, 4);
    renderOutput();
    renderBuildResult();
    updateStepChrome();
    setTab('check');
    genLog([
      `// package written: ${displayPath(data.dir)}`,
      `// zip: ${data.zipName} (${formatBytes(data.zipBytes)})`,
      `// validation: ${data.validation?.ok ? 'passed' : `${data.validation?.errors?.length || 0} errors`}`,
    ]);
    toast(data.validation?.ok ? '技能包已生成并通过校验，点击下一步导出' : `技能包已生成，有 ${data.validation?.errors?.length || 0} 个校验错误`, {
      tone: data.validation?.ok ? 'ok' : 'warn',
    });
    scheduleSave();
  } catch (error) {
    setOutputState('err', 'ERROR');
    genLog([`// error: ${error.message}`]);
    toast(`生成失败：${error.message}`, { tone: 'err' });
  } finally {
    state.busy = false;
    setBusy(button, false);
    updateStepChrome();
  }
}

async function previewOnly() {
  const button = $('#btn-preview');
  setBusy(button, true, '校验中');
  genLog(['// preview only', '// validate contract …']);
  try {
    await runPreview({ validate: true, silent: false });
    setTab('check');
    openDrawerIfMobile();
    genLog([`// validation: ${state.validation?.ok ? 'passed' : `${state.validation?.errors?.length || 0} errors`}`, `// files: ${currentFiles().length}`]);
    toast(state.validation?.ok ? '校验通过' : `发现 ${state.validation?.errors?.length || 0} 个错误`, { tone: state.validation?.ok ? 'ok' : 'warn' });
  } finally {
    setBusy(button, false);
  }
}

async function openExportFolder() {
  if (!state.build) return;
  try {
    const response = await fetch(`${API}/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: state.build.dir }),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || '打开失败');
    toast('已在 Finder 中打开导出目录', { tone: 'ok' });
  } catch (error) {
    toast(`打开失败：${error.message}`, { tone: 'err' });
  }
}

/* ---------------- drawer / tabs ---------------- */
function setTab(tab) {
  state.tab = tab;
  $$('.tab').forEach((button) => button.setAttribute('aria-selected', String(button.dataset.tab === tab)));
  renderOutputBody();
}

function openDrawer() {
  $('.wizard').classList.add('drawer-open');
  $('#drawer-overlay').classList.remove('hidden');
}

function closeDrawer() {
  $('.wizard').classList.remove('drawer-open');
  $('#drawer-overlay').classList.add('hidden');
}

function openDrawerIfMobile() {
  if (window.matchMedia('(max-width: 1040px)').matches) openDrawer();
}

/* ---------------- persistence ---------------- */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDraft, 400);
}

function saveDraft() {
  try {
    const payload = { blueprint: state.blueprint, genScript: state.genScript, step: state.step, unlocked: state.unlocked, savedAt: Date.now() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    state.savedAt = payload.savedAt;
    state.hasStoredDraft = true;
    $('#sb-saved').textContent = `蓝图自动保存 · ${new Date(payload.savedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
  } catch {
    $('#sb-saved').textContent = '蓝图自动保存失败（本地存储已满）';
  }
}

function restoreDraft() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed?.blueprint) return false;
    applyBlueprint(parsed.blueprint);
    state.genScript = parsed.genScript !== false;
    state.step = Math.min(STEP_COUNT, Math.max(1, Number(parsed.step) || 1));
    state.unlocked = Math.min(STEP_COUNT, Math.max(state.step, Number(parsed.unlocked) || 1));
    state.savedAt = Number(parsed.savedAt) || 0;
    state.hasStoredDraft = true;
    $('#f-gen-script').checked = state.genScript;
    return true;
  } catch {
    return false;
  }
}

/* ---------------- project lifecycle ---------------- */
function resetProject({ persist = true } = {}) {
  state.blueprint = defaultBlueprint();
  state.files = [];
  state.preview = null;
  state.validation = null;
  state.build = null;
  state.tab = 'preview';
  state.selectedFile = 'SKILL.md';
  state.step = 1;
  state.unlocked = 1;
  state.genScript = true;
  state.touched.clear();
  state.savedAt = 0;
  state.hasStoredDraft = false;
  syncForm();
  renderFiles();
  updateMaterialsUi();
  renderOutput();
  renderBuildResult();
  updateExportUi();
  updateStepChrome();
  setTab('preview');
  genLog(['// 等待输入 …']);
  if (persist) scheduleSave();
}

function showWelcome() {
  saveDraft();
  setView('welcome');
  renderResume();
}

async function startFlow(mode) {
  if (mode === 'resume') {
    setView('wizard');
    goStep(state.step, { force: true });
    if (hasContent()) runPreview({ validate: true });
    return;
  }
  if (mode === 'import') {
    $('#skill-input').click();
    return;
  }
  if (mode === 'example') {
    loadExample();
    return;
  }
  resetProject({ persist: false });
  setView('wizard');
  if (mode === 'blank') {
    state.unlocked = 2;
    goStep(2, { force: true });
  } else {
    goStep(1, { force: true });
  }
  scheduleSave();
}

async function nextStep() {
  if (state.busy) return;
  if (state.step === 1) {
    if (!state.blueprint.name.trim() && state.files.some((file) => file.text)) {
      const drafted = await runDraft({ advance: false, quiet: true });
      if (drafted) toast('已根据资料自动起草，检查后继续', { tone: 'info' });
    }
    goStep(2, { force: true });
    return;
  }
  if (state.step === 2) {
    const { missing } = readinessChecks();
    if (missing.length) {
      toast(`还差 ${missing.length} 项：${missing.slice(0, 3).join('、')}`, { tone: 'warn' });
      $('#missing-box')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    goStep(3, { force: true });
    return;
  }
  if (state.step === 3) {
    if (!state.build) {
      toast('先生成技能包', { tone: 'warn' });
      return;
    }
    goStep(4, { force: true });
    return;
  }
  resetProject({ persist: true });
  setView('welcome');
  toast('已开始新的制作，可以随时继续上次草稿', { tone: 'info' });
}

function backStep() {
  if (state.step === 1) {
    showWelcome();
    return;
  }
  goStep(state.step - 1);
}

/* ---------------- blueprint JSON / clipboard ---------------- */
function exportBlueprintJson() {
  const safe = (state.blueprint.name || 'skill').replace(/[^a-z0-9-]/gu, '') || 'skill';
  const blob = new Blob([`${JSON.stringify(state.blueprint, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safe}-blueprint.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('蓝图 JSON 已导出', { tone: 'ok' });
}

function importBlueprintJson(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      const blueprint = parsed.blueprint || parsed;
      if (!blueprint || typeof blueprint !== 'object') throw new Error('不是合法蓝图');
      applyBlueprint(blueprint);
      state.unlocked = Math.max(state.unlocked, 2);
      goStep(2, { force: true });
      runPreview({ validate: true });
      scheduleSave();
      toast('蓝图已导入', { tone: 'ok' });
    } catch (error) {
      toast(`导入蓝图失败：${error.message}`, { tone: 'err' });
    }
  };
  reader.readAsText(file);
}

async function copyCurrent() {
  let text = '';
  if (state.tab === 'source') {
    const file = currentFiles().find((item) => item.path === state.selectedFile) || currentFiles()[0];
    text = file?.text || '';
  } else if (state.tab === 'check') {
    const { validation, errors, warnings } = issueLists();
    text = JSON.stringify(validation || { errors, warnings }, null, 2);
  } else {
    text = currentSkillMarkdown();
  }
  if (!text) {
    toast('当前没有可复制的内容', { tone: 'warn' });
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板', { tone: 'ok' });
  } catch {
    toast('复制失败：浏览器拒绝剪贴板访问', { tone: 'err' });
  }
}

/* ---------------- bindings ---------------- */
function bindTopbar() {
  $('#btn-example').addEventListener('click', () => {
    if (state.view === 'wizard' && hasContent() && !window.confirm('载入示例会覆盖当前编辑，继续？')) return;
    loadExample();
  });
  $('#btn-import').addEventListener('click', () => $('#skill-input').click());
  $('#skill-input').addEventListener('change', (event) => {
    const files = [...event.target.files];
    event.target.value = '';
    importSkill(files);
  });
  $('#btn-blueprint-json').addEventListener('click', () => $('#json-input').click());
  $('#json-input').addEventListener('change', (event) => {
    importBlueprintJson(event.target.files?.[0]);
    event.target.value = '';
  });
  $('#btn-home').addEventListener('click', () => {
    if ((hasContent() || state.build) && !window.confirm('重新开始会清空当前编辑（已生成的技能包不会删除），继续？')) return;
    resetProject({ persist: true });
    setView('welcome');
    toast('已清空，可以重新选择起点', { tone: 'info' });
  });
}

function bindWelcome() {
  $$('#start-grid [data-start]').forEach((button) => button.addEventListener('click', () => startFlow(button.dataset.start)));
  $('#btn-resume').addEventListener('click', () => startFlow('resume'));
  $('#btn-discard').addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY);
    resetProject({ persist: false });
    state.hasStoredDraft = false;
    state.savedAt = 0;
    renderResume();
    toast('已清空上次草稿', { tone: 'info' });
  });
}

function bindWizard() {
  $$('[data-step-go]').forEach((button) =>
    button.addEventListener('click', () => {
      const target = Number(button.dataset.stepGo);
      if (target > state.unlocked) {
        toast('先完成当前步骤，再进入下一步', { tone: 'warn' });
        return;
      }
      goStep(target, { force: true });
    }),
  );
  $('#btn-back').addEventListener('click', backStep);
  $('#btn-next').addEventListener('click', nextStep);
  $('#stage-action').addEventListener('click', () => {
    if (state.step === 1) return runDraft({ advance: true });
    if (state.step === 2) return runDraft({ advance: false });
    if (state.step === 3) return previewOnly();
    if (state.step === 4) return openExportFolder();
  });
  $('#btn-build').addEventListener('click', buildPackage);
  $('#btn-preview').addEventListener('click', previewOnly);
  $('#btn-fix-back').addEventListener('click', () => goStep(2, { force: true }));
  $('#btn-back-generate').addEventListener('click', () => goStep(3, { force: true }));
  $('#btn-open').addEventListener('click', openExportFolder);
  $('#export-path').addEventListener('click', async () => {
    if (!state.build) return;
    try {
      await navigator.clipboard.writeText(state.build.dir);
      toast('路径已复制', { tone: 'ok' });
    } catch {
      toast('复制失败', { tone: 'err' });
    }
  });
  $('#btn-copy-md').addEventListener('click', copyCurrent);
  $$('.tab').forEach((button) => button.addEventListener('click', () => setTab(button.dataset.tab)));
  $('#output-body').addEventListener('click', (event) => {
    const fileButton = event.target.closest('[data-file]');
    if (!fileButton) return;
    state.selectedFile = fileButton.dataset.file;
    setTab('source');
  });
  $('#btn-preview-fab').addEventListener('click', openDrawer);
  $('#drawer-overlay').addEventListener('click', closeDrawer);
  $('#btn-drawer-close').addEventListener('click', closeDrawer);
  $('#seg-filesystem').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (!button) return;
    state.blueprint.permissions.filesystem = button.dataset.value;
    state.touched.add('permissions.filesystem');
    $$('#seg-filesystem button').forEach((item) => (item.dataset.active = String(item === button)));
    onBlueprintChanged();
  });
  $('#f-network').addEventListener('change', (event) => {
    state.blueprint.permissions.network = event.target.checked;
    state.touched.add('permissions.network');
    onBlueprintChanged();
  });
  $('#f-shell').addEventListener('change', (event) => {
    state.blueprint.permissions.shell = event.target.checked;
    state.touched.add('permissions.shell');
    onBlueprintChanged();
  });
  $('#f-timeout').addEventListener('input', (event) => {
    state.blueprint.timeoutMs = Math.min(600, Math.max(1, Number(event.target.value) || 45)) * 1000;
    state.touched.add('timeoutMs');
    onBlueprintChanged();
  });
  $('#f-version').addEventListener('input', (event) => {
    state.blueprint.version = Math.max(1, Number(event.target.value) || 1);
    scheduleSave();
  });
  $('#f-gen-script').addEventListener('change', (event) => {
    state.genScript = event.target.checked;
    scheduleSave();
    schedulePreview();
  });
  $('#btn-export-json').addEventListener('click', exportBlueprintJson);
  $('#btn-reset').addEventListener('click', () => {
    if (!window.confirm('清空当前编辑？导出目录里的已有技能包不会被删除。')) return;
    resetProject({ persist: true });
    setView('welcome');
    toast('已清空', { tone: 'info' });
  });
  $('#btn-add-paste').addEventListener('click', addPastedMaterial);
  $('#btn-draft').addEventListener('click', () => runDraft({ advance: true }));
}

function bindGlobalKeys() {
  document.addEventListener('keydown', (event) => {
    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key === 'Enter') {
      event.preventDefault();
      if (state.view === 'wizard') buildPackage();
    }
    if (meta && event.key.toLowerCase() === 's') {
      event.preventDefault();
      exportBlueprintJson();
    }
    if (event.key === 'Escape') closeDrawer();
  });
}

/* ---------------- meta ---------------- */
async function loadMeta() {
  try {
    const response = await fetch(`${API}/meta`);
    const data = await response.json();
    state.meta = data;
    state.homeDir = data.paths?.homeDir || '';
    state.ready = true;
    $('#engine-label').textContent = `ENGINE · node ${data.app?.node || '—'}`;
    $('#version-label').textContent = `v${data.app?.version || '1.0.0'}`;
    $('#sb-engine').textContent = `ENGINE · ${data.app?.version || ''} · 0 deps`;
    $('#engine-dot').dataset.state = 'up';
    $('#engine-label').title = `导出目录：${data.paths?.exportsDir || ''}`;
    const catalog = Array.isArray(data.catalogSkills) ? data.catalogSkills : [];
    const datalist = $('#skill-names');
    if (datalist) {
      datalist.innerHTML = catalog
        .slice(0, 120)
        .map((skill) => `<option value="${escapeHtml(skill.name)}">${escapeHtml((skill.description || '').slice(0, 60))}</option>`)
        .join('');
    }
    const overlapHint = $('#overlap-hint');
    if (overlapHint) {
      overlapHint.textContent = catalog.length
        ? `本机已安装 ${catalog.length} 个技能；可输入名字声明分工，校验时会做 description 相似度检查。`
        : '本机未扫描到已安装技能；仍可手写分工说明。';
    }
  } catch (error) {
    state.ready = false;
    $('#engine-label').textContent = 'ENGINE · 离线';
    $('#engine-dot').dataset.state = 'down';
    $('#sb-ready').textContent = '本地服务未连接';
    $('#sb-ready').dataset.tone = 'err';
    toast(`无法连接本地服务：${error.message}`, { tone: 'err' });
  }
}

/* ---------------- init ---------------- */
async function init() {
  bindScalars();
  bindRowContainer('#rows-inputs', 'inputs');
  bindRowContainer('#rows-outputs', 'outputs');
  bindRowContainer('#rows-steps', 'steps');
  bindRowContainer('#rows-errors', 'errorCodes');
  bindAddButtons();
  bindMaterials();
  bindTopbar();
  bindWelcome();
  bindWizard();
  bindGlobalKeys();

  const restored = restoreDraft();
  syncForm();
  renderFiles();
  updateMaterialsUi();
  setView('welcome');
  renderOutput();
  renderBuildResult();
  updateExportUi();
  updateStepChrome();
  setTab('preview');
  renderResume();
  if (restored && hasContent()) {
    $('#sb-saved').textContent = '已恢复上次草稿 · 点「继续制作」';
  }
  await loadMeta();
  if (restored) runPreview({ validate: true });
}

init();
