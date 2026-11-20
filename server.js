import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import tls from 'node:tls';
import * as k8s from '@kubernetes/client-node';
import { demo } from './demo.js';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1'; // only local by default: kubeconfig = cluster access
const DEMO = process.env.DEMO === '1';

// ---------- kubeconfig ----------
// Several files can be given, separated by ':' like $KUBECONFIG. They are merged the way kubectl does it:
// the first file that defines a cluster/user/context name wins, and current-context comes from the first
// file that sets one. So every context of every file shows up in the UI's context list.
const expandHome = (p) => path.resolve(p.replace(/^~(?=$|[\\/])/, os.homedir()));
const splitList = (v) => (v ? v.split(path.delimiter).map((p) => p.trim()).filter(Boolean).map(expandHome) : []);

function resolveKubeconfigs() {
  // an explicit list (argument or $KUBECONFIG) is used as is; defaults are only tried when nothing was given
  const explicit = splitList(process.argv[2]).length ? splitList(process.argv[2]) : splitList(process.env.KUBECONFIG);
  if (explicit.length) {
    for (const p of explicit) if (!fs.existsSync(p)) console.warn(`  Kubeconfig skipped (not found): ${p}`);
    return explicit.filter((p) => fs.existsSync(p));
  }
  const def = ['kubeconfig.yaml', 'kubeconfig.yml', path.join(os.homedir(), '.kube', 'config')].map(expandHome);
  const found = def.find((p) => fs.existsSync(p));
  return found ? [found] : [];
}

const kcPaths = DEMO ? [] : resolveKubeconfigs();
if (!DEMO && !kcPaths.length) {
  console.error('Kubeconfig not found. Usage:  node server.js /path/to/kubeconfig.yaml[:/path/to/another.yaml]');
  console.error('Or try it without a cluster:  npm run demo');
  process.exit(1);
}

const contextFile = new Map(); // context name -> file it came from
function loadMerged() {
  const merged = { clusters: [], users: [], contexts: [], currentContext: '' };
  const seen = { clusters: new Set(), users: new Set(), contexts: new Set() };
  contextFile.clear();
  for (const file of kcPaths) {
    const one = new k8s.KubeConfig();
    one.loadFromFile(file); // also makes relative cert/key paths absolute to this file's folder
    for (const kind of ['clusters', 'users', 'contexts']) {
      for (const item of one[kind]) {
        if (seen[kind].has(item.name)) {
          if (kind === 'contexts') console.warn(`  Duplicate context "${item.name}" in ${file} ignored (first one wins)`);
          continue;
        }
        seen[kind].add(item.name);
        merged[kind].push(item);
        if (kind === 'contexts') contextFile.set(item.name, file);
      }
    }
    if (!merged.currentContext && one.currentContext) merged.currentContext = one.currentContext;
  }
  if (!merged.currentContext && merged.contexts[0]) merged.currentContext = merged.contexts[0].name;
  const out = new k8s.KubeConfig();
  out.loadFromOptions(merged);
  return out;
}

let kc;
let api = {};
// files are re-read on every context switch, so kubeconfig edits are picked up without a restart
function loadClients(contextName) {
  const next = loadMerged();
  if (contextName) {
    if (!next.getContextObject(contextName)) throw Object.assign(new Error(`Unknown context: ${contextName}`), { code: 400 });
    next.setCurrentContext(contextName);
  }
  kc = next;
  api = {
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
    batch: kc.makeApiClient(k8s.BatchV1Api),
    net: kc.makeApiClient(k8s.NetworkingV1Api),
    version: kc.makeApiClient(k8s.VersionApi),
    custom: kc.makeApiClient(k8s.CustomObjectsApi),
  };
}
if (!DEMO) loadClients();

// ---------- helpers ----------
const age = (ts) => (ts ? new Date(ts).toISOString() : null);

// Kubernetes quantities -> numbers: CPU in cores, memory in bytes
function cpuCores(q) {
  if (q == null || q === '') return 0;
  const m = /^([0-9.]+)([numk]?)$/.exec(String(q));
  if (!m) return 0;
  const f = { n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, '': 1 }[m[2]];
  return Number(m[1]) * f;
}
function memBytes(q) {
  if (q == null || q === '') return 0;
  const m = /^([0-9.]+(?:e[0-9]+)?)(Ki|Mi|Gi|Ti|Pi|k|K|M|G|T|P|m)?$/.exec(String(q));
  if (!m) return 0;
  const f = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, m: 1e-3 }[m[2]] ?? 1;
  return Number(m[1]) * f;
}
// sum of a resource over all containers; null when any container leaves it unset (= no limit)
function sumRes(containers, field, key, conv) {
  let total = 0;
  for (const c of containers) {
    const v = c.resources?.[field]?.[key];
    if (v == null) return null;
    total += conv(v);
  }
  return containers.length ? total : null;
}
// owning workload: ReplicaSet "api-7c9d5f" -> Deployment "api"
function workloadOf(meta) {
  const o = (meta?.ownerReferences || []).find((r) => r.controller);
  if (!o) return meta?.name;
  return o.kind === 'ReplicaSet' ? o.name.replace(/-[a-z0-9]{5,10}$/, '') : o.name;
}

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
    app: workloadOf(p.metadata),
    // requests / limits summed over containers (cores, bytes); null = not set on some container
    cpuReq: sumRes(p.spec?.containers || [], 'requests', 'cpu', cpuCores),
    cpuLim: sumRes(p.spec?.containers || [], 'limits', 'cpu', cpuCores),
    memReq: sumRes(p.spec?.containers || [], 'requests', 'memory', memBytes),
    memLim: sumRes(p.spec?.containers || [], 'limits', 'memory', memBytes),
    lastTerm: lastTermination(cs),
  };
}

// why the pod restarted last: most recent terminated state across containers (OOMKilled, Error, ...)
function lastTermination(statuses) {
  let best = null;
  for (const c of statuses) {
    const t = c.lastState?.terminated || (c.state?.terminated && c.restartCount ? c.state.terminated : null);
    if (!t) continue;
    const at = age(t.finishedAt || t.startedAt);
    if (!best || (at || '') > (best.at || '')) best = { container: c.name, reason: t.reason || 'Terminated', exitCode: t.exitCode, at };
  }
  return best;
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

const images = (tpl) => (tpl?.spec?.containers || []).map((c) => c.image);
const stsSummary = (d) => ({
  name: d.metadata.name, namespace: d.metadata.namespace,
  replicas: d.spec?.replicas ?? 0, ready: d.status?.readyReplicas ?? 0,
  images: images(d.spec?.template), created: age(d.metadata.creationTimestamp),
});
const dsSummary = (d) => ({
  name: d.metadata.name, namespace: d.metadata.namespace,
  desired: d.status?.desiredNumberScheduled ?? 0, ready: d.status?.numberReady ?? 0,
  images: images(d.spec?.template), created: age(d.metadata.creationTimestamp),
});
const jobSummary = (j) => {
  const st = j.status || {};
  const failed = (st.conditions || []).some((c) => c.type === 'Failed' && c.status === 'True');
  const done = (st.conditions || []).some((c) => c.type === 'Complete' && c.status === 'True');
  const end = st.completionTime ? new Date(st.completionTime) : new Date();
  return {
    name: j.metadata.name, namespace: j.metadata.namespace,
    status: failed ? 'Failed' : done ? 'Completed' : st.active ? 'Running' : 'Pending',
    completions: `${st.succeeded || 0}/${j.spec?.completions ?? 1}`,
    duration: st.startTime ? Math.round((end - new Date(st.startTime)) / 1000) : null,
    created: age(j.metadata.creationTimestamp),
  };
};
const cronSummary = (c) => ({
  name: c.metadata.name, namespace: c.metadata.namespace,
  schedule: c.spec?.schedule, suspend: !!c.spec?.suspend,
  active: (c.status?.active || []).length, lastRun: age(c.status?.lastScheduleTime),
  created: age(c.metadata.creationTimestamp),
});
const cmSummary = (c) => {
  const keys = [...Object.keys(c.data || {}), ...Object.keys(c.binaryData || {})];
  return { name: c.metadata.name, namespace: c.metadata.namespace, keys: keys.length, keyNames: keys.join(', '), created: age(c.metadata.creationTimestamp) };
};
const pvcSummary = (v) => ({
  name: v.metadata.name, namespace: v.metadata.namespace,
  status: v.status?.phase, capacity: v.status?.capacity?.storage || v.spec?.resources?.requests?.storage || '-',
  storageClass: v.spec?.storageClassName || '-', access: (v.spec?.accessModes || []).join(', '),
  volume: v.spec?.volumeName || '-', created: age(v.metadata.creationTimestamp),
});

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

// liveness for start.sh: answers without touching the cluster
app.get('/api/health', (req, res) => res.json({ ok: true, app: APP_ID }));

// ---------- HTTP probe (nginx / any URL), used by the Nginx tab ----------
// TLS details come from a separate handshake so expiry is shown even when the certificate is invalid.
function tlsInfo(host, port) {
  return new Promise((resolve) => {
    const isIp = /^[0-9.]+$|:/.test(host);
    const sock = tls.connect({ host, port, servername: isIp ? undefined : host, rejectUnauthorized: false, timeout: 5000 }, () => {
      const c = sock.getPeerCertificate();
      resolve(c && c.valid_to ? {
        validTo: new Date(c.valid_to).toISOString(), subject: c.subject?.CN || '', issuer: c.issuer?.O || c.issuer?.CN || '',
        authorized: sock.authorized, error: sock.authorized ? null : String(sock.authorizationError || ''),
      } : null);
      sock.end();
    });
    sock.on('timeout', () => { sock.destroy(); resolve(null); });
    sock.on('error', () => resolve(null));
  });
}
async function probe(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw Object.assign(new Error('Invalid URL'), { code: 400 }); }
  if (!/^https?:$/.test(url.protocol)) throw Object.assign(new Error('Only http and https URLs'), { code: 400 });
  const out = { url: url.href, at: new Date().toISOString(), up: false, status: null, ms: null, server: null, error: null, tls: null, stub: null };
  const tlsP = url.protocol === 'https:' ? tlsInfo(url.hostname, Number(url.port) || 443) : Promise.resolve(null);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'manual', headers: { 'User-Agent': 'anchor-k8s-probe' } });
    out.ms = Date.now() - t0;
    out.status = r.status;
    out.server = r.headers.get('server');
    out.up = r.status < 500;
    const body = (await r.text()).slice(0, 65536);
    // nginx stub_status page
    const m = /Active connections:\s*(\d+)\s*\n\s*server accepts handled requests\s*\n\s*(\d+)\s+(\d+)\s+(\d+)\s*\n\s*Reading:\s*(\d+)\s*Writing:\s*(\d+)\s*Waiting:\s*(\d+)/.exec(body);
    if (m) out.stub = { active: +m[1], accepts: +m[2], handled: +m[3], requests: +m[4], reading: +m[5], writing: +m[6], waiting: +m[7] };
  } catch (e) {
    out.ms = Date.now() - t0;
    out.error = e.name === 'TimeoutError' ? 'timeout' : e.cause?.code || e.cause?.message || e.message;
  }
  out.tls = await tlsP;
  return out;
}

const route = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    // key: i18n key the UI translates (uz/ru/en); error: English fallback
    res.status(e?.code && e.code >= 400 && e.code < 600 ? e.code : 500).json({ error: errMsg(e), key: e?.key });
  }
};

app.post('/api/probe', route(async (req) => probe(String(req.body?.url || ''))));

if (DEMO) {
  demo(app);
} else {
  app.get('/api/info', route(async () => {
    const ctx = kc.getContextObject(kc.getCurrentContext());
    const cluster = kc.getCluster(ctx?.cluster);
    let version = null;
    // capped so an unreachable cluster (VPN down, tunnel closed) doesn't hang the page load
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000));
    try { version = (await Promise.race([api.version.getCode(), timeout])).gitVersion; } catch { /* unreachable */ }
    return {
      demo: false,
      kubeconfig: kcPaths.join(', '),
      currentContext: kc.getCurrentContext(),
      contexts: kc.getContexts().map((c) => ({ name: c.name, cluster: c.cluster, user: c.user, namespace: c.namespace, file: contextFile.get(c.name) })),
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

  // metrics-server (metrics.k8s.io): current usage. /api/nodes/metrics must come before /api/:ns/metrics
  app.get('/api/nodes/metrics', route(async () =>
    (await api.custom.listClusterCustomObject({ group: 'metrics.k8s.io', version: 'v1beta1', plural: 'nodes' })).items
      .map((n) => ({ name: n.metadata.name, cpu: cpuCores(n.usage?.cpu), memory: memBytes(n.usage?.memory) }))));

  app.get('/api/:ns/metrics', route(async (req) => {
    const q = { group: 'metrics.k8s.io', version: 'v1beta1', plural: 'pods' };
    const r = req.params.ns === '_all'
      ? await api.custom.listClusterCustomObject(q)
      : await api.custom.listNamespacedCustomObject({ ...q, namespace: req.params.ns });
    return r.items.map((p) => ({
      name: p.metadata.name, namespace: p.metadata.namespace,
      cpu: (p.containers || []).reduce((a, c) => a + cpuCores(c.usage?.cpu), 0),
      memory: (p.containers || []).reduce((a, c) => a + memBytes(c.usage?.memory), 0),
    }));
  }));

  // extra resource kinds, loaded only while their tab is open
  const EXTRA = {
    statefulsets: [(a) => api.apps.listNamespacedStatefulSet(a), () => api.apps.listStatefulSetForAllNamespaces(), stsSummary, (a) => api.apps.readNamespacedStatefulSet(a)],
    daemonsets: [(a) => api.apps.listNamespacedDaemonSet(a), () => api.apps.listDaemonSetForAllNamespaces(), dsSummary, (a) => api.apps.readNamespacedDaemonSet(a)],
    jobs: [(a) => api.batch.listNamespacedJob(a), () => api.batch.listJobForAllNamespaces(), jobSummary, (a) => api.batch.readNamespacedJob(a)],
    cronjobs: [(a) => api.batch.listNamespacedCronJob(a), () => api.batch.listCronJobForAllNamespaces(), cronSummary, (a) => api.batch.readNamespacedCronJob(a)],
    configmaps: [(a) => api.core.listNamespacedConfigMap(a), () => api.core.listConfigMapForAllNamespaces(), cmSummary, (a) => api.core.readNamespacedConfigMap(a)],
    pvcs: [(a) => api.core.listNamespacedPersistentVolumeClaim(a), () => api.core.listPersistentVolumeClaimForAllNamespaces(), pvcSummary, (a) => api.core.readNamespacedPersistentVolumeClaim(a)],
  };
  for (const [kind, [nsFn, allFn, summary]] of Object.entries(EXTRA)) {
    app.get(`/api/:ns/${kind}`, route(async (req) => (await nsList(req.params.ns, nsFn, allFn)).items.map(summary)));
  }

  // rollout history: the deployment's ReplicaSets, newest revision first
  app.get('/api/:ns/deployments/:name/history', route(async (req) => {
    const { ns, name } = req.params;
    const dep = await api.apps.readNamespacedDeployment({ namespace: ns, name });
    const sel = Object.entries(dep.spec?.selector?.matchLabels || {}).map(([k, v]) => `${k}=${v}`).join(',');
    const rss = (await api.apps.listNamespacedReplicaSet({ namespace: ns, labelSelector: sel || undefined })).items
      .filter((rs) => (rs.metadata.ownerReferences || []).some((o) => o.uid === dep.metadata.uid));
    const current = dep.metadata.annotations?.['deployment.kubernetes.io/revision'];
    return rss.map((rs) => ({
      revision: Number(rs.metadata.annotations?.['deployment.kubernetes.io/revision'] || 0),
      name: rs.metadata.name,
      images: images(rs.spec?.template),
      replicas: rs.status?.replicas ?? 0,
      ready: rs.status?.readyReplicas ?? 0,
      cause: rs.metadata.annotations?.['kubernetes.io/change-cause'] || '',
      created: age(rs.metadata.creationTimestamp),
      current: String(rs.metadata.annotations?.['deployment.kubernetes.io/revision']) === String(current),
    })).sort((a, b) => b.revision - a.revision);
  }));


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

  // YAML of the extra kinds
  app.get('/api/:ns/:kind/:name/yaml', route(async (req) => {
    const e = EXTRA[req.params.kind];
    if (!e) throw Object.assign(new Error('Unknown kind'), { code: 404 });
    return { text: k8s.dumpYaml(await e[3]({ namespace: req.params.ns, name: req.params.name })) };
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
  console.log(DEMO ? '  Mode: DEMO (fake data)\n' : `  Kubeconfig: ${kcPaths.join(', ')}\n  Contexts: ${kc.getContexts().length} (current: ${kc.getCurrentContext()})\n`);
});
