import { clean, ids, readEntries, reviewHistory, stateEdit, states } from './markdown.js';
import { candidateFiles, configuredPaths, digest, documentAt, gitOverview, inspectPrdVersions, loadDocuments, localPath, ProjectError, projectRoot, readProjectFile, reference } from './workspace.js';
import { prdImport } from './handoff.js';
import { deliveryState } from './stages.js';

const kinds = ['prd', 'design', 'tasks'];
const priorityOrder = new Map(['P0', 'P1', 'P2', 'P3'].map((p, index) => [p, index]));
const notConfirmed = /(?:待确认|DRAFT|BLOCKED|REVIEW|未确认|已废弃|撤回|DEPRECATED|CANCELLED)/i;
const retired = /(?:已废弃|废弃|撤回|DEPRECATED|CANCELLED)/i;
const dependencyBlock = /^(?:前置依赖|依赖未完成|dependency\b)/i;
const ownerPattern = /^[^\x00-\x1f\x7f]{1,80}$/;
const approvedDesign = row => /^(?:APPROVED\b|已确认$|已批准$)/i.test(row.fields.status ?? '');
const designRequirements = row => ids('prd', row.fields.req ?? row.body);

function requirementState(row, duplicates) {
  if (duplicates.has(row.id)) return 'duplicate';
  if (retired.test(row.fields.status ?? '')) return 'retired';
  if (notConfirmed.test(row.fields.status ?? '')) return 'pending';
  return 'confirmed';
}

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
    else if (requirementState(req, index.prd.duplicates) !== 'confirmed') add('contract', `需求状态待处理 ${id} ${req.fields.status}`);
  }
  for (const id of task.designs) {
    const des = index.design.index.get(id);
    if (!des || index.design.duplicates.has(id)) {
      add('references', `设计不存在或重复 ${id}`);
      continue;
    }
    if (!approvedDesign(des)) add('contract', `设计尚未确认 ${id}`);
    const reqs = designRequirements(des);
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

function planningCoverage(index) {
  const requirements = new Map([...index.prd.index.values()].map(row => [row.id, {
    id: row.id, title: row.title, state: requirementState(row, index.prd.duplicates), designs: [], tasks: [],
  }]));
  for (const row of index.design.index.values()) {
    if (index.design.duplicates.has(row.id) || !approvedDesign(row)) continue;
    for (const id of designRequirements(row)) requirements.get(id)?.designs.push(row.id);
  }
  for (const task of index.tasks.index.values()) {
    for (const id of task.reqs) requirements.get(id)?.tasks.push(task.id);
  }
  return requirements;
}

export function preparation(project, action, input = {}) {
  const kind = { requirements: 'prd', design: 'design', plan: 'tasks' }[action];
  const requirements = [...project.requirements.values()];
  const confirmed = requirements.filter(row => row.state === 'confirmed');
  const items = action === 'design' ? confirmed.filter(row => input.revise || row.designs.length === 0)
    : action === 'plan' ? confirmed.filter(row => row.designs.length > 0 && row.tasks.length === 0)
      : requirements;
  const problems = [];
  if (action !== 'requirements' && !project.paths[kind]) problems.push('请先在 AGENTS.md 确认目标文档路径。');
  if (action === 'design' && !items.length) problems.push(confirmed.length ? '当前可用于设计的需求均已关联已确认设计。' : '请先接入有稳定 ID 的已确认需求。');
  if (action === 'plan' && project.index.tasks.duplicates.size) problems.push('请先修正重复的任务 ID，再编排新增任务。');
  if (action === 'plan' && !items.length && !problems.length) problems.push(confirmed.some(row => row.designs.length)
    ? '已有确认设计的需求均已关联任务。' : '任务编排需要先确认技术设计。');
  return { token: project.token, paths: project.paths, path: project.paths[kind], items, problems, ready: problems.length === 0 };
}

function model(root, loaded, git) {
  const { paths, documents, diagnostics, prdVersions } = loaded;
  const index = indexes(documents);
  const cycles = cycleIds(index.tasks.index);
  const tasks = [...index.tasks.index.values()].map(task => ({ ...task, problems: taskProblems(task, index, cycles) }));
  const counts = Object.fromEntries(states.map(state => [state, tasks.filter(task => task.status === state).length]));
  const ordered = [...tasks].sort((a, b) => (priorityOrder.get(a.priority) ?? 4) - (priorityOrder.get(b.priority) ?? 4) || a.id.localeCompare(b.id, 'en', { numeric: true }));
  const active = ordered.filter(task => task.status === 'IN_PROGRESS');
  const next = active.length ? null : ordered.find(task => task.status === 'TODO' && !task.problems.length)?.id ?? null;
  const token = digest([root, git.head, paths, documents, prdVersions]);
  const issues = [...diagnostics];
  for (const kind of kinds) {
    if (documents[kind] === null) issues.push({ kind, code: 'missing', message: `缺少 ${kind.toUpperCase()} 文档` });
    else if (!index[kind].index.size) issues.push({ kind, code: 'unindexed', message: `没有读取到 ${kind.toUpperCase()} 的稳定 ID` });
    for (const id of index[kind].duplicates) issues.push({ kind, code: 'duplicate', message: `重复的 ID ${id}` });
  }
  return { root, paths, documents, git, index, ordered, counts, next, active, token, issues, prdVersions, requirements: planningCoverage(index) };
}

export async function openProject(path, signal) {
  const root = await projectRoot(path, signal);
  const [loaded, git] = await Promise.all([loadDocuments(root), gitOverview(root, signal)]);
  loaded.prdVersions = await inspectPrdVersions(root, loaded.paths.prd, loaded.documents.prd);
  return model(root, loaded, git);
}

function publicTask(task) {
  const { id, title, line, priority, status, owner, reqs, designs, deps, files, acceptance, reason, problems } = task;
  return { id, title, line, priority, status, owner, reqs, designs, deps, files, acceptance, reason, problems };
}

export function overview(project) {
  const readiness = Object.fromEntries([
    ['importPrd', prdImport(project)],
    ['design', preparation(project, 'design', { revise: true })],
    ['plan', preparation(project, 'plan')],
  ].map(([action, { ready, problems }]) => [action, { ready, problems }]));
  const report = {
    token: project.token, git: project.git, counts: project.counts, active: project.active.map(task => task.id), next: project.next,
    documents: Object.fromEntries(Object.entries(project.paths).filter(([kind]) => kind !== 'reviews').map(([kind, path]) =>
      [kind, { path, found: project.documents[kind] !== null, entries: project.index[kind]?.index.size ?? null }])),
    prdVersions: project.prdVersions.versions.map(({ version, current }) => ({ version, current })),
    issues: project.issues, tasks: project.ordered.map(publicTask), requirements: [...project.requirements.values()], readiness,
  };
  return { ...report, delivery: deliveryState(report) };
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
  return [...index.design.index.values()].filter(row => designRequirements(row).some(id => reqs.has(id))).map(row => row.id);
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
    const req = project.requirements.get(change.id);
    if (req.state !== 'confirmed' || req.tasks.length) continue;
    const designs = req.designs;
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

const placeholderEvidence = /^(无|待补|待确认|N\/A|—|-)$/i;

async function inspectReview(project, taskId, signal) {
  const task = requireTask(project, taskId);
  const problems = task.problems.map(problem => problem.text);
  if (!['REVIEW', 'DONE'].includes(task.status)) problems.push('请先提交候选版本并将任务推进到 REVIEW。');
  if (!task.owner) problems.push('任务缺少开发负责人。');
  const evidencePath = reviewPath(project, task);
  if (!evidencePath) problems.push('请先在 AGENTS.md 确认审核目录。');
  const fileSet = task.files.length && task.files.every(localPath)
    ? await candidateFiles(project.root, task.files, [...Object.values(project.paths), evidencePath], signal) : [];
  if (fileSet.length === 0) problems.push('候选交付缺少可验证的任务文件。');
  const candidate = digest([
    fileSet, comparable('tasks', task), task.owner,
    task.reqs.map(id => comparable('prd', project.index.prd.index.get(id))),
    task.designs.map(id => comparable('design', project.index.design.index.get(id))),
  ]);
  const saved = evidencePath ? await readProjectFile(project.root, evidencePath) : null;
  const { round, next } = reviewHistory(saved);
  const canReview = problems.length === 0;
  if (!round) problems.push('等待独立审核者运行测试并提交记录。');
  else {
    if (round.candidate !== candidate) problems.push('审核证据与当前候选摘要不一致，需要复验。');
    if (!round.reviewer || identity(round.reviewer) === identity(task.owner ?? '')) problems.push('审核者应填写实名或明确的会话身份，并独立于开发者。');
    if (!/^PASS$/i.test(round.test ?? '')) problems.push('必要测试缺少 PASS 结果。');
    if (!round.evidence || placeholderEvidence.test(round.evidence)) problems.push('缺少实际测试命令、日志或 CI 证据。');
    if (!/^PASS$/i.test(round.verdict ?? '')) problems.push('独立审核结论须为 PASS。');
    if (!/^(0|无|none)$/i.test(round.issues ?? '')) problems.push('需要确认未关闭的 P0/P1 问题为 0。');
  }
  const result = { token: project.token, reviewToken: digest([candidate, evidencePath, saved]), task: publicTask(task), path: evidencePath, candidate,
    files: fileSet.map(([file]) => file), round, paths: project.paths, problems, ready: !problems.length, canReview,
    taskEdit: stateEdit(project.documents.tasks, task, 'DONE') };
  return { result, saved, next };
}

export async function checkReview(project, { taskId }, signal) {
  return (await inspectReview(project, taskId, signal)).result;
}

export async function prepareReviewRecord(project, input, sessionId, signal) {
  const { result, saved, next } = await inspectReview(project, input.taskId, signal);
  if (input.expected !== result.token || input.expectedReview !== result.reviewToken) {
    throw new ProjectError('候选代码、工程文档或审核记录已变化，请刷新并复核后再生成记录。', 409);
  }
  if (!result.canReview) throw new ProjectError(result.problems.join(' '), 409);
  const reviewer = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!ownerPattern.test(reviewer) || identity(reviewer) === identity(result.task.owner) ||
    identity(`审核会话 ${reviewer}`) === identity(result.task.owner)) {
    throw new ProjectError('请使用独立于开发者的审核会话。', 409);
  }

  const { testResult, verdict, openIssues } = input;
  const oneLine = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  const evidence = oneLine(input.evidence);
  const release = oneLine(input.release);
  if (!['PASS', 'FAIL'].includes(testResult) || !['PASS', 'FAIL'].includes(verdict) ||
    !Number.isSafeInteger(openIssues) || openIssues < 0) throw new ProjectError('填写测试结果、审核结论和未关闭 P0/P1 数量。');
  if (verdict === 'PASS' && (testResult !== 'PASS' || openIssues > 0)) throw new ProjectError('审核通过需要测试通过且未关闭 P0/P1 为 0。');
  if (!clean(evidence) || placeholderEvidence.test(clean(evidence)) || evidence.length > 12000 || release.length > 4000) {
    throw new ProjectError('填写简明的实际测试命令、退出码及结果，或附上测试日志引用。');
  }
  if (!Number.isSafeInteger(next)) throw new ProjectError('审核轮次超出范围，请核对现有记录。');

  const newline = saved?.includes('\r\n') ? '\r\n' : '\n';
  const prefix = saved ? (saved.endsWith(newline + newline) ? '' : saved.endsWith(newline) ? newline : newline + newline)
    : `# ${result.task.id} 审核记录${newline}${newline}`;
  const markdown = prefix + [
    `## 第 ${next} 轮`, '',
    `- 候选摘要：${result.candidate}`,
    `- 审核者：审核会话 ${reviewer}`,
    `- 测试结果：${testResult}`,
    `- 测试证据：${evidence}`,
    `- 结论：${verdict}`,
    `- 未关闭P0/P1：${openIssues}`,
    ...(release ? [`- 发布交接：${release}`] : []), '',
  ].join(newline);
  const history = reviewHistory((saved ?? '') + markdown);
  if (history.round?.candidate !== result.candidate || history.next !== next + 1) {
    throw new ProjectError('现有审核记录的 Markdown 格式需要修正后才能追加。', 409);
  }
  return { path: result.path, operation: saved === null ? 'create' : 'append', markdown };
}
