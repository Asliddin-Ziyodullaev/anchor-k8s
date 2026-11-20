// Fake data so the UI can be tried without a cluster:  npm run demo
const now = Date.now();
const ago = (min) => new Date(now - min * 60000).toISOString();

const namespaces = ['default', 'apps-dev', 'apps-staging', 'monitoring', 'ingress-nginx', 'kube-system'];

const deployments = [
  ['apps-dev', 'web-gateway', 3, 3, 'registry.local/apps/gateway:1.14.2'],
  ['apps-dev', 'auth-service', 2, 2, 'registry.local/apps/auth:2.3.0'],
  ['apps-dev', 'orders-service', 2, 1, 'registry.local/apps/orders:0.9.7'],
  ['apps-dev', 'notification-worker', 1, 1, 'registry.local/apps/notify:1.2.1'],
  ['apps-dev', 'search-service', 2, 0, 'registry.local/apps/search:3.0.0-rc1'],
  ['apps-staging', 'web-frontend', 2, 2, 'registry.local/apps/frontend:5.1.0'],
  ['apps-staging', 'admin-panel', 2, 2, 'registry.local/apps/admin:2.0.4'],
  ['monitoring', 'grafana', 1, 1, 'grafana/grafana:11.2.0'],
  ['monitoring', 'prometheus-server', 1, 1, 'prom/prometheus:v2.54.1'],
  ['ingress-nginx', 'ingress-nginx-controller', 2, 2, 'registry.k8s.io/ingress-nginx/controller:v1.11.2'],
  ['kube-system', 'coredns', 2, 2, 'registry.k8s.io/coredns/coredns:v1.11.1'],
].map(([namespace, name, replicas, ready, image], i) => ({
  namespace, name, replicas, ready, updated: replicas, available: ready, images: [image], created: ago(60 * 24 * (i + 2)),
  argocd: namespace.startsWith('apps') ? name : null,
}));

const nodes = ['dev-master-01', 'dev-worker-01', 'dev-worker-02', 'dev-worker-03'];
const rnd = (s) => Math.abs([...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7));

let pods = [];
for (const d of deployments) {
  for (let i = 0; i < Math.max(d.replicas, 1); i++) {
    const h = rnd(d.name + ':' + i * 7919);
    const suffix = h.toString(36).slice(0, 5);
    let status = i < d.ready ? 'Running' : (d.name === 'search-service' ? 'CrashLoopBackOff' : 'Pending');
    if (d.replicas === 0) status = 'Completed';
    pods.push({
      name: `${d.name}-${rnd(d.name).toString(36).slice(0, 9)}-${suffix}${i}`,
      namespace: d.namespace,
      status,
      ready: status === 'Running' ? '1/1' : '0/1',
      restarts: status === 'CrashLoopBackOff' ? 14 + i : h % 3,
      node: status === 'Pending' ? '-' : nodes[1 + (h % 3)],
      ip: status === 'Pending' ? '-' : `10.244.${h % 4}.${h % 250}`,
      created: ago((h % 3000) + 5),
      owner: 'ReplicaSet',
      containers: [d.name],
      images: d.images,
      app: d.name,
      cpuReq: d.name.includes('gateway') ? 0.25 : null,
      cpuLim: null,
      memReq: d.name.includes('gateway') ? 256 * 2 ** 20 : null,
      memLim: d.name === 'grafana' ? 512 * 2 ** 20 : null,
      lastTerm: status === 'CrashLoopBackOff' ? { container: d.name, reason: 'Error', exitCode: 1, at: ago(2) }
        : d.name === 'orders-service' && i === 0 ? { container: d.name, reason: 'OOMKilled', exitCode: 137, at: ago(40) } : null,
    });
  }
}

// steady per-pod baseline + noise, so the Resources tab and its trend lines have something to show
const baseMem = (p) => (64 + (rnd(p.name) % 900)) * 2 ** 20;
const baseCpu = (p) => ((rnd(p.name) % 400) + 5) / 1000;
let tick = 0;

const statefulsets = [
  { namespace: 'apps-dev', name: 'redis', replicas: 3, ready: 3, images: ['redis:7.2-alpine'], created: ago(60 * 24 * 30) },
  { namespace: 'monitoring', name: 'loki', replicas: 1, ready: 1, images: ['grafana/loki:3.1.0'], created: ago(60 * 24 * 20) },
];
const daemonsets = [
  { namespace: 'monitoring', name: 'node-exporter', desired: 4, ready: 4, images: ['prom/node-exporter:v1.8.2'], created: ago(60 * 24 * 90) },
];
const jobs = [
  { namespace: 'apps-dev', name: 'db-migrate-1131', status: 'Completed', completions: '1/1', duration: 42, created: ago(300) },
  { namespace: 'apps-dev', name: 'report-export-28801', status: 'Failed', completions: '0/1', duration: 610, created: ago(90) },
];
const cronjobs = [
  { namespace: 'apps-dev', name: 'report-export', schedule: '0 */6 * * *', suspend: false, active: 0, lastRun: ago(90), created: ago(60 * 24 * 40) },
];
const configmaps = deployments.filter((d) => d.namespace === 'apps-dev').map((d) => ({
  namespace: d.namespace, name: d.name + '-config', keys: 2, keyNames: 'application.yml, logback.xml', created: d.created,
}));
const pvcs = [
  { namespace: 'apps-dev', name: 'data-redis-0', status: 'Bound', capacity: '8Gi', storageClass: 'longhorn', access: 'ReadWriteOnce', volume: 'pvc-1f2e', created: ago(60 * 24 * 30) },
  { namespace: 'monitoring', name: 'storage-loki-0', status: 'Bound', capacity: '50Gi', storageClass: 'longhorn', access: 'ReadWriteOnce', volume: 'pvc-9a8b', created: ago(60 * 24 * 20) },
];

const services = deployments.map((d, i) => ({
  namespace: d.namespace,
  name: d.name,
  type: d.name.includes('ingress') ? 'LoadBalancer' : 'ClusterIP',
  clusterIP: `10.96.${i}.${10 + i * 7}`,
  external: d.name.includes('ingress') ? '192.168.10.50' : '-',
  ports: d.name.includes('ingress') ? '80:30080/TCP, 443:30443/TCP' : '8080/TCP',
  created: d.created,
}));

const ingresses = [
  { namespace: 'apps-dev', name: 'web-gateway', className: 'nginx', hosts: 'api-dev.example.local', address: '192.168.10.50', created: ago(9000) },
  { namespace: 'apps-staging', name: 'frontend', className: 'nginx', hosts: 'app-staging.example.local', address: '192.168.10.50', created: ago(8000) },
  { namespace: 'monitoring', name: 'grafana', className: 'nginx', hosts: 'grafana-dev.example.local', address: '192.168.10.50', created: ago(20000) },
];

const events = [
  { namespace: 'apps-dev', type: 'Warning', reason: 'BackOff', object: 'Pod/' + pods.find((p) => p.status === 'CrashLoopBackOff')?.name, message: 'Back-off restarting failed container search-service', count: 87, last: ago(1) },
  { namespace: 'apps-dev', type: 'Warning', reason: 'FailedScheduling', object: 'Pod/' + pods.find((p) => p.status === 'Pending')?.name, message: '0/4 nodes are available: 3 Insufficient memory, 1 node(s) had untolerated taint.', count: 12, last: ago(3) },
  { namespace: 'apps-dev', type: 'Normal', reason: 'ScalingReplicaSet', object: 'Deployment/orders-service', message: 'Scaled up replica set orders-service-7c9d to 2', count: 1, last: ago(4) },
  { namespace: 'apps-dev', type: 'Normal', reason: 'Pulled', object: 'Pod/' + pods[0].name, message: 'Container image "registry.local/apps/gateway:1.14.2" already present on machine', count: 1, last: ago(25) },
  { namespace: 'monitoring', type: 'Normal', reason: 'Started', object: 'Pod/' + pods.find((p) => p.namespace === 'monitoring').name, message: 'Started container grafana', count: 1, last: ago(60) },
];

const byNs = (arr, ns) => (ns === '_all' ? arr : arr.filter((x) => x.namespace === ns));

const logText = (pod) => {
  if (pod.status === 'CrashLoopBackOff') {
    return [
      '2026-11-20T05:01:12.331Z INFO  Starting search-service v3.0.0-rc1',
      '2026-11-20T05:01:12.902Z INFO  Loading config from /etc/config/application.yml',
      '2026-11-20T05:01:13.118Z WARN  DB_POOL_SIZE not set, using default 10',
      '2026-11-20T05:01:14.507Z ERROR Failed to connect to postgres://search-db:5432 - connection refused',
      '2026-11-20T05:01:14.508Z ERROR Application startup failed',
      'Exception in thread "main" java.net.ConnectException: Connection refused',
      '    at org.postgresql.core.v3.ConnectionFactoryImpl.openConnectionImpl(ConnectionFactoryImpl.java:319)',
    ].join('\n');
  }
  const lines = [];
  for (let i = 40; i > 0; i--) {
    const t = new Date(now - i * 4000).toISOString();
    const path = ['/api/v1/orders', '/api/v1/products', '/health', '/api/v1/search', '/api/v1/users'][i % 5];
    lines.push(`${t} INFO  ${['GET', 'POST'][i % 2]} ${path} ${i % 11 === 0 ? 500 : 200} ${(i * 7) % 90 + 3}ms`);
  }
  return lines.join('\n');
};

export function demo(app) {
  let currentContext = 'dev-cluster-apps';
  const contexts = [
    { name: 'dev-cluster-apps', cluster: 'dev-cluster', user: 'demo-user', namespace: 'apps-dev' },
    { name: 'dev-cluster-admin', cluster: 'dev-cluster', user: 'admin', namespace: 'default' },
  ];

  app.get('/api/info', (req, res) => res.json({
    demo: true,
    kubeconfig: '(demo)',
    currentContext,
    contexts,
    server: 'https://10.0.0.10:6443',
    defaultNamespace: contexts.find((c) => c.name === currentContext)?.namespace || 'default',
    version: 'v1.30.4',
  }));
  app.post('/api/context', (req, res) => { currentContext = req.body.name; res.json({ ok: true, currentContext }); });
  app.get('/api/namespaces', (req, res) => res.json(namespaces.map((name) => ({ name, status: 'Active' }))));
  app.get('/api/nodes', (req, res) => res.json(nodes.map((name, i) => ({
    name, status: 'Ready', roles: i === 0 ? 'control-plane' : 'worker', version: 'v1.30.4', cpu: i === 0 ? '4' : '8', memory: i === 0 ? '8Gi' : '32Gi', created: ago(60 * 24 * 120),
  }))));
  app.get('/api/nodes/metrics', (req, res) => res.status(403).json({ error: 'nodes.metrics.k8s.io is forbidden: User "system:serviceaccount:dev:mobile-dev" cannot list resource "nodes"' }));
  app.get('/api/:ns/metrics', (req, res) => {
    tick++;
    res.json(byNs(pods, req.params.ns).filter((p) => p.status === 'Running').map((p) => ({
      name: p.name, namespace: p.namespace,
      cpu: baseCpu(p) * (0.6 + Math.random() * 0.8),
      // orders-service slowly "leaks" so its trend line climbs
      memory: baseMem(p) * (p.name.startsWith('orders') ? 1 + tick * 0.03 : 0.95 + Math.random() * 0.1),
    })));
  });
  app.get('/api/:ns/statefulsets', (req, res) => res.json(byNs(statefulsets, req.params.ns)));
  app.get('/api/:ns/daemonsets', (req, res) => res.json(byNs(daemonsets, req.params.ns)));
  app.get('/api/:ns/jobs', (req, res) => res.json(byNs(jobs, req.params.ns)));
  app.get('/api/:ns/cronjobs', (req, res) => res.json(byNs(cronjobs, req.params.ns)));
  app.get('/api/:ns/configmaps', (req, res) => res.json(byNs(configmaps, req.params.ns)));
  app.get('/api/:ns/pvcs', (req, res) => res.json(byNs(pvcs, req.params.ns)));
  app.get('/api/:ns/deployments/:name/history', (req, res) => {
    const d = deployments.find((x) => x.name === req.params.name);
    if (!d) return res.status(404).json({ error: 'not found' });
    const tag = d.images[0].split(':').pop();
    const prev = tag.replace(/(\d+)(?!.*\d)/, (m) => Math.max(0, Number(m) - 1));
    res.json([
      { revision: 7, name: `${d.name}-7c9d5f`, images: d.images, replicas: d.replicas, ready: d.ready, cause: '', created: ago(60 * 26), current: true },
      { revision: 6, name: `${d.name}-5b8a21`, images: [d.images[0].replace(tag, prev)], replicas: 0, ready: 0, cause: '', created: ago(60 * 24 * 6), current: false },
      { revision: 5, name: `${d.name}-49f0c3`, images: [d.images[0].replace(tag, prev + '-rc1')], replicas: 0, ready: 0, cause: '', created: ago(60 * 24 * 14), current: false },
    ]);
  });
  app.get('/api/:ns/pods', (req, res) => res.json(byNs(pods, req.params.ns)));
  app.get('/api/:ns/deployments', (req, res) => res.json(byNs(deployments, req.params.ns)));
  app.get('/api/:ns/services', (req, res) => res.json(byNs(services, req.params.ns)));
  app.get('/api/:ns/ingresses', (req, res) => res.json(byNs(ingresses, req.params.ns)));
  app.get('/api/:ns/events', (req, res) => res.json(byNs(events, req.params.ns)));
  app.get('/api/:ns/pods/:name/logs', (req, res) => {
    const p = pods.find((x) => x.name === req.params.name);
    if (!p) return res.json({ text: '' });
    const ts = req.query.timestamps === '1';
    // a few fresh lines each call so refresh visibly brings new logs
    const extra = p.status === 'Running' ? Array.from({ length: 3 }, (_, i) => `${new Date(Date.now() - (2 - i) * 1000).toISOString()} INFO  GET /api/v1/health 200 ${3 + i}ms`) : [];
    const lines = [...logText(p).split('\n'), ...extra].slice(-Number(req.query.tail || 500));
    res.json({ text: lines.map((l) => (ts ? l : l.replace(/^\S+ /, ''))).join('\n') });
  });
  const yaml = (kind, o) => `apiVersion: ${kind === 'Pod' ? 'v1' : 'apps/v1'}\nkind: ${kind}\nmetadata:\n  name: ${o.name}\n  namespace: ${o.namespace}\nspec:\n  containers:\n${o.images.map((im) => `    - image: ${im}`).join('\n')}\n`;
  app.get('/api/:ns/pods/:name/yaml', (req, res) => res.json({ text: yaml('Pod', pods.find((x) => x.name === req.params.name) || { name: '?', namespace: '?', images: [] }) }));
  app.get('/api/:ns/deployments/:name/yaml', (req, res) => res.json({ text: yaml('Deployment', deployments.find((x) => x.name === req.params.name) || { name: '?', namespace: '?', images: [] }) }));
  app.get('/api/:ns/:kind/:name/yaml', (req, res) => res.json({ text: `kind: ${req.params.kind}\nmetadata:\n  name: ${req.params.name}\n  namespace: ${req.params.ns}\n# (demo)\n` }));
  app.delete('/api/:ns/pods/:name', (req, res) => {
    pods = pods.map((p) => (p.name === req.params.name ? { ...p, status: 'Terminating' } : p));
    res.json({ ok: true });
  });
  app.post('/api/:ns/pods/:name/restart', (req, res) => {
    const p = pods.find((x) => x.name === req.params.name && x.namespace === req.params.ns);
    if (!p) return res.status(404).json({ error: 'pod not found' });
    const suffix = Math.random().toString(36).slice(2, 7);
    pods = pods.map((x) => (x === p ? { ...p, name: p.name.replace(/-[^-]+$/, '-' + suffix), status: 'ContainerCreating', ready: '0/1', restarts: 0, created: new Date().toISOString() } : x));
    res.json({ ok: true });
  });
  app.post('/api/:ns/deployments/:name/scale', (req, res) => {
    const d = deployments.find((x) => x.name === req.params.name && x.namespace === req.params.ns);
    if (d) { d.replicas = Number(req.body.replicas); d.ready = Math.min(d.ready, d.replicas); }
    res.json({ ok: true });
  });
  app.post('/api/:ns/deployments/:name/restart', (req, res) => {
    const t = new Date().toISOString();
    pods = pods.map((p) => (p.namespace === req.params.ns && p.name.startsWith(req.params.name + '-') ? { ...p, created: t, restarts: 0 } : p));
    res.json({ ok: true });
  });
}
