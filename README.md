<p align="center"><img src="public/logo.svg" width="88" alt="Anchor K8s"></p>

<h1 align="center">Anchor K8s</h1>

<p align="center"><code>uz.az.anchor.k8s</code> · O'zbek · Русский · English</p>

<p align="center">
  <a href="https://github.com/anchor-k8s/anchor/actions/workflows/ci.yml"><img src="https://github.com/anchor-k8s/anchor/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20.11-339933.svg" alt="Node.js 20.11+">
</p>

A lightweight web dashboard for Kubernetes that connects through a kubeconfig. One Node.js server and one HTML page: no build step and no database.

## Features

- Switch contexts and namespaces; several kubeconfig files are merged into one context list
- Built-in **SSH tunnels**: `start.sh` opens them before the server starts, for clusters behind a bastion host ([details](#multiple-environments-and-ssh-tunnels))
- Pods, Deployments, StatefulSets, DaemonSets, Jobs, CronJobs, Services, Ingresses, ConfigMaps, PVCs, Events, Nodes, with search, sorting and auto-refresh
- **Resources tab**: live RAM / CPU per pod or per app from metrics-server, totals, request / limit, a trend line per pod (spots memory leaks) and pods without a memory limit
- **Health tab**: OOMKilled, CrashLoop, not-ready pods, readiness / liveness probe failures and the reason of every pod's last restart (with a link to its previous log)
- **Alerts**: RAM threshold, pod restarts and nginx up/down, shown in the app and optionally as browser notifications
- **Versions tab**: image tags of every deployment side by side across namespaces, with differences highlighted; rollout history per deployment
- **Nginx tab**: checks external nginx servers (up/down, response time, TLS certificate expiry, `stub_status` connections) and lists nginx running inside the cluster
- Overview of unhealthy pods and recent warnings
- **Pod logs**: `--tail`, `--timestamps`, `--previous`, container picker, auto-refresh, search and filter, download, fullscreen
- **Spring Boot log view**: JSON log lines are shown like the Spring Boot console, with colored levels, abbreviated loggers, expandable payloads and stack traces ([details](#spring-boot-log-view))
- **Pod restart** (the pod is deleted and its controller creates a new one) and pod delete
- **Deployment restart** (same as `kubectl rollout restart`) and scale
- YAML view
- Deployments managed by **Argo CD** are marked, and you get a warning before scaling one
- RBAC-aware: resources you can't access show a 🔒, and the namespace list falls back to the kubeconfig contexts
- Three UI languages: Uzbek, Russian and English (switch from the top bar; the choice is remembered)
- Light and dark theme, works on small screens
- Plug and play on macOS: starts at login (`./start.sh install`) and installs as an app with its own window and Dock icon

## Getting started

Requires Node.js 20.11+.

```bash
git clone <repo-url> anchor-k8s && cd anchor-k8s
npm install
cp .env.example .env      # set KUBECONFIG_FILE to your kubeconfig path
./start.sh
```

The browser opens automatically at http://127.0.0.1:9901

`start.sh` runs the server in the background, so the dashboard keeps running after you close the terminal:

```bash
./start.sh            # start
./start.sh stop       # stop the server and close the tunnels
./start.sh restart    # restart
./start.sh status     # server and tunnel status
./start.sh tunnel     # (re)open only the SSH tunnels
./start.sh logs       # follow the server log
```

Settings go in `.env` or on the command line: `PORT=9000 ./start.sh`, `KUBECONFIG_FILE=~/.kube/dev.yaml ./start.sh`. Command-line values override `.env`.

The kubeconfig is looked up in this order: `KUBECONFIG_FILE` → `$KUBECONFIG` → `./kubeconfig.yaml` → `~/.kube/config`.

Without the script: `node server.js /path/to/kubeconfig.yaml` (port from `PORT`, default 9901).

### Start at login (plug and play)

On macOS, let the Mac start the dashboard for you:

```bash
./start.sh install      # turn on: starts at login, restarts if it crashes, opens the app
./start.sh uninstall    # turn off
```

This adds a LaunchAgent (`~/Library/LaunchAgents/uz.az.anchor.k8s.plist`) that runs `./start.sh run` after you log in. The dashboard opens once per boot; set `OPEN_ON_LOGIN=0` in `.env` to only start the server. `./start.sh stop` stops it until the next login, `./start.sh status` shows whether start at login is on.

SSH tunnels from `SSH_TUNNELS` also open at login, but there is no terminal to type a password into, so use a key without a passphrase, `ssh-agent`, or a key stored in the macOS Keychain (`UseKeychain yes` in `~/.ssh/config`).

### Use it as an app

Open the dashboard in Chrome or Edge and choose **Install Anchor K8s** in the address bar (or Safari → File → **Add to Dock**). It then runs in its own window with the anchor icon in the Dock and Launchpad, and start at login opens this app window instead of a browser tab.

### Try it without a cluster

```bash
npm run demo     # fake data, http://127.0.0.1:9901
```

If the real dashboard is already running on 9901, use another port: `PORT=9902 npm run demo`.

## Monitoring tabs

| Tab | Data source | Notes |
|---|---|---|
| Resources | `metrics.k8s.io` (metrics-server) | Per-node usage appears only if the kubeconfig user may read node metrics. Trends live in the browser while the page is open. |
| Health | pod status and `Unhealthy` events | The last restart reason comes from the container's `lastState.terminated` (e.g. `OOMKilled`, exit code 137). |
| Alerts | Health tab → Alerts | Rules are saved per browser. Notifications only fire while the dashboard is open. |
| Versions | deployments of every namespace you can access | Click ⟲ on a cell (or **History** on a deployment) for the rollout history. |
| Nginx | `POST /api/probe` from the server | Add any `http(s)://` URL. Point it at an `stub_status` page (e.g. `/nginx_status`) to also get connection and request counts. Targets are saved per browser. |

StatefulSets, DaemonSets, Jobs, CronJobs, ConfigMaps and PVCs are fetched only while their tab is open, so the regular refresh stays light. Secrets are intentionally not shown.

## Spring Boot log view

The **Spring** toggle in the log toolbar (on by default, remembered per browser) renders each log line the way Spring Boot prints it to the console:

```
2026-11-20T17:16:49.123  INFO --- [orders-service] [nio-8080-exec-1] c.e.o.controller.OrderController         : #request GET /api/v1/orders 200
```

- **JSON formats:** `{"@timestamp","message"}` lines, the logstash encoder and log4j2 `JsonLayout` (`level`/`logLevel`, `thread`/`threadName`, `loggerName`).
- **Colors:** faint date; green, yellow or red level; cyan logger abbreviated like Logback's `%logger{39}`.
- **Object messages:** the text plus a short summary (`type` and `target.method` for `#message` lines, method/path/status for `#request` and `#response`). The rest of the payload is a one-line preview that expands to syntax-colored JSON on click and stays open across auto-refresh.
- **Exceptions:** `exception`, `thrown` and `stackTrace` fields are printed as a Java stack trace.
- **Missing level:** inferred from the line: an error, an exception or a 5xx status means `ERROR`, a 4xx status means `WARN`.
- **Plain text lines:** ANSI colors are applied, Spring Boot text lines and stack frames are colored, and the `kubectl --timestamps` prefix is kept.
- **Search:** a hit inside a collapsed payload opens it.
- **Raw log:** turn the toggle off to see the raw log. Copy and download always use the raw log.

## Multiple environments and SSH tunnels

### Several kubeconfig files

List them with `:` (like `$KUBECONFIG`). They are merged the way kubectl does it, and every context appears in the dashboard's context list (hover a context to see its file):

```bash
KUBECONFIG_FILE=~/.kube/dev.yaml:~/.kube/staging.yaml:~/.kube/prod.yaml
```

If two files define the same name, the first one wins. Files are re-read on every context switch, so kubeconfig edits apply without a restart.

### Clusters behind a bastion (SSH)

Put the tunnels in `.env`. `./start.sh` opens them before starting the server, and `./start.sh stop` closes them. Each tunnel is plain `ssh` arguments; separate several tunnels with `;`:

```bash
SSH_TUNNELS="-D 1080 user@bastion-prod; -L 16443:10.0.7.4:6443 user@bastion-stage"
```

Then point the cluster in the kubeconfig at the tunnel:

| Tunnel | Kubeconfig `cluster:` |
|---|---|
| SOCKS proxy: `-D 1080 user@bastion` | keep the real `server:` and add `proxy-url: socks5://127.0.0.1:1080` |
| Port forward: `-L 16443:10.0.7.4:6443 user@bastion` | `server: https://127.0.0.1:16443` (add `tls-server-name:` if the certificate doesn't cover 127.0.0.1) |

The SOCKS proxy is the easier option: one tunnel covers every cluster behind that bastion, and TLS checks keep working because the real address is used.

Other ssh options work as usual: `-p 2222`, `-i ~/.ssh/key`, `-J jump-host`, or a `Host` alias from `~/.ssh/config`. Password and key passphrase prompts appear in the terminal when you run `./start.sh`. If the connection drops, the tunnel closes (`./start.sh status` shows it); reopen it with `./start.sh tunnel`.

## Working with Argo CD

| Action | Result |
|---|---|
| Pod restart / delete | Safe: the ReplicaSet recreates the pod |
| Deployment restart | Safe: Argo CD's own Restart action does the same thing |
| Scale | `replicas` is defined in git. With `selfHeal` on, Argo CD reverts it; otherwise the app goes OutOfSync. To change it permanently, edit the values in git |

## Security

- The server listens on `127.0.0.1` only. The dashboard has no authentication, so don't expose it on the network with `HOST=0.0.0.0`.
- Every action runs with the permissions (RBAC) of the kubeconfig user.
- **Never commit a kubeconfig.** `.gitignore` excludes all `*.yaml` / `*.yml` files and `.env`.

## Project layout

```
server.js          Express API: Kubernetes requests (@kubernetes/client-node)
public/index.html  The whole UI (HTML + CSS + JS, no framework), uz/ru/en strings
public/logo.svg    Logo
demo.js            Fake data for the no-cluster demo mode
start.sh           Background start / stop script
scripts/check.mjs  Syntax checks used by `npm run check` and CI
.github/           Issue / PR templates, CI workflow, Dependabot
```

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the setup and guidelines, and follow the [code of conduct](CODE_OF_CONDUCT.md). Report security issues privately as described in [SECURITY.md](SECURITY.md). For help, see [SUPPORT.md](SUPPORT.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

MIT
