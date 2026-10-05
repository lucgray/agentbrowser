# Hub autostart

Two ways to stop seeing "hub 未连接":

## A · Start with the browser (recommended)

A native-messaging host — `server/native/hub-keeper.mjs` — is spawned by the
browser itself when the extension asks. It probes `127.0.0.1:9010` and only
starts `hub.mjs` if nothing is listening, so **one hub serves every browser
on the machine** (Chrome + Edge + others simultaneously) and multiple
platforms never duplicate it.

Install once per machine:

```bash
node server/native/install.mjs <extension-id>
# or pick browsers explicitly:
node server/native/install.mjs <extension-id> --browser chrome --browser edge
```

`<extension-id>` is on `chrome://extensions` with Developer mode on. The
installer writes a launcher (absolute node path + `hub-keeper.mjs`) into
`~/.agentchat/native/` and registers the `com.agentbrowser.hub` manifest:

- **Linux**: `~/.config/<browser-config>/NativeMessagingHosts/com.agentbrowser.hub.json`
- **macOS**: `~/Library/Application Support/<browser>/NativeMessagingHosts/com.agentbrowser.hub.json`
- **Windows**: `HKCU\Software\<vendor>\NativeMessagingHosts\com.agentbrowser.hub` → manifest under `%USERPROFILE%\.agentchat\native\`

Then restart the browser. When the side panel (or any feature) needs the
hub and it isn't running, the extension pings the keeper, which spawns
`hub.mjs` detached with output appended to `~/.agentchat/hub-autostart.log`.
Without the install the extension behaves exactly as before — manual
`npm start` still works and the keeper warn is harmless.

## B · Start at login (alternative)

Keeps the hub up even before any browser opens. Only one of A/B is needed —
the port probe prevents doubles either way, but pick one to keep things tidy.

### macOS — launchd

Create `~/Library/LaunchAgents/com.agentchat.hub.plist`, substituting the
absolute path to your clone and to `node` (`which node`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>              <string>com.agentchat.hub</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/absolute/path/to/agentbrowser/server/hub/hub.mjs</string>
  </array>
  <key>WorkingDirectory</key>   <string>/absolute/path/to/agentbrowser/server</string>
  <key>RunAtLoad</key>          <true/>
  <key>KeepAlive</key>          <true/>
  <key>StandardOutPath</key>    <string>/tmp/agentchat-hub.log</string>
  <key>StandardErrorPath</key>  <string>/tmp/agentchat-hub.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.agentchat.hub.plist   # load
launchctl bootout   "gui/$(id -u)/com.agentchat.hub"                                # unload
```

### Windows — Task Scheduler

```bat
schtasks /create /tn "AgentBrowserHub" /sc onlogon /rl limited /tr "\"C:\path\to\node.exe\" \"C:\path\to\agentbrowser\server\hub\hub.mjs\""
```

Logs land wherever you redirect them (e.g. wrap in a .bat that appends to
`%USERPROFILE%\.agentchat\hub-autostart.log`). Delete with
`schtasks /delete /tn "AgentBrowserHub" /f`.

### Linux — systemd user unit

```ini
# ~/.config/systemd/user/agentbrowser-hub.service
[Unit]
Description=AgentBrowser hub

[Service]
ExecStart=/usr/bin/node /absolute/path/to/agentbrowser/server/hub/hub.mjs
WorkingDirectory=/absolute/path/to/agentbrowser/server
Restart=always

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now agentbrowser-hub
```

While a login service owns `127.0.0.1:9010`, running `node hub.mjs` by hand
exits with a port-in-use message — stop the service first, or set
`AGENTCHAT_PORT` to something else.
