// ponytail: hand-rolled Prometheus text format (one counter, one histogram). Switch to prom-client when you need gauges or labels beyond route/status.
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
const requests = new Map(); // "route|status" -> count
const durations = new Map(); // route -> { counts: number[], sum, count }

export function observe(route, status, seconds) {
  const key = `${route}|${status}`;
  requests.set(key, (requests.get(key) ?? 0) + 1);

  let h = durations.get(route);
  if (!h) durations.set(route, (h = { counts: BUCKETS.map(() => 0), sum: 0, count: 0 }));
  BUCKETS.forEach((le, i) => { if (seconds <= le) h.counts[i] += 1; });
  h.sum += seconds;
  h.count += 1;
}

export function render() {
  const out = [
    '# TYPE http_requests_total counter',
    ...[...requests].map(([key, n]) => {
      const [route, status] = key.split('|');
      return `http_requests_total{route="${route}",status="${status}"} ${n}`;
    }),
    '# TYPE http_request_duration_seconds histogram',
  ];
  for (const [route, h] of durations) {
    BUCKETS.forEach((le, i) => out.push(`http_request_duration_seconds_bucket{route="${route}",le="${le}"} ${h.counts[i]}`));
    out.push(`http_request_duration_seconds_bucket{route="${route}",le="+Inf"} ${h.count}`);
    out.push(`http_request_duration_seconds_sum{route="${route}"} ${h.sum}`);
    out.push(`http_request_duration_seconds_count{route="${route}"} ${h.count}`);
  }
  return out.join('\n') + '\n';
}
