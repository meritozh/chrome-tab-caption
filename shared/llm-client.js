/**
 * LLM client abstraction — Anthropic Messages + OpenAI Responses-style (ADR §3.3).
 * Real network calls from user config (local apiKey). Mock kept for TEST_LLM.
 * Never log secrets. Do NOT use chat/completions-only or Gemini Nano as the primary path.
 */

import { EXCERPT_HARD_CAP_CHARS } from './constants.js';
import { capExcerpt } from './topic-cache.js';
import { formatTopicLabel } from './topic-normalize.js';

/**
 * @typedef {object} ClassifyInput
 * @property {string} url
 * @property {string} title
 * @property {string} [snippet]
 * @property {string} [extractedText]
 */

/**
 * @typedef {object} ClassifyResult
 * @property {string} topic
 * @property {string[]} [synonyms]
 * @property {number} [confidence]
 * @property {unknown} [raw]
 */

/**
 * @typedef {object} LlmClientConfig
 * @property {'anthropic' | 'openai-responses'} provider
 * @property {string} endpointBaseUrl
 * @property {string} apiKey
 * @property {string} model
 */

export const CLASSIFY_SYSTEM_PROMPT =
  'You classify browser tabs into fine-grained English topic labels. ' +
  'Reply with a single JSON object only: {"topic":"English Topic","synonyms":["optional near-duplicate"],"confidence":0.0}. ' +
  'Topics must be short, specific, and English. Prefer merging near-duplicates via synonyms. No markdown.';

/**
 * Fields that will be sent for a classify call (privacy preview — ADR #12).
 * @param {ClassifyInput} input
 * @param {Pick<LlmClientConfig, 'provider' | 'model' | 'endpointBaseUrl'>} meta
 */
export function buildClassifyPayloadPreview(input, meta) {
  return {
    fields: [
      { name: 'url', value: input.url ?? '' },
      { name: 'title', value: input.title ?? '' },
      { name: 'snippet', value: input.snippet ?? '' },
      { name: 'extractedText', value: input.extractedText ?? '' },
      { name: 'provider', value: meta.provider ?? '' },
      { name: 'model', value: meta.model ?? '' },
      { name: 'endpointBaseUrl', value: meta.endpointBaseUrl ?? '' },
    ],
    note: 'API key is never shown in preview. English fine-grained topic labels only.',
  };
}

/**
 * User message body for classify (shared across providers).
 * @param {ClassifyInput} input
 */
export function buildClassifyUserPrompt(input) {
  const excerpt = capExcerpt(input.extractedText || input.snippet || '', EXCERPT_HARD_CAP_CHARS);
  return [
    'Classify this tab into one fine-grained English topic.',
    `URL: ${input.url ?? ''}`,
    `Title: ${input.title ?? ''}`,
    excerpt ? `Excerpt: ${excerpt}` : 'Excerpt: (none)',
  ].join('\n');
}

/**
 * Parse model text into ClassifyResult. Tolerates fenced JSON.
 * @param {string} text
 * @param {unknown} [raw]
 * @returns {ClassifyResult}
 */
export function parseClassifyResponseText(text, raw) {
  const cleaned = String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  let parsed = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = null;
      }
    }
  }
  if (parsed && typeof parsed === 'object' && parsed.topic) {
    const synonyms = Array.isArray(parsed.synonyms)
      ? parsed.synonyms.map(String).filter(Boolean)
      : [];
    const confidence =
      typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
        ? parsed.confidence
        : undefined;
    return {
      topic: formatTopicLabel(String(parsed.topic)),
      synonyms,
      confidence,
      raw: raw ?? parsed,
    };
  }
  // Fallback: first non-empty line as topic
  const line = cleaned.split('\n').map((l) => l.trim()).find(Boolean) || 'General';
  return {
    topic: formatTopicLabel(line.replace(/^topic\s*:\s*/i, '').slice(0, 80)),
    synonyms: [],
    confidence: 0,
    raw: raw ?? { unparsed: text },
  };
}

/**
 * Join base URL + path without duplicating slashes or version prefixes.
 * @param {string} base
 * @param {string} path
 */
export function joinEndpoint(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  if (!b) return p;
  // If user already included the API path, append nothing beyond base
  if (/\/v1\/(messages|responses)$/i.test(b) && (path.includes('messages') || path.includes('responses'))) {
    return b;
  }
  return `${b}${p}`;
}

/**
 * @param {Response} response
 * @param {string} provider
 */
async function readErrorMessage(response, provider) {
  let body = '';
  try {
    body = await response.text();
  } catch {
    body = '';
  }
  const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 240);
  return `${provider} HTTP ${response.status}${snippet ? `: ${snippet}` : ''}`;
}

/**
 * @interface
 */
export class LlmClient {
  /**
   * @param {ClassifyInput} _input
   * @returns {Promise<ClassifyResult>}
   */
  async classifyTopic(_input) {
    throw new Error('LlmClient.classifyTopic not implemented');
  }
}

/** Mock client — deterministic stub for UI / TEST_LLM; no network. */
export class MockLlmClient extends LlmClient {
  /**
   * @param {ClassifyInput} input
   * @returns {Promise<ClassifyResult>}
   */
  async classifyTopic(input) {
    const host = (() => {
      try {
        return new URL(input.url).hostname.replace(/^www\./, '');
      } catch {
        return 'unknown';
      }
    })();
    const topic = host
      .split('.')
      .slice(0, -1)
      .join(' ')
      .replace(/[-_]/g, ' ')
      .trim() || 'General';
    return {
      topic: formatTopicLabel(topic),
      synonyms: [],
      confidence: 0,
      raw: { mock: true, title: input.title },
    };
  }
}

/**
 * Anthropic Messages API adapter.
 * @extends {LlmClient}
 */
export class AnthropicLlmClient extends LlmClient {
  /** @param {LlmClientConfig} config */
  constructor(config) {
    super();
    this.config = config;
  }

  /**
   * Build fetch args (testable without network).
   * @param {ClassifyInput} input
   */
  buildRequest(input) {
    const url = joinEndpoint(this.config.endpointBaseUrl || 'https://api.anthropic.com', '/v1/messages');
    const body = {
      model: this.config.model,
      max_tokens: 200,
      system: CLASSIFY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildClassifyUserPrompt(input) }],
    };
    return {
      url,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      },
    };
  }

  /** @param {ClassifyInput} input */
  async classifyTopic(input) {
    const { url, init } = this.buildRequest(input);
    const response = await fetch(url, init);
    if (!response.ok) {
      throw new Error(await readErrorMessage(response, 'Anthropic'));
    }
    const data = await response.json();
    const text = extractAnthropicText(data);
    return parseClassifyResponseText(text, data);
  }
}

/**
 * @param {any} data
 * @returns {string}
 */
export function extractAnthropicText(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return blocks
    .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
    .map((b) => b.text || '')
    .join('\n')
    .trim();
}

/**
 * OpenAI Responses-style adapter (not chat/completions).
 * @extends {LlmClient}
 */
export class OpenAiResponsesLlmClient extends LlmClient {
  /** @param {LlmClientConfig} config */
  constructor(config) {
    super();
    this.config = config;
  }

  /**
   * @param {ClassifyInput} input
   */
  buildRequest(input) {
    const url = joinEndpoint(this.config.endpointBaseUrl || 'https://api.openai.com', '/v1/responses');
    const body = {
      model: this.config.model,
      instructions: CLASSIFY_SYSTEM_PROMPT,
      input: buildClassifyUserPrompt(input),
      max_output_tokens: 200,
    };
    return {
      url,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
      },
    };
  }

  /** @param {ClassifyInput} input */
  async classifyTopic(input) {
    const { url, init } = this.buildRequest(input);
    const response = await fetch(url, init);
    if (!response.ok) {
      throw new Error(await readErrorMessage(response, 'OpenAI Responses'));
    }
    const data = await response.json();
    const text = extractOpenAiResponsesText(data);
    return parseClassifyResponseText(text, data);
  }
}

/**
 * @param {any} data
 * @returns {string}
 */
export function extractOpenAiResponsesText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const output = Array.isArray(data?.output) ? data.output : [];
  const parts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (typeof c?.text === 'string') parts.push(c.text);
      else if (c?.type === 'output_text' && typeof c?.text === 'string') parts.push(c.text);
    }
  }
  if (parts.length) return parts.join('\n').trim();
  // Some gateways mirror chat-style choices — accept as soft fallback only for parsing,
  // never as the request path (we still POST /v1/responses).
  const choice = data?.choices?.[0]?.message?.content;
  if (typeof choice === 'string') return choice.trim();
  return '';
}

/**
 * Factory from user config.
 * @param {Partial<LlmClientConfig> & { useMock?: boolean }} config
 * @returns {LlmClient}
 */
export function createLlmClient(config) {
  if (config.useMock || !config.provider || !config.apiKey) {
    return new MockLlmClient();
  }
  if (config.provider === 'anthropic') {
    return new AnthropicLlmClient(/** @type {LlmClientConfig} */ (config));
  }
  if (config.provider === 'openai-responses') {
    return new OpenAiResponsesLlmClient(/** @type {LlmClientConfig} */ (config));
  }
  return new MockLlmClient();
}
