# Native Chrome MCP 快速上手

这份教程针对 macOS 上的原生模式：Agent → 本地权限检查 → Playwright MCP → 官方 Chrome 扩展 → 现有 Chrome。无需 Docker。管理页面负责站点 allowlist、审批和审计。

**当前是功能原型，不是针对同用户 shell 权限的安全隔离。** agent 如果可以读取本机凭证、修改程序或直接启动原版 Playwright，就可以绕过检查。下面的操作用于功能验收；在这个权限模型下不能把它视为强制安全边界。

## 1. 安装

准备 Node.js 18+、npm、Google Chrome，并在你要使用的 Chrome 配置文件中安装官方 [Playwright 扩展](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm)。在仓库目录运行：

```bash
./install-macos-native.sh
node "$HOME/.config/agent-browser-native/native-control-cli.cjs" open
```

第二条命令会启动本地管理服务并打开已带一次性登录码的管理页面。默认地址为 `http://127.0.0.1:7331`。如果安装时自定义了目录或 XDG 路径，请使用安装程序打印的命令。

安装器不会自动修改 MCP 客户端配置。修改仓库代码后也需要重新运行安装器，安装目录里的副本才会更新。

## 2. 首次配对与站点授权

在官方扩展界面复制 `PLAYWRIGHT_MCP_EXTENSION_TOKEN`，粘贴到管理页的 **首次配对**，保存后重新连接 MCP。凭证由程序保存，后续 worker 自动读取；不要把凭证放进聊天或 MCP 配置文件。

当前输入框只接受 token 值。如果复制的是 `PLAYWRIGHT_MCP_EXTENSION_TOKEN=...` 或 `export PLAYWRIGHT_MCP_EXTENSION_TOKEN='...'`，请只粘贴等号后的值，并去掉外层引号。保存整段赋值文本会导致扩展提示 `Invalid token provided`。

不保存 token 也能使用官方交互式连接流程，但首次操作仍需要在 Chrome 上手动确认，不能解决无人值守连接的问题。首次配对及自动重连仍需在你的实际 Chrome 环境验收。

全局 allowlist 默认是空的。可以先添加 `https://example.com`；也可以暂不添加，在第 4 步通过待审批列表放行。规则必须是完整 origin，例如 `https://github.com`，不能带路径或通配符，也不会自动包含子域名。

## 3. 配置 MCP 客户端

这是 **STDIO MCP**：客户端启动下面的程序，通过标准输入输出调用工具。`7331` 是管理页面端口，不是 MCP HTTP 地址。

```text
/Users/YOUR_USER/.config/agent-browser-native/playwright-mcp-native-wrapper.sh
```

替换 `YOUR_USER`，使用安装器打印的绝对路径。客户端与该程序默认运行在浏览器所在机器；远程审批的 SSH 隧道不会把 MCP 本身变成远程服务。

- **Codex**：合并仓库中的 [codex-native-config-snippet.toml](../codex-native-config-snippet.toml) 到现有客户端配置，替换路径后重启。示例将工具超时设为 240 秒。
- **Claude Code / Claude Desktop**：按 [Claude 配置说明](CLAUDE.md) 添加 native 条目并重启。
- **其他 STDIO MCP 客户端**：设置上述 `command`，`args` 为空；如支持，工具超时设为至少 240 秒。

采用 `mcpServers` JSON 格式的客户端可以合并以下条目；配置文件位置取决于客户端：

```json
{
  "mcpServers": {
    "agent-browser-native": {
      "command": "/Users/YOUR_USER/.config/agent-browser-native/playwright-mcp-native-wrapper.sh",
      "args": []
    }
  }
}
```

不要覆盖其他已有的 MCP 条目。客户端自身的工具审批与本项目的站点审批是两套机制；管理页批准站点不会代替客户端批准工具调用。

## 4. 第一次调用与验收

在客户端确认能看到 `browser_navigate`、`browser_snapshot` 等工具，然后让 agent：

> 使用 agent-browser-native 打开 https://example.com，读取页面标题，并截一张图。

如果该站点没有授权，管理页应出现待审批项。在 90 秒内选择会话授权或 **始终允许**，原来等待中的导航应继续。会话授权持续 30 分钟，绑定当前 worker；重启 worker 后需重新授权。

逐项确认：

1. Chrome 扩展连接成功，agent 可以得到页面快照和截图。
2. 未授权站点会出现审批；拒绝后工具调用失败。
3. 放行后可以操作，在管理页撤销或暂停后，后续调用被阻止。
4. 管理页审计列表出现对应工具、站点、授权决定和执行结果。
5. 保存扩展凭证后，重启客户端再次连接，确认不再需要手动批准扩展连接。

超时后批准不会重新执行旧请求，需要发起新调用。已经执行的点击如果触发受限导航，可能返回执行结果不确定；检查当前页面再继续，不要盲目重复点击。

## 5. 远程审批

在操作者的电脑上转发浏览器主机的管理端口：

```bash
ssh -N -L 7331:127.0.0.1:7331 USER@BROWSER_HOST
```

在浏览器主机的、由你操作的终端中运行：

```bash
node "$HOME/.config/agent-browser-native/native-control-cli.cjs" login
```

在远程电脑打开 `http://127.0.0.1:7331`，输入该命令输出的一次性登录码。登录码 10 分钟有效、只能使用一次；不要让 agent 代取或把它贴到聊天中。登录后可以管理全局规则、批准请求、撤销临时授权和查看审计。

## 6. 排错和生命周期

| 现象 | 检查方式 |
| --- | --- |
| 客户端没有浏览器工具 | 检查 MCP command 的绝对路径、是否安装、是否重启客户端，以及客户端的 MCP 启动日志。 |
| GUI 客户端提示找不到 node | GUI 可能不继承终端 PATH；在客户端进程环境中配置可用的 Node 路径。 |
| 有站点审批但仍连接不上 Chrome | 站点授权与扩展配对独立；确认目标 Chrome 配置文件已装扩展，首次连接提示已处理，保存凭证后已重启 worker。 |
| 放行主页后仍被阻止 | 检查页面是否含其他 origin 的 iframe、登录跳转或不同端口；当前策略要求所有非空 frame 都获授权。 |
| 依赖升级后 worker 拒绝启动 | 适配器只接受锁定版本的 bundle；恢复 lockfile 对应依赖并重新安装。不要直接改 hash 跳过校验。 |
| 批准了但旧请求没继续 | 可能已超时、取消或在执行中遇到受限导航；检查页面和审计，再决定是否发起新调用。 |

```bash
node "$HOME/.config/agent-browser-native/native-control-cli.cjs" start
node "$HOME/.config/agent-browser-native/native-control-cli.cjs" stop
```

关闭 MCP 客户端不会停止管理服务。停止服务后检查会失败；下次启动 worker 或 CLI 可以重新启动服务。全局规则和审计保留，临时授权、待审批项及管理登录会话不保留。

默认审计文件为 `~/.local/share/agent-browser-native/control/audit.jsonl`。页面快照和截图位于同一数据目录下的 `artifacts/`，与只记录元数据的审计不同，可能包含页面内容。

## 验证覆盖范围

自动化测试使用临时数据目录和独立 Chromium 配置文件，实际启动 MCP 并通过管理页面批准请求，覆盖导航、快照、点击、截图、限制工具、跨站限制、撤销与审计。它没有连接你的个人 Chrome，也没有验证官方扩展的首次配对及重连；这部分请按第 4 步验收。

```bash
npm ci --ignore-scripts
npm test
AGENT_BROWSER_TEST_EXECUTABLE='/absolute/path/to/chrome' npm run test:native-browser
```

这些测试需要允许创建本地监听端口和 Unix socket。未设置浏览器路径时，浏览器集成测试会跳过，不能把跳过当成通过。`npm test` 中另有一个默认跳过的 Docker 实际浏览器会话测试，与 native 集成测试独立。

完整实现边界和行为见 [Native permissions MVP](native-permissions-mvp.md)。
