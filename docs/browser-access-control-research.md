# 浏览器全局站点权限与审计选型

调研日期：2026-09-10。目标：多个 agent 共用由用户维护的站点 allowlist，记录操作及拒绝结果，远程使用不依赖本机连接弹窗。

## 建议

**PinchTab 可作为静态站点规则和操作记录的参考，但不满足现成的“远程批准站点后当前会话立即继续”流程。若该流程是必要条件，不应据此推荐直接迁移；保留 Playwright 并补齐授权通道也是合理选择。暂不迁移到 JS Eyes 或 uiuing/browser-agent。**

补充核查：PinchTab 域名拒绝返回 HTTP 403 `idpi_domain_blocked`，不是挂起等待审批；源码提供的放行补救是编辑 `security.allowedDomains` 后执行 `pinchtab server restart`，并注明安全配置在启动时取快照。可远程管理配置不等于有一次性/会话级审批和原任务恢复。之前将它称为首选验证对象，仅适用于静态预授权，未充分考虑此关键交互要求。[拒绝与重启流程](https://github.com/pinchtab/pinchtab/blob/3771028ffe8cfb1a54e03efdc95b18d656ad7d99/internal/handlers/idpi_domain_block.go)、[待重启提示](https://github.com/pinchtab/pinchtab/blob/3771028ffe8cfb1a54e03efdc95b18d656ad7d99/cmd/pinchtab/cmd_security.go)

PinchTab 已有统一域名配置、管理凭证与 agent 会话凭证的区分、HTTP 操作记录和界面，最接近“通用浏览器服务”的目标。但其浏览器入口是独立实例或 CDP，不是当前官方 Chrome 扩展的直接替代。尚未证明其所有跨站、iframe 和撤销流程满足本项目要求，不能据本次调研直接宣称可用于生产权限隔离。

本次没有找到同时满足以下全部条件的已验证即插即用方案：沿用现有 Chrome 扩展连接、严格全局站点上限、所有操作统一审计、agent 不能自行扩大权限。

## 比较

| 候选 | 全局站点限制 | 操作记录 | 与现有 Chrome 扩展模式的关系 | 结论 |
| --- | --- | --- | --- | --- |
| PinchTab | 有统一 `security.allowedDomains`；非空名单、IDPI enabled、strictMode 才构成拒绝规则 | 持久 JSONL、查询、保留期、Dashboard；包括状态码、耗时、会话、动作、标签页等 | 管理独立 Chrome 或 CDP 连接；不是扩展替换包 | 现成服务首选验证对象 |
| Vercel agent-browser | 有域名和动作策略，包含页面资源的网络限制 | 活动流等调试能力；本次未确认满足完整持久审计要求 | 当前源码拒绝 allowlist 与 CDP、auto-connect、profile 等组合 | 新建隔离浏览器时有价值，不适合直接接管当前浏览器 |
| JS Eyes | 静态域名列表只是多种放行来源之一，默认还吸收页面链接和当前标签页 | 服务端调用事件、策略事件；需补齐结果关联及统一脱敏语义 | 自有扩展、服务及 MCP，需要迁移 | 可参考配置/审计组织，不直接采用其站点授权语义 |
| uiuing/browser-agent | 名称虽为 allowlist，实际主要豁免危险动作确认，不是名单外默认拒绝 | 扩展本地记录，保留最近 500 条 | 完整浏览器内 agent，非现有 MCP 后端替代 | 不选；授权语义与需求不符 |
| anomalyco/browser-control | 所检查 CDP guard 没有站点边界，主要阻止少量全局破坏性操作 | 每次 execute 的本地 journal，尽力写入 | Playwright + 自有扩展 + relay，架构相近 | 参考会话与 journal，不能直接解决 allowlist |
| browden | 读取规则和按站点/元素允许的写入；默认读取含热门网站集合 | 本次未核实完整操作审计 | Selenium 管理 profile，不能与日常 Chrome 同时占用同一 profile | 读取为主可考虑，不适合本需求的通用控制 |

## PinchTab：最接近现成服务，但仍有条件

查看了域名基础函数、当前标签页检查、路由声明、标签页导航监听、弹窗处理、活动记录和会话权限文档。

- 导航目标有域名检查；snapshot、screenshot、text、action 等主要路由声明 `guardDomainPolicy`。并非只检查一次 open URL。[路由入口](https://github.com/pinchtab/pinchtab/blob/3771028ffe8cfb1a54e03efdc95b18d656ad7d99/internal/handlers/handlers.go)、[标签页检查](https://github.com/pinchtab/pinchtab/blob/3771028ffe8cfb1a54e03efdc95b18d656ad7d99/internal/handlers/tab_policy.go)
- 标签页监听顶层 `FrameNavigated` 更新策略状态，后续操作会读取该状态；这是跨站后控制的基础，不等同于保证跨站请求绝不发出。iframe 的处理和检查/执行竞态仍需浏览器集成测试。[导航监听](https://github.com/pinchtab/pinchtab/blob/3771028ffe8cfb1a54e03efdc95b18d656ad7d99/internal/bridge/tab_policy.go)
- 空名单表示关闭域名限制，且按 hostname 匹配，不区分协议和端口。若产品要求“删掉最后一个站点后全部拒绝”或精确 origin，需要适配。[匹配实现](https://github.com/pinchtab/pinchtab/blob/3771028ffe8cfb1a54e03efdc95b18d656ad7d99/internal/security/allowlist.go)
- 实例可额外扩大域名名单，因此必须只给 agent 受限 session 凭证，不能给管理 token。其文档说明 session 身份不能访问 config、profile、instance 等管理接口，但也明确不把它定位为敌对多租户沙箱。[安全文档](https://github.com/pinchtab/pinchtab/blob/3771028ffe8cfb1a54e03efdc95b18d656ad7d99/docs/guides/security.md)
- `activity` 才是这里需要的操作记录；项目另有 `audit` 网站质量检查功能，不能混淆。记录包含请求/会话/agent/实例/标签页、URL、动作、状态、耗时；默认保留期常量为 30 天。但 middleware 忽略 Record 错误，不是“日志写失败就拒绝动作”的强制审计。[事件模型](https://github.com/pinchtab/pinchtab/blob/3771028ffe8cfb1a54e03efdc95b18d656ad7d99/internal/activity/activity.go)、[记录入口](https://github.com/pinchtab/pinchtab/blob/3771028ffe8cfb1a54e03efdc95b18d656ad7d99/internal/activity/context.go)

因此，适合先用一个专用 profile 做试点。若必须零迁移复用当前 Chrome 标签页，它不是成本最低的选择。

## JS Eyes：修正初步判断

README 看起来最接近，但当前源码显示其策略目标不是用户维护的静态权限上限。

`EgressGate.isAllowed()` 会接受 task scope、静态名单、session 名单任意一种匹配。默认 task scope 来源包括 `fetched-links`；服务端读取 HTML 的响应会调用 `recordFetchedHtml()`。[策略模块](https://github.com/imjszhang/js-eyes/blob/aa2cd19e714851c2c6628ce4b7fd02f0d90eebbd/packages/policy/egress.js)、[任务范围](https://github.com/imjszhang/js-eyes/blob/aa2cd19e714851c2c6628ce4b7fd02f0d90eebbd/packages/policy/task-origin.js)、[服务端调用路径](https://github.com/imjszhang/js-eyes/blob/aa2cd19e714851c2c6628ce4b7fd02f0d90eebbd/packages/server-core/ws-handler.js)

本地调用原始策略模块得到：

1. strict 模式且静态列表只有 github.com 时，访问 outside.example 返回 pending-egress。
2. 记录含有 outside.example 链接的 HTML 后，同一目标返回 allow。
3. 即使关闭动态 scope 来源，策略模块仍允许针对未授权标签页的 extractPage 和 executeAction；这不是所有工具统一的站点检查。
4. `http://github.com:8080` 符合 github.com 的 hostname 规则，非精确 origin。

这些是策略模块复现，不是对完整扩展所有可能拦截层的端到端绕过证明。足以说明不能把其 allowlist 当成本项目要求直接采用。

审计方面，server dispatch 确实记录 `automation.invoke`，不是只有敏感工具有记录；但记录入口没有通用成功/失败完成事件的配对保证。通用 `sanitizeRecord` 只做长度限制和序列化，不做通用 secret 脱敏，实际安全依赖调用方选择字段。[审计实现](https://github.com/imjszhang/js-eyes/blob/aa2cd19e714851c2c6628ce4b7fd02f0d90eebbd/packages/server-core/audit.js)

## 其他候选的关键证据

**uiuing/browser-agent**：`checkToolCall` 直接允许 read，普通 act 也没有“名单外拒绝”。页面级 allowlist 用于跳过危险点击确认；匹配还包含 `url.includes(clean)`，因此 unrelated URL 的 query 含 github.com 即可能满足该判断。本地原始模块复现了此行为。审计仓库只存最近 500 条。[工具 gate](https://github.com/uiuing/browser-agent/blob/a8517e2c5cd5be9d77e66f90180e25490c67d9ba/packages/extension/src/guardrails/tool-gate.ts)、[页面 gate](https://github.com/uiuing/browser-agent/blob/a8517e2c5cd5be9d77e66f90180e25490c67d9ba/packages/extension/src/guardrails/security.ts)、[审计存储](https://github.com/uiuing/browser-agent/blob/a8517e2c5cd5be9d77e66f90180e25490c67d9ba/packages/extension/src/storage/repos.ts)

**Vercel agent-browser**：launch 校验明确拒绝 `allowed-domains` 与 CDP、auto-connect、profile、restore/state 的组合。这是产品明确的边界，不应靠删掉报错强行启用。域名过滤还作用于 CDN 等资源，比“允许 agent 操作哪些站点”更广，会增加维护名单的成本。[启动校验](https://github.com/vercel-labs/agent-browser/blob/a156ff5760414dc7bfc1d9c074b9eb6441a79b4f/cli/src/native/actions.rs)、[域名过滤](https://github.com/vercel-labs/agent-browser/blob/a156ff5760414dc7bfc1d9c074b9eb6441a79b4f/cli/src/native/network.rs)

**anomalyco/browser-control**：journal 一次 execute 一条，记录代码/结果预览、URL、错误、耗时，不是逐浏览器动作的不可篡改日志。`readOnly` 的 CDP guard 拦截 Input.*，但该函数允许 Runtime.evaluate；不能仅凭 readOnly 名称推断不存在写入能力。本次只验证此 guard 函数，没有对完整执行器做绕过试验。[guard](https://github.com/anomalyco/browser-control/blob/6785d65153e2b5e3f59c7a51b26c5014e3ca35c0/src/cdp-guardrails.ts)、[journal](https://github.com/anomalyco/browser-control/blob/6785d65153e2b5e3f59c7a51b26c5014e3ca35c0/src/session-journal.ts)

**browden**：读取默认参考热门域名集合，非用户显式选中的少量站点；未授权标签页可能在列举时关闭，且 profile 独占，不适合直接套到日常浏览器。[使用边界](https://github.com/nishantsny/browden/blob/31b73f723b456cd21133b9ced7fb52afd3d5b7f0/README.md)

## 保留当前 Playwright 时的实现方向

现有仓库 native wrapper 直接启动官方 MCP，尚无权限或审计代理。官方当前扩展的 relay 接受 debugger attach/sendCommand 和 tabs create/remove；可以作为控制入口，但转发的是底层 CDP，单纯加一次 URL 判断不够。[官方 relay](https://github.com/microsoft/playwright/blob/af74c938e45f3e759dc2521993f201389eb16cb6/packages/extension/src/relayConnection.ts)

建议先做有限兼容性原型，而非承诺只是几行改动：

- 控制层以用户维护的全局 origin 列表为上限；会话权限只能缩小它，不能由页面内容扩大。
- 扩展/浏览器执行入口检查实际 target 和 frame；覆盖新标签页、自动附加、导航后事件/结果输出，不能只拦 MCP navigate。
- MCP 层记录用户能理解的动作，执行层记录实际允许/拒绝及目标；通过请求 ID 关联。底层 CDP 日志不能独自替代业务动作审计。
- 策略编辑与连接 token 不暴露给 browser tools；管理 UI 也不能成为 agent 可操作的授权入口。
- 与当前锁定的 MCP 0.0.79 校验协议兼容性。本次看的官方扩展是新的主分支提交，不能假定直接兼容现有依赖。

如果 agent 有同一操作系统账户的任意 shell 和文件写权限，任何同账户配置/日志都不构成防篡改边界。需要把凭证、策略写权限和日志接收端置于它无法改写的服务/账户边界；这对所有候选都成立。

## 采用前必须通过的验收

| 场景 | 目标行为 |
| --- | --- |
| 名单为空、配置读取失败 | 拒绝浏览器内容读取和交互；保留独立管理入口 |
| URL query、userinfo 含允许域名 | 仍以解析后的真实目标匹配，不发生子串放行 |
| 点击/重定向/新标签页进入未授权站点 | 不向 agent 返回该站点内容，后续输入/读取被拒绝 |
| 跨源 iframe、既有未授权标签页 | 不因顶层页面已授权而取得未授权内容或控制权 |
| 用户撤销站点、已有并发会话仍活跃 | 后续调用与事件输出受新规则控制，无法靠旧 scope 保留权限 |
| agent 尝试改配置或自行增加实例权限 | 管理端拒绝；不能用自己的会话凭证升级权限 |
| 点击/读取/拒绝/超时/断线 | 审计能关联请求、会话、目标、结果；不把未确认完成写成成功 |
| 日志写入失败、服务重启 | 明确丢日志或停止执行策略；历史记录可追溯且不泄露秘密 |

该验收针对“禁止 agent 控制未授权站点”。若要求所有浏览器出站流量也严格限制，需要另外定义 CDN、SSO、WebSocket、后台页面及网络隔离规则。

## 检查范围与复现

- 通过 GitHub API 固定提交后读取源码；未安装扩展、未修改现有浏览器配置、未读取连接 token。
- 执行了 11 个 Node 原始模块行为断言，见 [结果](browser-access-control-probe-results.json)。这是候选行为确认，不是安全验收通过。
- 使用 gvm 中 Go 1.26.0，以命名文件方式执行 PinchTab 原始 `allowlist.go` 和 `allowlist_test.go`，10 个单元测试通过；未运行 PinchTab 完整测试、服务器或真实浏览器集成测试。
- 下载源码和临时探针保存在 `/tmp/browser-policy-research`，临时目录可清理。所有关键源码链接已固定 SHA。
- PinchTab、JS Eyes、uiuing/browser-agent、anomalyco/browser-control 的仓库元数据标注 MIT；Vercel agent-browser、browden、Playwright 标注 Apache-2.0。实际复制代码时应保留相关版权与许可证文件。

调研结论是源码选型建议，不是这些项目的完整安全审计。
