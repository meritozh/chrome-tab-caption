import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  AnthropicLlmClient,
  OpenAiResponsesLlmClient,
  buildClassifyPayloadPreview,
  buildClassifyUserPrompt,
  buildClassifySystemPrompt,
  normalizeExistingTopics,
  shouldPreferExistingTopics,
  CLASSIFY_SYSTEM_PROMPT,
  CLASSIFY_PREFER_EXISTING_SYSTEM_SUFFIX,
  createLlmClient,
  isLlmConfigured,
  LLM_CONFIG_REQUIRED_MESSAGE,
  parseClassifyResponseText,
  extractAnthropicText,
  extractOpenAiResponsesText,
  joinEndpoint,
} from '../shared/llm-client.js';

describe('llm-client', () => {
  it('isLlmConfigured requires supported provider + non-empty apiKey', () => {
    assert.equal(isLlmConfigured(null), false);
    assert.equal(isLlmConfigured({ provider: 'anthropic' }), false);
    assert.equal(isLlmConfigured({ provider: 'anthropic', apiKey: '   ' }), false);
    assert.equal(isLlmConfigured({ llmProvider: 'anthropic', apiKey: 'sk-x' }), true);
    assert.equal(
      isLlmConfigured({ provider: 'openai-responses', apiKey: 'sk-o' }),
      true,
    );
    assert.equal(isLlmConfigured({ provider: 'other', apiKey: 'sk-x' }), false);
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

  it('factory refuses without provider or apiKey (no mock)', () => {
    assert.throws(
      () => createLlmClient({ provider: 'anthropic' }),
      (err) =>
        err instanceof Error && err.message.includes('LLM is not configured'),
    );
    assert.throws(
      () => createLlmClient({ apiKey: 'sk-x' }),
      (err) => err instanceof Error && err.message === LLM_CONFIG_REQUIRED_MESSAGE,
    );
    assert.throws(
      () =>
        createLlmClient({
          provider: 'unknown-provider',
          apiKey: 'sk-x',
        }),
      /Unsupported LLM provider/,
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
    const parsed = parseClassifyResponseText(
      '{"topic":"Space Flight","synonyms":["rockets"],"confidence":0.9}',
    );
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

  it('candidate prompts list seeds/groups; forbid Other; Reorganize uses seed wording', () => {
    assert.deepEqual(normalizeExistingTopics([' Docs ', 'docs', 'News']), [
      'Docs',
      'News',
    ]);
    assert.equal(
      shouldPreferExistingTopics({
        preferExisting: true,
        existingTopics: ['Docs'],
      }),
      true,
    );
    assert.equal(
      shouldPreferExistingTopics({
        preferExisting: false,
        existingTopics: ['Docs'],
      }),
      false,
    );

    const organize = buildClassifyUserPrompt({
      url: 'https://a.test',
      title: 'A',
      preferExisting: true,
      candidateMode: 'organize',
      existingTopics: ['Docs', '开源 · AI / Agents'],
    });
    assert.match(organize, /Candidate topics/);
    assert.match(organize, /- Docs/);
    assert.match(organize, /开源 · AI \/ Agents/);
    assert.match(organize, /Never use Other/);
    assert.doesNotMatch(organize, /Seed topics \(/);

    const reorganize = buildClassifyUserPrompt({
      url: 'https://a.test',
      title: 'A',
      preferExisting: true,
      candidateMode: 'reorganize',
      existingTopics: ['开源 · AI / Agents', '视频'],
    });
    assert.match(reorganize, /Seed topics/);
    assert.match(reorganize, /- 视频/);
    assert.match(reorganize, /Never use Other/);
    assert.doesNotMatch(reorganize, /Candidate topics/);

    const omit = buildClassifyUserPrompt({
      url: 'https://a.test',
      title: 'A',
      preferExisting: false,
      existingTopics: ['Docs'],
    });
    assert.doesNotMatch(omit, /Candidate topics|Seed topics/);

    assert.equal(buildClassifySystemPrompt({ preferExisting: false }), CLASSIFY_SYSTEM_PROMPT);
    assert.match(CLASSIFY_SYSTEM_PROMPT, /Never use catch-all/);
    assert.ok(
      buildClassifySystemPrompt({
        preferExisting: true,
        existingTopics: ['Docs'],
      }).includes(CLASSIFY_PREFER_EXISTING_SYSTEM_SUFFIX),
    );
  });

  it('joinEndpoint avoids double slashes', () => {
    assert.equal(
      joinEndpoint('https://api.anthropic.com/', '/v1/messages'),
      'https://api.anthropic.com/v1/messages',
    );
  });

  it('classifyTopic uses stubbed fetch (network client fixture)', async () => {
    const client = new AnthropicLlmClient({
      provider: 'anthropic',
      apiKey: 'sk-test',
      model: 'claude-test',
      endpointBaseUrl: 'https://api.anthropic.com',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      async json() {
        return {
          content: [
            {
              type: 'text',
              text: '{"topic":"Fixture Topic","synonyms":[],"confidence":0.8}',
            },
          ],
        };
      },
    }));
    try {
      const result = await client.classifyTopic({
        url: 'https://news.example/story',
        title: 'Story',
      });
      assert.equal(result.topic, 'Fixture Topic');
      assert.equal(globalThis.fetch.mock.callCount(), 1);
      const [calledUrl, init] = globalThis.fetch.mock.calls[0].arguments;
      assert.match(String(calledUrl), /\/v1\/messages$/);
      assert.equal(init.headers['x-api-key'], 'sk-test');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('ping() issues a real classify-shaped request via stubbed fetch', async () => {
    const client = createLlmClient({
      provider: 'openai-responses',
      apiKey: 'sk-ping',
      model: 'gpt-test',
      endpointBaseUrl: 'https://api.openai.com',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      async json() {
        return { output_text: '{"topic":"Ping Ok","synonyms":[],"confidence":1}' };
      },
    }));
    try {
      const result = await client.ping();
      assert.equal(result.topic, 'Ping Ok');
      assert.equal(globalThis.fetch.mock.callCount(), 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
