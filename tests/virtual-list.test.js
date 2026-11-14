import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { visibleRange, totalHeight } from '../sidepanel/virtual-list.js';

describe('visibleRange', () => {
  it('returns empty window for empty lists', () => {
    assert.deepEqual(
      visibleRange({
        scrollTop: 0,
        viewportHeight: 200,
        itemHeight: 56,
        itemCount: 0,
      }),
      { start: 0, end: 0 },
    );
  });

  it('windows the first page with overscan', () => {
    assert.deepEqual(
      visibleRange({
        scrollTop: 0,
        viewportHeight: 200,
        itemHeight: 50,
        itemCount: 100,
        overscan: 2,
      }),
      { start: 0, end: 6 },
    );
  });

  it('advances the window on scroll', () => {
    assert.deepEqual(
      visibleRange({
        scrollTop: 500,
        viewportHeight: 200,
        itemHeight: 50,
        itemCount: 100,
        overscan: 2,
      }),
      { start: 8, end: 16 },
    );
  });

  it('clamps to the list end', () => {
    assert.deepEqual(
      visibleRange({
        scrollTop: 4800,
        viewportHeight: 200,
        itemHeight: 50,
        itemCount: 100,
        overscan: 4,
      }),
      { start: 92, end: 100 },
    );
  });

  it('ignores negative scroll', () => {
    assert.deepEqual(
      visibleRange({
        scrollTop: -40,
        viewportHeight: 100,
        itemHeight: 50,
        itemCount: 10,
        overscan: 0,
      }),
      { start: 0, end: 2 },
    );
  });
});

describe('totalHeight', () => {
  it('multiplies count by row height', () => {
    assert.equal(totalHeight(10, 56), 560);
    assert.equal(totalHeight(0, 56), 0);
    assert.equal(totalHeight(-1, 56), 0);
  });
});
