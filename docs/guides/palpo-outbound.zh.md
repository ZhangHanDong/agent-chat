# HAFleet 与 Palpo 的纯出站连接

HAFleet 主动连接 Palpo，发布资源、心跳和申请处理结果，并长轮询领取申请与 Matrix 消息。HAFleet 可以在内网或 NAT 后运行，无需公网回调地址或 SSH 反向转发。

## 从网页接入

1. 在 Palpo 管理页选择 **Authorize a HAFleet**。默认连接方式为 **Outbound**，填写提供方的 Matrix ID 并授权。
2. 提供方登录 **My HAFleet access**，下载 **Download HAFleet configuration**。
3. 在 HAFleet 的“接入一个项目方”向导选择 Matrix 服务器，选择 Appservice、**导入 Palpo 已授权配置**，上传 JSON 并保存。已有项目方也可从接洽页的“替换”入口导入。
4. HAFleet 自动启动后台连接。回到 Palpo，点击 **Verify connection & create reception**。实际 Matrix 验证事件经队列到达 HAFleet、检查权限并回报后，页面才显示可以接收申请。
5. 在 Palpo 建立或选择项目，选择 HAFleet 自动发布的资源池、角色和模型，填写 Agent 名称并提交申请。HAFleet 的接洽页受理、审批和分配资源；Palpo 显示实际处理进度。
6. 分配完成且 Agent 已加入目标项目房间后，Palpo 才显示可用。项目方在 Matrix 中与 Agent 交互。

保存配置只验证 Matrix 凭据；Palpo 的连接验证确认消息实际到达。接收队列的 ACK 只表示 HAFleet 已持久保存消息，审批与资源分配有独立状态。

## 断线与重连

- 验证成功后，后台心跳维持在线状态。提供方不需要定期登录网页续期。
- 短暂断线时，Palpo 保留资源目录和申请。已验证的连接允许离线排队，显示等待 HAFleet 领取。
- HAFleet 接收消息后先写本地 SQLite，再回报收到。重启后继续处理；同一条消息不会因重试而重复分配资源。
- 状态发布也先写发件箱。响应丢失时，重试同一序号与原始内容。状态携带实际观察时间，重新传输旧状态不会让 Agent 被误判为刚刚验证可用。
- 连接凭据轮换使用新 generation，并保留同一 Matrix 注册下已经接收的未完成消息。旧连接验证事件不能建立新 generation 的就绪状态。

## 部署边界

Palpo Web 与 Matrix homeserver 位于服务器侧。Matrix 把 Appservice 事务交给同侧 Palpo Web relay；HAFleet 通过公开 HTTPS 地址领取事务。这两段都不依赖服务器反向连接 HAFleet。

公开浏览器和机器入口可以使用同一个 HTTPS origin；内部 relay 使用固定容器地址。浏览器仍使用登录会话与 CSRF 校验；机器使用独立 Bearer token 和 generation，不能使用浏览器凭据替代。

既有 Appservice 可以通过管理员的迁移操作原位切换 URL，保留注册 ID、namespace、Matrix token、用户、房间及历史申请。Palpo 的 URL 更新使用原值比较，拒绝覆盖并发修改。文件配置创建的 Appservice 还须更新其注册源文件，避免 homeserver 重启后恢复旧 URL。

如果同时把 Matrix 地址从 SSH 本地转发改成公网地址，应在保存新地址后协调重启 bridge。私聊启动会用原设备 token 在新地址核验用户及设备 ID，成功才更新缓存地址，保留原加密状态；失败不会删除缓存或重新登录。已运行的私聊客户端暂不热切换地址。

队列满时会明确拒绝新投递并让上游重试，保留已有记录；管理员可查看容量并按 Palpo 部署文档扩容。去重记录不会被静默删除。

## 验证范围

仓库包含持久化、丢响应、重启、凭据轮换、消息来源、跨项目权限、状态新鲜度和导入页面的回归。跨仓库 HTTP 验证使用真实 HAFleet/Palpo 协议实现与隔离的 Matrix、执行后端数据；它不等同于真实模型执行。具体部署和线上验收记录见[本次评审报告](../reviews/2026-09-08-palpo-outbound-implementation.md)。

本次 Mini1 部署的 Palpo 管理页为 `https://crew.ominix.io:19444`，Matrix 地址为 `https://crew.ominix.io:19443`，本地 HAFleet 仍为 `http://127.0.0.1:13202`。旧的本地 `18080`、`18010` 转发已停止，请更新书签。既有账号、房间和资源分配保留。
