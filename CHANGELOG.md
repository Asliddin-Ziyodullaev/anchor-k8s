# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Top navigation with sections (Overview, Monitoring, Workloads, Network, Config & storage, Cluster) and sub-tabs, replacing the left sidebar.
- **Resources** tab: live RAM / CPU per pod or per app from metrics-server, totals, request / limit, per-pod trend lines and pods without a memory limit.
- **Health** tab: OOMKilled, CrashLoop, not-ready pods, probe failures and each pod's last restart reason, with a link to its previous log.
- **Alerts**: RAM threshold, pod restarts and nginx up/down, in-app and as browser notifications.
- **Versions** tab: deployment image tags across namespaces with differences highlighted; rollout history per deployment.
- **Nginx** tab: external server checks (status, response time, TLS expiry, `stub_status`) and nginx running in the cluster.
- StatefulSets, DaemonSets, Jobs, CronJobs, ConfigMaps and PVCs, loaded only while their tab is open.
- Several kubeconfig files merged into one context list; SSH tunnels opened by `start.sh`.
- Spring Boot console style for JSON pod logs.
- Start at login on macOS (`./start.sh install` / `uninstall`) and an installable app (web manifest, app icons).
- Community files: code of conduct, contributing guide, security policy, issue and PR templates, CI.

### Fixed
- The page no longer hangs when the cluster is unreachable (version lookup is capped at 3 seconds).
- `start.sh` checks the server through `/api/health`, which doesn't depend on the cluster.

## [1.0.0] - 2026-11-20

### Added
- Kubeconfig-based dashboard: pods, deployments, services, ingresses, events, nodes; search, sorting and auto-refresh.
- Pod logs viewer (`--tail`, `--timestamps`, `--previous`, filter, download), YAML view.
- Pod restart / delete, deployment restart and scale, with Argo CD awareness.
- RBAC-aware UI, Uzbek / Russian / English, light and dark theme, splash screen and logo.
- `start.sh` background start/stop, demo mode.
