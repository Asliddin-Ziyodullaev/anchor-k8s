# Security policy

## Supported versions

Security fixes are provided for the latest version on the `main` branch.

## Reporting a vulnerability

Please do not disclose a suspected vulnerability in a public issue. Use [GitHub's private vulnerability reporting form](https://github.com/anchor-k8s/anchor/security/advisories/new). If that form is unavailable, contact the maintainers privately through the [project's GitHub page](https://github.com/anchor-k8s).

Include the affected commit or version, a minimal reproduction, the likely impact, and any suggested fix. **Never include a real kubeconfig, token, certificate or cluster address.** You should receive an acknowledgement within seven days.

## Security model

Keep these in mind when reporting or contributing:

- Anchor K8s is a **local** tool. The server listens on `127.0.0.1` and has **no authentication**. Exposing it on a network (`HOST=0.0.0.0`) gives anyone who can reach it the full rights of the kubeconfig user.
- Every Kubernetes action runs with the kubeconfig user's RBAC permissions. Use a ServiceAccount with the least privileges you need rather than a cluster-admin kubeconfig.
- Kubeconfig files, `.env` and logs must never be committed. `.gitignore` excludes them, but check your diff.
- The Nginx tab makes HTTP(S) requests from the server to the URLs you add.
