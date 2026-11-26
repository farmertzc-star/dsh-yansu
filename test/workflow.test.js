import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, symlink, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { checkReview, openProject, overview, preparation, prepareReviewRecord, startTask, taskDiff } from '../lib/flow.js';
import { documentPreview, draft, initialization, prdImport } from '../lib/handoff.js';
import { readEntries, stateEdit } from '../lib/markdown.js';

const prd = '# 需求\n\n## REQ-001 订单导出\n\n- 状态：APPROVED\n- 验收标准：根据日期导出。\n';
const design = '# 技术设计\n\n## DES-001 导出服务\n\n- 需求：REQ-001\n- 状态：APPROVED\n\n复用现有服务。\n';
const makeTask = (id, { status = 'TODO', deps = '无', file = 'src/order.js', extras = '', owner = 'Dev' } = {}) => `## ${id} 导出交付\n\n- 需求：REQ-001\n- 设计：DES-001\n- 优先级：P1\n- 状态：${status}\n- 负责人：${owner}\n- 依赖：${deps}\n- 目标文件：\`${file}\`\n- 验收标准：验证日期过滤。\n${extras}\n`;

function git(root, ...args) {
  return execFileSync('git', ['-C', root, '-c', 'user.name=Yansu Test', '-c', 'user.email=yansu@example.invalid', ...args], { encoding: 'utf8' });
}

async function fixture(t, tasks = makeTask('TASK-001'), documents = 'docs') {
  const root = await mkdtemp(join(tmpdir(), 'yansu-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, documents, 'reviews'), { recursive: true });
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/order.js'), 'export const format = "csv";\n');
  if (documents !== 'docs') await writeFile(join(root, 'AGENTS.md'), `- PRD: \`${documents}/PRD.md\`\n- DESIGN: \`${documents}/DESIGN.md\`\n- TASKS: \`${documents}/TASKS.md\`\n- Reviews: \`${documents}/reviews\`\n`);
  await writeFile(join(root, documents, 'PRD.md'), prd);
  await writeFile(join(root, documents, 'DESIGN.md'), design);
  await writeFile(join(root, documents, 'TASKS.md'), '# 任务清单\n\n' + tasks);
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Baseline');
  return root;
}

test('discovers existing explicit document paths and preserves sources on initialization', async t => {
  const root = await fixture(t, makeTask('TASK-001'), 'project-documents');
  const p = await openProject(root);
  assert.equal(overview(p).next, 'TASK-001');
  assert.equal(p.paths.prd, 'project-documents/PRD.md');
  assert.deepEqual(initialization(p).create, []);
  assert.match(draft('initialize', initialization(p), {}), /先展示文档补丁/);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('versions one active PRD and keeps archives out of requirement and task calculations', async t => {
  const root = await fixture(t, makeTask('TASK-001'), 'project-documents');
  const active = 'project-documents/PRD.md';
  const archive = active + '.versions/v1.md';
  const before = await openProject(root);
  const plan = prdImport(before);
  assert.equal(plan.current, 'v1');
  assert.deepEqual(plan.update, { version: 'v2', archivePath: archive, archiveExists: false, conflict: false });
  const merged = draft('importPrd', plan, { mode: 'merge' });
  const supplemented = draft('importPrd', plan, { mode: 'supplement' });
  const replaced = draft('importPrd', plan, { mode: 'replace' });
  const nextVersion = draft('importPrd', plan, { mode: 'newVersion' });
  assert.match(merged, /合并重复条目，复用既有 REQ ID/);
  assert.match(supplemented, /导入 PRD · 补充[\s\S]*保留已有规则和需求状态，将冲突单独列为待确认/);
  assert.match(replaced, /导入 PRD · 替换[\s\S]*替换指定条目的内容并沿用其 REQ ID，保留其余条目/);
  assert.match(nextVersion, /导入 PRD · 新版本[\s\S]*完整的下一版需求范围[\s\S]*明确确认撤销后标为已废弃/);
  assert.throws(() => draft('importPrd', plan, { mode: 'unknown' }), /未知 PRD 更新方式/);
  for (const prompt of [supplemented, replaced, nextVersion]) {
    assert.match(prompt, /相同资料重复导入而需求无变化时，无需写入或升版/);
    assert.match(prompt, /负责人确认后重新校验基线/);
    assert.match(prompt, /<!-- yansu:prd-version v2 -->/);
  }
  const revision = draft('revisePrd', plan, {});
  assert.match(revision, /action=revisePrd/);
  assert.match(revision, /先问我要改什么/);
  assert.match(revision, /保存到 "project-documents\/PRD\.md\.versions\/v1\.md"/);
  assert.match(revision, /关联设计标为 DRAFT.*保留原方案和其他设计的状态/);
  assert.match(revision, /负责人确认后重新校验基线/);
  assert.match(revision, /<!-- yansu:prd-version v2 -->/);

  await mkdir(join(root, active + '.versions'));
  await writeFile(join(root, archive), prd);
  const retried = prdImport(await openProject(root));
  assert.equal(retried.update.archiveExists, true);
  assert.equal(retried.update.version, 'v2');
  assert.notEqual(retried.token, before.token);
  await writeFile(join(root, active), '<!-- yansu:prd-version v2 -->\n' + prd.replace('订单导出', '订单明细导出'));
  const after = await openProject(root);
  const report = overview(after);
  assert.equal(report.documents.prd.entries, 1);
  assert.equal(report.next, 'TASK-001');
  assert.deepEqual(report.prdVersions, [{ version: 'v2', current: true }, { version: 'v1', current: undefined }]);
  assert.equal((await documentPreview(after, 'prd', 'v1')).text, prd);
  assert.match((await documentPreview(after, 'prd')).text, /订单明细导出/);
  await assert.rejects(documentPreview(after, 'prd', '../AGENTS.md'), /找不到此 PRD 版本/);
  assert.equal(prdImport(after).update.version, 'v3');
  const redesign = preparation(after, 'design', { revise: true });
  assert.deepEqual(redesign.items.map(row => row.id), ['REQ-001']);
  assert.match(draft('design', redesign, { revise: true }), /revise=true/);
  assert.match(draft('rules', after, {}), /保留其余条款、PRD、DESIGN、TASKS 和 Reviews/);
});

test('prepares a first PRD without requiring an update mode or an archive', async t => {
  const root = await fixture(t);
  await rm(join(root, 'docs/PRD.md'));
  const plan = prdImport(await openProject(root));
  assert.equal(plan.current, null);
  assert.deepEqual(plan.update, { version: 'v1', archivePath: null, archiveExists: false, conflict: false });
  const prompt = draft('importPrd', plan, {});
  assert.match(prompt, /用本轮资料建立生效 PRD/);
  assert.match(prompt, /<!-- yansu:prd-version v1 -->/);
  assert.doesNotMatch(prompt, /当前 PRD 原文/);
});

test('blocks a PRD import when its version archive already contains different content', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'docs/PRD.md.versions'));
  await writeFile(join(root, 'docs/PRD.md.versions/v1.md'), '# different');
  const project = await openProject(root);
  const plan = prdImport(project);
  assert.equal(plan.ready, false);
  assert.throws(() => draft('importPrd', plan, {}), /历史版本路径或内容存在冲突/);
  assert.equal((await documentPreview(project, 'prd', 'v1')).text, prd);
});

test('supports Markdown tables and task state replacements without touching other fields', () => {
  const md = '| 任务 | 标题 | 状态 | 优先级 | 需求 | 设计 | 负责人 | 目标文件 | 验收标准 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| TASK-001 | TODO 标题 | TODO | P1 | REQ-001 | DES-001 | Dev | `src/my module.js` | 程序可运行 |\n';
  const [task] = readEntries('tasks', md);
  assert.deepEqual(task.files, ['src/my module.js']);
  assert.match(stateEdit(md, task, 'IN_PROGRESS').after, /TODO 标题 \| IN_PROGRESS/);
  assert.equal(readEntries('prd', '```md\n## REQ-099 虚假条目\n```').length, 0);
  const legacy = '**TASK-012：实现订单创建**\n\n- 设计：DESIGN §4.2\n- 状态：TODO\n**执行要求**\n继续说明';
  assert.deepEqual(readEntries('tasks', legacy).map(row => [row.id, row.designs, row.status]), [['TASK-012', ['§4.2'], 'TODO']]);
  assert.equal(readEntries('design', '### 4.2 共享契约\n- 状态：APPROVED')[0].id, '§4.2');
});

test('plans first tasks from approved designs even when HEAD has no changes', async t => {
  const root = await fixture(t, '');
  await writeFile(join(root, 'docs/PRD.md'), prd + '\n## REQ-002 导出权限\n- 状态：待确认\n\n## REQ-003 导出模板\n');
  await writeFile(join(root, 'docs/DESIGN.md'), design + '\n## DES-003 模板服务\n- 需求：REQ-003\n- 状态：DRAFT\n');
  git(root, 'rm', 'docs/TASKS.md');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Approved requirements and design');

  const project = await openProject(root);
  assert.equal(overview(project).documents.tasks.found, false);
  assert.deepEqual((await taskDiff(project, { ref: 'HEAD' })).suggestions, []);
  const plan = preparation(project, 'plan');
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.items.map(row => [row.id, row.designs]), [['REQ-001', ['DES-001']]]);
  assert.match(draft('plan', plan, {}), /REQ-001 · DES-001/);
  assert.deepEqual(preparation(project, 'design').items.map(row => row.id), ['REQ-003']);

  await writeFile(join(root, 'docs/TASKS.md'), makeTask('TASK-001'));
  const planned = preparation(await openProject(root), 'plan');
  assert.equal(planned.ready, false);
  assert.throws(() => draft('plan', planned, {}), /确认设计/);

  await writeFile(join(root, 'docs/PRD.md'), project.documents.prd.replace('导出模板', '导出模板配置'));
  const diff = await taskDiff(await openProject(root), { ref: 'HEAD' });
  assert.equal(diff.suggestions.find(row => row.reasons.includes('REQ-003')).action, '先补技术设计');
});

test('offers stage actions based on prerequisites and only completes planning when every confirmed requirement is linked', async t => {
  const root = await fixture(t, makeTask('TASK-001', { status: 'DONE' }));
  const prdPath = join(root, 'docs/PRD.md');
  const designPath = join(root, 'docs/DESIGN.md');
  await writeFile(prdPath, '# 需求\n\n待整理的订单导出说明。\n');
  const intake = overview(await openProject(root));
  assert.equal(intake.delivery.recommended, 0);
  assert.equal(intake.delivery.steps[0].name, '需求接入');
  assert.equal(intake.delivery.steps[0].actions[0].action, 'requirements');
  assert.equal(intake.delivery.steps[1].actions[0].stage, 0);
  assert.equal(intake.delivery.steps[2].actions[0].stage, 1);

  await writeFile(prdPath, prd + '\n## REQ-002 下载权限\n\n- 状态：APPROVED\n\n## REQ-003 模板格式\n\n- 状态：待确认\n');
  const partial = overview(await openProject(root));
  const [requirementsStep, designStep, planStep, executionStep] = partial.delivery.steps;
  assert.equal(partial.delivery.recommended, 1);
  assert.equal(requirementsStep.actions[0].action, 'requirements');
  assert.ok(requirementsStep.actions.some(action => action.action === 'revisePrd'));
  assert.deepEqual(designStep.actions[0], { label: '讨论技术设计', action: 'design' });
  assert.equal(planStep.done, false);
  assert.equal(planStep.summary, '1/2 条需求已关联任务');
  assert.ok(!planStep.actions.some(action => action.action === 'plan'));
  assert.equal(executionStep.done, false);

  await writeFile(designPath, design + '\n## DES-002 下载控制\n\n- 需求：REQ-002\n- 状态：APPROVED\n');
  const ready = overview(await openProject(root));
  assert.equal(ready.delivery.recommended, 2);
  assert.equal(ready.delivery.steps[2].actions[0].action, 'plan');
  assert.deepEqual(ready.delivery.steps[1].actions[0].params, { revise: '1' });

  const taskPath = join(root, 'docs/TASKS.md');
  const existing = await readFile(taskPath, 'utf8');
  await writeFile(taskPath, existing + makeTask('TASK-001'));
  const blocked = overview(await openProject(root));
  assert.ok(!blocked.delivery.steps[2].actions.some(action => action.action === 'plan'));
  assert.match(blocked.delivery.steps[2].problems[0], /重复的任务 ID/);

  await writeFile(taskPath, existing + makeTask('TASK-002').replace('REQ-001', 'REQ-002').replace('DES-001', 'DES-002'));
  const planned = overview(await openProject(root));
  assert.equal(planned.delivery.recommended, 3);
  assert.equal(planned.delivery.steps[2].done, true);
  assert.equal(planned.delivery.steps[3].actions[0].task, 'TASK-002');
});

test('diff propagates requirements through design and downstream tasks and proposes stable follow-up IDs', async t => {
  const initial = makeTask('TASK-001', { status: 'DONE' }) + makeTask('TASK-002', { deps: 'TASK-001' });
  const root = await fixture(t, initial);
  await writeFile(join(root, 'docs/PRD.md'), prd + '\n- 区间最多 31 天。\n');
  const first = await taskDiff(await openProject(root), { ref: 'HEAD' });
  assert.equal(first.changes.prd[0].id, 'REQ-001');
  assert.deepEqual(first.suggestions.map(row => row.action), ['新增后续任务', '更新']);
  const followUp = first.suggestions[0];
  assert.equal(followUp.newId, 'TASK-003');
  await writeFile(join(root, 'docs/TASKS.md'), initial + makeTask('TASK-003', {
    extras: `- 来源任务：TASK-001\n- 变更键：${followUp.changeKey}`,
  }));
  const second = await taskDiff(await openProject(root), { ref: first.baseline });
  assert.equal(second.suggestions[0].action, '复用后续任务');
  assert.equal(second.suggestions[0].newId, 'TASK-003');
  assert.match(draft('diff', second, { selected: [0] }), /复用后续任务 TASK-001 → TASK-003/);
});

test('assigns only eligible tasks and reports unresolved cycles and stale designs', async t => {
  const root = await fixture(t, makeTask('TASK-001', { deps: 'TASK-002' }) + makeTask('TASK-002', { deps: 'TASK-001' }));
  const initial = await openProject(root);
  assert.equal(overview(initial).next, null);
  assert.ok(startTask(initial, { taskId: 'TASK-001' }).problems.some(problem => problem.includes('循环依赖')));
  await writeFile(join(root, 'docs/TASKS.md'), makeTask('TASK-001', { status: 'IN_PROGRESS' }) + makeTask('TASK-002'));
  await writeFile(join(root, 'docs/DESIGN.md'), design.replace('APPROVED', 'DRAFT'));
  const updated = await openProject(root);
  const r = startTask(updated, { taskId: 'TASK-002', owner: 'Dev' });
  assert.ok(r.problems.some(problem => problem.includes('设计尚未确认')));
  assert.ok(r.problems.some(problem => problem.includes('已有写任务')));
  assert.notEqual(updated.token, initial.token);
});

test('reviews only a current candidate with independent recorded evidence', async t => {
  const root = await fixture(t, makeTask('TASK-001', { status: 'REVIEW' }));
  const p = await openProject(root);
  const noReview = await checkReview(p, { taskId: 'TASK-001' });
  assert.equal(noReview.ready, false);
  assert.equal(noReview.canReview, true);
  assert.match(draft('review', noReview, {}), /yansu_review_record/);
  const path = join(root, noReview.path);
  const testEvidence = `## 第 1 轮\n- 候选摘要：${noReview.candidate}\n- 审核者：dev\n- 测试结果：PASS\n- 测试证据：实际运行 \`node --test\`，通过。\n- 结论：PASS\n- 未关闭P0/P1：0\n`;
  await writeFile(path, testEvidence);
  assert.ok((await checkReview(p, { taskId: 'TASK-001' })).problems.some(problem => problem.includes('独立')));
  await writeFile(path, testEvidence.replace('审核者：dev', '审核者：QA'));
  const passed = await checkReview(p, { taskId: 'TASK-001' });
  assert.equal(passed.ready, true);
  assert.match(passed.taskEdit.after, /DONE/);
  assert.match(draft('review', passed, {}), /expectedReview=/);
  assert.match(draft('review', passed, {}), /我已在验收面板核对独立审核身份及测试证据/);
  await writeFile(join(root, 'src/order.js'), 'export const format = "tsv";');
  const stale = await checkReview(await openProject(root), { taskId: 'TASK-001' });
  assert.equal(stale.ready, false);
  assert.notEqual(stale.reviewToken, passed.reviewToken);
  assert.ok(stale.problems.some(problem => problem.includes('摘要不一致')));
});

test('generates an append-only review record from structured evidence and rejects stale snapshots', async t => {
  const taskId = 'TASK-001';
  const root = await fixture(t, makeTask(taskId, { status: 'REVIEW' }));
  const project = await openProject(root);
  const initial = await checkReview(project, { taskId });
  const input = {
    taskId, expected: initial.token, expectedReview: initial.reviewToken,
    testResult: 'PASS', evidence: '`node --test`\n退出码 0，12 项通过。', verdict: 'PASS', openIssues: 0,
  };
  await assert.rejects(prepareReviewRecord(project, input, 'dev'), /独立/);
  await assert.rejects(prepareReviewRecord(project, { ...input, openIssues: 1 }, 'qa-session'), /P0\/P1/);

  const record = await prepareReviewRecord(project, input, 'qa-session');
  assert.equal(record.operation, 'create');
  const file = join(root, record.path);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  assert.match(record.markdown, /^## 第 1 轮$/m);
  assert.match(record.markdown, /^- 测试结果：PASS$/m);
  await writeFile(file, record.markdown);
  const passed = await checkReview(project, { taskId });
  assert.equal(passed.ready, true);
  assert.equal(passed.round.reviewer, '审核会话 qa-session');
  assert.equal(passed.round.evidence, 'node --test 退出码 0，12 项通过。');
  await assert.rejects(prepareReviewRecord(project, input, 'qa-session'), /审核记录已变化/);

  const followUp = await prepareReviewRecord(project, { ...input, expectedReview: passed.reviewToken, verdict: 'FAIL' }, 'qa-session');
  assert.equal(followUp.operation, 'append');
  assert.match(followUp.markdown, /^## 第 2 轮$/m);
  await writeFile(file, record.markdown + followUp.markdown);
  const failed = await checkReview(project, { taskId });
  assert.equal(failed.ready, false);
  assert.equal(failed.round.verdict, 'FAIL');

  await writeFile(join(root, 'src/order.js'), 'export const format = "tsv";');
  const changed = await openProject(root);
  await assert.rejects(prepareReviewRecord(changed, { ...input, expectedReview: failed.reviewToken }, 'qa-session'), /候选代码/);
});

test('refuses to inspect Markdown through symlinks and requires the Git root', async t => {
  const root = await fixture(t);
  const contents = await readFile(join(root, 'docs/PRD.md'));
  await writeFile(join(root, 'outside-prd.md'), contents);
  await rm(join(root, 'docs/PRD.md'));
  await symlink(join(root, 'outside-prd.md'), join(root, 'docs/PRD.md'));
  await assert.rejects(openProject(root), /实际文件路径/);
  await assert.rejects(openProject(join(root, 'src')), /仓库根目录/);
});
