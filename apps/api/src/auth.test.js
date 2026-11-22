import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, parseCookies, sessionKey, validCredentials } from './auth.js';
import { packSeats } from './seats.js';

test('argon2id hash verifies the right password only, with a fresh salt each time', async () => {
  const h = await hashPassword('correct horse');
  assert.match(h, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.equal(await verifyPassword('correct horse', h), true);
  assert.equal(await verifyPassword('wrong horse', h), false);
  assert.notEqual(await hashPassword('correct horse'), h);
});

test('cookies, session keys and credential checks', () => {
  assert.deepEqual(parseCookies('a=%zz; sid=x-y_z'), { a: '%zz', sid: 'x-y_z' });
  assert.equal(validCredentials({ email: 'a\u0000@b.c', password: '12345678' }), false);
  assert.deepEqual(parseCookies(undefined), {});
  assert.notEqual(sessionKey('t'), 'sess:t');
  assert.equal(validCredentials({ email: 'a@b.c', password: '12345678' }), true);
  assert.equal(validCredentials({ email: 'nope', password: '12345678' }), false);
  assert.equal(validCredentials({ email: 'a@b.c', password: 'short' }), false);
  assert.equal(validCredentials(null), false);
});

test('an expired hold shows as available on the seat map', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const rows = [
    { seat_id: 1, section: 'A', row: 1, number: 1, price_cents: 100, status: 'available', held_until: null },
    { seat_id: 2, section: 'A', row: 1, number: 2, price_cents: 100, status: 'held', held_until: new Date(now + 1000) },
    { seat_id: 3, section: 'A', row: 1, number: 3, price_cents: 100, status: 'held', held_until: new Date(now - 1000) },
    { seat_id: 4, section: 'A', row: 1, number: 4, price_cents: 100, status: 'sold', held_until: null },
    { seat_id: 5, section: 'A', row: 1, number: 5, price_cents: 100, status: 'held', held_until: null },
  ];
  assert.deepEqual(packSeats(rows, now).map((s) => s[5]), [0, 1, 0, 2, 1]);
});
