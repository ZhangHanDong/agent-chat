# HAgency 全链 E2E 手册(macOS,codex 执行)

面向:在 macOS 机器上由 codex(CLI,可用 shell + 看图)独立搭起 palpo + HAFleet + robrix2 + 本地 agent,并跑完三层 E2E,产出可核对的证据。本文基于 2026-09-02~06 在 Linux 上跑通的同一套(OLP 黑板 #8–#17、E2E-1/2/3),命令均为实际用过的形状;macOS 差异单列。配套:`docs/TESTING.md`(测试纪律)、`scripts/verify-agent-e2e.sh`(一键序列)。

---
## 0. 目标与三层验收(先读懂再动手)

目标一句话:**用 palpo appservice 把本地 agent 组织进 Matrix 房间——不给每个 agent 注册账号;人在 robrix2 里聊需求,agent 在本地干活,结果回到房间。**

| 层 | 名称 | 证明什么 | 驱动方式 |
|---|---|---|---|
| E2E-1 | API 层全链 + 回归清单(8 项) | sync 收件、三种收件模式失败边界、多项目隔离(F03/F04)、来源校验(F06)、名单校验(F10)、多 fleet(模型 C) | 真实 Matrix API(@alex token)+ 日志/状态文件取证 |
| E2E-2 | robrix2 图形界面全链 | 人在 GUI 里发 `!request` → 看到 `@ac_<agent>` 的回复显示在时间线 | 截图 + 鼠标/键盘自动化(macOS 见 §6) |
| E2E-3 | agent 起 octoloop(octoscode 内环)完成任务并回报 + 可观测 | 任务在房间下达 → agent 接单 → octoscode 干活 → 状态/结果回房间;tmux/herdr 随时可看 | agent 侧执行策略(CLAUDE.md)+ MCP task 工具 + GUI/API 取证 |

**纪律(硬)**:每项给 verified / partially-verified / failed + 证据路径;失败项记复现步骤不猜根因;**发现 bug 直接修**(operator 裁决:E2E 发现的 bug 由 codex 直修,先红后绿,`npm run verify:ci` 过,只 commit 不 push,ACK 附逐字);不改 remote/;不把测试缝当生产证明;不用 `/tmp` 放构建产物;所有证据放 `~/.octos/outer/verify/e2e-<n>/`。

---
## 1. 组件与代码状态

| 组件 | 仓库 | 说明 |
|---|---|---|
| palpo(Matrix homeserver,Rust) | `palpo-im/palpo` main | 源码构建 `cargo build --release`(首编 6–10 分钟);需 PostgreSQL |
| HAFleet(backend + bridge + MCP + CLI,Node) | `hagency-org/HAFleet` master | **必须含**:#137(F03/F04)、#139/#140(sync majors F05–F10)、#143/#145(F06 gate)、#147(r9 邀请态终局)。**应含**:#149(r10 限流退避)、#150(r11 回复按来源房路由)——若尚未合并,请 `git merge origin/fix/sync-member-read-backoff origin/fix/source-room-reply-routing` 到本地测试分支后再跑 |
| robrix2(Matrix 客户端,Rust/Makepad) | 本地 robrix2 仓 | `cargo build --release`(首编 20–40 分钟,先起后台) |
| 本地 agent | Claude Code(或 codex)在 tmux 内,经 HAFleet MCP 连 backend | `hafleet up <name> <workspace> claude` |
| octoscode + herdr + octoloop skill | 已安装 | E2E-3 用 |

已知上游 palpo 问题(有 PR/素材,不阻塞):命名空间正则不锚定(PR #421)、退房成员不过滤、filter 无通配、注册表分裂(只用 YAML 目录 + 重启,**别用 admin API 注册**)。

---
## 2. 搭环境(macOS)

### 2.1 依赖
```
brew install postgresql@16 tmux jq
# Rust toolchain(rustup)、Node ≥ 20、cargo 已就绪;Xcode CLT
```
PostgreSQL:用 brew 服务或 Docker(`docker run -d --name palpo-e2e-pg -e POSTGRES_USER=palpo -e POSTGRES_PASSWORD=<pw> -e POSTGRES_DB=palpo_smoke -p 127.0.0.1:5433:5432 postgres:16`)。**只用一次性空库**。

### 2.2 palpo
`~/.hafleet/e2e/palpo.toml` 最小形状(与 Linux 同款):
```toml
server_name = "127.0.0.1:8008"
allow_registration = true
enable_admin_room = false
appservice_registration_dir = "/Users/<you>/.hafleet/e2e/appservices"
[listener]        # 以仓库 palpo-example.toml 为准
address = "127.0.0.1:8008"
[db]
url = "postgres://palpo:<pw>@127.0.0.1:5433/palpo_smoke"
```
启动:`PALPO_CONFIG=~/.hafleet/e2e/palpo.toml nohup ./target/release/palpo >> ~/.hafleet/e2e/logs/palpo.log 2>&1 &`;健康:`curl -s http://127.0.0.1:8008/_matrix/client/versions`。**registration 只在启动时装载:每次改 `appservices/` 目录都要重启 palpo。**

### 2.3 HAFleet runtime
`~/.hafleet/e2e/.env`(键名;值自定,`HAFLEET_OWNER_DM_ROOM` 建完审批房再填):
```
HAFLEET_RUNTIME_DIR=~/.hafleet/e2e   HAFLEET_BACKEND_PORT=8090   API_TOKEN=<随机>
MATRIX_BRIDGE_SECRET=<随机>   MATRIX_HOMESERVER=http://127.0.0.1:8008   MATRIX_SERVER_NAME=e2e-home.invalid
MATRIX_BOT_USERNAME=   MATRIX_BOT_PASSWORD=          # 留空 = bot-less 模式(预期告警,不消音)
MATRIX_AGENT_PREFIX=ac_   MATRIX_TRUST_MODE=audit     # 第二轮切 enforce 重走
MATRIX_OPERATOR_MXIDS=@alex:127.0.0.1:8008   MATRIX_ADMIN_MXIDS=@alex:127.0.0.1:8008
HAFLEET_OWNER_MXID=@alex:127.0.0.1:8008   HAFLEET_OWNER_DM_ROOM=<owner 审批房 id>
HAFLEET_APPSERVICE_SYNC_SIDE=127.0.0.1:8008   HAFLEET_APPSERVICE_SYNC_URL=http://127.0.0.1:8008
```
起 backend / bridge(从仓库根目录,同一 .env):
```
set -a; . ~/.hafleet/e2e/.env; set +a
nohup node backend-v2.js  >> ~/.hafleet/e2e/logs/backend.log 2>&1 &
nohup node bridge-matrix.js >> ~/.hafleet/e2e/logs/bridge.log  2>&1 &
```
健康:backend 日志 "listening on http://127.0.0.1:8090";bridge 日志 "[appservice-sync] logged in as @hafleet:…";`GET /api/matrix/reach`(Bearer API_TOKEN)→ `flowing`。

### 2.4 一键走完"空 fleet → 人类消息到达组"
`scripts/verify-agent-e2e.sh`(需 `HAFLEET_RUNTIME_DIR`)把 project side 创建、registration 生成(写到 `<runtime>/appservices/*.yaml`,**然后重启 palpo**)、agent 登记、`!offer`/`!request`、verdict `{approve, allocatedTokens}` 等字段名全部编码好了——先跑它,失败再看 §7 的坑。关键 API:`POST /api/project-sides`、`POST /api/agents`、`POST /api/agents/:name/matrix-identity`、`POST /api/engagements/:id/verdict`、`GET /api/agents/:name/pane`。

### 2.5 人类账号与房间(curl 扮人,GUI 前置)
- 注册 `@alex`(开放注册):`POST /_matrix/client/v3/register`(`alex` / 密码自定,记入手册)。
- 建 **明文** 项目房(名 `e2e project room`,**关加密**)、owner 审批房(名 `e2e owner approvals`),把 room id 写入 `~/.hafleet/e2e/{project-room.id,owner-room.id}`,alex 的 token 写 `alex.token`。
- 邀请代表 `@hafleet:127.0.0.1:8008` 进项目房 → 代表经 sync 收到 invite 自动入房("knock answered")→ group 自动创建。

### 2.6 本地 agent
```
mkdir -p ~/.hafleet/e2e/agent-ws && hafleet up e2e-claude ~/.hafleet/e2e/agent-ws claude
tmux ls   # 期望看到 e2e-claude
```
`agent-ws/.mcp.json` 指向仓库 `mcp-server.js`,env 含 `HAFLEET_API`、`HAFLEET_AGENT_STATE_DIR`(令牌 fail-closed:缺 agent-token 会 exit 3,这是设计)。role-capacity 的 strong 档已含 `claude-fable-5-1`;若用别的模型名,preset 里声明可匹配的模型。

---
## 3. E2E-1(API 层)清单
以 @alex token 发消息 / 读 `/messages`,日志在 `~/.hafleet/e2e/logs/`,状态在 `~/.hafleet/e2e/data/matrix/bridge-state.json`(`appserviceSync` 是 cursor)。
1. **主链**:项目房 `!request coding 500` → 代表回执 "awaiting a decision…" → `POST /api/engagements/<id>/verdict {"approve":true,"allocatedTokens":500}` → 再发一条点名 `@ac_e2e-claude:… <唯一 nonce>` → 房内出现 agent 回复(`m.in_reply_to` 指向 nonce 消息)。**注意:批准不会让 agent 自动发言,必须再点名。**
2. **F03 同名房**:@alex 新建同名 "e2e project room" 邀请代表 → 原映射不变、日志 `Group "…" is ambiguous across sides`/冲突拒绝、新房不接管;(r9 前这里会毒批熔断,r9 后同批 invite→join→state 应一次通过)。**跑完把同名房改名**,否则后续回复按组名路由会歧义(r11 前)。
3. **F04**:同 agent 第二个项目房接 engagement → 两房 owner/DM 绑定各自不变。
4. **F05/F08**:构造代表 join 可重试失败(短停 palpo)→ 不 ack、cursor 不动、恢复后重投成功。
5. **F07 + r10**:agent `/leave` → bridge 清扫日志、该房不再投递;大批 noise 事件制造 `timeline.limited` gap → 补拉触发;palpo 限流 `M_LIMIT_EXCEEDED` 时 collector **指数退避后自动恢复,不永久熔断**(r10)。
6. **F10**:命名空间内但未登记的 `@ac_ghost` 走准入/撤单 → 零 Matrix 请求 + REFUSED(公共 API 会在更前面以 unknown agent 拒绝,如实记边界)。
7. **F06**:sync 结构化 provenance 日志(mode/registration/sideId/room/ref);无 push listener 时"伪 hs_token→403"无可达入口,记 partially;无代表登记的 side → 终局 `side_incomplete_registration`。
8. **多 fleet(模型 C)**:第二份 registration(`id: hafleet-e2e-b`,`sender_localpart: hafleet_b`,`@bc_.*` exclusive)放入 `appservices/` → 重启 palpo → 用 B 的 as_token `m.login.application_service` 登录为 `@hafleet_b` → 断言:互相冒名 403 "not in appservice's namespace";各自 /sync 只见自己前缀事件;B 代表在房不构成 A 的关系(A 查成员 404、A agent 跨发 403)。

---
## 4. E2E-2(robrix2 GUI)
1. **干净会话**:robrix 会自动恢复上次登录(如 matrix.palpo.im)。用隔离目录启动:macOS 下 robrix 数据在 `~/Library/Application Support/robrix`(robius_directories ProjectDirs);把它临时改名,或用 `HOME=<隔离目录>` 启动。
2. 登录页三栏:User ID `alex` / Password / **Homeserver URL 手输 `http://127.0.0.1:8008`**(默认 matrix.org);Makepad 输入框**没有 Tab 切焦点、没有可见焦点指示**,必须**鼠标点击**每个框再输入;输入后截图确认文字落在正确框再提交。
3. 进 `e2e project room`,发 `!request coding 500`(编辑器里 **Enter 是换行**,点右下角发送按钮)→ 代表回执 → API 批准(§3.1)→ 再发点名 nonce → **时间线出现 `ac_e2e-claude [bot]` 的回复**(截图)→ `/messages` 核对原消息/回复/`m.in_reply_to.event_id`。
4. 结束后 robrix 保持运行给 operator 看。
安全规则:每次点击/输入前确认前台窗口是 Robrix(`osascript -e 'tell app "System Events" to get name of first process whose frontmost is true'`),只点 Robrix 窗口内坐标;只输入 URL/用户名/测试密码/一条指令;连续两次焦点确认失败即停;**非安全类偏差(如 Enter 变换行)自行处理继续**。

---
## 5. E2E-3(agent 起 octoloop + 回报 + 可观测)
现状(已核):agent 的 MCP 已有 `whoami send_message post check_inbox check_group create_task list_tasks get_task accept_task transition_task comment_task update_task_execution`;backend 有 `GET /api/agents/:name/pane`(tmux 屏幕捕获);缺的是 **agent 执行策略**(配置)、聊天→task 自动化(D1)、task→房间卡片(G2)。
1. 给 agent 写执行策略 `~/.hafleet/e2e/agent-ws/CLAUDE.md`:
   - `check_inbox` 收到任务文本 → `create_task` + `accept_task` → `post` "已接单 <task id>" 到房间;
   - 在 herdr 新工作区 `hafleet-agents` 起 octoscode(`herdr pane split --cwd <ws> && herdr agent start <name> --kind octoscode --pane <id>`)跑 goal,自己当外环盯黑板;期间 `update_task_execution` 写进度/心跳;
   - 完成:`comment_task` 结果摘要(diff/测试/PR 链接)+ `transition_task` 到 done + `post` 结果到房间。
2. operator(或 codex 扮 alex)在 robrix 发任务:"在 agent-ws 的 demo 仓加一个 `hello` CLI,带单测"。
3. 取证:房间出现 已接单 / 进行中 / 完成+结果;`GET /api/tasks/<id>` 的 execution 历史与 comments 一致;`GET /api/agents/e2e-claude/pane` 能截到 tmux 屏幕;herdr `hafleet-agents` 工作区可随时打开看 octoscode;`tmux attach -t e2e-claude` 直连。
4. 缺口立单不阻塞:D1(聊天→task)、G2(task→房间卡片)、G3(v1 agent home 模板补执行策略)、G4(`hafleet peek <agent>` 一键打开 tmux/herdr;robrix2 agent_ops 面板显示 pane)、G5(owner 审批房目前**收不到审批卡**,只能 API 批)。

---
## 6. macOS 差异速查
| Linux 用法 | macOS 替代 |
|---|---|
| grim 截图 | `screencapture -x <file>.png`(需"屏幕录制"权限);窗口区域 `screencapture -l <windowid>`(`osascript` 取 id)|
| hyprctl 聚焦/活动窗口 | `osascript -e 'tell app "Robrix" to activate'`;活动窗口见 §4 安全规则 |
| ydotool 点击/输入 | `brew install cliclick` → `cliclick c:<x>,<y>` / `t:<text>`;或 `osascript -e 'tell app "System Events" to keystroke "…"'`(需"辅助功能"权限)|
| wtype | `cliclick t:` 或 System Events keystroke |
| tmux/herdr | 同 Linux(herdr 需在 mac 安装)|
| Retina 坐标 | `screencapture` 出物理像素;cliclick 用逻辑点 = 物理/2。先做一次标定:移到窗口中心截图确认 |
| /tmp | 可用,但构建产物一律放仓库 target/,证据放 `~/.octos/outer/verify/` |

---
## 7. 坑目录(今天真踩过的)
- **robrix 自动恢复旧会话**登到线上服务器 → 隔离数据目录(§4.1)。
- **Makepad 无 Tab 焦点、Enter 换行** → 必须点击;发送按钮在右下角。
- **批准后 agent 不说话** → 再发点名消息。
- **owner 审批房没有审批卡** → 只能 API 批(G5)。
- **同名房让组名歧义** → 回复被 `group-route` 拒投(r11 修;修前把同名测试房改名)。
- **代表仅被邀请的房间** → r9 前把 create 事件判可重试 → 毒批 8×500 → collector 熔断、cursor 卡死 → 需重启 bridge;r9 后应一次通过。
- **成员读取限流 M_LIMIT_EXCEEDED** → r10 前永久熔断;r10 后指数退避自动恢复。
- **registration 只在 palpo 启动时装载**;**别用 admin API 注册**(进 DB 不进文件表,masquerade 必挂)。
- **bridge 有 owner 锁**:重启要精确找 pid(`ps -eo pid,args | awk '$2=="node" && $3 ~ /bridge-matrix\.js$/'`),别用 pgrep 文本匹配。
- **verify:ci 有未定义标识符门禁**:改测试也要跑 `npm run verify:ci`。
- **令牌 fail-closed**:agent 状态目录缺 `agent-token` → MCP exit 3,属设计。

---
## 8. 交付格式
- 每层一个 `RESULT.md`(清单表:项 / 结论 / 证据路径 / 复现步骤),证据文件编号。
- ACK 写到 HAFleet 仓 `.octos/OUTER_LOOP_REVIEW.md`:`ACK(E2E-<n> done|blocked)` + 表;bug 修复:分支 `fix/<slug>` 基 master,先红后绿逐字,`npm run verify:ci`,只 commit 不 push,ACK 附 `git show --stat`。
- R2 诚实分级:verified / partially-verified / unverified,不把测试缝、静态证据或"选择器命中"冒充真机行为。
