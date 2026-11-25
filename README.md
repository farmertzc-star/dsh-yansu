# 研序 · 轻量研发交付

研序是 DeepSeek Harness 的工作区插件。它读取 Git 与仓库内的 Markdown，展示需求、设计、任务、阻塞和验收状态，并在原生会话中准备下一步的操作草稿。任务进度以 `TASKS` 为准，审核记录保存在仓库里。

## 安装

`0.1.0` 面向 DeepSeek Harness `0.2.2-rc.5`。使用前，在 Harness 侧栏把项目的 Git 根目录添加为工作区。

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

1. 在侧栏打开「研序」，选择 Git 工作区，点「检查工程文档」。点击文档卡片可以查看原文。工程文档缺失时，选择「初始化文档」，打开会话生成补丁预览。
2. 在「Git 基线」填入提交、标签或分支。用 `HEAD` 可以比较最新提交与当前工作区。点「生成任务差分」，勾选需要处理的建议，打开差分处理会话。
3. 选中一项任务，填写或确认负责人，点击「指派并执行」。依赖和设计通过检查后，打开原生会话并发送草稿。用另一位参与者的会话执行最终验收。
4. 对 `REVIEW` 状态的任务点击「检查验收」。审核者实际运行测试并追加审核记录。检查通过后，结项会话可以更新 `TASKS`。涉及上线时，把制品、配置、迁移、验证、监控和回滚交给运维。

会话草稿由用户发送。初始化和任务差分的草稿要求先向用户展示文件补丁，得到确认后再应用。插件及其会话工具只读 Git 和项目文件，变更使用 DSH 原生文件工具与当前会话的沙箱和审批。跨 Harness 实例或外部编辑者需共同遵循 `TASKS` 的分配规则。

## 文档格式

优先复用现有文档。对于自定义位置，可以在根目录的 `AGENTS.md` 里标注路径。

```md
- PRD: `docs/PRD.md`
- DESIGN: `docs/DESIGN.md`
- TASKS: `docs/TASKS.md`
- Reviews: `docs/reviews`
```

需求使用 `## REQ-001 需求名称`。设计使用 `## DES-001 技术契约` 或明确的 `## §4.2 技术契约`，通过 `需求` 字段关联 `REQ`。可执行任务对应的设计应为 `APPROVED`。标题块和带字段名的 Markdown 表格都可使用。无法识别的旧格式可以通过初始化会话整理，保留原始条目及 ID。

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
