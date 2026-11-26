window.__ModuleLoader__.load({
  id: 'dsh-yansu',
  factory(require) {
    const { createElement: h, Fragment, useEffect, useRef, useState } = require('react');
    const states = { TODO: '待开始', IN_PROGRESS: '进行中', BLOCKED: '受阻', REVIEW: '待验收', DONE: '已完成' };
    const documents = {
      prd: { name: '产品需求', unit: '条需求', format: '## REQ-001 需求名称' },
      design: { name: '技术设计', unit: '项设计', format: '## DES-001 技术契约' },
      tasks: { name: '任务清单', unit: '项任务', format: '## TASK-001 任务名称' },
      agents: { name: '协作规则' },
    };
    const preparations = {
      requirements: {
        title: '接入已确认需求', button: '开始整理需求',
        summary: '从已确认的 PRD 中提取需求条目，保留原文、来源和验收口径。',
      },
      design: {
        title: '准备架构设计', button: '开始设计对话',
        summary: '结合仓库现状为下列需求提出设计方案，由负责人确认。',
      },
      plan: {
        title: '编排任务', button: '开始编排对话',
        summary: '按已确认设计为下列需求拆分任务，补全依赖、写入范围和验收标准。',
      },
    };
    const chatTitles = { requirements: '需求整理', revisePrd: '需求变更', importPrd: 'PRD 导入', design: '技术设计', plan: '任务编排', review: '任务验收' };
    const prdModes = [
      { value: 'supplement', label: '补充', description: '新增需求或补齐细节，保留现有规则。' },
      { value: 'replace', label: '替换', description: '替换指定需求，保留其余条目。请注明 REQ ID 或需求名称。' },
      { value: 'newVersion', label: '新版本', description: '以完整 PRD 建立下一版基线，确认后切换。' },
    ];

    function stageSessionKey(workspace, action, data) {
      return action === 'review' ? JSON.stringify([workspace, action, data.task.id, data.candidate]) : `${workspace}:${action}`;
    }

    const button = (label, options = {}) => h('button', { type: 'button', ...options }, label);
    const primary = (label, options) => button(label, { className: 'ys-primary', ...options });

    function BrandMark({ size }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, focusable: 'false',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('circle', { cx: 5.5, cy: 5.25, r: 2.25 }),
        h('circle', { cx: 18.5, cy: 5.25, r: 2.25 }),
        h('path', { d: 'M5.5 7.5v2.75L12 14l6.5-3.75V7.5M12 14v2.5' }),
        h('rect', { x: 9.5, y: 16.5, width: 5, height: 5, rx: 0.9 }));
    }

    function BrandWordmark() {
      return h('svg', { width: 48, height: 22, viewBox: '80 10 103 46', 'aria-hidden': true, focusable: 'false',
        fill: 'none', stroke: 'currentColor', strokeWidth: 3.7, strokeLinejoin: 'round' },
        h('g', { transform: 'translate(80 10)' },
          h('path', { d: 'M2 6h18M11 6C10.2 14.2 7.1 20.1 1.4 25.5M7.6 39.8V22.4h10.1v14.2H7.6' }),
          h('path', { d: 'M23 6h21M21 21h25M29 6v13.5c0 10.9-2.1 17.5-8.4 22.7M39 6v36.4' })),
        h('g', { transform: 'translate(135 10)' },
          h('path', { d: 'm23.2 1.6 4.2 6.1M45.6 10.2H8.9v14.6c0 7.7-2 13.1-6.6 18.2' }),
          h('path', { d: 'M15.8 17.7h24.6l-12 9.1M21.8 22.8l7.8 6M12.5 29h32l-5.6 6.7M28.7 29v10.2c0 2.4-1.3 3.8-3.6 3.8h-6' })));
    }

    async function api(params, signal) {
      const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null));
      const response = await fetch(`/yansu/api?${query}`, { signal, credentials: 'same-origin', headers: { accept: 'application/json' } });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) throw new Error(data?.error ?? `研序接口不可用（${response.status}）`);
      return data;
    }

    async function openStageConversation(ctx, workspace, { sessionId, prompt, files = [], whenDraftExists = 'append' }, signal) {
      const conversation = ctx.get('conversation');
      const sessions = ctx.get('sessions');
      if (!sessions?.create || !sessions?.retain || !conversation?.input) {
        throw new Error('当前 Harness 组合缺少会话组件。');
      }
      if (!sessionId) {
        sessionId = await sessions.create({ workspaceId: workspace });
      }
      signal.throwIfAborted();
      const reference = sessions.retain(sessionId, { source: 'yansu', signal });
      try {
        const binding = await reference.ready;
        signal.throwIfAborted();
        if (binding.session.getSnapshot().openState === 'error') throw new Error('无法打开会话，请重试。');
        if (prompt && prepareConversationDraft(conversation, binding, prompt, files, whenDraftExists) === 'preserved') {
          reference.release();
          return openStageConversation(ctx, workspace, { prompt, files }, signal);
        }
        return reference;
      } catch (error) {
        reference.release();
        throw error;
      }
    }

    function prepareConversationDraft(conversation, binding, prompt, files, whenDraftExists) {
      const input = conversation.input.for(binding.ctx);
      const drafts = files.length ? conversation.createDrafts(binding.sessionId, files, true) : [];
      const ids = drafts.map(draft => draft.id);
      let attached = false;
      try {
        attached = ids.length > 0 && input.addAttachments(ids);
        if (ids.length && !attached) throw new Error('无法添加本次选择的附件。');
        const status = conversation.input.requestDraftInitialization(binding, { prompt, whenDraftExists });
        if (status === 'blocked') throw new Error('当前会话正在发送，请稍后重试。');
        return status;
      } catch (error) {
        if (attached) for (const id of ids) input.removeAttachment(id);
        if (drafts.length) conversation.releaseDraftAttachments(drafts);
        throw error;
      }
    }

    function issueList(issues) {
      return issues?.length ? h('ul', { className: 'ys-issues' }, issues.map((issue, index) => h('li', { key: index }, issue))) : null;
    }

    function taskStatus(task) {
      return h('span', { className: 'ys-status ys-' + (task.status ?? 'unknown') }, states[task.status] ?? '状态待确认');
    }

    function PrdVersion({ version }) {
      return h('span', { className: 'ys-prd-version' }, '当前 PRD ', h('strong', null, version));
    }

    function Overview({ report, currentVersion, delivery, selectedStage, setSelectedStage, busy, request, selectTask, openDiff, openTaskBoard }) {
      const { steps, recommended } = delivery;
      const selected = selectedStage ?? recommended;
      const step = steps[selected];
      function proceed(action) {
        if (action.task) selectTask(action.task);
        if (action.action) request(action.action, action.params ?? {});
        if (action.stage !== undefined) setSelectedStage(action.stage);
        if (action.diff) openDiff();
        if (action.taskBoard) openTaskBoard();
      }
      return h('section', { className: 'ys-hero', 'aria-labelledby': 'ys-focus' },
        h('div', { className: 'ys-hero-body' },
          h('div', { className: 'ys-focus' },
            h('div', { className: 'ys-focus-heading' }, h('h2', { id: 'ys-focus' }, step.name),
              selected === 0 && currentVersion && h(PrdVersion, { version: currentVersion })),
            h('p', { className: 'ys-focus-copy' }, step.text),
            issueList(step.problems),
            step.actions.length > 0 && h('div', { className: 'ys-actions' }, step.actions.map((action, index) =>
              (index === 0 ? primary : button)(action.label, { key: action.label, disabled: busy, onClick: () => proceed(action) })))),
          h('dl', { className: 'ys-git' },
            h('dt', null, 'Git 工作区'),
            h('dd', null, report.git.dirty ? `${report.git.changeCount} 项变更` : '工作区干净'),
            h('dt', null, '当前提交'),
            h('dd', null, h('code', null, report.git.head?.slice(0, 8) ?? '尚无提交')))),
        h('ol', { className: 'ys-steps', 'aria-label': '交付流程' }, steps.map(({ name, summary, done }, index) => {
          const suggested = index === recommended && !done;
          return h('li', { key: name, className: done ? 'ys-step-done' : '' },
            button(h(Fragment, null, h('span', { className: 'ys-step-dot', 'aria-hidden': true }, done ? '✓' : null),
              h('span', null, h('strong', null, name), h('small', null, summary),
                suggested && h('small', { className: 'ys-step-suggestion' }, '建议处理'))), {
              className: 'ys-step', disabled: busy, 'aria-pressed': index === selected,
              'aria-label': `${name} · ${summary}${done ? ' · 阶段已完成' : suggested ? ' · 建议处理' : ''}`,
              onClick: () => setSelectedStage(index === recommended ? null : index),
            }));
        })));
    }

    function DocumentShelf({ report, currentVersion, request, busy }) {
      const history = report.prdVersions ?? [];
      const hasDesign = report.documents.design.entries > 0;
      const actions = {
        prd: [report.readiness.importPrd.ready && button(report.documents.prd.found ? '导入 / 更新' : '导入 PRD', {
          key: 'import', disabled: busy, onClick: () => request('importPrd', {}),
        }),
          history.length > (currentVersion ? 1 : 0) && button('历史版本', {
            key: 'history', disabled: busy, onClick: () => request('document', { kind: 'prd', version: currentVersion ?? history[0].version }),
          })],
        design: report.readiness.design.ready && button(hasDesign ? '复核设计' : '讨论设计', {
          disabled: busy, onClick: () => request('design', hasDesign ? { revise: '1' } : {}),
        }),
        tasks: report.readiness.plan.ready && button('编排任务', { disabled: busy, onClick: () => request('plan', {}) }),
        agents: button('自定义规则', { disabled: busy, onClick: () => request('rules', {}) }),
      };
      return h('section', { className: 'ys-card ys-docs', 'aria-labelledby': 'ys-docs' },
        h('div', { className: 'ys-card-header' }, h('h2', { id: 'ys-docs' }, '工程文档')),
        h('ul', { className: 'ys-doc-list' }, Object.entries(documents).map(([kind, { name, unit, format }]) => {
          const doc = report.documents[kind];
          const issues = report.issues.filter(issue => issue.kind === kind && !['missing', 'unindexed'].includes(issue.code));
          const status = !doc.found ? doc.path ? '缺失' : '路径待确认'
            : doc.entries === null ? '已读取' : doc.entries ? `${doc.entries} ${unit}` : '已读取 · 待整理';
          const content = h(Fragment, null,
            h('span', { className: 'ys-doc-name' }, name,
              kind === 'prd' && currentVersion && h(PrdVersion, { version: currentVersion })),
            h('code', { className: 'ys-doc-path' }, doc.path ?? '在 AGENTS.md 指定路径'),
            h('span', { className: 'ys-doc-state', 'data-ready': doc.found && doc.entries !== 0 }, status));
          return h('li', { key: kind },
            h('div', { className: 'ys-doc-row' },
              doc.found ? h('button', { className: 'ys-doc', type: 'button', disabled: busy,
                onClick: () => request('document', { kind }) }, content) : h('div', { className: 'ys-doc' }, content),
              h('div', { className: 'ys-doc-tools' }, actions[kind])),
            doc.found && doc.entries === 0 && h('p', { className: 'ys-doc-hint' }, '条目格式 ', h('code', null, format)),
            issueList(issues.map(issue => issue.message)));
        })),
        issueList(report.issues.filter(issue => issue.kind === 'reviews').map(issue => issue.message)),
        h('div', { className: 'ys-doc-actions' },
          report.documents.prd.found &&
            button('整理现有 PRD', { disabled: busy, onClick: () => request('requirements', {}) }),
          button('初始化工程文档', { disabled: busy, onClick: () => request('initialize', {}) })));
    }

    function TaskTable({ tasks, selected, select }) {
      return h('ul', { className: 'ys-task-list', 'aria-label': '任务列表' }, tasks.map(task =>
        h('li', { key: task.id }, h('button', {
          type: 'button', className: 'ys-task', 'aria-pressed': selected === task.id, onClick: () => select(task.id),
        }, h('span', { className: 'ys-task-id' }, h('code', null, task.id), task.priority && h('small', null, task.priority)),
        h('strong', null, task.title), h('span', { className: 'ys-task-owner' }, task.owner || '未分派'), taskStatus(task)))));
    }

    function TaskDetail({ task, owner, setOwner, request, busy, detailRef }) {
      if (!task) return null;
      return h('section', { className: 'ys-task-detail', 'aria-label': '任务详情', tabIndex: -1, ref: detailRef },
        h('header', { className: 'ys-row' }, h('code', null, task.id), taskStatus(task)),
        h('h3', null, task.title),
        h('dl', { className: 'ys-fields' },
          h('dt', null, '需求与设计'), h('dd', null, [...task.reqs, ...task.designs].join(' · ') || '待补齐'),
          h('dt', null, '前置任务'), h('dd', null, task.deps.join(' · ') || '无'),
          h('dt', null, '写入范围'), h('dd', null, task.files.join('、') || '待补齐'),
          h('dt', null, '验收标准'), h('dd', null, task.acceptance || '待补齐')),
        issueList([...new Set([task.reason, ...task.problems.map(problem => problem.text)].filter(Boolean))]),
        ['TODO', 'IN_PROGRESS'].includes(task.status) && h('form', { className: 'ys-task-actions', onSubmit: event => {
          event.preventDefault();
          request('start', { taskId: task.id, owner });
        } }, h('label', { className: 'ys-field' }, h('span', null, '执行者'), h('input', {
          value: owner, placeholder: '姓名或 Agent 标识', maxLength: 80, onChange: event => setOwner(event.target.value),
        })), h('button', { type: 'submit', className: 'ys-primary', disabled: busy }, '检查执行条件')),
        ['REVIEW', 'DONE'].includes(task.status) && button('检查验收', { disabled: busy, onClick: () => request('review', { taskId: task.id }) }));
    }

    function Tasks({ report, filter, setFilter, tasks, focused, selectTask, owner, setOwner, request, busy, detailRef, boardRef }) {
      const hasTasks = report.tasks.length > 0;
      return h('section', { className: 'ys-card ys-tasks', 'aria-labelledby': 'ys-tasks', tabIndex: -1, ref: boardRef },
        h('div', { className: 'ys-card-header' }, h('h2', { id: 'ys-tasks' }, '任务工作台'),
          hasTasks && h('span', { className: 'ys-muted' }, `${report.tasks.length} 项 · ${report.counts.DONE} 已完成`)),
        hasTasks ? h(Fragment, null,
          h('div', { className: 'ys-filters', 'aria-label': '按任务状态筛选' },
            [['', '全部'], ...Object.entries(states)].map(([key, label]) => button(
              h(Fragment, null, label, h('span', null, key ? report.counts[key] : report.tasks.length)),
              { key, 'aria-pressed': filter === key, onClick: () => setFilter(key) }))),
          tasks.length ? h('div', { className: 'ys-task-layout', 'data-focused': Boolean(focused) },
            h(TaskTable, { tasks, selected: focused?.id, select: selectTask }),
            h(TaskDetail, { task: focused, owner, setOwner, request, busy, detailRef }))
            : h('p', { className: 'ys-empty' }, `没有${states[filter]}的任务。`))
          : h('div', { className: 'ys-empty' },
            h('h3', null, report.documents.tasks.found ? '清单中还没有可识别的任务' : '尚未建立任务清单'),
            h('p', null, report.documents.tasks.found
              ? '检查任务是否使用了 TASK ID，或继续按已确认设计编排任务。'
              : '需求和设计确认后，编排的任务会在这里显示。')));
    }

    function DiffControls({ diffRef, git, baseline, setBaseline, busy, request }) {
      return h('details', { className: 'ys-card ys-diff-controls', ref: diffRef },
        h('summary', null, '任务差分', h('span', { className: 'ys-muted' }, '需求或设计变更时使用')),
        h('form', { className: 'ys-diff-form', onSubmit: event => { event.preventDefault(); request('diff', { ref: baseline.trim() }); } },
          h('label', { className: 'ys-field' }, h('span', null, 'Git 基线'), h('input', {
            value: baseline, maxLength: 160, placeholder: 'HEAD、提交、分支或标签', onChange: event => setBaseline(event.target.value),
          })),
          h('button', { type: 'submit', className: 'ys-primary', disabled: busy || !baseline.trim() || !git.head && baseline.trim() === 'HEAD' }, '生成任务差分'),
          h('p', { className: 'ys-muted' }, git.head ? '将基线中的需求、设计与任务同当前工作区比较。' : '仓库尚无 HEAD 提交，请选择已有提交，或在设计确认后编排首批任务。')));
    }

    function DiffPreview({ data, selected, setSelected }) {
      function toggle(index) {
        setSelected(checked => checked.includes(index) ? checked.filter(value => value !== index) : [...checked, index]);
      }
      return h(Fragment, null,
        h('p', { className: 'ys-muted' }, 'Git 基线 ', h('code', null, data.baseline)),
        issueList(data.issues),
        h('h3', null, '任务影响'),
        data.suggestions.length ? h('ul', { className: 'ys-diffs' }, data.suggestions.map((diff, index) => h('li', { key: index },
          h('label', null, h('input', { type: 'checkbox', checked: selected.includes(index), onChange: () => toggle(index) }),
            h('span', null, h('strong', null, diff.action), ' ', diff.task?.id ?? diff.reasons[0],
              diff.newId && ` → ${diff.newId}`,
              h('small', null, diff.task?.title, diff.task?.title ? ' · ' : '', diff.reasons.join(' · ')))),
          diff.edit && h('div', { className: 'ys-line-diff' }, h('code', null, `− ${diff.edit.before}`), h('code', null, `+ ${diff.edit.after}`)))))
          : h('p', null, '比对结果没有需要调整的任务。'),
        Object.entries(data.changes).flatMap(([kind, changes]) => changes.map(change => h('details', {
          className: 'ys-change', key: `${kind}-${change.id}`,
        }, h('summary', null, `${change.id} · ${change.type}`),
        h('div', { className: 'ys-compare' },
          h('div', null, h('small', null, `基线 · ${data.oldPaths[kind] ?? '—'} ${change.before?.line ?? ''}`), h('pre', null, change.before?.text || '—')),
          h('div', null, h('small', null, `当前 · ${data.paths[kind] ?? '—'} ${change.after?.line ?? ''}`), h('pre', null, change.after?.text || '—')))))));
    }

    const sourceFileKey = file => JSON.stringify([file.name, file.size, file.lastModified]);

    function PrdSourceFiles({ files, setFiles, busy }) {
      const picker = useRef(null);
      const dragDepth = useRef(0);
      const [dragging, setDragging] = useState(false);
      const [folderIgnored, setFolderIgnored] = useState(false);
      function addFiles(newFiles) {
        setFiles(current => {
          const unique = new Map(current.map(file => [sourceFileKey(file), file]));
          for (const file of newFiles) {
            const key = sourceFileKey(file);
            if (!unique.has(key)) unique.set(key, file);
          }
          return [...unique.values()];
        });
      }
      function dragEnter(event) {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }
      function dragLeave() {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }
      function drop(event) {
        const { files: dropped, items, types } = event.dataTransfer;
        if (!dropped.length && !types.includes('Files')) return;
        event.preventDefault();
        event.stopPropagation();
        dragDepth.current = 0;
        setDragging(false);
        if (busy) return;
        const fileItems = Array.from(items).filter(item => item.kind === 'file');
        const regularFiles = fileItems.filter(item => !item.webkitGetAsEntry?.()?.isDirectory);
        const hasFolder = regularFiles.length !== fileItems.length;
        setFolderIgnored(hasFolder);
        addFiles(hasFolder ? regularFiles.map(item => item.getAsFile()).filter(Boolean) : Array.from(dropped));
      }
      return h('section', { className: 'ys-prd-sources', 'aria-labelledby': 'ys-prd-sources' },
        h('h3', { id: 'ys-prd-sources' }, '需求文件'),
        h('div', { className: 'ys-prd-drop', 'data-dragging': dragging && !busy,
          onDragEnter: dragEnter, onDragLeave: dragLeave, onDrop: drop,
          onDragOver: event => {
            if (!event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
          },
        }, h('span', null, '拖动文件到此处'), button('选择文件', { disabled: busy, onClick: () => picker.current.click() }),
        h('input', { ref: picker, type: 'file', multiple: true, hidden: true, disabled: busy,
          onChange: event => {
            if (event.target.files.length) {
              setFolderIgnored(false);
              addFiles(Array.from(event.target.files));
            }
            event.target.value = '';
          },
        })),
        h('p', { className: 'ys-muted', role: 'status' }, folderIgnored ? `目录已跳过。已选 ${files.length} 个文件。`
          : files.length ? `已选 ${files.length} 个文件` : '支持一次选择或拖入多个文件。'),
        files.length > 0 && h('ul', { className: 'ys-source-files' }, files.map(file => h('li', { key: sourceFileKey(file) },
          h('span', null, file.name), button('移除', { disabled: busy, 'aria-label': `移除 ${file.name}`,
            onClick: () => setFiles(current => current.filter(item => item !== file)),
          })))));
    }

    function PrdImportForm({ data, form, busy }) {
      return h('div', { className: 'ys-prd-import' },
        h('div', { className: 'ys-prd-version-summary' },
          data.current ? h(PrdVersion, { version: data.current }) : h('strong', null, '尚无当前 PRD'),
          data.ready && h('p', { className: 'ys-muted' }, data.current
            ? `确认变更后归档 ${data.current}，生效版本为 ${data.update.version}。`
            : `确认后建立 ${data.update.version}。`)),
        data.ready ? h(Fragment, null,
          data.current && h('fieldset', { className: 'ys-prd-modes' }, h('legend', null, '更新方式'),
            h('div', { className: 'ys-prd-mode-options' }, prdModes.map(({ value, label, description }) =>
              h('label', { className: 'ys-prd-mode', key: value, 'data-selected': form.mode === value },
                h('input', { type: 'radio', name: 'ys-prd-mode', value, checked: form.mode === value, disabled: busy,
                  'aria-labelledby': `ys-prd-mode-${value}`, 'aria-describedby': `ys-prd-mode-${value}-help`,
                  onChange: () => form.setMode(value),
                }), h('span', null, h('strong', { id: `ys-prd-mode-${value}` }, label),
                  h('small', { id: `ys-prd-mode-${value}-help` }, description)))))),
          h(PrdSourceFiles, { files: form.files, setFiles: form.setFiles, busy }),
          h('label', { className: 'ys-prd-intake' }, h('span', null, '粘贴需求说明'),
            h('textarea', { value: form.intake, rows: 4, disabled: busy, onChange: event => form.setIntake(event.target.value) })),
          h('p', { className: 'ys-muted' }, '在会话中发送草稿，审阅变更补丁后再确认应用。')) : issueList(data.problems));
    }

    function previewContent(panel, selected, setSelected, form, viewVersion, busy) {
      const { data, action, params } = panel;
      if (action === 'document') {
        const currentVersion = data.versions?.find(row => row.current)?.version;
        return { title: documents[params.kind].name, subtitle: data.path,
          content: h(Fragment, null,
            data.versions?.length > 0 && h('div', { className: 'ys-version-picker' },
              currentVersion && h(PrdVersion, { version: currentVersion }),
              !currentVersion && data.versions.length === 1 && h('span', { className: 'ys-muted' }, `历史版本 ${data.version}`),
              data.versions.length > 1 && h('label', { className: 'ys-field' }, h('span', null, '查看版本'),
                h('select', { value: data.version, disabled: busy, onChange: event => viewVersion(event.target.value) },
                  data.versions.map(row => h('option', { key: row.version, value: row.version }, row.version + (row.current ? ' · 当前' : ' · 历史')))))),
            h('pre', { className: 'ys-document' }, data.text || '文档为空。')),
        };
      }
      if (action === 'importPrd') return {
        title: data.current ? '导入 / 更新 PRD' : '导入 PRD', subtitle: data.path,
        label: data.ready ? '准备导入会话' : null, disabled: !form.files.length && !form.intake.trim(),
        content: h(PrdImportForm, { data, form, busy }),
      };
      if (action === 'revisePrd') return {
        title: '修改需求', subtitle: data.path, label: data.ready ? '开始需求变更对话' : null,
        content: data.ready ? h(Fragment, null,
          h('p', null, '在对话中说明变更内容，审阅 PRD 补丁和受影响的设计。'),
          data.current && h('p', { className: 'ys-muted' }, `当前 ${data.current} · 确认更新后保存为 ${data.update.version}`))
          : issueList(data.problems),
      };
      if (action === 'rules') return {
        title: '自定义协作规则', subtitle: data.paths.agents, label: '打开规则编辑会话', disabled: !form.rules.trim(),
        content: h('label', { className: 'ys-field ys-doc-form' }, h('span', null, '要新增或修改的规则'),
          h('textarea', { value: form.rules, rows: 8, disabled: busy,
            onChange: event => form.setRules(event.target.value) })),
      };
      if (Object.hasOwn(preparations, action)) {
        const { title, button: label, summary } = preparations[action];
        return { title, subtitle: data.path, label: data.ready ? label : null,
          content: h(Fragment, null, h('p', null, summary), issueList(data.problems),
            action !== 'requirements' && data.items.length > 0 && h('ul', { className: 'ys-scope' }, data.items.map(row =>
              h('li', { key: row.id }, h('code', null, row.id), h('strong', null, row.title),
                row.designs.length > 0 && h('small', null, row.designs.join(' · ')))))) };
      }
      if (action === 'initialize') return {
        title: '初始化工程文档', label: '打开初始化会话',
        content: h(Fragment, null, h('p', null, '在会话中盘点已有文档，预览需要补齐的内容。'),
          data.create.length > 0 && h('ul', null, data.create.map(row => h('li', { key: row.kind }, h('code', null, row.path)))),
          issueList(data.issues.filter(issue => issue.code !== 'missing').map(issue => issue.message))),
      };
      if (action === 'start') return {
        title: '执行预检', subtitle: `${data.task.id} · ${data.task.title}`, label: data.ready ? '打开开发会话' : null,
        content: h(Fragment, null, h('p', null, `执行者 ${data.assignee || '待分派'}`),
          data.ready ? h('p', null, '依赖、设计与写入范围已通过预检。请在开发会话发送草稿。') : issueList(data.problems)),
      };
      if (action === 'review') {
        const canClose = data.ready && data.task.status === 'REVIEW' && data.taskEdit;
        const round = data.round;
        const heading = data.task.status === 'DONE' ? '已结项，验收证据有效。' : '验收通过，等待负责人确认结项。';
        return { title: '验收检查', subtitle: `${data.task.id} · ${data.task.title}`,
          label: canClose ? '确认结项' : !data.ready && data.canReview ? '打开独立审核会话' : null,
          content: h(Fragment, null,
            h('p', { role: 'status' }, data.ready ? heading : !round && data.canReview ? '等待独立审核' : '验收待处理'),
            h('dl', { className: 'ys-fields' },
              h('dt', null, '开发负责人'), h('dd', null, data.task.owner || '待分配'),
              h('dt', null, '审核记录'), h('dd', null, data.path ?? '待确认'),
              h('dt', null, '候选摘要'), h('dd', null, h('code', null, data.candidate)),
              round && h(Fragment, null,
                h('dt', null, '审核者'), h('dd', null, round.reviewer || '待填写'),
                h('dt', null, '测试结果'), h('dd', null, round.test || '待填写'),
                h('dt', null, '结论'), h('dd', null, round.verdict || '待填写'),
                h('dt', null, '未关闭 P0/P1'), h('dd', null, round.issues || '待填写'),
                h('dt', null, '测试证据'), h('dd', null, round.evidence || '待填写'),
                round.release && h(Fragment, null, h('dt', null, '发布交接'), h('dd', null, round.release)))),
            issueList(data.problems),
            canClose && h('div', { className: 'ys-change' },
              h('p', null, data.paths.tasks),
              h('div', { className: 'ys-line-diff' },
                h('code', null, `− ${data.taskEdit.before}`), h('code', null, `+ ${data.taskEdit.after}`)),
              h('p', { className: 'ys-muted' }, '确认后，在会话发送结项草稿以复检并应用变更。'))) };
      }
      return { title: '任务差分', label: data.suggestions.length ? '打开差分处理会话' : null,
        disabled: !selected.length, content: h(DiffPreview, { data, selected, setSelected }) };
    }

    function Preview({ panel, close, apply, resume, refresh, viewVersion, selected, setSelected, busy, error, prompt }) {
      const dialog = useRef(null);
      const [copyStatus, setCopyStatus] = useState('');
      const [files, setFiles] = useState([]);
      const [intake, setIntake] = useState('');
      const [mode, setMode] = useState('supplement');
      const [rules, setRules] = useState('');
      const form = { files, setFiles, intake, setIntake, mode, setMode, rules, setRules };
      const { title, subtitle, label, content, disabled } = previewContent(panel, selected, setSelected, form, viewVersion, busy);
      useEffect(() => {
        const node = dialog.current;
        node.showModal();
        return () => node.close();
      }, []);
      useEffect(() => setCopyStatus(''), [prompt]);
      async function copy() {
        try {
          await navigator.clipboard.writeText(prompt);
          setCopyStatus('已复制');
        } catch {
          setCopyStatus('请从文本框复制草稿。');
        }
      }
      return h('dialog', { className: 'ys-drawer', ref: dialog, 'aria-labelledby': 'ys-drawer-title',
        onCancel: event => { event.preventDefault(); close(); },
      }, h('div', { className: 'ys-drawer-layout' },
        h('header', { className: 'ys-drawer-header' },
          h('div', null, h('h2', { id: 'ys-drawer-title' }, title), subtitle && h('p', { className: 'ys-muted' }, subtitle)),
          button('关闭', { onClick: close, autoFocus: true })),
        h('div', { className: 'ys-drawer-body' }, content,
          prompt && h('details', { className: 'ys-prompt', open: true }, h('summary', null, '会话草稿'),
            h('textarea', { readOnly: true, value: prompt, rows: 8, 'aria-label': '会话草稿' }),
            navigator.clipboard && button('复制草稿', { onClick: copy }),
            copyStatus && h('span', { className: 'ys-muted', role: 'status' }, copyStatus))),
        (label || resume || refresh || error) && h('footer', { className: 'ys-drawer-footer' },
          error && h('p', { className: 'ys-error', role: 'alert' }, error),
          label && primary(busy ? '正在准备会话…' : label, { disabled: busy || disabled,
          onClick: () => apply({ files, intake, mode: panel.data.current ? mode : undefined, rules }) }),
          resume && button(panel.action === 'review' ? '返回审核会话' : '继续上次对话', { disabled: busy, onClick: resume }),
          refresh && button('刷新验收', { disabled: busy, onClick: refresh }),
          panel.action === 'diff' && h('span', { className: 'ys-muted' }, `已选 ${selected.length} 项`))));
    }

    function ConversationContent({ renderFactorySlot }) {
      return renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false });
    }

    function Panel({ ctx, stageSessions, SessionProvider, renderSlot }) {
      const [catalog, setCatalog] = useState(null);
      const [workspace, setWorkspace] = useState('');
      const [report, setReport] = useState(null);
      const [snapshot, setSnapshot] = useState(0);
      const [filter, setFilter] = useState('');
      const [task, setTask] = useState('');
      const [owner, setOwner] = useState('');
      const [baseline, setBaseline] = useState('HEAD');
      const [selectedStage, setSelectedStage] = useState(null);
      const [preview, setPreview] = useState(null);
      const [chat, setChat] = useState(null);
      const [checked, setChecked] = useState([]);
      const [prompt, setPrompt] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const active = useRef(null);
      const detailRef = useRef(null);
      const boardRef = useRef(null);
      const revealDetails = useRef(false);
      const diffRef = useRef(null);

      useEffect(() => {
        const ctrl = new AbortController();
        api({ action: 'workspaces' }, ctrl.signal).then(rows => {
          if (ctrl.signal.aborted) return;
          setCatalog(rows);
          const current = ctx.get('uiWorkspace')?.mainReference?.sessionId;
          const same = current && rows.find(row => row.sessionIds.includes(current));
          setWorkspace(same?.id ?? (rows.length === 1 ? rows[0].id : ''));
        }).catch(failure => { if (!ctrl.signal.aborted) setError(failure.message); });
        return () => ctrl.abort();
      }, [ctx]);

      useEffect(() => {
        active.current?.abort();
        if (!workspace) { setBusy(false); return undefined; }
        const ctrl = new AbortController();
        active.current = ctrl;
        setBusy(true);
        setError('');
        api({ action: 'overview', workspace }, ctrl.signal).then(data => {
          if (ctrl.signal.aborted) return;
          setReport(data);
        }).catch(failure => {
          if (ctrl.signal.aborted) return;
          setReport(null);
          setError(failure.message);
        }).finally(() => { if (!ctrl.signal.aborted) setBusy(false); });
        return () => ctrl.abort();
      }, [workspace, snapshot]);

      const delivery = report?.delivery;
      const tasks = report?.tasks.filter(row => !filter || row.status === filter) ?? [];
      const preferred = task || delivery?.task;
      const focused = tasks.find(row => row.id === preferred) ?? tasks[0];
      useEffect(() => setOwner(focused?.owner ?? ''), [focused?.id, focused?.owner]);
      useEffect(() => {
        if (revealDetails.current && detailRef.current) {
          revealDetails.current = false;
          detailRef.current.focus({ preventScroll: true });
          detailRef.current.scrollIntoView({ block: 'nearest' });
        }
      });
      useEffect(() => () => active.current?.abort(), []);
      useEffect(() => () => chat?.reference.release(), [chat]);

      function selectTask(id, clearFilter = true) {
        revealDetails.current = true;
        if (clearFilter) setFilter('');
        setTask(id);
        if (focused?.id === id && detailRef.current) {
          revealDetails.current = false;
          detailRef.current.focus({ preventScroll: true });
          detailRef.current.scrollIntoView({ block: 'nearest' });
        }
      }

      function closePreview() {
        active.current?.abort();
        setBusy(false);
        setPreview(null);
        setPrompt('');
        setError('');
      }

      async function showChat(action, sessionKey, options, signal) {
        const reference = await openStageConversation(ctx, workspace, options, signal);
        if (signal.aborted) {
          reference.release();
          return;
        }
        if (options.whenDraftExists !== 'keep') stageSessions.set(sessionKey, reference.sessionId);
        setChat({ reference, action });
      }

      async function request(action, params, { apply = false, resume, files = [], intake = '', mode, rules = '', refreshBoard = false } = {}) {
        active.current?.abort();
        const ctrl = new AbortController();
        active.current = ctrl;
        setBusy(true);
        setError('');
        setPrompt('');
        try {
          if (resume) {
            await showChat(action, stageSessionKey(workspace, action, preview.data), { sessionId: resume }, ctrl.signal);
            return;
          }
          const query = { action, workspace, ...params };
          if (!apply) {
            const [data, updatedReport] = await Promise.all([
              api(query, ctrl.signal),
              refreshBoard ? api({ action: 'overview', workspace }, ctrl.signal) : null,
            ]);
            if (ctrl.signal.aborted) return;
            if (updatedReport) setReport(updatedReport);
            setChecked([]);
            setPreview({ action, params, data });
            return;
          }
          const data = preview.data;
          const result = await api({ ...query, draft: '1', expected: data.token, expectedReview: data.reviewToken,
            ref: data.baseline ?? params.ref, selected: checked.join(','), mode }, ctrl.signal);
          if (ctrl.signal.aborted) return;
          let draft = result.prompt;
          if (action === 'importPrd') {
            if (intake.trim()) files = [...files, new File([intake.trim()], '粘贴的需求说明.md', { type: 'text/markdown' })];
            draft += `\n本次选定的附件 ${JSON.stringify(files.map(file => file.name))}。`;
          }
          if (action === 'rules') draft += `\n\n【规则调整要求】\n${rules.trim()}`;
          setPrompt(draft);
          if (Object.hasOwn(chatTitles, action)) {
            const sessionKey = stageSessionKey(workspace, action, result);
            const closing = action === 'review' && result.ready;
            const sessionId = closing ? stageSessions.get(sessionKey) : undefined;
            await showChat(action, sessionKey, { sessionId, prompt: draft, files,
              whenDraftExists: closing ? 'keep' : 'append' }, ctrl.signal);
          } else {
            ctx.get('uiWorkspace')?.startSession(workspace, { prompt: draft, whenDraftExists: 'append' });
          }
        } catch (failure) {
          if (!ctrl.signal.aborted) setError(failure.message);
        } finally {
          if (!ctrl.signal.aborted) setBusy(false);
        }
      }

      function changeWorkspace(event) {
        closePreview();
        setReport(null);
        setWorkspace(event.target.value);
        setTask('');
        setFilter('');
        setBaseline('HEAD');
        setSelectedStage(null);
      }

      function openDiff() {
        const node = diffRef.current;
        if (!node) return;
        node.open = true;
        node.querySelector('input')?.focus({ preventScroll: true });
        node.scrollIntoView({ block: 'nearest' });
      }

      function openTaskBoard() {
        const node = boardRef.current;
        node?.focus({ preventScroll: true });
        node?.scrollIntoView({ block: 'nearest' });
      }

      if (chat) return h('section', { className: 'ys-stage-chat', 'aria-labelledby': 'ys-stage-chat-title' },
        h('header', { className: 'ys-stage-chat-header' },
          button(chat.action === 'review' ? '返回验收面板' : '返回交付流程', { onClick: () => {
            setChat(null);
            if (chat.action === 'review') {
              request('review', preview.params, { refreshBoard: true });
            } else {
              closePreview();
              setSnapshot(value => value + 1);
            }
          } }),
          h('h2', { id: 'ys-stage-chat-title' }, chatTitles[chat.action]),
          h('span', null, catalog?.find(item => item.id === workspace)?.title)),
        h(SessionProvider, { session: chat.reference }, renderSlot('yansu.conversation', {})));

      const taskBoard = report && h(Tasks, {
        key: 'tasks', report, filter, setFilter, tasks, focused, selectTask: id => selectTask(id, false), owner, setOwner, request, busy, detailRef, boardRef,
      });
      const currentVersion = report?.prdVersions?.find(row => row.current)?.version;
      const docShelf = report && h(DocumentShelf, { key: 'docs', report, currentVersion, request, busy });
      const previousChat = preview && stageSessions.get(stageSessionKey(workspace, preview.action, preview.data));
      return h('div', { className: 'ys' }, h('main', { className: 'ys-content' },
        h('header', { className: 'ys-top' },
          h('div', { className: 'ys-brand' }, h(BrandMark, { size: 42 }),
            h('div', null, h('h1', { 'aria-label': '研序' }, h(BrandWordmark)), h('p', null, '交付工作台'))),
          h('div', { className: 'ys-workspace' },
            h('label', { className: 'ys-field' }, h('span', null, '工作区'), h('select', {
              value: workspace, onChange: changeWorkspace, disabled: !catalog?.length,
            }, h('option', { value: '' }, '选择 Git 工作区'), (catalog ?? []).map(row => h('option', { key: row.id, value: row.id }, row.title)))),
            button('刷新', { disabled: !workspace || busy, onClick: () => setSnapshot(value => value + 1) }))),
        error && !preview && h('p', { className: 'ys-error ys-notice', role: 'alert' }, error),
        !catalog && !error && h('p', { className: 'ys-notice', role: 'status' }, '正在读取工作区…'),
        catalog?.length === 0 && h('p', { className: 'ys-notice' }, '请从 Harness 侧栏添加一个 Git 工作区。'),
        catalog?.length > 0 && !workspace && h('p', { className: 'ys-notice' }, '选择一个 Git 工作区以查看交付进度。'),
        busy && !report && h('p', { className: 'ys-notice', role: 'status' }, '正在读取交付进度…'),
        report && h(Fragment, null,
          h(Overview, { report, currentVersion, delivery, selectedStage, setSelectedStage, busy, request, selectTask, openDiff, openTaskBoard }),
          h('div', { className: 'ys-board' }, report.tasks.length ? [taskBoard, docShelf] : [docShelf, taskBoard]),
          h(DiffControls, { diffRef, git: report.git, baseline, setBaseline, busy, request })),
        preview && h(Preview, { key: preview.action, panel: preview, close: closePreview, selected: checked, setSelected: setChecked, busy, error, prompt,
          viewVersion: version => request('document', { kind: 'prd', version }),
          refresh: preview.action === 'review' ? () => request('review', preview.params, { refreshBoard: true }) : undefined,
          resume: previousChat ? () => request(preview.action, preview.params, { resume: previousChat }) : undefined,
          apply: form => request(preview.action, preview.params, { ...form, apply: true }) })));
    }

    const css = `
      .ys {
        --ys-base: var(--dsw-alias-bg-base, #fff);
        --ys-ink: var(--dsw-alias-label-primary, #1b263d);
        --ys-muted: var(--dsw-alias-label-secondary, #52617b);
        --ys-line: var(--dsw-alias-line-normal, #dbe5fa);
        --ys-focus: #4d6bfe;
        --ys-accent: #3459d1;
        --ys-accent-hover: #2547b9;
        --ys-accent-text: #2547b9;
        --ys-bg: color-mix(in srgb, var(--ys-focus) 5%, var(--ys-base));
        --ys-soft: color-mix(in srgb, var(--ys-focus) 6%, var(--ys-base));
        --ys-tint: color-mix(in srgb, var(--ys-focus) 12%, var(--ys-base));
        --ys-danger: var(--dsw-alias-label-danger, #a63d35);
        --ys-success: var(--dsw-alias-label-success, #196953);
        --ys-radius: 15px;
        container: ys-panel / inline-size;
        height: 100%;
        overflow: auto;
        color: var(--ys-ink);
        background: var(--ys-bg);
        font: inherit;
        font-size: 14px;
        line-height: 1.55;
      }
      @media (prefers-color-scheme: dark) {
        .ys {
          --ys-base: var(--dsw-alias-bg-base, #171e31);
          --ys-ink: var(--dsw-alias-label-primary, #e8eeff);
          --ys-muted: var(--dsw-alias-label-secondary, #a9b7d1);
          --ys-line: var(--dsw-alias-line-normal, #354465);
          --ys-accent-text: #b5c4ff;
          --ys-danger: var(--dsw-alias-label-danger, #ffb2a5);
          --ys-success: var(--dsw-alias-label-success, #a1e0c9);
        }
      }
      .ys *, .ys *::before, .ys *::after { box-sizing: border-box; }
      .ys h1, .ys h2, .ys h3, .ys p, .ys ol, .ys dl { margin: 0; }
      .ys h1, .ys h2, .ys h3 { line-height: 1.3; }
      .ys h2 { font-size: 17px; font-weight: 700; }
      .ys h3 { font-size: 15px; font-weight: 680; }
      .ys code, .ys pre { font-family: ui-monospace, 'SFMono-Regular', Consolas, monospace; }
      .ys code, .ys small { font-size: 12px; }
      .ys small, .ys .ys-muted { color: var(--ys-muted); }
      .ys button, .ys input:not([type=checkbox], [type=radio]), .ys select, .ys textarea {
        min-width: 0;
        font: inherit;
        color: inherit;
        border: 1px solid var(--ys-line);
        border-radius: 8px;
        background: var(--ys-base);
        padding: 7px 11px;
      }
      .ys button, .ys select, .ys input:not([type=checkbox], [type=radio]) { min-height: 38px; }
      .ys button { cursor: pointer; font-weight: 600; }
      .ys button:disabled { opacity: .6; cursor: default; }
      .ys button:hover:enabled { border-color: var(--ys-accent); }
      .ys :is(button, input, select, textarea, summary, [tabindex]):focus-visible {
        outline: 2px solid var(--ys-focus);
        outline-offset: 2px;
      }
      .ys .ys-primary { background: var(--ys-accent); border-color: var(--ys-accent); color: #fff; }
      .ys .ys-primary:hover:enabled { background: var(--ys-accent-hover); }
      .ys-content { width: min(1200px, 100%); margin: auto; padding: 26px clamp(16px, 4%, 44px) 42px; }
      .ys-top, .ys-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .ys-top { margin-bottom: 22px; }
      .ys-brand, .ys-workspace, .ys-actions { display: flex; align-items: center; gap: 10px; }
      .ys-brand > svg { flex-shrink: 0; }
      .ys-brand h1 svg { display: block; }
      .ys-brand p { font-size: 12px; color: var(--ys-muted); margin-top: 2px; }
      .ys-workspace { min-width: 0; }
      .ys-workspace select { width: clamp(145px, 28cqi, 280px); text-overflow: ellipsis; }
      .ys-field { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 9px; min-width: 0; }
      .ys-field > span { color: var(--ys-muted); font-size: 12px; font-weight: 600; }
      .ys-hero, .ys-card, .ys-notice { border: 1px solid var(--ys-line); border-radius: var(--ys-radius); background: var(--ys-base); }
      .ys-hero { overflow: hidden; }
      .ys-hero-body {
        display: grid; grid-template-columns: minmax(0, 1fr) minmax(128px, 190px); gap: 18px 26px;
        padding: clamp(19px, 3.8cqi, 32px);
        background: linear-gradient(108deg, var(--ys-tint), var(--ys-base) 81%);
      }
      .ys-focus-heading, .ys-doc-name, .ys-version-picker { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 10px; }
      .ys-prd-version {
        display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 6px;
        color: var(--ys-accent-text); background: var(--ys-tint); font-size: 12px; font-weight: 600; white-space: nowrap;
      }
      .ys-prd-version strong { font-size: 14px; font-variant-numeric: tabular-nums; }
      .ys-focus h2 { font-size: clamp(22px, 4cqi, 32px); letter-spacing: -.025em; }
      .ys-focus-copy { max-width: 52ch; color: var(--ys-muted); margin-top: 8px !important; overflow-wrap: anywhere; }
      .ys-actions { flex-wrap: wrap; margin-top: 17px; }
      .ys .ys-git {
        align-self: center; padding: 6px 0 6px 18px; border-left: 1px solid var(--ys-line);
      }
      .ys-git dt { color: var(--ys-muted); font-size: 12px; }
      .ys-git dd { font-size: 14px; font-weight: 650; margin: 1px 0 9px; overflow-wrap: anywhere; }
      .ys-git dd:last-child { margin-bottom: 0; }
      .ys-steps {
        list-style: none; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
        padding: 0; border-top: 1px solid var(--ys-line);
      }
      .ys-steps li {
        min-width: 0; border-right: 1px solid var(--ys-line);
      }
      .ys-steps li:last-child { border-right: 0; }
      .ys button.ys-step {
        display: flex; align-items: flex-start; gap: 8px; width: 100%; height: 100%;
        padding: 13px clamp(10px, 2cqi, 22px); border: 0; border-radius: 0;
        text-align: left; background: transparent;
      }
      .ys button.ys-step:focus-visible { outline-offset: -2px; }
      .ys button.ys-step:hover:enabled { background: var(--ys-soft); }
      .ys button.ys-step[aria-pressed=true] { background: var(--ys-tint); box-shadow: inset 0 -2px var(--ys-accent); }
      .ys-steps strong, .ys-steps small { display: block; overflow-wrap: anywhere; }
      .ys-steps small { margin-top: 2px; }
      .ys-step-dot {
        display: grid; place-items: center; flex: 0 0 13px; height: 13px; border: 1px solid var(--ys-muted);
        border-radius: 50%; margin-top: 4px; font-size: 9px; line-height: 1;
      }
      .ys-step-done .ys-step-dot { color: var(--ys-success); border-color: var(--ys-success); }
      .ys-steps .ys-step-suggestion { color: var(--ys-accent-text); font-weight: 650; }
      .ys-board { display: grid; grid-template-columns: minmax(0, 1.75fr) minmax(255px, 1fr); gap: 16px; align-items: start; margin-top: 16px; }
      .ys-card { min-width: 0; }
      .ys-card-header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 17px 16px 12px; }
      .ys-card-header > span { font-size: 12px; }
      .ys-doc-list, .ys-task-list, .ys-diffs, .ys-scope { list-style: none; padding: 0; margin: 0; }
      .ys-doc-list > li { border-top: 1px solid var(--ys-line); }
      .ys-doc-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
      .ys .ys-doc {
        border: 0; border-radius: 0; display: grid; width: 100%; grid-template-columns: minmax(0, 1fr);
        gap: 3px; text-align: left; align-items: center; padding: 11px 8px 11px 16px; background: transparent;
      }
      .ys button.ys-doc:hover:enabled { background: var(--ys-soft); }
      .ys .ys-doc:focus-visible { outline-offset: -3px; }
      .ys-doc-name { font-weight: 650; }
      .ys-doc-path { grid-column: 1 / -1; grid-row: 2; color: var(--ys-muted); font-weight: 400; overflow-wrap: anywhere; }
      .ys-doc-state { justify-self: start; color: var(--ys-muted); font-size: 11px; padding: 2px 6px; border-radius: 5px; background: var(--ys-soft); }
      .ys-doc-state[data-ready=true] { color: var(--ys-accent-text); background: var(--ys-tint); }
      .ys-doc-tools { display: flex; flex-wrap: wrap; gap: 5px; justify-content: flex-end; max-width: 165px; padding-right: 12px; }
      .ys .ys-doc-tools button { min-height: 33px; padding: 4px 7px; font-size: 12px; color: var(--ys-accent-text); }
      .ys .ys-doc-hint { padding: 0 16px 10px; color: var(--ys-muted); font-size: 12px; overflow-wrap: anywhere; }
      .ys-doc-list .ys-issues, .ys-docs > .ys-issues { margin: 0 16px 10px; }
      .ys-doc-actions { border-top: 1px solid var(--ys-line); display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 12px; }
      .ys-doc-actions button { font-size: 12px; min-height: 33px; padding: 5px 8px; }
      .ys-tasks { container: ys-tasks / inline-size; }
      .ys-filters { display: flex; flex-wrap: wrap; gap: 5px; padding: 0 12px 12px; }
      .ys .ys-filters button { min-height: 33px; padding: 4px 8px; font-size: 12px; }
      .ys-filters button > span { margin-left: 5px; font-variant-numeric: tabular-nums; color: var(--ys-muted); }
      .ys button[aria-pressed=true] { border-color: var(--ys-accent); background: var(--ys-tint); }
      .ys-task-layout { display: grid; min-width: 0; padding: 0 12px 12px; gap: 10px; }
      .ys-task-list { display: grid; gap: 5px; align-content: start; min-width: 0; max-height: min(480px, 58vh); overflow: auto; padding: 3px; }
      .ys .ys-task {
        width: 100%; text-align: left; display: grid; grid-template-columns: minmax(0, 1fr) auto;
        gap: 4px 8px; align-items: center; padding: 8px 10px;
      }
      .ys-task strong, .ys-task-owner { overflow-wrap: anywhere; }
      .ys-task-owner { color: var(--ys-muted); font-weight: 400; font-size: 12px; }
      .ys-task-id { display: flex; gap: 7px; align-items: baseline; min-width: 0; grid-column: 1 / -1; overflow-wrap: anywhere; }
      .ys-task-id code { color: var(--ys-muted); }
      .ys-task .ys-status { grid-column: 2; grid-row: 2 / span 2; white-space: nowrap; }
      .ys-status { justify-self: end; border-radius: 5px; padding: 2px 6px; background: var(--ys-soft); font-size: 11px; font-weight: 650; }
      .ys-IN_PROGRESS, .ys-DONE { color: var(--ys-success); background: var(--ys-tint); }
      .ys-REVIEW { color: var(--ys-ink); background: color-mix(in srgb, #dfac54 20%, var(--ys-base)); }
      .ys-BLOCKED { color: var(--ys-danger); background: color-mix(in srgb, var(--ys-danger) 10%, var(--ys-base)); }
      .ys-task-detail { min-width: 0; padding: 11px; border: 1px solid var(--ys-line); border-radius: 9px; }
      .ys-task-detail > h3 { margin-top: 7px; overflow-wrap: anywhere; }
      .ys-task-detail > button { margin-top: 10px; }
      .ys .ys-fields { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7px 10px; margin: 11px 0; font-size: 12px; }
      .ys-fields dt { color: var(--ys-muted); }
      .ys-fields dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
      .ys-task-actions { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; }
      .ys-task-actions label { display: grid; flex: 1 1 120px; }
      .ys-task-actions input { width: 100%; }
      .ys .ys-empty { border-top: 1px solid var(--ys-line); padding: 21px 16px; color: var(--ys-muted); }
      .ys-empty h3 { color: var(--ys-ink); margin-bottom: 5px; }
      .ys-diff-controls { margin-top: 16px; }
      .ys summary { cursor: pointer; overflow-wrap: anywhere; }
      .ys-diff-controls > summary { padding: 13px 16px; font-weight: 680; }
      .ys-diff-controls > summary span { font-size: 12px; font-weight: 400; margin-left: 9px; }
      .ys-diff-form {
        display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 12px 16px;
        border-top: 1px solid var(--ys-line);
      }
      .ys-diff-form input { width: 190px; max-width: 100%; }
      .ys-diff-form p { flex-basis: 100%; font-size: 12px; }
      .ys .ys-notice { padding: 14px 16px; margin-bottom: 12px; }
      .ys-error { color: var(--ys-danger); overflow-wrap: anywhere; }
      .ys-issues { padding-left: 18px; margin: 8px 0; color: var(--ys-danger); font-size: 12px; overflow-wrap: anywhere; }
      .ys-drawer {
        position: fixed; inset: 0 0 0 auto; margin: 0; padding: 0;
        width: min(650px, 100%); max-width: 100%; height: 100%; max-height: 100%;
        border: 0; border-left: 1px solid var(--ys-line);
        color: var(--ys-ink); background: var(--ys-base);
        box-shadow: -8px 0 40px #101e2c28;
      }
      .ys-drawer::backdrop { background: #14234170; }
      .ys-drawer-layout { height: 100%; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; }
      .ys-drawer-header, .ys-drawer-footer { display: flex; align-items: center; gap: 10px; padding: 14px clamp(12px, 3cqi, 24px); }
      .ys-drawer-header { justify-content: space-between; border-bottom: 1px solid var(--ys-line); }
      .ys-drawer-header p { overflow-wrap: anywhere; font-size: 12px; margin-top: 4px; }
      .ys-drawer-header button { flex: none; }
      .ys-drawer-body { overflow: auto; padding: 14px clamp(12px, 3cqi, 24px); overflow-wrap: anywhere; }
      .ys-drawer-body > :is(p, ul, h3, details) + :is(p, ul, h3, details) { margin-top: 12px; }
      .ys-drawer-footer { flex-wrap: wrap; border-top: 1px solid var(--ys-line); }
      .ys-drawer-footer p { flex-basis: 100%; }
      .ys-doc-form { display: grid; gap: 12px; justify-items: start; }
      .ys-doc-form input, .ys-doc-form textarea { max-width: 100%; }
      .ys-doc-form textarea { width: 100%; }
      .ys-prd-import, .ys-prd-sources, .ys-prd-intake { display: grid; min-width: 0; }
      .ys-prd-import { gap: 18px; }
      .ys-prd-import p { font-size: 12px; }
      .ys-prd-version-summary { display: grid; justify-items: start; gap: 6px; padding: 12px; border-radius: 8px; background: var(--ys-soft); }
      .ys-prd-modes { min-width: 0; border: 0; margin: 0; padding: 0; }
      .ys-prd-modes legend { padding: 0; margin-bottom: 8px; font-size: 15px; font-weight: 680; }
      .ys-prd-mode-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
      .ys-prd-mode {
        display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 8px;
        padding: 9px; border: 1px solid var(--ys-line); border-radius: 8px; cursor: pointer;
      }
      .ys-prd-mode[data-selected=true] { background: var(--ys-soft); border-color: var(--ys-accent); }
      .ys-prd-mode input { margin: 4px 0 0; accent-color: var(--ys-accent); }
      .ys-prd-mode small { display: block; margin-top: 3px; }
      .ys-prd-sources, .ys-prd-intake { gap: 8px; }
      .ys-prd-drop {
        display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px 12px;
        min-height: 88px; padding: 12px; border: 1px dashed var(--ys-accent); border-radius: 8px; background: var(--ys-soft);
      }
      .ys-prd-drop[data-dragging=true] { background: var(--ys-tint); border-style: solid; }
      .ys-source-files { display: grid; gap: 6px; list-style: none; margin: 0; padding: 0; }
      .ys-source-files li { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 4px 8px; background: var(--ys-soft); border-radius: 8px; }
      .ys .ys-source-files button { flex: none; min-height: 32px; padding: 4px 8px; font-size: 12px; }
      .ys-prd-intake > span { font-size: 14px; font-weight: 650; }
      .ys-prd-intake textarea { width: 100%; resize: vertical; }
      .ys-version-picker { margin-bottom: 12px; }
      .ys-scope li { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; align-items: baseline; padding: 9px 0; border-top: 1px solid var(--ys-line); }
      .ys-scope small { grid-column: 2; }
      .ys-document, .ys-compare pre {
        min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 2;
        padding: 12px; background: var(--ys-soft); border-radius: 8px; margin: 0; font-size: 12px;
      }
      .ys-diffs { display: grid; gap: 6px; }
      .ys-diffs li, .ys-change { border: 1px solid var(--ys-line); border-radius: 8px; padding: 8px 10px; }
      .ys-diffs label { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
      .ys-diffs small { display: block; }
      .ys-line-diff { display: grid; gap: 4px; margin: 6px 0 0 22px; }
      .ys-line-diff code:first-child { color: var(--ys-danger); }
      .ys-line-diff code:last-child { color: var(--ys-success); }
      .ys-compare { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 8px; }
      .ys-prompt textarea { width: 100%; margin: 8px 0; }
      .ys-prompt span { margin-left: 8px; }
      .ys-stage-chat {
        height: 100%; min-height: 0; min-width: 0; display: grid; grid-template-rows: auto minmax(0, 1fr);
        background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1b263d);
      }
      .ys-stage-chat-header {
        display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px;
        padding: max(12px, var(--dsh-frame-top-clearance, 0px)) 20px 12px;
        border-bottom: 1px solid var(--dsw-alias-line-normal, #dbe5fa);
      }
      .ys-stage-chat-header h2 { margin: 0; font-size: 16px; font-weight: 680; }
      .ys-stage-chat-header span { font-size: 12px; color: var(--dsw-alias-label-secondary, #52617b); overflow-wrap: anywhere; }
      .ys-stage-chat-header button {
        padding: 5px 10px; border: 1px solid var(--dsw-alias-line-normal, #dbe5fa); border-radius: 8px;
        background: transparent; color: inherit; font: inherit; cursor: pointer;
      }
      .ys-stage-chat-header button:hover { background: var(--dsw-alias-bg-hover, #7a89aa1a); }
      @media (max-width: 500px) {
        .ys-prd-mode-options { grid-template-columns: minmax(0, 1fr); }
      }
      @container ys-tasks (min-width: 520px) {
        .ys-task-layout[data-focused=true] { grid-template-columns: minmax(190px, .9fr) minmax(0, 1.1fr); align-items: start; }
      }
      @container ys-tasks (max-width: 519px) {
        .ys-task-list { max-height: 290px; }
      }
      @container ys-panel (max-width: 740px) {
        .ys-board { grid-template-columns: minmax(0, 1fr); }
      }
      @container ys-panel (max-width: 560px) {
        .ys-top { align-items: flex-start; gap: 10px; flex-direction: column; }
        .ys-workspace { width: 100%; }
        .ys-workspace label { flex: 1; }
        .ys-workspace select { flex: 1; width: 0; }
        .ys-hero-body { grid-template-columns: minmax(0, 1fr); }
        .ys .ys-git {
          display: grid; grid-template-columns: auto 1fr; align-items: baseline; column-gap: 10px;
          border-left: 0; border-top: 1px solid var(--ys-line); padding: 7px 0 0;
        }
        .ys-git dd { margin-bottom: 0; }
        .ys-steps { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .ys-steps li:nth-child(2) { border-right: 0; }
        .ys-steps li:nth-child(-n+2) { border-bottom: 1px solid var(--ys-line); }
        .ys-compare { grid-template-columns: minmax(0, 1fr); }
      }
    `;

    function apply(ctx) {
      const stageSessions = new Map();
      ctx.effect(() => {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.append(style);
        return () => style.remove();
      }, 'yansu: styles');
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'yansu', order: 26, label: () => '研序' },
        () => h(BrandMark, { size: 20 })));
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'yansu',
        children: { 'yansu.conversation': { kind: 'single', scope: 'session' } },
      }, props => h(Panel, { ...props, ctx, stageSessions })));
      ctx.slots.inject('yansu.conversation', () => ctx.slots.register({ name: 'yansu.conversation' }, ConversationContent));
    }
    return { inject: ['slots', 'uiWorkspace'], apply };
  },
});
