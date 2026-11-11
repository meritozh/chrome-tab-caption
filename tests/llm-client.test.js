import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MockLlmClient,
  buildClassifyPayloadPreview,
  createLlmClient,
} from '../shared/llm-client.js';

describe('llm-client stubs', () => {
  it('mock classifies without network', async () => {
    const client = new MockLlmClient();
    const result = await client.classifyTopic({
      url: 'https://www.news.example/story',
      title: 'Story',
    });
    assert.equal(typeof result.topic, 'string');
    assert.ok(result.topic.length > 0);
  });

  it('preview lists privacy fields without api key', () => {
    const preview = buildClassifyPayloadPreview(
      { url: 'https://a.test', title: 'A' },
      { provider: 'anthropic', model: 'm', endpointBaseUrl: 'https://api.anthropic.com' },
    );
    assert.ok(preview.fields.some((f) => f.name === 'url'));
    assert.ok(!preview.fields.some((f) => f.name === 'apiKey'));
  });

  it('factory returns mock when key missing', () => {
    assert.ok(createLlmClient({ provider: 'anthropic' }) instanceof MockLlmClient);
  });
});
