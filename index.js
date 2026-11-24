import { defineTool, ToolArgsError, ToolContextUnavailableError } from '@deepseek-ai/dsh-tools';
import { checkReview, openProject, overview, startTask, taskDiff } from './lib/flow.js';
import { draft, initialization, previewMarkdown } from './lib/handoff.js';
import { realpath } from 'node:fs/promises';
import { contains, ProjectError } from './lib/workspace.js';

export const name = 'yansu';
export const inject = ['tools', 'workspaceRegistry', 'workingDirectory', 'webServer', 'connection'];
const actions = ['overview', 'initialize', 'diff', 'start', 'review'];
const taskId = /^TASK-\d+$/;

async function run(path, input, signal) {
  const project = await openProject(path, signal);
  if (input.expected && input.expected !== project.token) throw new ProjectError('工程文档版本已变化，请刷新后重新预览。', 409);
  if (input.action === 'overview') return overview(project);
  if (input.action === 'initialize') return initialization(project);
  if (input.action === 'diff') return taskDiff(project, input, signal);
  if (!taskId.test(input.taskId ?? '')) throw new ProjectError('需要有效的 TASK ID。');
  if (input.action === 'start') return startTask(project, input);
  if (input.action !== 'review') throw new ProjectError('未知操作。');
  const result = await checkReview(project, input, signal);
  if (input.expectedReview && input.expectedReview !== result.reviewToken) throw new ProjectError('候选代码或审核证据已变化，请重新验收。', 409);
  return result;
}

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(data));
}

function fromQuery(url) {
  const param = key => url.searchParams.get(key) ?? undefined;
  const list = param('selected');
  return {
    action: param('action') ?? 'overview', ref: param('ref'), taskId: param('taskId'), owner: param('owner'),
    expected: param('expected'), expectedReview: param('expectedReview'),
    selected: list && /^(\d+,)*\d+$/.test(list) ? list.split(',').map(Number) : [],
  };
}

export function apply(ctx) {
  const assignments = new Map();
  function release(session) {
    for (const [workspace, assignment] of assignments) {
      if (assignment.session === session) assignments.delete(workspace);
    }
  }
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') release(session);
  });
  ctx.on('session/disposed', release);

  ctx.tools.register(defineTool({
    name: 'yansu_workflow',
    description: 'Read-only project workflow checks for 研序. Use a registered Git workspace. Checks authoring plans, task diffs, assignment readiness and independent review evidence. Call again with expected before an approved document edit.',
    parameters: {
      action: { type: 'string', enum: actions, required: true, description: 'Workflow action' },
      taskId: { type: 'string', description: 'TASK-NNN for start and review' },
      owner: { type: 'string', description: 'Assignment owner for start' },
      ref: { type: 'string', description: 'Git baseline for diff' },
      expected: { type: 'string', description: 'Document snapshot token from preview' },
      expectedReview: { type: 'string', description: 'Evidence snapshot token for review' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(input, exec) {
      if (!exec.agent) throw new ToolContextUnavailableError('研序需要当前工作区会话。');
      const cwd = await realpath(ctx.workingDirectory.get(exec.agent.session));
      const workspace = ctx.workspaceRegistry.list().filter(item => contains(item.path, cwd)).sort((a, b) => b.path.length - a.path.length)[0];
      if (!workspace) throw new ToolArgsError(['当前目录未注册为 DSH 工作区。']);
      try {
        const result = await run(workspace.path, input, exec.signal);
        if (input.action === 'start' && input.expected && result.ready) {
          const assignment = assignments.get(workspace.id);
          const session = exec.agent.session;
          if (assignment && (assignment.session !== session || assignment.taskId !== input.taskId)) {
            throw new ProjectError(`当前工作区正在分派 ${assignment.taskId}，请等待该会话结束后刷新。`, 409);
          }
          assignments.set(workspace.id, { session, taskId: input.taskId });
        }
        return JSON.stringify(result);
      } catch (error) {
        if (error instanceof ProjectError) throw new ToolArgsError([error.message]);
        throw error;
      }
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/yansu/api',
    async handler(req, res) {
      const status = ctx.connection.requestRejection(req);
      if (status !== undefined) return send(res, status, { error: '请在 DeepSeek Harness 中打开研序。' });
      if (req.method !== 'GET') return send(res, 405, { error: '此接口只接受读取请求。' });
      const url = new URL(req.url, 'http://local');
      const action = url.searchParams.get('action');
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      try {
        if (action === 'workspaces') {
          return send(res, 200, ctx.workspaceRegistry.list().map(({ id, title, sessionIds }) => ({ id, title, sessionIds })));
        }
        const workspace = ctx.workspaceRegistry.get(url.searchParams.get('workspace'));
        if (!workspace) throw new ProjectError('请先选择已注册的 DSH 工作区。', 404);
        if (action === 'document') {
          const key = url.searchParams.get('kind');
          if (!['agents', 'prd', 'design', 'tasks'].includes(key)) throw new ProjectError('未知文档类型。');
          const project = await openProject(workspace.path, abort.signal);
          return send(res, 200, { path: project.paths[key], text: previewMarkdown(project.documents[key]) });
        }
        const input = fromQuery(url);
        if (!actions.includes(input.action)) throw new ProjectError('未知操作。');
        const result = await run(workspace.path, input, abort.signal);
        const requested = url.searchParams.get('draft') === '1';
        return send(res, 200, requested && input.action !== 'overview' ? { ...result, prompt: draft(input.action, result, input) } : result);
      } catch (error) {
        if (abort.signal.aborted) return;
        if (error instanceof ProjectError) return send(res, error.status, { error: error.message });
        ctx.logger('yansu').warn('工作区检查失败', error);
        return send(res, 500, { error: '工作区检查失败，请检查文件和 Git 状态后重试。' });
      }
    },
  }), 'yansu: workspace API');
}
