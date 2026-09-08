---
kind: requirement
id: REQ-PALPO-HAFLEET-ONBOARDING
title: "Palpo 项目方的 HAFleet 自助接入、接洽房间与 Agent 身份管理"
status: Proposed
liveness: auto
tags: [palpo, matrix, appservice, onboarding, representative, engagement]
---

## Problem

项目方希望允许多个 HAFleet 提供 Agent 服务。当前接入依赖人工准备服务器凭据、
安装 App Service 注册配置、创建房间和邀请代表，无法形成可重复的自助接入体验。
现有 HAFleet 默认代表名与 Agent 命名空间也没有完整表达多个独立服务提供方。

本需求定义由项目方运营的 Palpo 管理 API 和 Web 应用，以及 HAFleet 对接流程：
项目方授权 HAFleet 入驻，系统建立独立接洽身份和房间；项目方申请角色并指定项目，
HAFleet 批准资源投入、提供 Agent，项目方在目标项目中使用 Agent。

本文是操作员于 2026-09-06 要求编写的需求草案，不是实现完成声明，也不自动替代
已有 Accepted 需求。尤其是“接洽大厅与目标项目分离”需要对现有房间授权合同作显式修订。
本次文档工作不安装、轮换或删除现有运行环境的凭据。

## Product Scope

### 用户与职责

| 用户／系统 | 职责 |
|---|---|
| Palpo 服务器管理员 | 授权 HAFleet 入驻，管理 App Service、命名空间、准入和撤销政策 |
| HAFleet 所有者 | 申请入驻、公布可提供的角色，批准资源投入，管理本地 Agent 运行 |
| 项目所有者／获授权申请人 | 选择提供方、申请角色和额度，授权 Agent 进入项目 |
| 项目成员 | 在已获授权的项目中给 Agent 下达任务、查看结果 |
| 接洽代表 | HAFleet 在该服务器上的服务账号，接收请求、回复状态、协助成员准入 |
| 工作 Agent | 获批后提供具体工作的运行实例与对应 Matrix 身份 |

接洽代表由服务程序驱动，不要求模型资源，也不等同于 coding 等工作角色。
一个 HAFleet 在同一项目方服务器上拥有一个接洽代表，可服务多个项目。

### 管理边界

| Palpo 管理端拥有的事实 | HAFleet 拥有的事实 |
|---|---|
| 入驻授权、App Service 安装状态及凭据版本 | 本地服务连接配置、资源声明与接单意愿 |
| Matrix 账号、房间、成员关系、项目准入政策 | Agent 模型、推理级别、工作目录与本地进程 |
| 服务器侧接入限制与撤销状态 | 接洽额度预留、任务、委派与实际工作结果 |

Palpo 可显示 HAFleet 公开声明的能力，但不保存提供方模型 API key、工作目录或进程配置，
不成为另一个任务或运行配置真相源。Palpo 接入限制与 HAFleet 的 token 额度分别展示。

## Current Baseline

| 能力 | 2026-09-06 的已知情况 |
|---|---|
| HAFleet 项目方记录、代表、两种凭据类型 | 已有实现：App Service 与注册令牌 |
| App Service 注册文件生成、监听器、远端 edge | 已有实现；生成配置不等于服务器安装成功 |
| Palpo 管理 API | 上游 main `3e4fbd3` 有注册、列表、详情、删除、启用、停用接口；不能据此认定当前部署镜像全部支持 |
| Palpo App Service 更新与 token 轮换 | 上述路由没有通用更新接口；必须进一步设计并验证 |
| 当前完整实时测试环境 | 使用注册令牌；项目方创建房间，代表受邀加入；角色申请和 Agent 入场已实测 |
| HAFleet 当前角色申请 | `!request` 的来源房间直接成为目标项目房间 |
| 专属接洽大厅与目标项目分离 | 本文要求的新能力，当前未完成 |
| 多 HAFleet 自助管理与权限隔离 | 本文要求的新能力，不能把现有全局管理员 API 直接开放给各 HAFleet |

本地 HAFleet 手工 onboarding 完成，只说明本地 Agent 可运行；不自动证明其已拥有某个
项目方的 Matrix 身份、项目准入或接洽绑定。

## Requirements

### 入驻和 App Service

[REQ-PALPO-HAFLEET-ONBOARDING-API] Palpo MUST 提供项目方管理 API 和使用同一 API 的 Web 页面；HAFleet MUST 能通过程序化接口发起接入、查询结果和继续中断流程。

[REQ-PALPO-HAFLEET-ONBOARDING-GRANT] Palpo MUST 将申请人身份与入驻授权绑定；管理员 MAY 预先批准明确范围内的接入，使后续操作无需重复人工批准；未获授权的申请 MUST NOT 获得服务权限。

[REQ-PALPO-HAFLEET-ONBOARDING-ISOLATION] Palpo MUST 为每个 HAFleet 分配稳定的 fleetId、独立 App Service ID、代表账号及互不重叠的用户命名空间；每个 HAFleet MUST 只能管理自己的登记对象。

[REQ-PALPO-HAFLEET-ONBOARDING-AUTHORITY] 服务器管理员凭据 MUST 留在项目方管理服务中；HAFleet MUST 仅获得获批范围内的管理能力；浏览器 MUST NOT 因读取列表或详情而获得原始服务 token。

[REQ-PALPO-HAFLEET-ONBOARDING-INSTALL] 管理端 MUST 经受控服务器管理接口安装 App Service，并核实有效配置；不支持所需接口的部署 MUST 明确显示版本或能力缺口，不得把生成文件或保存数据库记录直接报告为可用。

[REQ-PALPO-HAFLEET-ONBOARDING-CONNECTION] 入驻 MUST 同时验证 HAFleet 对 Palpo 的身份操作和 Palpo 对事件接收端的交付；标准直接推送与服务器侧 edge MAY 作为不同连接方式提供，页面 MUST 显示实际启用方式及故障所在方向。

[REQ-PALPO-HAFLEET-ONBOARDING-NETWORK] 管理端 MUST 按服务器政策校验回调目标，并用服务器分配的命名空间生成注册配置；租户输入 MUST NOT 扩大为其他 HAFleet 的身份或任意服务器事件范围。

[REQ-PALPO-HAFLEET-ONBOARDING-CREDENTIALS] 凭据交付 MUST 绑定该 HAFleet，支持有明确版本的轮换和撤销；新凭据启用失败 MUST 保留可解释、可恢复的状态，旧凭据是否仍有效 MUST 可核实。

[REQ-PALPO-HAFLEET-ONBOARDING-IDEMPOTENCY] 同一接入请求的重试 MUST 复用既有 fleetId、代表、App Service 和接洽房间；同一请求标识承载不同内容 MUST 返回冲突。

### 接洽房间与项目申请

[REQ-PALPO-HAFLEET-ONBOARDING-RECEPTION] 入驻流程 MUST 幂等地建立或绑定该 HAFleet 的专属接洽房间，配置可发现的入口，并确认代表已加入；房间的发现与加入范围 MUST 遵守项目方政策。

[REQ-PALPO-HAFLEET-ONBOARDING-READINESS] 页面 MUST 区分申请中、已授权、安装中、待连接、可接单、暂停、撤销和操作失败；仅当注册、身份、事件通道、代表成员关系及接洽房间均就绪时 MAY 显示可接单。

[REQ-PALPO-HAFLEET-ONBOARDING-OFFERS] 项目方 MUST 能在接洽入口查看该 HAFleet 已发布的角色及公开服务配置；展示 MUST 区分没有能力、暂不可用、未发布与读取失败。

[REQ-PALPO-HAFLEET-ONBOARDING-TARGET] 从接洽房间发起的申请 MUST 选择已登记的目标项目；管理端 MUST 核实申请人的完整 MXID、目标项目的申请权限、房间与项目方关系，并形成持久授权绑定；仅在消息正文填写目标 roomId MUST NOT 授予该房间权限。

[REQ-PALPO-HAFLEET-ONBOARDING-REQUEST] 申请 MUST 保存提供方、角色、额度、来源房间及事件、目标项目及房间、申请人、授权版本和请求标识；白名单与额度判断 MUST 使用经验证的目标项目，不得继承接洽大厅的白名单。

[REQ-PALPO-HAFLEET-ONBOARDING-VERDICT] HAFleet MUST 独立决定是否投入资源，显示将服务的 Agent 或新建计划、模型与额度；服务器入驻许可、代表入房及项目方发起申请 MUST NOT 等同于 HAFleet 批准。

[REQ-PALPO-HAFLEET-ONBOARDING-FULFILLMENT] 获批申请 MUST 先持久预留额度，再创建或复用符合资格的 Agent；仅在身份、目标房间准入、项目所有者绑定和运行条件满足后 MAY 显示可使用，部分失败 MUST 显示阶段与原因并可重试。

[REQ-PALPO-HAFLEET-ONBOARDING-DELIVERY] 申请状态 MUST 返回接洽上下文；具体任务与结果 MUST 绑定目标项目及正确线程，私密审批内容 MUST NOT 回传到接洽大厅或项目群聊。

### Agent 身份管理

[REQ-PALPO-HAFLEET-ONBOARDING-AGENT-CREATE] 管理端 MUST 按已批准且归属明确的请求创建 Agent 的 Matrix 身份；注册重试 MUST NOT 制造重复账号，账号冲突或丢失凭据 MUST 显示真实恢复需求。

[REQ-PALPO-HAFLEET-ONBOARDING-AGENT-READ] 管理端 MUST 能按 HAFleet 和项目查询 Agent 身份、公开角色、成员关系、接洽状态及观测时间；未知状态 MUST 保持未知，不得由 Matrix 在线推断本地任务健康。

[REQ-PALPO-HAFLEET-ONBOARDING-AGENT-UPDATE] 管理端 MUST 支持获授权范围内的显示资料和项目成员关系变更；Matrix 身份及归属 MUST NOT 通过修改显示名称而改变；模型和本地运行配置 MUST 仍由 HAFleet 管理。

[REQ-PALPO-HAFLEET-ONBOARDING-AGENT-RETIRE] 用户侧的删除操作 MUST 明确表现为停用或退役：撤回目标范围权限、阻止继续使用该已撤销身份、通知 HAFleet 结束关联接洽，并保留历史与审计；仍有未确认停止的任务 MUST 显示未完成清理。

[REQ-PALPO-HAFLEET-ONBOARDING-REVOKE] 撤销整个 HAFleet MUST 阻止新的身份和接单操作，处理其服务凭据与现有接入，并记录 HAFleet 本地任务停止的独立确认；断开 Matrix 连接 MUST NOT 被报告为本地进程已终止。

[REQ-PALPO-HAFLEET-ONBOARDING-AUDIT] 授权、安装、轮换、成员变更、批准、失败重试与撤销 MUST 记录操作者、归属、对象、时间和结果；未知、失败与部分完成 MUST NOT 被折算为成功。

## UX Workflow

### A. HAFleet 入驻

1. 管理员邀请或按既有政策授权 HAFleet。
2. HAFleet 所有者连接项目方，提交名称和连接方式。
3. 管理端分配 fleetId、服务身份和命名空间，安装 App Service。
4. HAFleet 接收自身配置，启动接收端或连接 edge。
5. 双向验证后，建立接洽房间、邀请代表，展示可分享入口。
6. HAFleet 公布可提供的角色，项目方看到“可接单”。

### B. 申请、批准与使用

1. 项目方进入某个 HAFleet 的接洽入口，查看公开能力。
2. 选择角色、目标项目和申请额度；系统验证目标项目权限。
3. HAFleet 所有者查看申请与资源计划，批准或拒绝。
4. 批准后显示“正在准备”，直到 Agent 身份、项目成员关系和工作条件就绪。
5. 双方看到同一申请的状态；项目方得到目标项目房间与实际服务 Agent 的入口。
6. 项目成员在目标房间明确提及该 Agent 下达任务。
7. 若运行时需要权限，项目所有者在其私密审批界面处理，HAFleet 消费对应协议决定。
8. Agent 在正确线程回传结果；任务完成以产物和验证结果为证，不以收到申请或批准为证。

### C. 页面最小集合

| 页面 | 首版必须可完成的动作 |
|---|---|
| 管理员：HAFleet 接入 | 邀请／授权、查看安装与连接阶段、暂停、撤销 |
| HAFleet：我的接入 | 提交申请、完成配对、打开接洽房间、查看失败与重试 |
| 项目方：接洽与申请 | 查看角色、选择目标项目、发起申请、跟踪履约、进入项目 |
| 管理员／HAFleet：Agent 身份 | 列表、详情、允许的资料与成员变更、停用／退役 |

API 必须先支持完整流程，页面不得依赖复制管理员 token、手动 SQL 或浏览器脚本完成接入。

## State and Ownership

| 对象 | 关键字段 | 权威方 |
|---|---|---|
| FleetConnection | fleetId、serverName、owner、授权范围、状态、版本 | Palpo 管理端 |
| ServiceRegistration | App Service ID、代表、命名空间、回调、凭据版本 | Palpo 管理端 |
| ReceptionBinding | fleetId、房间、别名、成员政策、就绪状态 | Palpo 管理端 |
| Project | projectId、房间、所有者与申请政策 | 项目方 |
| AgentRequest | 请求 ID、来源事件、已验证目标、角色、额度、授权版本 | 入口记录由项目方持有，HAFleet 保存经验证的副本 |
| Engagement | 接受决定、额度预留、资源计划、履约阶段 | HAFleet |
| AgentIdentity | fleetId、MXID、关联 Agent ID、项目成员关系、退役状态 | Palpo 管理端；本地 Agent 状态由 HAFleet 报告 |

各对象使用稳定 ID 关联；显示名称、房间别名和 UI 列表行不得成为授权依据。
跨系统操作使用持久操作记录和请求 ID，明确失败后的恢复与补偿，不假设分布式事务天然原子。

## Scenarios

Scenario: 授权后的首次入驻
  Given 管理员已批准某个 HAFleet 的明确接入范围
  When HAFleet 完成配对并建立双向事件通道
  Then 一个 App Service、一个代表和一个接洽入口可用
  And 页面显示实际身份、连接方式与可接单状态

Scenario: 重复提交不会创建重复对象
  Given 入驻请求已创建代表但房间创建中断
  When 相同请求被重试
  Then 原有身份被复用且只产生一个接洽房间
  And 不同内容复用同一请求 ID 被拒绝

Scenario: 多 HAFleet 隔离
  Given 同一服务器存在 HAFleet A 和 HAFleet B
  When A 查询、更新或停用 B 的服务或 Agent 身份
  Then 操作被拒绝且 B 的状态不变

Scenario: 安装完成但通道未就绪
  Given App Service 配置已安装但事件接收端不可达
  When 管理端执行连接检查
  Then 状态仍为待连接并明确失败方向
  And 不显示可接单

Scenario: 大厅申请绑定到另一项目
  Given 申请人有权为项目 P 申请且接洽大厅为 R
  When 申请人在 R 选择 P 并提交角色申请
  Then 系统验证 P 的房间并持久保存源 R 与目标 P 的区别
  And 白名单和项目准入只按验证后的 P 判断

Scenario: 替换目标项目被拒绝
  Given 申请人只获准为 P 申请
  When 消息或 API 参数被替换成无权访问的 Q
  Then 不为 Q 分配额度或创建 Agent 绑定

Scenario: HAFleet 人工批准并履约
  Given 一个未列入自动批准政策的合法角色申请
  When HAFleet 所有者批准明确额度与资源计划
  Then Agent 被创建或合法复用并加入已验证的目标项目
  And 原申请上下文获得同一请求的就绪通知

Scenario: 部分履约失败可恢复
  Given 已预留额度但 Agent 注册或入房失败
  When 双方查看该请求
  Then 显示真实失败阶段且不声称可使用
  And 重试复用已有资源计划并保留原始失败记录

Scenario: 项目方使用 Agent
  Given Agent 已就绪且项目成员满足任务准入政策
  When 成员明确提及 Agent 并提交带验收要求的任务
  Then 任务在正确项目线程执行并返回产物和测试证据
  And 需要的运行权限由绑定的所有者在私密界面决定

Scenario: 凭据轮换失败
  Given 当前服务凭据有效而新版本尚未完成验证
  When 新连接验证失败
  Then 界面准确展示生效版本与故障
  And 不把新凭据写入成功当作轮换成功

Scenario: 退役仍有本地任务
  Given Agent 正在 HAFleet 本地执行任务
  When 项目方撤销该身份的接入
  Then 后续被撤销范围内的操作被阻止
  And 页面单独跟踪 HAFleet 的任务停止确认而非立即报告已停止

Scenario: 重启保留授权和操作状态
  Given 已建立接洽入口且一个履约操作尚未完成
  When Palpo 管理端或 HAFleet 重启
  Then 入驻归属、凭据版本、房间映射与操作记录可恢复
  And 不重复批准、注册身份或消费额度

## Delivery and Acceptance

首版交付范围：入驻授权、独立 App Service、连接检查、专属接洽房间、经验证的项目选择、
请求／批准／入场闭环，以及 Agent 身份查询和停用。资料编辑、凭据轮换和失败恢复也必须
有明确可操作路径，不能通过删除重建掩盖未完成的更新语义。

确定性测试使用本地受控依赖，不连接真实 Matrix 或模型服务。实时验收单独执行，至少包含：

- 两个 HAFleet 同时入驻同一服务器，证明身份、房间和管理权限隔离。
- 从接洽房间申请目标项目、HAFleet 批准、Agent 入场并实际完成带测试的任务。
- 非授权申请和篡改目标被拒绝；超额度与未就绪不能假成功。
- 中断重试、服务重启、凭据轮换失败及退役中运行任务的状态保持真实。

验收 MUST 保留每步的请求 ID、可公开状态、房间／身份关联与实际执行结果。凭据、私密审批
内容、服务器机器清单和提供方私人路径仅留在受限运行证据中，不进入本仓库。
当前注册令牌路径的成功不得被记为本需求的 App Service 自助接入成功。

## Dependencies

- REQ-CONTRIBUTION-CONSOLE：角色公开、提供方接受、额度和白名单语义。
- REQ-OWNER-UI-APPROVAL、REQ-MATRIX-DM-PRIVACY：运行权限与私密审批。
- Palpo 的管理员管理接口及所部署版本的真实能力；此文不假设上游代码已经部署。

## Source Trace

- [ADR-016](../decisions/adr-016-project-sides-as-matrix-reachability-unit.md)：项目方、代表、按接洽提供 Agent 的基础模型。
- [ADR-018](../decisions/adr-018-review-closure-recovery.md)：持久履约、额度预留、凭据保存与退出恢复。
- 操作员于 2026-09-06 要求编写 Palpo 管理 Web 应用、HAFleet 自动 App Service 接入及 Agent CRUD 需求。
- [Matrix App Service 注册规范](https://spec.matrix.org/latest/application-service-api/#registration)：服务器侧授权，不是普通用户自行取得命名空间。
- [Palpo 上游管理路由，固定版本](https://github.com/palpo-im/palpo/blob/3e4fbd332fe3845e99d91884d812493189f91860/crates/server/src/routing/admin/appservice.rs)。
- [Palpo 管理员鉴权，固定版本](https://github.com/palpo-im/palpo/blob/3e4fbd332fe3845e99d91884d812493189f91860/crates/server/src/routing/admin.rs)。
- HAFleet 当前实现：`lib/project-side-store.js`、`lib/matrix-representative.js`、`lib/bot-commands.js`、`backend-v2.js`、`bridge-matrix.js`。
- [现有环境的人工验证步骤](../../docs/guides/hafleet-borrower-walkthrough.zh.md)。

## Open Questions

- 实施前须确定 Palpo 代码仓库、部署版本与管理应用归属；当前只核对上游源码，未把能力视为 Mini1 的已验证接口。
- 须显式修订现有“来源 Matrix 房间即目标项目”的授权要求，定义并验证跨大厅／项目的绑定协议；不能直接放开正文 roomId。
- 不同服务器上的私密加密运行审批与现有项目方明文代表通道仍有合同冲突；本需求不默认代表具备加密能力，也不允许降级泄露审批内容。
- 首版是否要求直接推送与 edge 两种连接均通过实时验收，须在实施 Task Contract 中确定；至少一种必须完整可用，其他方式不得伪装为已支持。

## Out of Scope

- 在 Palpo 上运行 HAFleet 的模型、工作目录或本地任务调度器。
- 向 HAFleet 分发整个 Matrix 服务器的管理员权限。
- 货币计费、将声明的 token 额度视为已测量消费。
- 删除项目历史消息以实现 Agent 退役。
- 未经验证的跨服务器 federation 与全量加密接洽能力。
