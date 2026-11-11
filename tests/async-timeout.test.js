import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout, createDeadline, remainingMs } from '../shared/async-timeout.js';

describe('async timeout helpers', () => {
  it('resolves when under budget', async () => {
    const value = await withTimeout(Promise.resolve(7), 1000, 'ok');
    assert.equal(value, 7);
  });

  it('rejects when over budget', async () => {
    await assert.rejects(
      () =>
        withTimeout(
          new Promise((resolve) => setTimeout(() => resolve(1), 50)),
          5,
          'slow',
        ),
      /timed out/,
    );
  });

  it('tracks deadline remaining', () => {
    const d = createDeadline(1000);
    assert.ok(d.remaining() > 0);
    assert.equal(d.expired(), false);
    assert.ok(remainingMs(Date.now() + 50) >= 0);
  });
});
