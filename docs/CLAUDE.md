# Use Agent Browser Runtime with Claude

Both runtime modes expose a standard STDIO MCP server and work with Claude Code or Claude Desktop. Choose one:

- `agent-browser-native`: macOS only; controls a user-selected tab in the regular Chrome profile through the official Playwright Extension.
- `agent-browser`: Docker; controls session-isolated Chromium contexts and supports noVNC takeover. Contexts are retained briefly after idle disconnects, not persisted across broker restarts.

Run the corresponding installer before configuring Claude. Use absolute paths in all MCP configuration.

## Claude Code

### Native Chrome on macOS

1. Install the official [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm) in the Chrome profile you want to use.
2. Install the native runtime:

   ```bash
   ./install-macos-native.sh
   ```

3. Register it for the current user:

   ```bash
   claude mcp add --scope user agent-browser-native -- "$HOME/.config/agent-browser-native/playwright-mcp-native-wrapper.sh"
   ```

4. Run `claude mcp get agent-browser-native` to verify the entry, then restart Claude Code.
5. Open `node "$HOME/.config/agent-browser-native/native-control-cli.cjs" open` in Terminal to configure site permissions and optionally save the extension credential once. Without a saved credential, Chrome asks you to approve the connection on first use. See [Native permissions MVP](native-permissions-mvp.md) for remote approval and audit access. Configure a tool timeout of at least 240 seconds if your client supports it.

### Docker runtime

After running `./install.sh`, register:

```bash
claude mcp add --scope user agent-browser -- "$HOME/.config/agent-browser/mcp-stdio.sh"
```

Run `claude mcp get agent-browser`, then restart Claude Code. Open `http://127.0.0.1:6080/vnc.html` for local human takeover.

### Claude Code tool policy

Add these entries to the `deny` list under `permissions` in `~/.claude/settings.json` or the applicable managed/project settings file:

```json
{
  "permissions": {
    "deny": [
      "mcp__agent-browser__browser_evaluate",
      "mcp__agent-browser__browser_run_code_unsafe",
      "mcp__agent-browser-native__browser_evaluate",
      "mcp__agent-browser-native__browser_run_code_unsafe"
    ]
  }
}
```

Merge this object into existing settings; do not overwrite unrelated configuration. Keep normal permission prompts enabled and do not use `--dangerously-skip-permissions` with a browser connected to authenticated sessions.

## Claude Desktop on macOS

Claude Desktop reads local STDIO server entries from:

```text
$HOME/Library/Application Support/Claude/claude_desktop_config.json
```

Fully quit Claude Desktop before editing. Merge one or both entries into the existing `mcpServers` object, substituting the absolute home path because JSON does not expand `$HOME`:

```json
{
  "mcpServers": {
    "agent-browser-native": {
      "command": "/Users/YOUR_USER/.config/agent-browser-native/playwright-mcp-native-wrapper.sh",
      "args": []
    },
    "agent-browser": {
      "command": "/Users/YOUR_USER/.config/agent-browser/mcp-stdio.sh",
      "args": []
    }
  }
}
```

Reopen Claude Desktop and check its MCP/tool list. For native mode, approve the connection and select the intended Chrome tab when prompted.

Claude Desktop does not consume the Codex `enabled_tools` allowlist. Treat browser tool approvals as security-sensitive and never approve `browser_evaluate` or `browser_run_code_unsafe`. Native mode can access the authenticated state of the selected real-Chrome tab.

## Troubleshooting

- Claude Code: run `claude mcp list` and `claude mcp get <name>`.
- Claude Desktop logs on macOS: `$HOME/Library/Logs/Claude`.
- Use absolute executable paths; GUI applications do not inherit the same shell environment.
- After any MCP configuration change, fully restart the Claude client.
- Native mode requires the Playwright Extension in the active Chrome profile. Docker mode does not use the extension.
