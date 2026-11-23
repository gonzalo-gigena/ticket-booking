import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHold, MAX_PER_HOLD } from './holds.js';

test('hold requests: seats or a GA quantity, within the per-hold limit', () => {
  assert.deepEqual(parseHold({ event_id: 1, seat_ids: [3, 1] }), { eventId: 1, seatIds: [3, 1] });
  assert.deepEqual(parseHold({ event_id: 1, quantity: 2 }), { eventId: 1, quantity: 2 });
  const tooMany = Array.from({ length: MAX_PER_HOLD + 1 }, (_, i) => i + 1);
  for (const bad of [null, {}, { event_id: '1', seat_ids: [1] }, { event_id: 1, seat_ids: [] },
    { event_id: 1, seat_ids: [1, 1] }, { event_id: 1, seat_ids: [0] }, { event_id: 1, seat_ids: [2 ** 31] },
    { event_id: 1, seat_ids: ['1'] }, { event_id: 1, seat_ids: tooMany }, { event_id: 1, seat_ids: [1], quantity: 1 },
    { event_id: 1, quantity: 0 }, { event_id: 1, quantity: MAX_PER_HOLD + 1 }, { event_id: 1, quantity: 1.5 }]) {
    assert.equal(parseHold(bad), null, JSON.stringify(bad));
  }
});
