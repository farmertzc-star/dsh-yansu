function requirementsStage(prd, preflight, confirmed, pending) {
  const actions = [];
  if (pending || prd.found && !prd.entries) actions.push({ label: pending ? '整理待处理需求' : '整理现有 PRD', action: 'requirements' });
  if (prd.entries && preflight.ready) actions.push({ label: '修改需求', action: 'revisePrd' });
  if (preflight.ready) actions.push({ label: prd.found ? '导入 / 更新 PRD' : '导入 PRD', action: 'importPrd' });
  if (prd.found) actions.push({ label: '查看 PRD', action: 'document', params: { kind: 'prd' } });
  if (!prd.path) actions.push({ label: '配置文档路径', action: 'rules' });
  const summary = confirmed || pending ? `${confirmed} 条已确认${pending ? ` · ${pending} 条待处理` : ''}`
    : prd.entries ? '暂无有效需求' : prd.found ? 'PRD 待整理' : '待接入 PRD';
  const text = pending ? `${pending} 条需求待确认或存在重复 ID。只将已确认的需求纳入设计与任务编排。`
    : prd.found && !prd.entries ? '为实际需求补上稳定 ID，在 PRD 中记录确认状态和验收标准。'
      : !preflight.ready ? '更新前请处理 PRD 路径或版本问题。'
        : prd.found ? '在对话中修改需求和验收标准，或导入更新后的 PRD。' : '导入负责人已确认的需求资料，整理成工作区的 PRD。';
  return { name: '需求接入', done: confirmed > 0 && pending === 0, summary, text, actions, problems: preflight.problems };
}

function designStage(doc, preflight, confirmed, designed) {
  const missing = confirmed - designed;
  const actions = [];
  if (preflight.ready) actions.push(missing ? { label: '讨论技术设计', action: 'design' }
    : { label: '复核技术设计', action: 'design', params: { revise: '1' } });
  else if (!confirmed) actions.push({ label: '查看需求接入', stage: 0 });
  else if (!doc.path) actions.push({ label: '配置文档路径', action: 'rules' });
  if (doc.found) actions.push({ label: '查看技术设计', action: 'document', params: { kind: 'design' } });
  const text = !confirmed ? '接入并确认需求后，即可讨论技术方案。'
    : missing ? `${missing} 条已确认需求还缺少已确认设计。讨论方案后，请负责人确认。`
      : '已确认需求均有关联的已确认设计。需求有变化时，可以复核方案。';
  return { name: '架构设计', done: confirmed > 0 && missing === 0, summary: confirmed ? `${designed}/${confirmed} 条需求已有确认设计` : '等待需求确认',
    text, actions, problems: confirmed ? preflight.problems : [] };
}

function planningStage(doc, preflight, confirmed, designed, linked, duplicateTasks) {
  const unplanned = designed - linked;
  const actions = [];
  if (preflight.ready) actions.push({ label: '编排任务', action: 'plan' });
  else if (!unplanned && (!designed || designed < confirmed)) actions.push({ label: '查看架构设计', stage: 1 });
  else if (unplanned && !doc.path) actions.push({ label: '配置文档路径', action: 'rules' });
  if (doc.found) actions.push({ label: '查看任务清单', action: 'document', params: { kind: 'tasks' } });
  const text = unplanned ? `${unplanned} 条需求已有确认设计，尚未关联任务。`
    : !designed ? '确认技术设计后，可将设计拆成可执行、可验收的任务。'
      : designed < confirmed ? `已确认设计均有关联任务，还有 ${confirmed - designed} 条需求待确认设计。`
          : '已确认需求均有关联任务。需求或设计调整后，可以检查任务差分。';
  return { name: '任务编排', done: confirmed > 0 && linked === confirmed && !duplicateTasks,
    summary: designed ? `${linked}/${confirmed} 条需求已关联任务` : '等待设计确认',
    text, actions, problems: unplanned || duplicateTasks ? preflight.problems : [] };
}

function executionStage(report, planned) {
  const { tasks, counts, next, active } = report;
  const usableContract = row => !row.problems.some(({ kind }) => kind === 'contract' || kind === 'references');
  const review = tasks.find(row => row.status === 'REVIEW' && usableContract(row));
  const current = tasks.find(row => active.includes(row.id) && usableContract(row));
  const blocked = tasks.find(row => row.status === 'BLOCKED' || row.status !== 'DONE' && row.problems.length);
  const task = review ?? current ?? tasks.find(row => row.id === next) ?? blocked;
  let actions;
  let text;
  if (task) {
    const label = review ? '检查验收' : current ? '查看进行中的任务' : next ? '查看下一项任务' : '查看任务问题';
    actions = [{ label, task: task.id, ...(review && { action: 'review', params: { taskId: task.id } }) }];
    text = `${task.id} · ${task.title}`;
    if (task === blocked && !review && !current && !next) text += ` · ${task.reason || task.problems[0]?.text || '待解除阻塞'}`;
  } else if (tasks.length) {
    actions = [{ label: '查看任务工作台', taskBoard: true }];
    text = counts.DONE === tasks.length ? '任务清单中的任务均已标记完成，可查看各项验收记录。' : '在任务工作台核对任务状态、执行条件和验收记录。';
  } else {
    actions = [{ label: '查看任务编排', stage: 2 }];
    text = '编排任务后，可在任务工作台检查执行条件并提交验收。';
  }
  if (tasks.length && report.git.head) actions.push({ label: '查看任务差分', diff: true });
  return { name: '开发与验收', done: planned && tasks.length > 0 && counts.DONE === tasks.length,
    summary: tasks.length ? `${counts.DONE}/${tasks.length} 项已完成` : '等待任务编排',
    text, actions, task: task?.id, active: Boolean(review || current), actionable: Boolean(task) };
}

export function deliveryState(report) {
  const { requirements, documents: docs, readiness } = report;
  const confirmed = requirements.filter(row => row.state === 'confirmed');
  const pending = requirements.filter(row => row.state === 'pending' || row.state === 'duplicate').length;
  const designed = confirmed.filter(row => row.designs.length);
  const linked = designed.filter(row => row.tasks.length).length;
  const duplicateTasks = report.issues.some(({ kind, code }) => kind === 'tasks' && code === 'duplicate');
  const requirementsStep = requirementsStage(docs.prd, readiness.importPrd, confirmed.length, pending);
  const designStep = designStage(docs.design, readiness.design, confirmed.length, designed.length);
  const planningStep = planningStage(docs.tasks, readiness.plan, confirmed.length, designed.length, linked, duplicateTasks);
  const executionStep = executionStage(report, planningStep.done);
  const steps = [requirementsStep, designStep, planningStep, executionStep];
  let recommended = 3;
  if (!confirmed.length) recommended = 0;
  else if (!executionStep.active) {
    if (!designStep.done) recommended = 1;
    else if (!planningStep.done) recommended = 2;
    else if (!executionStep.actionable && pending) recommended = 0;
  }
  return { steps, recommended, task: executionStep.task };
}
