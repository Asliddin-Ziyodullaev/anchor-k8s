import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import * as k8s from '@kubernetes/client-node';
import { demo } from './demo.js';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1'; // only local by default: kubeconfig = cluster access
const DEMO = process.env.DEMO === '1';

// ---------- kubeconfig ----------
function resolveKubeconfig() {
  const candidates = [
    process.argv[2],
    process.env.KUBECONFIG?.split(path.delimiter)[0],
    path.resolve('kubeconfig.yaml'),
    path.resolve('kubeconfig.yml'),
    path.join(os.homedir(), '.kube', 'config'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

const kcPath = DEMO ? null : resolveKubeconfig();
if (!DEMO && !kcPath) {
  console.error('Kubeconfig not found. Usage:  node server.js /path/to/kubeconfig.yaml');
  console.error('Or try it without a cluster:  npm run demo');
  process.exit(1);
}

let kc;
let api = {};
function loadClients(contextName) {
  kc = new k8s.KubeConfig();
  kc.loadFromFile(kcPath);
  if (contextName) kc.setCurrentContext(contextName);
  api = {
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
    batch: kc.makeApiClient(k8s.BatchV1Api),
    net: kc.makeApiClient(k8s.NetworkingV1Api),
    version: kc.makeApiClient(k8s.VersionApi),
  };
}
if (!DEMO) loadClients();

// ---------- helpers ----------
const age = (ts) => (ts ? new Date(ts).toISOString() : null);

function podSummary(p) {
  const cs = p.status?.containerStatuses || [];
  const ready = cs.filter((c) => c.ready).length;
  const restarts = cs.reduce((a, c) => a + (c.restartCount || 0), 0);
  let status = p.status?.phase || 'Unknown';
  for (const c of cs) {
    const w = c.state?.waiting?.reason;
    const t = c.state?.terminated?.reason;
    if (w) { status = w; break; }
    if (t && status !== 'Succeeded') { status = t; }
  }
  if (p.metadata?.deletionTimestamp) status = 'Terminating';
  return {
    name: p.metadata.name,
    namespace: p.metadata.namespace,
    status,
    ready: `${ready}/${(p.spec?.containers || []).length}`,
    restarts,
    node: p.spec?.nodeName || '-',
    ip: p.status?.podIP || '-',
    created: age(p.metadata.creationTimestamp),
    owner: (p.metadata?.ownerReferences || []).find((o) => o.controller)?.kind || null,
    containers: (p.spec?.containers || []).map((c) => c.name),
    images: (p.spec?.containers || []).map((c) => c.image),
  };
}

const deploySummary = (d) => ({
  name: d.metadata.name,
  namespace: d.metadata.namespace,
  replicas: d.spec?.replicas ?? 0,
  ready: d.status?.readyReplicas ?? 0,
  updated: d.status?.updatedReplicas ?? 0,
  available: d.status?.availableReplicas ?? 0,
  images: (d.spec?.template?.spec?.containers || []).map((c) => c.image),
  created: age(d.metadata.creationTimestamp),
  // tracking-id = "<app>:<group>/<Kind>:<ns>/<name>"; label is used by older Argo CD setups
  argocd: d.metadata.annotations?.['argocd.argoproj.io/tracking-id']?.split(':')[0]
    || d.metadata.labels?.['argocd.argoproj.io/instance'] || null,
});

const svcSummary = (s) => ({
  name: s.metadata.name,
  namespace: s.metadata.namespace,
  type: s.spec?.type,
  clusterIP: s.spec?.clusterIP,
  external:
    (s.status?.loadBalancer?.ingress || []).map((i) => i.ip || i.hostname).join(', ') ||
    (s.spec?.externalIPs || []).join(', ') || '-',
  ports: (s.spec?.ports || [])
    .map((p) => `${p.port}${p.nodePort ? ':' + p.nodePort : ''}/${p.protocol}`)
    .join(', '),
  created: age(s.metadata.creationTimestamp),
});

const ingSummary = (i) => ({
  name: i.metadata.name,
  namespace: i.metadata.namespace,
  className: i.spec?.ingressClassName || '-',
  hosts: (i.spec?.rules || []).map((r) => r.host).filter(Boolean).join(', ') || '*',
  address: (i.status?.loadBalancer?.ingress || []).map((x) => x.ip || x.hostname).join(', ') || '-',
  created: age(i.metadata.creationTimestamp),
});

const evSummary = (e) => ({
  type: e.type,
  reason: e.reason,
  object: `${e.involvedObject?.kind}/${e.involvedObject?.name}`,
  message: e.message,
  count: e.count || 1,
  last: age(e.lastTimestamp || e.eventTime || e.metadata?.creationTimestamp),
});

const nodeSummary = (n) => {
  const ready = (n.status?.conditions || []).find((c) => c.type === 'Ready');
  const roles = Object.keys(n.metadata.labels || {})
    .filter((l) => l.startsWith('node-role.kubernetes.io/'))
    .map((l) => l.split('/')[1]);
  return {
    name: n.metadata.name,
    status: ready?.status === 'True' ? 'Ready' : 'NotReady',
    roles: roles.join(', ') || 'worker',
    version: n.status?.nodeInfo?.kubeletVersion,
    cpu: n.status?.capacity?.cpu,
    memory: n.status?.capacity?.memory,
    created: age(n.metadata.creationTimestamp),
  };
};

// "all" namespace => cluster-wide list
const nsList = (ns, nsFn, allFn) => (ns === '_all' ? allFn() : nsFn({ namespace: ns }));

function errMsg(e) {
  const body = e?.body;
  try {
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    if (parsed?.message) return parsed.message;
  } catch { /* ignore */ }
  return e?.message || String(e);
}

// ---------- app ----------
const APP_ID = 'uz.az.anchor.k8s';
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => { res.setHeader('X-App', APP_ID); next(); });
app.use(express.json());
app.use(express.static(path.join(import.meta.dirname, 'public')));

const route = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    // key: i18n key the UI translates (uz/ru/en); error: English fallback
    res.status(e?.code && e.code >= 400 && e.code < 600 ? e.code : 500).json({ error: errMsg(e), key: e?.key });
  }
};

if (DEMO) {
  demo(app);
} else {
  app.get('/api/info', route(async () => {
    const ctx = kc.getContextObject(kc.getCurrentContext());
    const cluster = kc.getCluster(ctx?.cluster);
    let version = null;
    try { version = (await api.version.getCode()).gitVersion; } catch { /* unreachable */ }
    return {
      demo: false,
      kubeconfig: kcPath,
      currentContext: kc.getCurrentContext(),
      contexts: kc.getContexts().map((c) => ({ name: c.name, cluster: c.cluster, user: c.user, namespace: c.namespace })),
      server: cluster?.server,
      defaultNamespace: ctx?.namespace || 'default',
      version,
    };
  }));

  app.post('/api/context', route(async (req) => {
    loadClients(req.body.name);
    return { ok: true, currentContext: kc.getCurrentContext() };
  }));

  app.get('/api/namespaces', route(async () =>
    (await api.core.listNamespace()).items.map((n) => ({ name: n.metadata.name, status: n.status?.phase }))));

  app.get('/api/nodes', route(async () => (await api.core.listNode()).items.map(nodeSummary)));

  app.get('/api/:ns/pods', route(async (req) =>
    (await nsList(req.params.ns, (a) => api.core.listNamespacedPod(a), () => api.core.listPodForAllNamespaces())).items.map(podSummary)));

  app.get('/api/:ns/deployments', route(async (req) =>
    (await nsList(req.params.ns, (a) => api.apps.listNamespacedDeployment(a), () => api.apps.listDeploymentForAllNamespaces())).items.map(deploySummary)));

  app.get('/api/:ns/services', route(async (req) =>
    (await nsList(req.params.ns, (a) => api.core.listNamespacedService(a), () => api.core.listServiceForAllNamespaces())).items.map(svcSummary)));

  app.get('/api/:ns/ingresses', route(async (req) =>
    (await nsList(req.params.ns, (a) => api.net.listNamespacedIngress(a), () => api.net.listIngressForAllNamespaces())).items.map(ingSummary)));

  app.get('/api/:ns/events', route(async (req) =>
    (await nsList(req.params.ns, (a) => api.core.listNamespacedEvent(a), () => api.core.listEventForAllNamespaces())).items
      .map(evSummary).sort((a, b) => (b.last || '').localeCompare(a.last || '')).slice(0, 200)));

  app.get('/api/:ns/pods/:name/logs', route(async (req) => {
    const text = await api.core.readNamespacedPodLog({
      namespace: req.params.ns,
      name: req.params.name,
      container: req.query.container || undefined,
      tailLines: Math.min(Math.max(Number(req.query.tail) || 500, 1), 100000),
      timestamps: req.query.timestamps === '1',
      previous: req.query.previous === '1',
    });
    return { text };
  }));

  app.get('/api/:ns/pods/:name/yaml', route(async (req) =>
    ({ text: k8s.dumpYaml(await api.core.readNamespacedPod({ namespace: req.params.ns, name: req.params.name })) })));

  app.get('/api/:ns/deployments/:name/yaml', route(async (req) =>
    ({ text: k8s.dumpYaml(await api.apps.readNamespacedDeployment({ namespace: req.params.ns, name: req.params.name })) })));

  app.delete('/api/:ns/pods/:name', route(async (req) => {
    await api.core.deleteNamespacedPod({ namespace: req.params.ns, name: req.params.name });
    return { ok: true };
  }));

  // "restart" a pod = delete it and let its controller (ReplicaSet/StatefulSet/DaemonSet/Job) recreate it
  app.post('/api/:ns/pods/:name/restart', route(async (req) => {
    const { ns, name } = req.params;
    const pod = await api.core.readNamespacedPod({ namespace: ns, name });
    if (!(pod.metadata?.ownerReferences || []).some((o) => o.controller)) {
      throw Object.assign(new Error('Pod has no controller: it would not be recreated'), { code: 400, key: 'no_controller' });
    }
    await api.core.deleteNamespacedPod({ namespace: ns, name });
    return { ok: true };
  }));

  app.post('/api/:ns/deployments/:name/scale', route(async (req) => {
    const replicas = Number(req.body.replicas);
    if (!Number.isInteger(replicas) || replicas < 0) throw Object.assign(new Error('Invalid replica count'), { code: 400, key: 'bad_replicas' });
    await api.apps.patchNamespacedDeploymentScale(
      { namespace: req.params.ns, name: req.params.name, body: { spec: { replicas } } },
      k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch),
    );
    return { ok: true };
  }));

  app.post('/api/:ns/deployments/:name/restart', route(async (req) => {
    await api.apps.patchNamespacedDeployment(
      {
        namespace: req.params.ns,
        name: req.params.name,
        body: { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } } },
      },
      k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch),
    );
    return { ok: true };
  }));
}

app.listen(PORT, HOST, (err) => {
  // Express 5 passes listen errors (e.g. EADDRINUSE) to this callback instead of throwing
  if (err) {
    console.error(err.code === 'EADDRINUSE'
      ? `Port ${PORT} is already in use. Start on another port:  PORT=3000 node server.js ...`
      : `Failed to start the server: ${err.message}`);
    process.exit(1);
  }
  console.log(`\n  ⚓ Anchor K8s (${APP_ID}):  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(DEMO ? '  Mode: DEMO (fake data)\n' : `  Kubeconfig: ${kcPath}\n  Context: ${kc.getCurrentContext()}\n`);
});
