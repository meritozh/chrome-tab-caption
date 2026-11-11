import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  originPatternFromEndpoint,
  resolveEndpointBaseUrl,
  buildOrganizePermissionOrigins,
  requestOrganizePermissions,
  hasEndpointPermission,
  ensureEndpointPermission,
  DEFAULT_ENDPOINT_BY_PROVIDER,
  EXTRACT_HOST_PATTERNS,
} from '../shared/permissions.js';

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

  it('resolves empty endpointBaseUrl to provider defaults', () => {
    assert.equal(resolveEndpointBaseUrl('', 'anthropic'), DEFAULT_ENDPOINT_BY_PROVIDER.anthropic);
    assert.equal(
      resolveEndpointBaseUrl('', 'openai-responses'),
      DEFAULT_ENDPOINT_BY_PROVIDER['openai-responses'],
    );
    assert.equal(resolveEndpointBaseUrl('https://custom.example', 'anthropic'), 'https://custom.example');
    assert.equal(resolveEndpointBaseUrl('', ''), '');
  });

  it('buildOrganizePermissionOrigins includes default host + extract patterns', () => {
    const origins = buildOrganizePermissionOrigins({
      endpointBaseUrl: '',
      provider: 'anthropic',
      includeExtractHosts: true,
    });
    assert.ok(origins.includes('https://api.anthropic.com/*'));
    for (const p of EXTRACT_HOST_PATTERNS) assert.ok(origins.includes(p));
  });

  it('requestOrganizePermissions calls request without contains first', async () => {
    const calls = [];
    const permissions = {
      async contains() {
        calls.push('contains');
        return false;
      },
      async request(detail) {
        calls.push(['request', detail]);
        return true;
      },
    };
    const ok = await requestOrganizePermissions(
      { endpointBaseUrl: 'https://api.openai.com', provider: 'openai-responses' },
      permissions,
    );
    assert.equal(ok, true);
    assert.equal(calls[0][0], 'request');
    assert.ok(!calls.includes('contains'));
    assert.ok(calls[0][1].origins.includes('https://api.openai.com/*'));
    assert.ok(calls[0][1].origins.includes('http://*/*'));
  });

  it('hasEndpointPermission only checks contains', async () => {
    const permissions = {
      async contains(detail) {
        assert.deepEqual(detail, { origins: ['https://api.anthropic.com/*'] });
        return true;
      },
      async request() {
        throw new Error('should not request');
      },
    };
    assert.equal(await hasEndpointPermission('', 'anthropic', permissions), true);
  });

  it('ensureEndpointPermission requests default host when URL empty + provider set', async () => {
    const permissions = {
      async request(detail) {
        assert.deepEqual(detail, { origins: ['https://api.anthropic.com/*'] });
        return true;
      },
    };
    assert.equal(await ensureEndpointPermission('', permissions, 'anthropic'), true);
  });
});
