# pi-lavish

Lavish Editor（[`lavish-axi`](https://github.com/kunchenguid/lavish-axi)）在 pi 里的集成：**把反馈轮询从 agent 的前台 bash 搬到扩展的后台监听**，用户点 Send 时自动唤醒一个新回合。

不做这个扩展，pi 里跑 `lavish-axi poll` 会独占整个 turn——人可能在浏览器里慢慢标注五分钟，模型这五分钟什么都干不了，也看不到你的疑问。

配套的调研与前后时序图对比见 `~/workspace/video-collect/docs/lavish-axi-pi.md`。

## 它做什么

```
agent: npx -y lavish-axi .lavish/plan.html     ← 扩展看到这条命令的 tool_result，自动接管监听
       ↓
       turn 正常结束，pi 空闲（可以继续别的活）
       ↓
用户点 Send ──→ 扩展收到反馈 ──→ pi.sendUserMessage(反馈) ──→ 新回合
       ↓
agent 改 HTML → npx -y lavish-axi reply … "改了什么" ──→ 扩展续上监听，等下一轮
```

具体行为：

| 事件 | 扩展动作 |
|---|---|
| `tool_result` 里出现 `lavish-axi <file>`（`status: opened/resumed`） | 自动开始监听该文件 |
| agent 想手跑 `lavish-axi poll <file>` | **拦下**（同一文件只能有一个 listener，扩展已占位） |
| poll 取回反馈 | 组一条结构化 user message 投给模型；空闲立即触发新回合，忙碌则 `followUp` 排到工具跑完之后 |
| 交付后 | 暂停监听，等 `agent_settled`（本轮改完）再续上，避免用户连发几条被拆成多个回合；10 分钟兜底 |
| `lavish-axi reply …` 成功 | 立刻续上监听，不等回合结束 |
| `Send & End` / `browser_disconnected` | 前者停止监听并告知；后者把「询问用户重开还是结束」交给模型，不擅自决定 |
| `session_shutdown` | 清空所有监听，不留孤儿 poll |

## 安装

```sh
pi install npm:pi-lavish
```

装完 `/reload` 或重开 pi。验证：`/lavish-status` 应显示「未监听」。

从仓库源码装（开发用）：

```sh
git clone https://github.com/fookhsu/pi-lavish && cd pi-lavish
pi install ./
# 或只在当前项目：pi install ./ -l
# 或临时试一次：pi -e ~/workspace/pi-lavish
```

### 装不上时的两个坑

- **`ETARGET: No matching version found`**：npm 本地元数据缓存还没同步。用 `npm i pi-lavish@<version> --prefer-online`，或删掉 `package-lock.json` 重试。
- **装到了 `0.0.0-stage`**：那是 npm 给新包首发时放的公开占位版本（“Temporary package placeholder for staged publishing”），不含扩展代码。显式指定版本即可：`pi install npm:pi-lavish@0.1.1`。

## 命令与工具

| 入口 | 用途 |
|---|---|
| `/lavish-status` | 列出正在监听的会话、连接状态、已交付轮数、最近错误 |
| `/lavish-watch <file>` | 手动开始监听（正常流程会自动，一般不用） |
| `/lavish-stop [file]` | 停止监听（省略 file 则全停） |
| 工具 `lavish_watch` | 同上三者，供模型自己调用（`action: start/stop/status`） |

想临时回到「前台阻塞轮询」的老姿势：`/lavish-stop <file>`，再让 agent 自己跑 `poll`。

## 与 lavish-axi 的接口

只走 HTTP API，不解析 CLI 的 TOON 输出（版本升级时字段变化会暴露而不是静默出错）：

- `GET /api/poll?file=<绝对路径>`：长轮询。响应头 `Lavish-Poll-State: listening` = listener 已挂上；body 的 `status` 为 `feedback` / `waiting` / `ended` / `browser_disconnected` / `error`。
- 必须带 `origin: http://127.0.0.1:4387`（服务端做同源校验，缺了会被 403）。
- 端口默认 4387，可用 `LAVISH_AXI_PORT` 改。
- 会话以 **HTML 文件绝对路径** 为 key，扩展直接用绝对路径对话，不存任何 id。

## 已知边界

- **一个文件一个 listener**：扩展占住 listener 时 agent 手跑 poll 会被拦。真需要前台轮询就先 `/lavish-stop`。
- **只在 pi 进程存活期间监听**：pi 退出后反馈仍留在服务端队列，下次打开该文件可见。
- **未处理的 `--takeover`**：若外部用 `--takeover` 抢走 listener，扩展收到 `LISTENER_REPLACED` 后停止并提示，不会自动抢回。
- **不覆盖 `lavish-axi playbook` / `design` 的用法指导**：artifact 怎么写仍然靠作者自己的 SKILL.md 与 CLI 的 `--help`。

## 开发

```sh
# 类型检查（需要 @types/node 与 typescript）
npm i --no-save typescript @types/node
npx tsc --noEmit -p tsconfig.json
```

`tsconfig.json` 把 `@earendil-works/pi-coding-agent` 与 `typebox` 指向宿主的全局安装路径；换机器时改这两条 `paths`，或改成正常装依赖的方式。
