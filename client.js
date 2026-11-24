window.__ModuleLoader__.load({
  id: 'dsh-yansu',
  factory(require) {
    const React = require('react');
    const { createElement: h, useEffect, useRef, useState } = React;
    const states = { TODO: '待开始', IN_PROGRESS: '进行中', BLOCKED: '受阻', REVIEW: '待验收', DONE: '已完成' };
    const docs = { agents: '协作规则', prd: '产品需求', design: '技术设计', tasks: '任务清单' };
    const buttons = (label, options) => h('button', { type: 'button', ...options }, label);

    async function api(params, signal) {
      const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null));
      const response = await fetch(`/yansu/api?${query}`, { signal, credentials: 'same-origin', headers: { accept: 'application/json' } });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) throw new Error(data?.error ?? `研序接口不可用（${response.status}）`);
      return data;
    }

    function DocGrid({ overview, show, disabled }) {
      return h('section', { className: 'ys-section' },
        h('h2', null, '工程文档'),
        h('div', { className: 'ys-docs' }, Object.entries(overview.documents).map(([key, doc]) => h('button', {
          className: 'ys-doc', key, type: 'button', disabled: disabled || !doc.found, onClick: () => show(key),
        }, h('strong', null, docs[key]), h('span', null, doc.path ?? '待确认'),
        h('small', null, doc.found ? doc.entries === null ? '已发现' : `${doc.entries} 条` : '待补齐')))));
    }

    function TaskTable({ tasks, selected, select }) {
      if (!tasks.length) return h('p', { className: 'ys-empty' }, '还没有可识别的任务。');
      return h('div', { className: 'ys-table', role: 'list', 'aria-label': '任务清单' }, tasks.map(task =>
        h('div', { key: task.id, role: 'listitem' }, h('button', {
          type: 'button', className: 'ys-task', 'aria-pressed': selected === task.id, onClick: () => select(task.id),
        }, h('code', null, task.id), h('strong', null, task.title), h('span', null, task.owner || '待分派'),
        h('span', { className: `ys-status ys-${task.status || 'unknown'}` }, states[task.status] || '状态待确认'), h('small', null, task.priority || '—')))));
    }

    function TaskDetail({ task, owner, setOwner, action, busy }) {
      if (!task) return null;
      return h('section', { className: 'ys-detail', 'aria-label': '任务详情' },
        h('h3', null, `${task.id} ${task.title}`),
        h('dl', null,
          h('dt', null, '需求 / 设计'), h('dd', null, [...task.reqs, ...task.designs].join(' · ') || '待补齐'),
          h('dt', null, '前置任务'), h('dd', null, task.deps.join(' · ') || '无'),
          h('dt', null, '写入范围'), h('dd', null, task.files.join('、') || '待补齐'),
          h('dt', null, '验收标准'), h('dd', null, task.acceptance || '待补齐')),
        (task.reason || task.problems.length > 0) && h('ul', { className: 'ys-issues' },
          [task.reason, ...task.problems.map(problem => problem.text)].filter(Boolean).map((problem, index) => h('li', { key: index }, problem))),
        h('div', { className: 'ys-actions' }, h('label', null, '执行者 ', h('input', {
          value: owner, placeholder: task.owner || '姓名或 Agent', maxLength: 80, onChange: event => setOwner(event.target.value),
        })), buttons('指派并执行', { disabled: busy, onClick: () => action('start', { taskId: task.id, owner }) }),
        buttons('检查验收', { disabled: busy, onClick: () => action('review', { taskId: task.id }) })));
    }

    function Preview({ panel, close, apply, selected, setSelected, busy }) {
      if (!panel) return null;
      const d = panel.data;
      function toggle(index) {
        setSelected(checked => checked.includes(index) ? checked.filter(value => value !== index) : [...checked, index]);
      }
      const names = { initialize: '工程初始化', diff: '任务差分', start: '任务预检', review: '验收检查', document: d.path };
      let content;
      let nextAction;
      if (panel.action === 'document') content = h('pre', { className: 'ys-document' }, d.text);
      if (panel.action === 'initialize') {
        content = h('div', null, h('p', null, '在原生会话审计项目、复用现有文档并预览补丁。'),
          d.create.length > 0 && h('ul', null, d.create.map(row => h('li', { key: row.path }, row.path))));
        nextAction = '打开初始化会话';
      }
      if (panel.action === 'start') {
        content = h('div', null, h('p', null, `${d.task.id} · ${d.assignee || '待分派'}`),
          d.ready ? h('p', null, '任务预检通过。发送会话草稿即可推进。') : issueList(d.problems));
        if (d.ready) nextAction = '打开开发会话';
      }
      if (panel.action === 'review') {
        content = h('div', null, h('p', null, d.path ?? '审核目录待确认'),
          h('p', { className: 'ys-mono' }, `候选摘要 ${d.candidate}`),
          d.round?.reviewer && h('p', null, `审核者 ${d.round.reviewer} · 测试 ${d.round.test || '待补'} · 结论 ${d.round.verdict || '待补'}`),
          d.round?.release && h('p', null, `发布交接 ${d.round.release}`),
          d.ready ? h('p', null, '验收校验通过。') : issueList(d.problems));
        if (d.path && (d.task.status === 'REVIEW' || d.task.status === 'DONE' && !d.ready)) nextAction = d.ready ? '打开结项会话' : '打开独立审核会话';
      }
      if (panel.action === 'diff') {
        content = h('div', null, h('p', { className: 'ys-mono' }, `Git 基线 ${d.baseline}`), issueList(d.issues),
          d.suggestions.length ? h('ul', { className: 'ys-diffs' }, d.suggestions.map((diff, index) => h('li', { key: index },
            h('label', null, h('input', { type: 'checkbox', checked: selected.includes(index), onChange: () => toggle(index) }),
              h('strong', null, diff.action), ' ', diff.task?.id || diff.reasons[0], diff.newId ? ` → ${diff.newId}` : '',
              h('small', null, diff.reasons.join(' · '))),
            diff.edit && h('div', { className: 'ys-line-diff' }, h('code', null, `− ${diff.edit.before}`), h('code', null, `+ ${diff.edit.after}`)))))
            : h('p', null, '没有需要调整的任务。'),
          Object.entries(d.changes).flatMap(([kind, changes]) => changes.map(change => h('details', { key: `${kind}-${change.id}` },
            h('summary', null, `${change.id} · ${change.type}`),
            h('div', { className: 'ys-compare' },
              h('div', null, h('small', null, `${d.oldPaths[kind] || '基线'} ${change.before?.line || ''}`), h('pre', null, change.before?.text || '—')),
              h('div', null, h('small', null, `${d.paths[kind] || '当前'} ${change.after?.line || ''}`), h('pre', null, change.after?.text || '—')))))));
        if (selected.length) nextAction = '打开差分处理会话';
      }
      return h('section', { className: 'ys-preview', 'aria-label': '操作预览' },
        h('div', { className: 'ys-row' }, h('h2', null, names[panel.action]), buttons('关闭', { onClick: close })),
        content,
        nextAction && buttons(nextAction, { className: 'ys-primary', disabled: busy, onClick: apply }));
    }

    function issueList(issues) {
      return issues?.length ? h('ul', { className: 'ys-issues' }, issues.map((issue, index) => h('li', { key: index }, issue))) : null;
    }

    function Panel({ ctx }) {
      const [catalog, setCatalog] = useState(null);
      const [workspace, setWorkspace] = useState('');
      const [report, setReport] = useState(null);
      const [snapshot, setSnapshot] = useState(0);
      const [filter, setFilter] = useState('');
      const [task, setTask] = useState('');
      const [owner, setOwner] = useState('');
      const [ref, setRef] = useState('HEAD');
      const [preview, setPreview] = useState(null);
      const [checked, setChecked] = useState([]);
      const [prompt, setPrompt] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const active = useRef(null);
      const previewRef = useRef(null);

      useEffect(() => {
        const ctrl = new AbortController();
        api({ action: 'workspaces' }, ctrl.signal).then(rows => {
          setCatalog(rows);
          const current = ctx.get('uiWorkspace')?.mainReference?.sessionId;
          const same = current && rows.find(row => row.sessionIds.includes(current));
          setWorkspace(same?.id ?? (rows.length === 1 ? rows[0].id : ''));
        }).catch(error => { if (!ctrl.signal.aborted) setError(error.message); });
        return () => ctrl.abort();
      }, [ctx]);

      useEffect(() => {
        active.current?.abort();
        setReport(null);
        setPreview(null);
        setPrompt('');
        if (!workspace) { setBusy(false); return undefined; }
        const ctrl = new AbortController();
        active.current = ctrl;
        setBusy(true);
        setError('');
        api({ action: 'overview', workspace }, ctrl.signal).then(data => {
          if (ctrl.signal.aborted) return;
          setReport(data);
          setTask(previous => data.tasks.some(row => row.id === previous) ? previous : data.next || '');
        }).catch(error => { if (!ctrl.signal.aborted) setError(error.message); })
          .finally(() => { if (!ctrl.signal.aborted) setBusy(false); });
        return () => ctrl.abort();
      }, [workspace, snapshot]);

      const focused = report?.tasks.find(row => row.id === task);
      useEffect(() => setOwner(focused?.owner ?? ''), [focused?.id, focused?.owner]);
      useEffect(() => { if (preview) previewRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [preview]);
      useEffect(() => () => active.current?.abort(), []);

      async function request(action, params, createDraft = false) {
        active.current?.abort();
        const ctrl = new AbortController();
        active.current = ctrl;
        setBusy(true);
        setError('');
        setPrompt('');
        try {
          const result = await api({ action, workspace, ...params,
            ...(createDraft ? { draft: '1', expected: preview.data.token, expectedReview: preview.data.reviewToken,
              ref: preview.data.baseline ?? params.ref, selected: checked.join(',') } : {}),
          }, ctrl.signal);
          if (ctrl.signal.aborted) return;
          if (!createDraft) {
            setChecked([]);
            setPreview({ action, params, data: result });
          } else {
            const native = ctx.get('uiWorkspace');
            if (native?.startSession) native.startSession(workspace, { prompt: result.prompt, whenDraftExists: 'append' });
            setPrompt(result.prompt);
          }
        } catch (failure) {
          if (!ctrl.signal.aborted) setError(failure.message);
        } finally {
          if (!ctrl.signal.aborted) setBusy(false);
        }
      }

      return h('div', { className: 'ys' }, h('div', { className: 'ys-content' },
        h('header', { className: 'ys-row ys-header' }, h('div', null, h('h1', null, '研序'), h('p', null, '轻量研发交付')),
          h('label', null, '工作区 ', h('select', {
            value: workspace, onChange: event => { setWorkspace(event.target.value); setTask(''); setFilter(''); },
          }, h('option', { value: '' }, '选择 Git 工作区'), (catalog ?? []).map(row => h('option', { key: row.id, value: row.id }, row.title))))),
        error && h('p', { className: 'ys-error', role: 'alert' }, error),
        !catalog && !error && h('p', { role: 'status' }, '正在读取工作区…'),
        catalog?.length === 0 && h('p', null, '请从 Harness 侧栏添加一个 Git 工作区。'),
        busy && !report && h('p', { role: 'status' }, '正在检查工程文档…'),
        workspace && h('div', { className: 'ys-actions ys-top-actions' }, buttons('检查工程文档', {
          disabled: busy, onClick: () => setSnapshot(value => value + 1),
        }), report && buttons('初始化文档', { disabled: busy, onClick: () => request('initialize', {}) }),
        report && h('label', null, 'Git 基线 ', h('input', { value: ref, 'aria-label': 'Git 基线', maxLength: 160, onChange: event => setRef(event.target.value) })),
        report && buttons('生成任务差分', { className: 'ys-primary', disabled: busy || !ref.trim(), onClick: () => request('diff', { ref: ref.trim() }) })),
        report && h(React.Fragment, null,
          h('p', { className: 'ys-hint' }, `${report.git.dirty ? `${report.git.changeCount} 项工作区变更` : '工作区干净'} · ${report.active.length ? `正在推进 ${report.active.join('、')}` : report.next ? `下一项 ${report.next}` : '暂无可执行任务'}`),
          h(DocGrid, { overview: report, show: kind => request('document', { kind }), disabled: busy }),
          issueList(report.issues.map(issue => issue.message)),
          h('section', { className: 'ys-section' }, h('h2', null, '任务进度'),
            h('div', { className: 'ys-states', 'aria-label': '按状态筛选' }, Object.entries(states).map(([key, label]) => h('button', {
              key, type: 'button', 'aria-pressed': filter === key, onClick: () => setFilter(old => old === key ? '' : key),
            }, h('strong', null, report.counts[key]), h('span', null, label)))),
            h(TaskTable, { tasks: report.tasks.filter(row => !filter || row.status === filter), selected: task, select: setTask }),
            h(TaskDetail, { task: focused, owner, setOwner, action: request, busy }))),
        h('div', { ref: previewRef }, h(Preview, { panel: preview, close: () => { setPreview(null); setPrompt(''); },
          selected: checked, setSelected: setChecked, busy, apply: () => request(preview.action, preview.params, true) })),
        prompt && h('details', { className: 'ys-preview' }, h('summary', null, '会话草稿'), h('textarea', { readOnly: true, value: prompt, rows: 8, 'aria-label': '会话草稿' }),
          navigator.clipboard && buttons('复制草稿', { onClick: () => navigator.clipboard.writeText(prompt).catch(() => setError('请从文本框复制草稿。')) }))));
    }

    const css = `
      .ys { height: 100%; overflow: auto; color: var(--dsw-alias-label-primary, #1b2630); background: var(--dsw-alias-bg-base, #f7f8fa); font: inherit; }
      .ys * { box-sizing: border-box; } .ys-content { width: min(1020px, 100%); margin: auto; padding: 42px clamp(16px, 5%, 54px); }
      .ys h1, .ys h2, .ys h3, .ys p { margin: 0; } .ys h1 { font-size: 32px; font-weight: 720; letter-spacing: .02em; } .ys h2 { font-size: 16px; font-weight: 680; } .ys h3 { font-size: 15px; font-weight: 680; }
      .ys-header { margin-bottom: 28px; } .ys-header p, .ys-hint, .ys-doc span, .ys-doc small, .ys small { color: var(--dsw-alias-label-secondary, #5c6471); }
      .ys-header p { margin-top: 4px; } .ys-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
      .ys button, .ys input:not([type=checkbox]), .ys select, .ys textarea { font: inherit; color: inherit; border: 1px solid var(--dsw-alias-line-normal, #c8ced6); border-radius: 8px; background: var(--dsw-alias-bg-base, #fff); padding: 6px 10px; }
      .ys button { cursor: pointer; min-height: 34px; } .ys button:hover:enabled { border-color: #0d8a76; } .ys button:disabled { opacity: .65; cursor: default; }
      .ys button:focus-visible, .ys input:focus-visible, .ys select:focus-visible { outline: 2px solid #118776; outline-offset: 2px; }
      .ys .ys-primary { background: #135649; border-color: #135649; color: #fff; } .ys .ys-primary:hover:enabled { background: #1b6c5d; }
      .ys-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; } .ys-actions input:not([type=checkbox]) { width: 140px; } .ys-top-actions { margin-bottom: 10px; }
      .ys-section { margin-top: 24px; } .ys-docs, .ys-states { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
      .ys-docs .ys-doc { text-align: left; display: grid; min-height: 82px; gap: 3px; padding: 10px 12px; } .ys-doc span, .ys-doc small { overflow-wrap: anywhere; font-size: 12px; }
      .ys-states { grid-template-columns: repeat(5, minmax(0, 1fr)); } .ys-states button { display: flex; gap: 6px; align-items: center; justify-content: center; min-height: 42px; }
      .ys [aria-pressed=true] { border-color: #168875; background: color-mix(in srgb, #168875 14%, transparent); }
      .ys-table { display: grid; gap: 4px; margin-top: 10px; } .ys-empty { margin-top: 12px !important; }
      .ys-table .ys-task { width: 100%; display: grid; gap: 10px; align-items: center; text-align: left; grid-template-columns: minmax(72px, auto) minmax(65px, 1fr) minmax(48px, auto) auto 24px; }
      .ys-task strong, .ys-task span { overflow-wrap: anywhere; } .ys-status { border-radius: 12px; padding: 1px 7px; background: color-mix(in srgb, currentColor 8%, transparent); }
      .ys-BLOCKED { color: var(--dsw-alias-label-danger, #aa3333); } .ys-DONE { color: var(--dsw-alias-label-success, #187660); }
      .ys-detail, .ys-preview { padding: 14px; border: 1px solid var(--dsw-alias-line-normal, #c8ced6); border-radius: 10px; margin-top: 14px; overflow-wrap: anywhere; }
      .ys-detail dl { display: grid; grid-template-columns: minmax(70px, auto) 1fr; gap: 4px 14px; margin: 10px 0; } .ys-detail dd { margin: 0; white-space: pre-wrap; }
      .ys-preview p, .ys-preview details, .ys-preview > button { margin-top: 10px; } .ys-preview textarea { width: 100%; margin: 8px 0; }
      .ys-document, .ys-compare pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px; background: color-mix(in srgb, currentColor 5%, transparent); border-radius: 7px; margin: 8px 0; }
      .ys-mono { font-family: ui-monospace, monospace; font-size: 12px; } .ys-error { color: var(--dsw-alias-label-danger, #aa3333); margin: 10px 0 !important; }
      .ys-issues { padding-left: 20px; margin: 8px 0; } .ys-diffs { list-style: none; padding: 0; } .ys-diffs li { margin: 7px 0; }
      .ys-diffs small { margin-left: 8px; } .ys-diffs input { margin-right: 6px; } .ys-line-diff { display: grid; margin-left: 22px; }
      .ys-line-diff code:first-child { color: var(--dsw-alias-label-danger, #aa3333); } .ys-line-diff code:last-child { color: var(--dsw-alias-label-success, #187660); }
      .ys-compare { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; } .ys summary { cursor: pointer; }
      @media (max-width: 640px) { .ys-docs, .ys-states, .ys-compare { grid-template-columns: repeat(2, minmax(0, 1fr)); } .ys-table .ys-task { grid-template-columns: auto 1fr auto; } .ys-task span:not(.ys-status), .ys-task small { display: none; } }
    `;

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.append(style);
        return () => style.remove();
      }, 'yansu: styles');
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'yansu', order: 26, label: () => '研序' },
        () => h('span', { 'aria-hidden': true, style: { fontSize: '17px' } }, '▤')));
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'yansu' }, () => h(Panel, { ctx })));
    }
    return { inject: ['slots', 'uiWorkspace'], apply };
  },
});
