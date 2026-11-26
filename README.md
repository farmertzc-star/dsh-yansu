# 研序 · 轻量研发交付

研序是 DeepSeek Harness 的工作区插件。它读取 Git 与仓库内的 Markdown，展示需求、设计、任务、阻塞和验收状态，并在原生会话中准备下一步的操作草稿。任务进度以 `TASKS` 为准，审核记录保存在仓库里。

## 安装

`0.2.0` 面向 DeepSeek Harness `0.2.2-rc.5`。使用前，在 Harness 侧栏把项目的 Git 根目录添加为工作区。

### macOS Desktop

完全退出 DeepSeek Harness，运行下面的命令从 GitHub 安装。安装完成后重新打开应用，在侧栏选择「研序」。

```sh
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' \
  plugin --profile desktop add 'git+https://github.com/farmertzc-star/dsh-yansu.git'
```

可以在应用的「插件」页面禁用或卸载研序。使用命令卸载时，先退出应用，再运行相同的 CLI，参数改为 `plugin --profile desktop remove dsh-yansu`。

### Web profile

用兼容版本的 `dsh` 创建一个新 profile，再安装并启动。`--from-default-profile` 会重置同名 profile，请使用一个新名字。

```sh
dsh --profile yansu-dev --from-default-profile web --dump-config
dsh plugin --profile yansu-dev add 'git+https://github.com/farmertzc-star/dsh-yansu.git'
dsh --profile yansu-dev
```

## 使用

1. 在侧栏打开「研序」，选择 Git 工作区。点击流程条可查看各阶段的进度和可用操作，「建议处理」标出当前建议优先处理的阶段。在「需求接入」可查看当前 PRD 版本、修改需求或导入更新。更新时先选「补充」「替换」或「新版本」，再选择或拖入一个或多个需求文件，也可粘贴说明。已有 PRD 缺少稳定 ID 时可点「整理现有 PRD」。确认需求调整时归档旧 PRD，并复核关联设计。
2. 在「架构设计」讨论或复核方案，由负责人确认。在「任务编排」预览本轮可编排的需求，再在研序内开始编排对话。只有已确认设计且尚未关联任务的需求进入范围。点「返回交付流程」会刷新工作台，同一次 Harness 运行中可从对应入口继续上次对话。已编排的需求发生变化时，可通过「任务差分」检查影响。选择 `HEAD` 可以比较最新提交与当前工作区。
3. 选中一项任务，填写或确认执行者，点击「检查执行条件」。依赖和设计通过检查后，打开开发会话并发送草稿。用独立会话或由另一位参与者执行最终验收。
4. 对 `REVIEW` 状态的任务点击「检查验收」。在独立审核会话中运行测试，由 `yansu_review_record` 生成标准记录并确认写入。点「返回验收面板」即可查看审核者、测试证据、结论和状态变更预览。通过后点「确认结项」，在会话发送草稿，复检通过后更新 `TASKS`。涉及上线时，把制品、配置、迁移、验证、监控和回滚交给运维。

点「协作规则」旁的「自定义规则」可输入调整要求，预览对 `AGENTS.md` 的修改。会话草稿由用户发送，文档修改由 DSH 原生文件工具根据当前会话的权限，在用户确认补丁后应用。点「刷新」重新读取文档和进度。

## 文档格式

优先复用现有文档。对于自定义位置，可以在根目录的 `AGENTS.md` 里标注路径。

```md
- PRD: `docs/PRD.md`
- DESIGN: `docs/DESIGN.md`
- TASKS: `docs/TASKS.md`
- Reviews: `docs/reviews`
```

需求使用 `## REQ-001 需求名称`。设计使用 `## DES-001 技术契约` 或明确的 `## §4.2 技术契约`，通过 `需求` 字段关联 `REQ`。可执行任务对应的设计应为 `APPROVED`。标题块和带字段名的 Markdown 表格都可使用。无法识别的旧格式可以通过初始化会话整理，保留原始条目及 ID。

PRD 导入有内容变化时使用同一个生效路径，并在首行记录 `<!-- yansu:prd-version v2 -->`。无版本标记的现有 PRD 视作 v1，更新前保存至相邻的 `PRD.md.versions/v1.md`。在「历史版本」中可切换预览。当前 PRD 参与需求统计和任务拆分。三种更新方式都在负责人确认补丁后生效，重复导入相同需求无需升版。

| 更新方式 | 适用范围 |
| --- | --- |
| 补充（默认） | 新增需求，或补齐已有条目的细节和验收标准。冲突单独待确认。 |
| 替换 | 按 REQ ID 或唯一的需求名称替换指定条目，沿用原 ID。 |
| 新版本 | 用完整资料编制下一版基线。对照当前 PRD 核对增删改，明确确认撤销后保留原 ID 并标为已废弃。 |

```md
## TASK-001 实现导出范围校验

- 需求：REQ-001
- 设计：DES-001
- 优先级：P1
- 状态：TODO
- 负责人：待分配
- 依赖：无
- 目标文件：`src/orders/export.js`、`test/orders/export.test.js`
- 验收标准：拒绝超过上限的日期区间，边界测试通过。
```

任务状态为 `TODO`、`IN_PROGRESS`、`BLOCKED`、`REVIEW`、`DONE`。使用 `阻塞原因` 记录阻塞。已完成任务如需后续修改，差分会建议新 ID。用 `来源任务` 和 `变更键` 保留关联，重复计算时可识别已采用的后续任务。

默认在 `docs/reviews/TASK-001-review.md` 追加审核轮次。`候选摘要` 由插件生成，绑定定义的任务文件与相关需求、设计。审核证据应引用真实命令、日志或 CI。项目负责人确认审核者身份和证据来源。

```md
## 第 1 轮

- 候选摘要：从「检查验收」复制 64 位摘要
- 审核者：QA 姓名或审核会话标识
- 测试结果：PASS
- 测试证据：实际运行的命令、结果和日志位置
- 结论：PASS
- 未关闭P0/P1：0
- 发布交接：涉及上线时填写制品、目标环境、验证、监控与回滚引用
```

## 开发与验证

`index.js` 是 Cordis Host，`client.js` 是 DSH 客户端入口，`lib/` 包含工作区读取、Markdown 解析、差分和预检逻辑。插件的 `yansu_workflow` 工具可在原生会话中按当前工作区复检预览版本。运行 `npm test` 验证临时 Git 仓库中的工作流，运行 `npm pack` 生成安装包。
