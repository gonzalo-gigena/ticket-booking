// Seat-map page load, navigation start to painted seats: headless Chrome with a throwaway profile, HTTP cache off.
// Runs on the host (Node 22+ and Chrome), against a seeded stack:
//   node infra/loadtest/pageload.mjs http://localhost:8080 30
// CHROME=/path/to/chrome overrides the macOS default. CPU_SLOWDOWN=4 emulates a slower device.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [, , base = 'http://localhost:8080', runs = '30'] = process.argv;
const profile = mkdtempSync(join(tmpdir(), 'pageload-'));
const chrome = spawn(process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,900',
  '--no-first-run', '--disable-background-networking', '--disable-sync', '--use-mock-keychain', 'about:blank',
]);
process.on('exit', () => { // also runs when a write to a closed pipe throws
  chrome.kill();
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
});
const ws = await new Promise((resolve, reject) => {
  chrome.stderr.on('data', (d) => { const m = /ws:\/\/\S+/.exec(d); if (m) resolve(new WebSocket(m[0])); });
  setTimeout(() => reject(new Error('chrome did not start')), 20_000).unref();
});
await new Promise((r) => { ws.onopen = r; });

let seq = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  pending.get(m.id)?.(m);
  pending.delete(m.id);
};
const send = (method, params = {}, sessionId) => new Promise((resolve) => {
  pending.set(++seq, resolve);
  ws.send(JSON.stringify({ id: seq, method, params, sessionId }));
});

const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId: s } } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Network.enable', {}, s);
await send('Network.setCacheDisabled', { cacheDisabled: true }, s);
if (process.env.CPU_SLOWDOWN) await send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.CPU_SLOWDOWN) }, s);
const js = async (expression) =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, s)).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let n = 0;
async function load() {
  await send('Page.navigate', { url: `${base}/?run=${++n}` }, s);
  for (let i = 0; i < 100; i++) {
    await sleep(50);
    const ms = await js(`location.search === '?run=${n}' ? document.querySelector('#map')?.dataset.ms : null`);
    if (ms) return Number(ms);
  }
  throw new Error('seat map never rendered');
}
const summary = (name, a) => {
  a.sort((x, y) => x - y);
  const q = (p) => a[Math.max(0, Math.ceil(a.length * p) - 1)];
  console.log(`${name}: n=${a.length} p50=${q(0.5)} p95=${q(0.95)} max=${a.at(-1)} ms, under 200: ${a.filter((x) => x < 200).length}/${a.length}`);
};

try {
  console.log('first load in a fresh browser:', await load(), 'ms;', await js(`(() => {
    const ms = (x) => Math.round(x);
    const nav = performance.getEntriesByType('navigation')[0];
    const api = performance.getEntriesByType('resource').filter((r) => r.name.includes('/api/seats'))[0];
    return 'html done at ' + ms(nav.responseEnd) + ', seats requested at ' + ms(api.startTime) + ' and received at ' + ms(api.responseEnd) + ' ms';
  })()`));
  const miss = [];
  for (let i = 0; i < Number(runs); i++) { await sleep(1700); miss.push(await load()); }
  summary('cache miss (Postgres)', miss);
  const hit = [];
  for (let i = 0; i < Number(runs); i++) {
    await fetch(`${base}/api/events`);
    await fetch(`${base}/api/seats?event=1`);
    hit.push(await load());
  }
  summary('cache hit (Redis)', hit);

  console.log('rects:', await js("document.querySelectorAll('#map rect').length"));
  console.log('tooltip:', await js("(() => { const r = document.querySelector('#map rect'); r.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); return r.textContent })()"));
  console.log('sign up:', await js(`(async () => {
    const f = document.querySelector('#auth');
    f.email.value = 'ui' + Date.now() + '@example.com';
    f.password.value = 'test-pass-1';
    f.requestSubmit(f.querySelector('button[value=register]'));
    await new Promise((r) => setTimeout(r, 1500));
    return document.querySelector('#account').textContent.trim() + ' | cookie visible to JS: ' + document.cookie.includes('sid=');
  })()`));
  await load();
  await sleep(500);
  console.log('after reload:', await js("document.querySelector('#account').textContent.trim()"));
} finally {
  chrome.kill();
  process.exit();
}
