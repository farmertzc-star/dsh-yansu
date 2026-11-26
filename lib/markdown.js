export const states = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'REVIEW', 'DONE'];
const idSource = {
  prd: 'REQ-[0-9]+', design: '(?:DES|DGN|DESIGN)-[0-9]+|§\\s*[0-9]+(?:\\.[0-9]+)*', tasks: 'TASK-[0-9]+',
};
const fieldNames = {
  status: ['状态', 'status'], owner: ['负责人', '开发者', 'owner', 'assignee'], priority: ['优先级', 'priority'],
  req: ['需求', '关联需求', 'PRD', '需求ID', 'REQ'], design: ['设计', '关联设计', '技术设计', 'DESIGN', '设计ID'],
  deps: ['依赖', '前置依赖', 'dependencies', 'depends-on'], files: ['目标文件', '文件', '写入范围', '允许写入', 'files', 'scope'],
  acceptance: ['验收标准', '验收', 'acceptance', 'criteria'], reason: ['阻塞原因', 'blocker'],
  review: ['审核记录', 'review'], source: ['来源任务', 'source-task'], change: ['变更键', 'change-key'],
  reviewer: ['审核者', '验收人', 'reviewer'], candidate: ['候选摘要', 'candidate'],
  test: ['测试结果', 'test-result'], evidence: ['测试证据', 'evidence'], verdict: ['结论', 'verdict'],
  issues: ['未关闭P0/P1', '未关闭 P0/P1', 'open-p0-p1'], release: ['发布交接', 'release'],
};
const fieldsByName = new Map(Object.entries(fieldNames).flatMap(([key, list]) => list.map(label => [label.toLowerCase(), key])));

export function clean(value = '') {
  return value.replace(/`|\*\*|__/g, '').trim();
}

export function ids(kind, value = '') {
  return [...new Set(Array.from(value.matchAll(new RegExp(`(?:${idSource[kind]})(?![0-9A-Za-z_-])`, 'gi')), match =>
    match[0].toUpperCase().replace(/\s/g, '')))];
}

export function entries(lines) {
  let fenced = '';
  return lines.map((line, index) => {
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence && (!fenced || fence[0] === fenced[0] && fence.length >= fenced.length)) {
      fenced = fenced ? '' : fence;
      return { line, index, muted: true };
    }
    return { line, index, muted: Boolean(fenced) };
  });
}

function field(line) {
  const match = /^\s*(?:[-*+]\s+)?([^:：]+?)\s*[:：]\s*(.*)$/.exec(line);
  const key = fieldsByName.get(clean(match?.[1]).toLowerCase());
  if (!key) return null;
  const value = match[2].replace(/^\*\*\s*/, '').trim();
  return { key, value: key === 'files' ? value : clean(value) };
}

export function readFields(lines) {
  const result = {};
  const locations = {};
  let current;
  for (const row of entries(lines)) {
    if (row.muted) continue;
    const item = field(row.line);
    if (item) {
      result[item.key] = item.value;
      locations[item.key] = row.index;
      current = item.key;
    } else if (current === 'files' && /^\s*[-*+]\s/.test(row.line)) {
      result[current] += `,${row.line.replace(/^\s*[-*+]\s+/, '')}`;
    } else if ((current === 'acceptance' || current === 'evidence' || current === 'release') && /^\s*[-*+]\s/.test(row.line)) {
      result[current] += `${result[current] ? '\n' : ''}${row.line.trim()}`;
    } else if (/^\s*#/.test(row.line)) {
      const key = fieldsByName.get(clean(row.line.replace(/^\s*#+\s*/, '')).toLowerCase());
      current = key;
      if (current && result[current] === undefined) result[current] = '';
    }
  }
  return { fields: result, locations };
}

function references(kind, statement) {
  return ids(kind, statement).sort();
}

function listFiles(text = '') {
  const input = [...text.matchAll(/`([^`]+)`|([^`,，、;]+)/g)].map(match => match[1] ?? match[2]);
  return input.map(value => clean(value).replace(/^\.\//, '').replace(/\/$/, ''))
    .filter(value => value && !/^(无|none|n\/a|—|-)$/i.test(value));
}

function taskFields(entry) {
  const f = entry.fields;
  return {
    ...entry,
    status: /\b(TODO|IN_PROGRESS|BLOCKED|REVIEW|DONE)\b/i.exec(f.status ?? '')?.[1]?.toUpperCase() ?? null,
    priority: /\b(P[0-3])\b/i.exec(f.priority ?? '')?.[1]?.toUpperCase() ?? null,
    owner: f.owner && !/^(待分配|待确认|无|—|-|none|unassigned)$/i.test(f.owner) ? f.owner : null,
    reqs: references('prd', f.req), designs: references('design', f.design), deps: references('tasks', f.deps),
    files: listFiles(f.files), acceptance: f.acceptance || '', reason: f.reason || '',
    source: references('tasks', f.source), change: f.change || '',
  };
}

function normalize(content) {
  return content.map(line => line.trim().replace(/\*\*/g, '').replace(/\s+/g, ' ')).filter(Boolean).join('\n');
}

function headingEntries(kind, rows) {
  const headings = rows.flatMap(row => {
    if (row.muted) return [];
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(row.line);
    const emphasis = /^\s{0,3}\*\*([^*]+)\*\*\s*$/.exec(row.line);
    if (!heading && !emphasis) return [];
    const titleText = clean(heading?.[2] ?? emphasis[1]);
    const match = new RegExp(`^\\s*(?:\\[)?(${idSource[kind]})(?![0-9A-Za-z_-])`, 'i').exec(titleText);
    const section = !match && heading && kind === 'design' && /^(\d+(?:\.\d+)+)(?:[.、:]?\s+|[、：])/.exec(titleText);
    const id = match?.[1].toUpperCase().replace(/\s/g, '') ?? (section ? `§${section[1]}` : null);
    if (!heading && !id) return [];
    const title = id ? titleText.slice(match?.[0].length ?? section[0].length).replace(/^[\s\]:：.、–—-]+/, '') : null;
    return [{ ...row, depth: heading?.[1].length ?? 3, id, title }];
  });
  return headings.flatMap((heading, index) => {
    if (!heading.id) return [];
    const after = headings.slice(index + 1).find(other => other.depth <= heading.depth || other.id);
    const lines = rows.slice(heading.index + 1, after?.index ?? rows.length).map(row => row.line);
    const { fields, locations } = readFields(lines);
    return [{ id: heading.id, title: heading.title || heading.id, fields, lines,
      body: normalize(lines), line: heading.index + 1,
      statusLine: locations.status === undefined ? null : heading.index + locations.status + 2 }];
  });
}

function tableEntries(kind, rows) {
  const found = [];
  let headers = [];
  for (const row of rows) {
    if (row.muted || !/^\s*\|.+\|\s*$/.test(row.line)) {
      headers = [];
      continue;
    }
    const raw = row.line.trim().slice(1, -1).split(/(?<!\\)\|/);
    const cells = raw.map(clean);
    if (cells.every(value => /^:?-+:?$/.test(value))) continue;
    const cellId = cells.findIndex(value => new RegExp(`^(${idSource[kind]})(?![0-9A-Za-z_-])`, 'i').test(value));
    if (cellId < 0) {
      headers = cells.map(value => value.toLowerCase());
      continue;
    }
    if (cells.length !== headers.length) continue;
    const id = ids(kind, cells[cellId])[0];
    let title = cells[cellId].slice(id.length).replace(/^[\s:：–—-]+/, '');
    const fields = {};
    let statusCell = null;
    headers.forEach((label, index) => {
      const key = fieldsByName.get(label);
      if (index !== cellId && key) {
        fields[key] = key === 'files' ? raw[index].trim() : cells[index];
        if (key === 'status') statusCell = index;
      }
      if (['名称', '任务名称', '需求名称', '标题', 'title', 'name'].includes(label)) title ||= cells[index];
    });
    found.push({ id, title: title || id, fields, lines: [row.line], body: normalize([row.line]), line: row.index + 1,
      statusLine: statusCell === null ? null : row.index + 1, statusCell });
  }
  return found;
}

export function readEntries(kind, doc) {
  const rows = entries((doc ?? '').split(/\r?\n/));
  const head = headingEntries(kind, rows);
  const table = tableEntries(kind, rows).filter(item => !head.some(heading => heading.id === item.id));
  const found = [...head, ...table].sort((a, b) => a.line - b.line);
  return kind === 'tasks' ? found.map(taskFields) : found;
}

export function stateEdit(text, task, state) {
  if (!states.includes(state) || !task.status || task.statusLine === null) return null;
  const before = text.split(/\r?\n/)[task.statusLine - 1];
  if (typeof before !== 'string') return null;
  const word = new RegExp(`\\b${task.status}\\b`, 'i');
  let after;
  if (Number.isInteger(task.statusCell)) {
    const pieces = before.split(/(?<!\\)\|/);
    const cell = task.statusCell + 1;
    pieces[cell] = pieces[cell].replace(word, state);
    after = pieces.join('|');
  } else {
    const colon = before.search(/[:：]/);
    after = before.slice(0, colon + 1) + before.slice(colon + 1).replace(word, state);
  }
  return before === after ? null : { line: task.statusLine, before, after };
}

const reviewHeading = /^\s{0,3}#{2,3}\s+(?:第\s*(\d+)\s*轮|轮次\s*(\d+)|Round\s+(\d+))/i;

export function reviewHistory(text) {
  const lines = (text ?? '').split(/\r?\n/);
  let last;
  let number = 0;
  for (const row of entries(lines)) {
    if (row.muted) continue;
    const match = reviewHeading.exec(row.line);
    if (!match) continue;
    last = row;
    number = Math.max(number, Number(match[1] ?? match[2] ?? match[3]));
  }
  const { fields } = readFields(last ? lines.slice(last.index + 1) : lines);
  const round = last || fields.reviewer || fields.candidate ? fields : null;
  return { round, next: (number || Number(Boolean(round))) + 1 };
}
