import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { originPatternFromEndpoint, ensureEndpointPermission } from '../shared/permissions.js';

describe('optional host permissions', () => {
  it('builds origin patterns from endpoint base URLs', () => {
    assert.equal(
      originPatternFromEndpoint('https://api.anthropic.com'),
      'https://api.anthropic.com/*',
    );
    assert.equal(
      originPatternFromEndpoint('https://gateway.example/v1/'),
      'https://gateway.example/*',
    );
    assert.equal(originPatternFromEndpoint(''), null);
    assert.equal(originPatternFromEndpoint('not-a-url'), null);
  });

  it('ensureEndpointPermission requests when missing', async () => {
    const calls = [];
    const permissions = {
      async contains(detail) {
        calls.push(['contains', detail]);
        return false;
      },
      async request(detail) {
        calls.push(['request', detail]);
        return true;
      },
    };
    const ok = await ensureEndpointPermission('https://api.openai.com', permissions);
    assert.equal(ok, true);
    assert.deepEqual(calls[0][1], { origins: ['https://api.openai.com/*'] });
    assert.equal(calls[1][0], 'request');
  });
});
