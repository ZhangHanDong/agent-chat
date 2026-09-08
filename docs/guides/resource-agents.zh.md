# 在 Palpo 定义 Agent，向 HAFleet 申请资源

Agent 由项目方在 Palpo 定义。HAFleet 提供资源、审批额度，批准后自动
创建运行环境和 Matrix 身份。同一份 Resource 可以供多个 Agent 使用。
HAFleet 不需要再手工定义一遍 Agent。

1. 提供方打开 http://127.0.0.1:13202/resources，用「配置 Resource」
   保存模型、思考强度和额度。可以配置多份资源。
2. 新资源保存后自动发布到已接入的 Palpo，支持的角色随资源能力自动列出。
   无需逐个点击发布资源或发布角色。可手动撤下资源或角色，阻止新申请；
   明确撤下的资源不会因编辑而重新发布。只分享名称、模型和思考强度。
3. 项目方打开 http://127.0.0.1:18080，登录自己的 Matrix 账号。
   选择项目 `octos-code-use`，在 HAFleet resource pool 中找到想用的资源，
   点 Define Agent on this resource。填写 Agent name，例如 `coding-fast-01`，
   再从该资源支持的 Role 中选择角色，填写 Requested tokens 和 Daily rate。
   页面可见时每 10 秒更新目录，回到页面也会刷新，填写中的申请会保留。
4. 点击 Send agent request。页面显示该 Agent 名称、申请的资源和
   pending 状态。若连接过期，先由 HAFleet 接入负责人点 Verify connection；
   连接恢复不会自动提交申请。
5. 提供方打开 HAFleet「接洽」审批。页面显示「项目方定义的 Agent」、
   名称、角色和资源配置。审核项目方和额度后批准，不需要创建或重新定义
   Agent。若需改名字或资源，拒绝该申请后由项目方提交新的申请。
6. 批准完成后，Palpo 显示获配的 Matrix ID 和实际模型配置。点
   Open project and use agent 进入项目房间，@ 该 Agent 开始工作。
7. 需要第二名时，在 Palpo 重复步骤 3，填写不同名称，例如
   `coding-fast-02`，可以选择同一 Resource。它有独立的申请、审批和身份。

名称以小写字母开头，支持小写字母、数字、下划线和连字符，最长 64 字符。
同一项目中正在申请或使用的名称不能重复。不同项目可以使用相同名称。
实际 Matrix ID 会加上用于区分项目和申请的后缀，请使用结果卡片显示的 ID。

定义和提交都不会立即启动模型，也不会授予额外的网络或沙箱权限。
同一 pool 内的多个 Agent 共享该 pool 的额度；使用同一模型账号的 pool
还受该账号已声明的总额度限制。失败时点 Retry submission 会保留
原定义和申请 ID；已经预留的创建过程由 HAFleet 重试，保留原 Agent 身份。

2026-09-08 已修正 Edison 暴露的记账问题：Palpo 指定 pool 的 Agent
申请直接使用该 pool 的额度，不再被旧项目方总限额挡住。审批页显示所选
pool 的总额、其他申请已分配额、可分配额，以及独立的共享账号额度。
旧项目方额度保留给没有项目 Agent 定义的旧版申请，并单独显示。

当前 edison 申请 100,000 tokens，选择 medium pool；该 pool 配置
100,000,000/月，已分配 0，可分配 100,000,000。共享模型账号的总额度
尚未声明，不能把 pool 配置误读为服务商保证的 token 数。
edison 仍待批准：刷新 HAFleet「接洽」，展开 edison 的「批准」，
核对 pool 和 100000 后点「确认批准」。此前补到 1,100,000 的旧项目方
额度保持原值，但不再参与 edison 的审批。第一名 Agent 的 1,000,000
分配未变。提交申请仍不占用 tokens，也不创建运行实例。

当前三份资源已经发布。`codex · gpt-5.6-sol / medium` 支持 coding、
testing、integration、documentation；两份 high 资源还支持 architect。
review 仍需要满足现有的跨模型家族条件。旧记录没有发布选择时保留原可见性，
当前三份已有资源已按操作员要求显式发布。

Palpo 后台通过 App Service 配对凭据访问 HAFleet 的资源 API。当前 Mini1
回调路径为 `host.docker.internal:19094`，经 SSH 反向隧道到本机
HAFleet `18195`，再转控制面 `18194`。目录由 HAFleet 计算；Palpo 不复制
模型密钥，也不运行本地 Agent。提交申请时，Palpo 先写 Matrix 申请事件，
再把事件 ID 和申请内容交给 HAFleet；HAFleet 核对发送者、项目和内容。
