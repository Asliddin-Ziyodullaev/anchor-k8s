<p align="center"><img src="public/logo.svg" width="88" alt="Anchor K8s"></p>

<h1 align="center">Anchor K8s</h1>

<p align="center"><code>uz.az.anchor.k8s</code> · O'zbek · Русский · English</p>

A lightweight web dashboard for Kubernetes that connects through a kubeconfig. One Node.js server and one HTML page: no build step and no database.

## Features

- Switch contexts and namespaces
- Pods, Deployments, Services, Ingresses, Events, Nodes, with search, sorting and auto-refresh
- Overview of unhealthy pods and recent warnings
- **Pod logs**: `--tail`, `--timestamps`, `--previous`, container picker, auto-refresh, search and filter, download, fullscreen
- **Pod restart** (the pod is deleted and its controller creates a new one) and pod delete
- **Deployment restart** (same as `kubectl rollout restart`) and scale
- YAML view
- Deployments managed by **Argo CD** are marked, and you get a warning before scaling one
- RBAC-aware: resources you can't access show a 🔒, and the namespace list falls back to the kubeconfig contexts
- Three UI languages: Uzbek, Russian and English (switch from the top bar; the choice is remembered)
- Light and dark theme, works on small screens

## Getting started

Requires Node.js 20.11+.

```bash
git clone <repo-url> anchor-k8s && cd anchor-k8s
npm install
cp .env.example .env      # set KUBECONFIG_FILE to your kubeconfig path
./start.sh
```

The browser opens automatically at http://127.0.0.1:8888

`start.sh` runs the server in the background, so the dashboard keeps running after you close the terminal:

```bash
./start.sh            # start
./start.sh stop       # stop
./start.sh restart    # restart
./start.sh status     # is it running?
./start.sh logs       # follow the server log
```

Settings go in `.env` or on the command line: `PORT=9000 ./start.sh`, `KUBECONFIG_FILE=~/.kube/dev.yaml ./start.sh`. Command-line values override `.env`.

The kubeconfig is looked up in this order: `KUBECONFIG_FILE` → `$KUBECONFIG` → `./kubeconfig.yaml` → `~/.kube/config`.

Without the script: `node server.js /path/to/kubeconfig.yaml` (port from `PORT`, default 8080).

### Try it without a cluster

```bash
npm run demo     # fake data, http://127.0.0.1:8090
```

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
```

## License

MIT
