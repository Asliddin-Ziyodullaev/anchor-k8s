# Contributing

Thanks for your interest in Anchor K8s! Bug reports, ideas and pull requests are welcome.

## Before you start

- For a bug, open an issue with the **Bug report** form first, unless the fix is tiny.
- For a new feature, open a **Feature request** so we can agree on the scope before you write code.
- Never paste a kubeconfig, token, certificate, real cluster address or real log data into an issue or PR. Reduce the problem to a safe example.

## Development setup

Requires Node.js 20.11+.

```bash
git clone https://github.com/anchor-k8s/anchor.git anchor-k8s && cd anchor-k8s
npm install
npm run demo        # fake data, no cluster needed: http://127.0.0.1:9901
```

Against a real cluster:

```bash
cp .env.example .env    # set KUBECONFIG_FILE
./start.sh
```

## Project layout

```
server.js          Express API that talks to Kubernetes (@kubernetes/client-node)
demo.js            Fake data for demo mode; keep it in sync with new API endpoints
public/index.html  The whole UI: HTML, CSS and JS, no framework and no build step
public/logo.svg    Logo
start.sh           Background start/stop script and SSH tunnels
```

## Guidelines

- **No build step and no new runtime dependencies** unless there is a strong reason. Discuss it in an issue first.
- **Translations:** every user-facing string goes through `t('key')` and must be added to all three languages in `I18N` (`uz`, `ru`, `en`).
- **Demo mode:** a new API endpoint needs a matching fake endpoint in `demo.js`, so the feature can be tried without a cluster.
- **Cluster load:** keep the regular refresh light. Fetch extra resources only while their tab is open.
- **RBAC:** the dashboard often runs with limited permissions. A `403` should show a 🔒 or a short note, not an error box.
- **Security:** the server listens on `127.0.0.1` and has no authentication. Don't add anything that exposes it to the network by default, and never log or return credentials.
- **Style:** match the surrounding code: 2-space indentation, single quotes, small functions, comments in English that explain *why*.

## Checks

Run before opening a PR:

```bash
npm run check       # syntax of server.js, demo.js, start.sh and the page script
npm run demo        # open the UI and click through the tabs you touched
```

CI runs the same checks plus a demo-mode smoke test on Node 20 and 22.

## Pull requests

- Keep a PR focused on one change, and describe what and why.
- Add screenshots for UI changes (light and dark theme if colors changed).
- Update `README.md` and `CHANGELOG.md` when behavior changes.
- Make sure no kubeconfig, `.env` or log file is part of the diff.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
