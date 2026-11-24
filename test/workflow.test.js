import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, symlink, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { checkReview, openProject, overview, startTask, taskDiff } from '../lib/flow.js';
import { initialization, draft } from '../lib/handoff.js';
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
  const path = join(root, noReview.path);
  const testEvidence = `## 第 1 轮\n- 候选摘要：${noReview.candidate}\n- 审核者：dev\n- 测试结果：PASS\n- 测试证据：实际运行 \`node --test\`，通过。\n- 结论：PASS\n- 未关闭P0/P1：0\n`;
  await writeFile(path, testEvidence);
  assert.ok((await checkReview(p, { taskId: 'TASK-001' })).problems.some(problem => problem.includes('独立')));
  await writeFile(path, testEvidence.replace('审核者：dev', '审核者：QA'));
  const passed = await checkReview(p, { taskId: 'TASK-001' });
  assert.equal(passed.ready, true);
  assert.match(passed.taskEdit.after, /DONE/);
  assert.match(draft('review', passed, {}), /expectedReview=/);
  await writeFile(join(root, 'src/order.js'), 'export const format = "tsv";');
  const stale = await checkReview(await openProject(root), { taskId: 'TASK-001' });
  assert.equal(stale.ready, false);
  assert.notEqual(stale.reviewToken, passed.reviewToken);
  assert.ok(stale.problems.some(problem => problem.includes('摘要不一致')));
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
