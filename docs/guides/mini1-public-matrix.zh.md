# Mini1 Palpo 公网连接

Robrix 的 Homeserver URL 使用：

`https://crew.ominix.io:19443`

继续使用已有的 Matrix ID 和密码。服务器身份仍是
`hfux-closure-20260906.test`，账号后缀不用改成 `crew.ominix.io`。
已有账号、房间、消息和 Agent 分配均保留。

此地址通过公网直接连接 Mini1，不经过客户端电脑的
`127.0.0.1:18010` SSH 转发。原来的 `https://crew.ominix.io/` 网站入口
保持不变；18443已有其他服务占用，因此 Palpo 使用19443。

Mini1 的 `/etc/caddy/Caddyfile` 新增 HTTPS19443站点，复用已有域名证书，
转发 Matrix client/media API 到 Mini1 本机18010。现有
`io.ominix.caddy` 系统服务负责启动和证书维护。Palpo 容器和数据库无需重建。
Palpo 管理后台仍走原18080入口；HAFleet 的 App Service 反向回调仍保留原
SSH 通道，本次只更改 Matrix 客户端公网入口。

2026-09-08验证：Chrome通过公网完成真实账号登录，whoami、房间列表、
sync、历史分页和 thread relations全部HTTP200；读取到9个已加入房间、
测试房间13条历史事件、指定thread的4条回复。TLS1.3证书校验通过。
临时测试登录已退出，不影响用户的现有客户端会话。

部署前配置备份位于 Mini1：
`/Users/cloud/palpo-web-admin/backups/Caddyfile-before-public-matrix-20260908T161520Z`。
本机私有测试缓存的 `mini1-public-matrix-deployment.json` 和
`mini1-public-matrix-verification.json` 保存部署和验证记录。
