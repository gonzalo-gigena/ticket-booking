import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://caddy:8080';

export const options = {
  vus: Number(__ENV.VUS || 20),
  duration: __ENV.DURATION || '20s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<300'],
  },
};

export default function () {
  const res = http.get(`${BASE}/api/hello`);
  check(res, { 'status is 200': (r) => r.status === 200 });
}
