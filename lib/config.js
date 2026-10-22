/**
 * Skill Forge — 本地应用配置。
 *
 * 这里不依赖 DSH / Cordis：应用自己跑在 node 上，只做「资料 → skill 包」。
 * 路径：
 *   ~/Documents/技能工坊/exports/<name>-<stamp>/   生成的技能包目录
 *   ~/Documents/技能工坊/zips/<buildId>.zip        可下载的压缩包
 *   ~/Documents/技能工坊/tmp/                       导入解析用的临时目录
 */
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(APP_ROOT, 'public');

export const APP_NAME = 'Skill Forge';
export const APP_TITLE = '技能锻造台';
export const APP_VERSION = '1.0.0';

export const DATA_DIR =
  process.env.SKILL_FORGE_DATA || path.join(homedir(), 'Documents', '技能工坊');
export const EXPORTS_DIR = path.join(DATA_DIR, 'exports');
export const ZIP_DIR = path.join(DATA_DIR, 'zips');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');

export const CATALOG_DESCRIPTION_MAX = 500;

export const LIMITS = {
  maxNameLength: 64,
  maxDescription: CATALOG_DESCRIPTION_MAX,
  minDescription: 24,
  maxSteps: 24,
  maxBodyBytes: 256 * 1024,
  maxTestOutput: 64 * 1024,
  defaultTestTimeoutMs: 15_000,
  maxTestTimeoutMs: 120_000,
  maxLogLineBytes: 8 * 1024,
  // 输入侧
  maxUploadFiles: 40,
  maxUploadFileBytes: 4 * 1024 * 1024,
  maxUploadTotalBytes: 24 * 1024 * 1024,
  maxMaterialsChars: 400_000,
};

/** 本机已安装技能根（只读扫描，用于重叠检测与「与现有技能的关系」）。 */
export const USER_SKILLS_ROOT = path.join(homedir(), '.agents', 'skills');
export const DSH_USER_SKILLS_ROOT = path.join(homedir(), '.dsh', 'skills');

export function catalogRoots({ projectRoot, userRoot = USER_SKILLS_ROOT } = {}) {
  const roots = [];
  if (projectRoot && existsSync(projectRoot)) {
    roots.push({ id: 'project-dsh', source: 'project-dsh', rank: 100, dir: path.join(projectRoot, '.dsh', 'skills') });
    roots.push({ id: 'project-agents', source: 'project-agents', rank: 200, dir: path.join(projectRoot, '.agents', 'skills') });
  }
  roots.push({ id: 'user-dsh', source: 'user-dsh', rank: 400, dir: DSH_USER_SKILLS_ROOT });
  roots.push({ id: 'user-agents', source: 'user-agents', rank: 500, dir: userRoot });
  return roots;
}

export function pathSummary() {
  return {
    homeDir: homedir(),
    dataDir: DATA_DIR,
    exportsDir: EXPORTS_DIR,
    zipDir: ZIP_DIR,
    tmpDir: TMP_DIR,
    userSkillsRoot: USER_SKILLS_ROOT,
    dshUserSkillsRoot: DSH_USER_SKILLS_ROOT,
    osTmp: tmpdir(),
  };
}
