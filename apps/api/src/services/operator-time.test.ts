import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isOnOperatorDay,
  OPERATOR_TIME_ZONE,
  operatorDay,
} from './operator-time.js';

test('operator days use Europe/Madrid summer time at the UTC boundary', () => {
  assert.equal(OPERATOR_TIME_ZONE, 'Europe/Madrid');
  assert.equal(operatorDay(new Date('2026-07-28T21:59:59.999Z')), '2026-07-28');
  assert.equal(operatorDay(new Date('2026-07-28T22:00:00.000Z')), '2026-07-29');
  assert.equal(isOnOperatorDay('2026-07-28T22:30:00.000Z', '2026-07-29'), true);
});

test('operator days use Europe/Madrid winter time at the UTC boundary', () => {
  assert.equal(operatorDay(new Date('2026-01-28T22:59:59.999Z')), '2026-01-28');
  assert.equal(operatorDay(new Date('2026-01-28T23:00:00.000Z')), '2026-01-29');
  assert.equal(isOnOperatorDay('not-a-date', '2026-01-29'), false);
});
