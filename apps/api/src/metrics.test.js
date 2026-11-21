import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observe, render } from './metrics.js';

test('histogram buckets are cumulative and counters add up', () => {
  observe('GET /x', 200, 0.003);
  observe('GET /x', 200, 0.2);
  observe('GET /x', 500, 7);
  const text = render();
  assert.match(text, /http_requests_total\{route="GET \/x",status="200"\} 2/);
  assert.match(text, /http_requests_total\{route="GET \/x",status="500"\} 1/);
  assert.match(text, /_bucket\{route="GET \/x",le="0.005"\} 1\n/);
  assert.match(text, /_bucket\{route="GET \/x",le="0.25"\} 2\n/);
  assert.match(text, /_bucket\{route="GET \/x",le="5"\} 2\n/);
  assert.match(text, /_bucket\{route="GET \/x",le="\+Inf"\} 3\n/);
  assert.match(text, /_count\{route="GET \/x"\} 3\n/);
});
