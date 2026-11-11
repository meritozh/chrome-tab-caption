import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MockLlmClient,
  AnthropicLlmClient,
  OpenAiResponsesLlmClient,
  buildClassifyPayloadPreview,
  buildClassifyUserPrompt,
  createLlmClient,
  parseClassifyResponseText,
  extractAnthropicText,
  extractOpenAiResponsesText,
  joinEndpoint,
} from '../shared/llm-client.js';

describe('llm-client', () => {
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
    assert.ok(!JSON.stringify(preview).includes('sk-'));
  });

  it('factory returns mock when key missing or useMock', () => {
    assert.ok(createLlmClient({ provider: 'anthropic' }) instanceof MockLlmClient);
    assert.ok(
      createLlmClient({
        provider: 'anthropic',
        apiKey: 'sk-x',
        useMock: true,
      }) instanceof MockLlmClient,
    );
  });

  it('factory selects Anthropic and OpenAI Responses clients', () => {
    assert.ok(
      createLlmClient({
        provider: 'anthropic',
        apiKey: 'sk-a',
        model: 'm',
        endpointBaseUrl: 'https://api.anthropic.com',
      }) instanceof AnthropicLlmClient,
    );
    assert.ok(
      createLlmClient({
        provider: 'openai-responses',
        apiKey: 'sk-o',
        model: 'm',
        endpointBaseUrl: 'https://api.openai.com',
      }) instanceof OpenAiResponsesLlmClient,
    );
  });

  it('Anthropic request uses Messages path and never puts key in body', () => {
    const client = new AnthropicLlmClient({
      provider: 'anthropic',
      apiKey: 'sk-secret-anthropic',
      model: 'claude-test',
      endpointBaseUrl: 'https://api.anthropic.com',
    });
    const { url, init } = client.buildRequest({
      url: 'https://example.com',
      title: 'Example',
      extractedText: 'body',
    });
    assert.match(url, /\/v1\/messages$/);
    assert.equal(init.headers['x-api-key'], 'sk-secret-anthropic');
    assert.equal(JSON.parse(init.body).model, 'claude-test');
    assert.ok(!init.body.includes('sk-secret-anthropic'));
    assert.ok(!init.body.includes('chat/completions'));
  });

  it('OpenAI Responses request uses /v1/responses not chat/completions', () => {
    const client = new OpenAiResponsesLlmClient({
      provider: 'openai-responses',
      apiKey: 'sk-secret-openai',
      model: 'gpt-test',
      endpointBaseUrl: 'https://api.openai.com',
    });
    const { url, init } = client.buildRequest({
      url: 'https://example.com',
      title: 'Example',
    });
    assert.match(url, /\/v1\/responses$/);
    assert.ok(!url.includes('chat/completions'));
    assert.equal(init.headers.authorization, 'Bearer sk-secret-openai');
    const body = JSON.parse(init.body);
    assert.ok(body.input || body.instructions);
    assert.ok(!init.body.includes('sk-secret-openai'));
  });

  it('parses classify JSON and provider text extractors', () => {
    const parsed = parseClassifyResponseText('{"topic":"Space Flight","synonyms":["rockets"],"confidence":0.9}');
    assert.equal(parsed.topic, 'Space Flight');
    assert.deepEqual(parsed.synonyms, ['rockets']);

    assert.equal(
      extractAnthropicText({ content: [{ type: 'text', text: 'hello' }] }),
      'hello',
    );
    assert.equal(
      extractOpenAiResponsesText({ output_text: 'from responses' }),
      'from responses',
    );
  });

  it('buildClassifyUserPrompt includes url/title', () => {
    const prompt = buildClassifyUserPrompt({
      url: 'https://x.test',
      title: 'X',
      extractedText: 'y'.repeat(400),
    });
    assert.match(prompt, /https:\/\/x\.test/);
    assert.ok(prompt.length < 800);
  });

  it('joinEndpoint avoids double slashes', () => {
    assert.equal(
      joinEndpoint('https://api.anthropic.com/', '/v1/messages'),
      'https://api.anthropic.com/v1/messages',
    );
  });
});
