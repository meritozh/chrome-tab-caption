import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatOrganizeCancelMessage,
  isIdleOrganizeCancel,
  isPreviewOnlyCancel,
  organizeCancelCheckpoint,
  shouldApplyOrganizeCompletion,
  shouldApplySettingsRetryCompletion,
  shouldMarkOrganizeConfigReady,
} from '../shared/organize-cancel.js';

describe('formatOrganizeCancelMessage', () => {
  it('reports no LLM calls when none were started', () => {
    assert.equal(
      formatOrganizeCancelMessage({ llmCallsAttempted: 0 }),
      'Organize cancelled — no LLM calls.',
    );
    assert.equal(formatOrganizeCancelMessage({}), 'Organize cancelled — no LLM calls.');
  });

  it('never claims no LLM calls once a request was started', () => {
    const msg = formatOrganizeCancelMessage({ llmCallsAttempted: 1, classified: 0 });
    assert.match(msg, /1 LLM call already sent/);
    assert.doesNotMatch(msg, /no LLM calls/);
    assert.match(msg, /cannot be recalled/);
  });

  it('includes classified count when present', () => {
    const msg = formatOrganizeCancelMessage({ llmCallsAttempted: 3, classified: 2 });
    assert.match(msg, /3 LLM calls already sent/);
    assert.match(msg, /2 classified before cancel/);
  });
});

describe('shouldApplyOrganizeCompletion', () => {
  it('allows completion only for the active run', () => {
    assert.equal(
      shouldApplyOrganizeCompletion({ runId: 2, activeRunId: 2, cancelRequested: false }),
      true,
    );
    assert.equal(
      shouldApplyOrganizeCompletion({ runId: 1, activeRunId: 2, cancelRequested: false }),
      false,
    );
  });

  it('suppresses completion when cancel was requested', () => {
    assert.equal(
      shouldApplyOrganizeCompletion({ runId: 3, activeRunId: 3, cancelRequested: true }),
      false,
    );
  });
});

describe('isIdleOrganizeCancel', () => {
  it('treats idle as no local Organize job', () => {
    assert.equal(isIdleOrganizeCancel('idle'), true);
    assert.equal(isIdleOrganizeCancel('permissions'), false);
    assert.equal(isIdleOrganizeCancel('running'), false);
    assert.equal(isIdleOrganizeCancel('cancelling'), false);
  });

  it('keeps deprecated isPreviewOnlyCancel alias for idle/preview', () => {
    assert.equal(isPreviewOnlyCancel('idle'), true);
    assert.equal(isPreviewOnlyCancel('preview'), true);
    assert.equal(isPreviewOnlyCancel('permissions'), false);
  });
});

describe('shouldApplySettingsRetryCompletion', () => {
  it('completes successful retry for matching runId (busy is expected)', () => {
    // Regression: busy=true must not block idle after hydrate for this run.
    assert.equal(
      shouldApplySettingsRetryCompletion({ runId: 5, activeRunId: 5 }),
      true,
    );
  });

  it('ignores superseded retry so setOrganizeIdle cannot clobber a newer Organize', () => {
    assert.equal(
      shouldApplySettingsRetryCompletion({ runId: 5, activeRunId: 6 }),
      false,
    );
  });
});

describe('shouldMarkOrganizeConfigReady', () => {
  it('marks ready only when a config object was returned', () => {
    assert.equal(shouldMarkOrganizeConfigReady({ llmProvider: 'anthropic' }), true);
    assert.equal(shouldMarkOrganizeConfigReady({}), true);
  });

  it('leaves not-ready on ok:false / missing config so Organize can retry', () => {
    assert.equal(shouldMarkOrganizeConfigReady(undefined), false);
    assert.equal(shouldMarkOrganizeConfigReady(null), false);
    assert.equal(shouldMarkOrganizeConfigReady('nope'), false);
  });
});

describe('organizeCancelCheckpoint', () => {
  it('continues when signal is missing or not aborted', () => {
    assert.deepEqual(organizeCancelCheckpoint(undefined, {}), { continue: true });
    const ac = new AbortController();
    assert.deepEqual(organizeCancelCheckpoint(ac.signal, {}), { continue: true });
  });

  it('does not invoke state factory unless aborted', () => {
    const ac = new AbortController();
    let called = 0;
    const out = organizeCancelCheckpoint(ac.signal, () => {
      called += 1;
      return { llmCallsAttempted: 9 };
    });
    assert.deepEqual(out, { continue: true });
    assert.equal(called, 0);
    ac.abort();
    const stopped = organizeCancelCheckpoint(ac.signal, () => {
      called += 1;
      return { llmCallsAttempted: 9, classified: 0 };
    });
    assert.equal(called, 1);
    assert.equal(stopped.continue, false);
    assert.equal(stopped.result.llmCallsAttempted, 9);
  });

  it('stops queued work with honest LLM stats when aborted', () => {
    const ac = new AbortController();
    ac.abort();
    const checkpoint = organizeCancelCheckpoint(ac.signal, {
      jobId: 'group-1',
      scope: 'all',
      llmCallsAttempted: 2,
      classified: 1,
      classifyErrors: 0,
      assignments: [{ tabId: 1 }],
      physical: { applied: 1, errors: [] },
      logical: [{ topicKey: 'a' }],
    });
    assert.equal(checkpoint.continue, false);
    assert.equal(checkpoint.result.ok, false);
    assert.equal(checkpoint.result.cancelled, true);
    assert.equal(checkpoint.result.llmCallsAttempted, 2);
    assert.equal(checkpoint.result.classified, 1);
    assert.doesNotMatch(checkpoint.result.message, /no LLM calls/);
    assert.match(checkpoint.result.message, /2 LLM calls already sent/);
  });

  it('reports no LLM calls when aborted before any classify', () => {
    const ac = new AbortController();
    ac.abort();
    const checkpoint = organizeCancelCheckpoint(ac.signal, {
      llmCallsAttempted: 0,
      classified: 0,
    });
    assert.equal(checkpoint.continue, false);
    assert.equal(checkpoint.result.message, 'Organize cancelled — no LLM calls.');
  });
});
