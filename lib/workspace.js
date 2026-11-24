import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const maxFile = 512 * 1024;
const scanFolders = ['docs', 'doc', 'design', 'requirements', 'documentation'];
export const defaultPaths = Object.freeze({
  agents: 'AGENTS.md', prd: 'docs/PRD.md', design: 'docs/DESIGN.md', tasks: 'docs/TASKS.md', reviews: 'docs/reviews',
});
const names = {
  prd: /^(prd|requirements?|product-requirements|需求|产品需求)(\.md)$/i,
  design: /^(design|architecture|technical-design|技术设计|系统设计)(\.md)$/i,
  tasks: /^(tasks?|todo|任务|任务清单)(\.md)$/i,
};

export function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

export class ProjectError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function localPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 500 && !isAbsolute(value) &&
    !/[\x00-\x1f\\:*?\[\]]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

export function contains(root, path) {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

function missing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

async function safePath(root, file) {
  if (!localPath(file)) throw new ProjectError(`无效的仓库相对路径 ${file}`);
  let cursor = root;
  for (const piece of file.split('/')) {
    cursor = join(cursor, piece);
    try {
      if (await realpath(cursor) !== cursor) throw new ProjectError(`请使用实际文件路径 ${file}`);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  return cursor;
}

export async function readProjectFile(root, file, options = {}) {
  const path = await safePath(root, file);
  if (path === null) return null;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
    if (missing(error)) return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new ProjectError(`需要常规文件 ${file}`);
    const cap = options.limit ?? maxFile;
    if (stat.size > cap) throw new ProjectError(`文件超出读取上限 ${file}`);
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (bytesRead !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      throw new ProjectError(`文件读取时发生变化，请刷新 ${file}`, 409);
    }
    const data = bytes.subarray(0, bytesRead);
    return options.binary ? data : data.toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function git(root, args, signal, encoding = 'utf8') {
  signal?.throwIfAborted();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const { stdout } = await execute('git', [
    '--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false', ...args,
  ], { cwd: root, env, signal, timeout: 10000, maxBuffer: 4 * 1024 * 1024, encoding, windowsHide: true });
  return stdout;
}

export async function projectRoot(path, signal) {
  const root = await realpath(path);
  try {
    const top = (await git(root, ['rev-parse', '--show-toplevel'], signal)).trimEnd();
    if (await realpath(top) === root) return root;
    throw new ProjectError('请选择以 Git 仓库根目录注册的 DSH 工作区。');
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ProjectError) throw error;
    throw new ProjectError('工作区需要可访问的 Git 仓库与 git 命令。');
  }
}

export async function reference(root, ref, signal) {
  if (typeof ref !== 'string' || !/^[\w./@~^+-]{1,160}$/.test(ref) || ref.startsWith('-')) {
    throw new ProjectError('请输入 Git 提交、分支、标签或 HEAD。');
  }
  try {
    return (await git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], signal)).trim();
  } catch {
    signal?.throwIfAborted();
    throw new ProjectError(`找不到 Git 基线 ${ref}`);
  }
}

async function treeFiles(root, directory, depth, budget = { directories: 100 }) {
  if (budget.directories-- <= 0) return [];
  const path = directory ? await safePath(root, directory) : root;
  if (path === null) return [];
  const rows = await readdir(path, { withFileTypes: true }).catch(error => {
    if (missing(error)) return [];
    throw error;
  });
  const found = [];
  for (const entry of rows.slice(0, 500)) {
    if (entry.name.startsWith('.')) continue;
    const file = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isFile() && /\.md$/i.test(file)) found.push(file);
    if (entry.isDirectory() && depth > 0 && (directory || scanFolders.includes(entry.name.toLowerCase()))) {
      found.push(...await treeFiles(root, file, depth - 1, budget));
    }
  }
  return found;
}

export function configuredPaths(agents) {
  const lines = (agents ?? '').split(/\r?\n/);
  const found = {};
  for (const line of lines) {
    const field = line.match(/^\s*(?:[-*]\s+)?\*{0,2}(PRD|DESIGN|TASKS|Reviews|需求文档|技术设计|任务清单|审核目录)\*{0,2}\s*[:：]\s*\*{0,2}(?:`([^`]+)`|([^`\s]+))/i);
    const kind = { 需求文档: 'prd', 技术设计: 'design', 任务清单: 'tasks', 审核目录: 'reviews' }[field?.[1]] ?? field?.[1]?.toLowerCase();
    if (kind) found[kind] = (field[2] ?? field[3]).replace(/^(?:\.\/)/, '').replace(/\/$/, '');
  }
  return found;
}

export async function loadDocuments(root) {
  const agents = await readProjectFile(root, defaultPaths.agents);
  const configured = configuredPaths(agents);
  const files = await treeFiles(root, '', 2);
  const paths = { ...defaultPaths };
  const documents = { agents };
  const diagnostics = [];
  for (const [kind, pattern] of Object.entries(names)) {
    const candidates = files.filter(file => pattern.test(file.split('/').at(-1)));
    let file = configured[kind] ?? (candidates.includes(paths[kind]) ? paths[kind] : candidates[0]);
    if (!configured[kind] && candidates.length > 1 && !candidates.includes(paths[kind])) {
      diagnostics.push({ kind, message: `发现多份候选文档 ${candidates.join('、')}。在 AGENTS.md 显式标注路径。` });
      file = null;
    }
    if (file === null || (file && !localPath(file))) {
      if (file !== null) diagnostics.push({ kind, message: `AGENTS.md 中的 ${kind.toUpperCase()} 路径无效` });
      paths[kind] = null;
      documents[kind] = null;
      continue;
    }
    paths[kind] = file ?? paths[kind];
    documents[kind] = await readProjectFile(root, paths[kind]);
    if (configured[kind] && documents[kind] === null) diagnostics.push({ kind, message: `已声明的文档缺失 ${paths[kind]}` });
  }
  if (configured.reviews) {
    paths.reviews = localPath(configured.reviews) ? configured.reviews : null;
    if (!paths.reviews) diagnostics.push({ kind: 'reviews', message: 'AGENTS.md 中的审核目录无效' });
  }
  return { paths, documents, diagnostics };
}

export async function trackedPaths(root, scopes, signal) {
  if (scopes.length === 0) return [];
  const rows = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...scopes], signal);
  return [...new Set(rows.split('\0').filter(Boolean))].sort();
}

export async function gitOverview(root, signal) {
  const [head, status] = await Promise.all([
    git(root, ['rev-parse', '--verify', 'HEAD'], signal).then(value => value.trim()).catch(() => null),
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all', '--no-renames'], signal),
  ]);
  const changes = status.split('\0').filter(Boolean);
  return { head, dirty: changes.length > 0, changeCount: changes.length, changes: changes.slice(0, 30) };
}

export async function documentAt(root, commit, file, signal) {
  if (!file || !localPath(file)) return null;
  const spec = `${commit}:${file}`;
  let size;
  try {
    size = Number((await git(root, ['cat-file', '-s', spec], signal)).trim());
  } catch (error) {
    signal?.throwIfAborted();
    if (/does not exist in|exists on disk|Not a valid object name/.test(error.stderr ?? '')) return null;
    throw new ProjectError(`无法读取基线文件 ${file}`, 409);
  }
  if (size > maxFile) throw new ProjectError(`基线文件超出读取上限 ${file}`);
  return git(root, ['cat-file', 'blob', spec], signal);
}

export async function candidateFiles(root, scopes, excluded, signal) {
  const tracked = await trackedPaths(root, scopes, signal);
  const files = tracked.filter(path => !excluded.includes(path) && localPath(path));
  for (const scope of scopes) {
    if (!files.some(file => file === scope || file.startsWith(`${scope}/`))) {
      try {
        if (await safePath(root, scope) !== null) files.push(scope);
      } catch (error) {
        if (error instanceof ProjectError) throw error;
        throw new ProjectError(`无法读取任务文件 ${scope}`);
      }
    }
  }
  if (files.length > 200) throw new ProjectError('任务覆盖文件过多，请缩小写入范围。');
  const result = [];
  let total = 0;
  for (const file of [...new Set(files)].sort()) {
    signal?.throwIfAborted();
    const content = await readProjectFile(root, file, { binary: true, limit: 4 * 1024 * 1024 });
    total += content?.length ?? 0;
    if (total > 32 * 1024 * 1024) throw new ProjectError('任务文件总体积过大，请缩小写入范围。');
    result.push([file, content === null ? null : createHash('sha256').update(content).digest('hex')]);
  }
  return result;
}
