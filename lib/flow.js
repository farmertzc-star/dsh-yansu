import { ids, lastReview, readEntries, stateEdit, states } from './markdown.js';
import { candidateFiles, configuredPaths, digest, documentAt, gitOverview, loadDocuments, localPath, ProjectError, projectRoot, readProjectFile, reference } from './workspace.js';

const kinds = ['prd', 'design', 'tasks'];
const priorityOrder = new Map(['P0', 'P1', 'P2', 'P3'].map((p, index) => [p, index]));
const notConfirmed = /(?:待确认|DRAFT|BLOCKED|REVIEW|未确认|已废弃|撤回|DEPRECATED|CANCELLED)/i;
const retired = /(?:已废弃|废弃|撤回|DEPRECATED|CANCELLED)/i;
const dependencyBlock = /^(?:前置依赖|依赖未完成|dependency\b)/i;
const ownerPattern = /^[^\x00-\x1f\x7f]{1,80}$/;

function uniqueMap(rows) {
  const index = new Map();
  const duplicates = new Set();
  for (const row of rows) {
    if (index.has(row.id)) duplicates.add(row.id);
    index.set(row.id, row);
  }
  return { index, duplicates };
}

function indexes(documents) {
  return Object.fromEntries(kinds.map(kind => [kind, uniqueMap(readEntries(kind, documents[kind]))]));
}

function cycleIds(taskIndex) {
  const incoming = new Map([...taskIndex.keys()].map(id => [id, 0]));
  const next = new Map();
  for (const task of taskIndex.values()) {
    for (const dep of task.deps.filter(id => taskIndex.has(id))) {
      incoming.set(task.id, incoming.get(task.id) + 1);
      if (!next.has(dep)) next.set(dep, []);
      next.get(dep).push(task.id);
    }
  }
  const safe = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
  for (const id of safe) {
    for (const follower of next.get(id) ?? []) {
      incoming.set(follower, incoming.get(follower) - 1);
      if (incoming.get(follower) === 0) safe.push(follower);
    }
  }
  return new Set([...incoming].filter(([, count]) => count > 0).map(([id]) => id));
}

function taskProblems(task, index, cycles) {
  const checks = [];
  const add = (kind, text) => checks.push({ kind, text });
  if (index.tasks.duplicates.has(task.id)) add('id', '任务 ID 重复');
  if (!task.status) add('fields', '缺少有效任务状态');
  if (!task.priority) add('fields', '缺少 P0–P3 优先级');
  if (!task.reqs.length) add('references', '缺少 PRD 需求引用');
  if (!task.designs.length) add('references', '缺少 DESIGN 条目引用');
  if (!task.files.length || !task.files.every(localPath)) add('fields', '需要至少一个有效的仓库相对写入路径');
  if (!task.acceptance) add('fields', '缺少交付验收标准');
  for (const id of task.reqs) {
    const req = index.prd.index.get(id);
    if (!req || index.prd.duplicates.has(id)) add('references', `需求不存在或重复 ${id}`);
    else if (notConfirmed.test(req.fields.status ?? '')) add('contract', `需求状态待处理 ${id} ${req.fields.status}`);
  }
  for (const id of task.designs) {
    const des = index.design.index.get(id);
    if (!des || index.design.duplicates.has(id)) {
      add('references', `设计不存在或重复 ${id}`);
      continue;
    }
    if (!/^APPROVED\b|^已确认$|^已批准$/i.test(des.fields.status ?? '')) add('contract', `设计尚未确认 ${id}`);
    const reqs = ids('prd', des.fields.req ?? des.body);
    if (!reqs.some(req => task.reqs.includes(req))) add('references', `设计 ${id} 未关联本任务的需求`);
  }
  if (cycles.has(task.id)) add('dependency', '任务位于循环依赖中，或依赖仍在循环中的任务');
  for (const id of task.deps) {
    const dep = index.tasks.index.get(id);
    if (!dep || index.tasks.duplicates.has(id)) add('dependency', `依赖不存在或重复 ${id}`);
    else if (dep.status !== 'DONE') add('dependency', `前置依赖尚未完成 ${id}`);
  }
  return checks;
}

function model(root, loaded, git) {
  const { paths, documents, diagnostics } = loaded;
  const index = indexes(documents);
  const cycles = cycleIds(index.tasks.index);
  const tasks = [...index.tasks.index.values()].map(task => ({ ...task, problems: taskProblems(task, index, cycles) }));
  const counts = Object.fromEntries(states.map(state => [state, tasks.filter(task => task.status === state).length]));
  const ordered = [...tasks].sort((a, b) => (priorityOrder.get(a.priority) ?? 4) - (priorityOrder.get(b.priority) ?? 4) || a.id.localeCompare(b.id, 'en', { numeric: true }));
  const active = ordered.filter(task => task.status === 'IN_PROGRESS');
  const next = active.length ? null : ordered.find(task => task.status === 'TODO' && !task.problems.length)?.id ?? null;
  const token = digest([root, git.head, paths, documents]);
  const issues = [...diagnostics];
  for (const kind of kinds) {
    if (!documents[kind]) issues.push({ kind, message: `缺少 ${kind.toUpperCase()} 文档` });
    else if (!index[kind].index.size) issues.push({ kind, message: `没有读取到 ${kind.toUpperCase()} 的稳定 ID` });
    for (const id of index[kind].duplicates) issues.push({ kind, message: `重复的 ID ${id}` });
  }
  return { root, paths, documents, git, index, ordered, counts, next, active, token, issues };
}

export async function openProject(path, signal) {
  const root = await projectRoot(path, signal);
  const [loaded, git] = await Promise.all([loadDocuments(root), gitOverview(root, signal)]);
  return model(root, loaded, git);
}

function publicTask(task) {
  const { id, title, line, priority, status, owner, reqs, designs, deps, files, acceptance, reason, problems } = task;
  return { id, title, line, priority, status, owner, reqs, designs, deps, files, acceptance, reason, problems };
}

export function overview(project) {
  return {
    token: project.token, git: project.git, counts: project.counts, active: project.active.map(task => task.id), next: project.next,
    documents: Object.fromEntries(Object.entries(project.paths).filter(([kind]) => kind !== 'reviews').map(([kind, path]) =>
      [kind, { path, found: project.documents[kind] !== null, entries: project.index[kind]?.index.size ?? null }])),
    issues: project.issues, tasks: project.ordered.map(publicTask),
  };
}

function comparable(kind, row) {
  if (!row) return null;
  if (kind !== 'tasks') return [row.title, row.body];
  const { title, reqs, designs, deps, files, acceptance, fields } = row;
  return [title, reqs, designs, deps, [...files].sort(), acceptance, fields.priority ?? ''];
}

function compareEntries(kind, before, after) {
  const found = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(id);
    const current = after.get(id);
    if (JSON.stringify(comparable(kind, old)) === JSON.stringify(comparable(kind, current))) continue;
    const summary = row => row ? { title: row.title, line: row.line, text: row.body.slice(0, 1100) } : null;
    found.push({ id, type: !old ? '新增' : !current ? '移除' : '更新', before: summary(old), after: summary(current) });
  }
  return found;
}

function relatedDesigns(index, reqs) {
  return [...index.design.index.values()].filter(row => ids('prd', row.fields.req ?? row.body).some(id => reqs.has(id))).map(row => row.id);
}

function nextId(index) {
  return Math.max(0, ...[...index.keys()].map(id => Number(id.split('-').at(-1)))) + 1;
}

function changedReasons(task, old, changeSets) {
  const references = new Set();
  for (const row of [task, old].filter(Boolean)) {
    for (const req of row.reqs) if (changeSets.prd.has(req)) references.add(req);
    for (const design of row.designs) if (changeSets.design.has(design)) references.add(design);
  }
  if (changeSets.tasks.has(task.id)) references.add(task.id);
  return [...references].sort();
}

export async function taskDiff(project, input, signal) {
  const sha = await reference(project.root, input.ref, signal);
  const oldAgents = await documentAt(project.root, sha, project.paths.agents, signal);
  const oldPaths = { ...project.paths };
  for (const [kind, path] of Object.entries(configuredPaths(oldAgents))) {
    if (kinds.includes(kind) && localPath(path)) oldPaths[kind] = path;
  }
  const beforeFiles = await Promise.all(kinds.map(async kind => {
    const recorded = await documentAt(project.root, sha, oldPaths[kind], signal);
    if (recorded !== null) return recorded;
    for (const file of [`docs/${kind.toUpperCase()}.md`, `${kind.toUpperCase()}.md`]) {
      if (file === oldPaths[kind]) continue;
      const candidate = await documentAt(project.root, sha, file, signal);
      if (candidate !== null) {
        oldPaths[kind] = file;
        return candidate;
      }
    }
    return null;
  }));
  const previous = indexes(Object.fromEntries(kinds.map((name, index) => [name, beforeFiles[index]])));
  const changes = Object.fromEntries(kinds.map(kind => [kind, compareEntries(kind, previous[kind].index, project.index[kind].index)]));
  const changeSets = Object.fromEntries(kinds.map(kind => [kind, new Set(changes[kind].map(change => change.id))]));
  const semantic = new Map(kinds.flatMap(kind => changes[kind].map(change => [change.id, [
    comparable(kind, previous[kind].index.get(change.id)), comparable(kind, project.index[kind].index.get(change.id)),
  ]])));
  for (const id of [...relatedDesigns(previous, changeSets.prd), ...relatedDesigns(project.index, changeSets.prd)]) changeSets.design.add(id);
  const affected = new Map();
  for (const task of project.ordered) {
    const reasons = changedReasons(task, previous.tasks.index.get(task.id), changeSets);
    if (reasons.length) affected.set(task.id, reasons);
  }
  let previousCount;
  do {
    previousCount = affected.size;
    for (const task of project.ordered) {
      if (affected.has(task.id)) continue;
      const upstream = task.deps.filter(id => affected.has(id) || changeSets.tasks.has(id));
      if (upstream.length) affected.set(task.id, upstream);
    }
  } while (affected.size !== previousCount);
  let sequence = Math.max(nextId(previous.tasks.index), nextId(project.index.tasks.index));
  const allocate = () => `TASK-${String(sequence++).padStart(3, '0')}`;
  const suggestions = [];
  for (const task of project.ordered) {
    const reasons = affected.get(task.id);
    const release = task.status === 'BLOCKED' && !task.problems.length && dependencyBlock.test(task.reason);
    if (!reasons && !release) continue;
    const evidence = reasons ?? task.deps;
    const withdrawn = task.reqs.length > 0 && task.reqs.every(id => {
      const req = project.index.prd.index.get(id);
      return req ? retired.test(req.fields.status ?? '') : previous.prd.index.has(id);
    });
    let action = '更新';
    let edit = null;
    let newId = null;
    let changeKey = null;
    if (task.status === 'DONE') {
      if (withdrawn || evidence.every(id => id === task.id)) continue;
      action = '新增后续任务';
      changeKey = digest([sha, task.id, evidence.map(id => [id, semantic.get(id)])]).slice(0, 16);
      const existing = project.ordered.find(row => row.source.includes(task.id) && row.change === changeKey);
      if (existing) {
        action = '复用后续任务';
        newId = existing.id;
      } else {
        newId = allocate();
      }
    } else if (withdrawn || task.problems.length) {
      action = withdrawn ? '停做待确认' : '阻塞';
      edit = stateEdit(project.documents.tasks, task, 'BLOCKED');
    } else if (release) {
      action = '解除阻塞';
      edit = stateEdit(project.documents.tasks, task, 'TODO');
    }
    suggestions.push({ action, task: publicTask(task), reasons: evidence, newId, changeKey, edit });
  }
  for (const change of changes.prd) {
    if (!change.after) continue;
    const req = project.index.prd.index.get(change.id);
    if (retired.test(req.fields.status ?? '') || project.ordered.some(task => task.reqs.includes(change.id))) continue;
    const designs = relatedDesigns(project.index, new Set([change.id]));
    suggestions.push({ action: designs.length ? '新增任务草案' : '先补技术设计', task: null, reasons: [change.id, ...designs],
      newId: designs.length ? allocate() : null, changeKey: null, edit: null });
  }
  return { token: project.token, ref: input.ref, baseline: sha, paths: project.paths, oldPaths, changes, suggestions,
    issues: kinds.flatMap((kind, index) => beforeFiles[index] === null ? [`基线中未找到 ${kind.toUpperCase()}，该项按首次盘点处理`] : []) };
}

function requireTask(project, id) {
  const task = project.ordered.find(row => row.id === id);
  if (!task) throw new ProjectError('找不到指定任务。', 404);
  return task;
}

export function reviewPath(project, task) {
  const configured = task.fields.review?.replace(/^\[.+?\]\((.+)\)$/, '$1').replace(/^\.\//, '');
  if (configured && localPath(configured) && /\.md$/i.test(configured)) return configured;
  return project.paths.reviews ? `${project.paths.reviews}/${task.id}-review.md` : null;
}

export function startTask(project, { taskId, owner }) {
  const task = requireTask(project, taskId);
  const assignee = typeof owner === 'string' && owner.trim() ? owner.trim() : task.owner;
  const problems = [...task.problems.map(problem => problem.text)];
  if (!assignee || !ownerPattern.test(assignee)) problems.push('请填写可识别的执行者。');
  if (!['TODO', 'IN_PROGRESS'].includes(task.status)) problems.push(`任务当前状态为 ${task.status ?? '未知'}`);
  if (task.status === 'IN_PROGRESS' && task.owner && task.owner !== assignee) problems.push(`任务已由 ${task.owner} 负责，请先在 TASKS 中确认交接。`);
  const other = project.active.find(active => active.id !== task.id);
  if (other) problems.push(`同一工作区已有写任务 ${other.id} 正在推进。`);
  return { token: project.token, task: publicTask(task), assignee, problems, ready: problems.length === 0,
    paths: project.paths, review: reviewPath(project, task), taskEdit: stateEdit(project.documents.tasks, task, 'IN_PROGRESS') };
}

function identity(value = '') {
  return value.normalize('NFKC').trim().toLowerCase();
}

export async function checkReview(project, { taskId }, signal) {
  const task = requireTask(project, taskId);
  const problems = task.problems.map(problem => problem.text);
  if (!['REVIEW', 'DONE'].includes(task.status)) problems.push('请先提交候选版本并将任务推进到 REVIEW。');
  if (!task.owner) problems.push('任务缺少开发负责人。');
  const evidencePath = reviewPath(project, task);
  const fileSet = task.files.length && task.files.every(localPath)
    ? await candidateFiles(project.root, task.files, [...Object.values(project.paths), evidencePath], signal) : [];
  if (fileSet.length === 0) problems.push('候选交付缺少可验证的任务文件。');
  const candidate = digest([
    fileSet, comparable('tasks', task), task.owner,
    task.reqs.map(id => comparable('prd', project.index.prd.index.get(id))),
    task.designs.map(id => comparable('design', project.index.design.index.get(id))),
  ]);
  const saved = evidencePath ? await readProjectFile(project.root, evidencePath) : null;
  const round = lastReview(saved);
  if (!round) problems.push(`缺少独立 Review${evidencePath ? ` ${evidencePath}` : ''}。`);
  else {
    if (round.candidate !== candidate) problems.push('审核证据与当前候选摘要不一致，需要复验。');
    if (!round.reviewer || identity(round.reviewer) === identity(task.owner ?? '')) problems.push('审核者应填写实名或明确的会话身份，并独立于开发者。');
    if (!/^PASS$/i.test(round.test ?? '')) problems.push('必要测试缺少 PASS 结果。');
    if (!round.evidence || /^(无|待补|待确认|N\/A|—|-)$/i.test(round.evidence)) problems.push('缺少实际测试命令、日志或 CI 证据。');
    if (!/^PASS$/i.test(round.verdict ?? '')) problems.push('独立审核结论须为 PASS。');
    if (!/^(0|无|none)$/i.test(round.issues ?? '')) problems.push('需要确认未关闭的 P0/P1 问题为 0。');
  }
  return { token: project.token, reviewToken: digest([candidate, evidencePath, saved]), task: publicTask(task), path: evidencePath, candidate,
    files: fileSet.map(([file]) => file), round, paths: project.paths, problems, ready: !problems.length,
    taskEdit: stateEdit(project.documents.tasks, task, 'DONE') };
}
