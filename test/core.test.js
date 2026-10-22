import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { draftBlueprint } from '../lib/draft.js';
import { importSkillPackage } from '../lib/importer.js';
import { composePackage, decodeUpload } from '../lib/package.js';
import { validateSkill } from '../lib/validator.js';
import { crc32, createZip } from '../lib/zip.js';

const MATERIAL = `# 面料花型描稿流水线

把服装面料照片清洗成可印刷的四方连续花版，输出 300dpi 分层 PSD；适用于棉、涤纶、真丝面料的数码印花前处理。

## 适用场景

用户给一张面料照片或花型图，需要做成可循环、可分色的印刷稿时使用。

## 步骤

1. 清洗输入：去背景、去褶皱、保花型
2. 四方连续：接缝对齐检查
3. 分色：3~6 个专色层

触发词：花型描稿、面料印花、四方连续

脚本会读取 process.env.FABRIC_API_KEY。
`;

function upload(name, role, content) {
  return { name, role, b64: Buffer.from(content, 'utf8').toString('base64') };
}

function blueprintFromDraft() {
  const { draft } = draftBlueprint({ materials: [{ name: 'fabric-notes.md', text: MATERIAL }] });
  return draft;
}

test('draft：从资料提取名称、触发词、步骤与环境变量', () => {
  const { draft, insights } = draftBlueprint({ materials: [{ name: 'fabric-notes.md', text: MATERIAL }] });
  assert.equal(draft.name, 'fabric-notes');
  assert.ok(draft.description.length >= 24);
  assert.deepEqual(draft.triggers.include.slice(0, 3), ['花型描稿', '面料印花', '四方连续']);
  assert.equal(draft.steps.length, 3);
  assert.deepEqual(draft.permissions.env, ['FABRIC_API_KEY']);
  assert.equal(insights.hasScript, false);
});

test('compose：资料按角色落位，作者脚本覆盖模板', () => {
  const script = '#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: true }));\n';
  const pkg = composePackage({
    blueprint: blueprintFromDraft(),
    files: [
      upload('notes.md', 'reference', MATERIAL),
      upload('prep.mjs', 'script', script),
      upload('logo.png', 'asset', '\x89PNG\r\n\x1a\n'),
    ],
  });
  assert.equal(pkg.ok, true, JSON.stringify(pkg.errors));
  const paths = pkg.files.map((file) => file.path);
  assert.ok(paths.includes('SKILL.md'));
  assert.ok(paths.includes('scripts/prep.mjs'));
  assert.ok(paths.includes('references/notes.md'));
  assert.ok(paths.includes('assets/logo.png'));
  assert.ok(paths.includes('tests/skill.test.json'));
  assert.equal(pkg.files.find((file) => file.path === 'scripts/prep.mjs').text, script);
  assert.match(pkg.skillMarkdown, /`assets\/logo\.png`/u);
  const spec = JSON.parse(pkg.files.find((file) => file.path === 'tests/skill.test.json').text);
  assert.deepEqual(spec.commands, []);
  assert.ok(pkg.warnings.some((item) => item.code === 'PKG001'));
});

test('compose：无脚本时生成可复现骨架与三条命令用例', () => {
  const pkg = composePackage({ blueprint: blueprintFromDraft(), files: [] });
  assert.equal(pkg.ok, true, JSON.stringify(pkg.errors));
  const paths = pkg.files.map((file) => file.path);
  assert.ok(paths.includes('scripts/fabric-notes.mjs'));
  const spec = JSON.parse(pkg.files.find((file) => file.path === 'tests/skill.test.json').text);
  assert.deepEqual(spec.commands.map((item) => item.name), ['normal', 'missing-arg', 'boundary-empty']);
});

test('blueprint：重复的触发场景句会被合并', () => {
  const draft = blueprintFromDraft();
  draft.description = `${draft.description} 触发场景：花型描稿。 触发场景：印花分色。`;
  const pkg = composePackage({ blueprint: draft, files: [] });
  assert.equal(pkg.ok, true);
  assert.equal((pkg.blueprint.description.match(/触发场景：/gu) || []).length, 1);
  assert.match(pkg.blueprint.description, /印花分色/u);
});

test('zip：CRC、deflate 数据与目录名可被标准解压器识别', () => {
  const a = Buffer.from('hello skill', 'utf8');
  const b = Buffer.from('# 参考资料\n', 'utf8');
  const zip = createZip([
    { name: 'demo/SKILL.md', data: a },
    { name: 'demo/references/x.md', data: b },
  ]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(crc32(a), crc32(Buffer.from('hello skill', 'utf8')));
  // 校验第一个条目的压缩数据能还原
  const nameLength = zip.readUInt16LE(26);
  const compressedLength = zip.readUInt32LE(18);
  const dataStart = 30 + nameLength;
  const inflated = inflateRawSync(zip.subarray(dataStart, dataStart + compressedLength));
  assert.equal(inflated.toString('utf8'), 'hello skill');
  // EOCD 条目数
  const eocd = zip.subarray(zip.length - 22);
  assert.equal(eocd.readUInt32LE(0), 0x06054b50);
  assert.equal(eocd.readUInt16LE(10), 2);
});

test('import：studio.json 往返后字段与资料都回来', () => {
  const pkg = composePackage({ blueprint: blueprintFromDraft(), files: [upload('notes.md', 'reference', MATERIAL)] });
  const dir = mkdtempSync(path.join(tmpdir(), 'skill-forge-import-'));
  try {
    const files = [];
    for (const [relativePath, buffer] of pkg.buffers) {
      const absolute = path.join(dir, relativePath);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, buffer);
      files.push({ name: path.basename(relativePath), path: relativePath, b64: buffer.toString('base64') });
    }
    const imported = importSkillPackage(files);
    assert.equal(imported.ok, true, imported.error);
    assert.equal(imported.blueprint.name, 'fabric-notes');
    assert.equal(imported.derived, false);
    assert.ok(imported.uploads.some((item) => item.role === 'script' || item.role === 'reference'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validator：生成目录通过上线契约校验', async () => {
  const pkg = composePackage({ blueprint: blueprintFromDraft(), files: [] });
  const dir = mkdtempSync(path.join(tmpdir(), 'skill-forge-validate-'));
  try {
    for (const [relativePath, buffer] of pkg.buffers) {
      const absolute = path.join(dir, relativePath);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, buffer, { mode: relativePath.startsWith('scripts/') ? 0o755 : 0o644 });
    }
    const result = await validateSkill(dir, { expectedName: 'fabric-notes', studioManaged: true });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.stats.files >= 4, true);
    assert.match(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), /## 执行步骤/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('解码：文本与二进制上传都能还原', () => {
  const text = decodeUpload({ name: 'a.md', text: '# hi' });
  assert.equal(text.text, '# hi');
  assert.equal(text.binary, false);
  const binary = decodeUpload({ name: 'b.png', b64: Buffer.from([0, 1, 2, 255]).toString('base64') });
  assert.equal(binary.binary, true);
  assert.equal(binary.bytes, 4);
});
