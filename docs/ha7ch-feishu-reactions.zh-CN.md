# HA7CH 飞书处理状态表情

本分支基于 OpenTag v0.0.5，增加可选的程序级进度表情，由 HA7CH 独立维护。上游为 `first-tree-ai/opentag`，保留原 Apache-2.0 许可证及声明。

在 OpenTag daemon 环境中设置 `OPENTAG_FEISHU_TURN_REACTIONS=1`，等正在执行的任务结束后重启。省略此变量即保持上游行为。此配置用于该计算机负责的飞书/Lark 消息，不启用 Slack 表情。

- `OnIt`：凭据已就绪，正在启动或处理。
- `DONE`：模型本轮正常结束，不代表所有业务目标完成，也不代表回复已送达。
- `ERROR`：本轮失败、取消或结果未知。

成功追加到本轮的消息也显示状态。同一轮重复消息去重；observer 副本不贴表情。会话负责的 ambient 消息也显示状态，即使模型选择不回复。

复用已有短期 tenant token，不增加持久化 app secret。每次 API 请求限时三秒且不跟随重定向；处理表情与模型并行执行，结束表情在凭据清理前完成。接口失败只记录不含凭据和响应正文的日志，不改变模型结果；只撤销本程序创建时返回的处理表情 ID，不对结果不明的请求盲目重试。

进程被强制终止、网络故障或 token 过期可能留下旧的处理表情。表情是界面提示，不是持久任务台账。飞书机器人可能需要消息表情权限，本功能不会自动扩大权限。

本分支同时保留已验证的 Codex Context Tree 修复：将关联树的 `.git` 目录明确加入可写范围，使沙箱内 fetch 和写入可执行。

## 验证

运行表情、turn-runner、credential-environment 和 session-runtime-manager 测试，再执行 `pnpm check`、client/CLI 构建和类型检查。上线验收由真人在目标群发消息，分别确认 `OnIt`、撤销、最终表情和实际回复。重启前应等待活动任务结束。
