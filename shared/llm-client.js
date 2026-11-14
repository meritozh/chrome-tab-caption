/**
 * LLM client abstraction — Anthropic Messages + OpenAI Responses-style (ADR §3.3).
 * Real network calls from user config (local apiKey) only — no mock / hostname fallback.
 * Never log secrets. Do NOT use chat/completions-only or Gemini Nano as the primary path.
 */

import { EXCERPT_HARD_CAP_CHARS } from './constants.js';
import { capExcerpt } from './topic-cache.js';
import { formatTopicLabel } from './topic-normalize.js';
import { resolveEndpointBaseUrl, DEFAULT_ENDPOINT_BY_PROVIDER } from './permissions.js';

/**
 * @typedef {object} ClassifyInput
 * @property {string} url
 * @property {string} title
 * @property {string} [snippet]
 * @property {string} [extractedText]
 * @property {string[]} [existingTopics] — English labels already in use
 * @property {boolean} [preferExisting] — default true when topics provided; false for Reorganize
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

export const CLASSIFY_PREFER_EXISTING_SYSTEM_SUFFIX =
  ' When the user message lists existing topics, prefer assigning the tab to one of those topics when a good fit exists. ' +
  'Only invent a new topic label when none of the existing topics fit.';

/** User-facing when provider or API key is missing. */
export const LLM_CONFIG_REQUIRED_MESSAGE =
  'LLM is not configured. Set provider and API key in Side Panel → Settings before Organize or Test connection.';

/**
 * Normalize / de-dupe topic labels for the classify prompt (case-insensitive).
 * @param {unknown} topics
 * @returns {string[]}
 */
export function normalizeExistingTopics(topics) {
  if (!Array.isArray(topics)) return [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const raw of topics) {
    const label = String(raw || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

/**
 * @param {Pick<ClassifyInput, 'preferExisting' | 'existingTopics'> | null | undefined} input
 */
export function shouldPreferExistingTopics(input) {
  if (!input || input.preferExisting === false) return false;
  return normalizeExistingTopics(input.existingTopics).length > 0;
}

/**
 * System prompt for classify — appends prefer-existing guidance when applicable.
 * @param {Pick<ClassifyInput, 'preferExisting' | 'existingTopics'> | null | undefined} [input]
 */
export function buildClassifySystemPrompt(input = null) {
  if (shouldPreferExistingTopics(input)) {
    return CLASSIFY_SYSTEM_PROMPT + CLASSIFY_PREFER_EXISTING_SYSTEM_SUFFIX;
  }
  return CLASSIFY_SYSTEM_PROMPT;
}

/**
 * True when config has a supported provider and a non-empty API key.
 * Accepts either `{ provider, apiKey }` or stored config `{ llmProvider, apiKey }`.
 * @param {Partial<LlmClientConfig> & { llmProvider?: string } | null | undefined} config
 */
export function isLlmConfigured(config) {
  if (!config || typeof config !== 'object') return false;
  const provider =
    typeof config.provider === 'string' && config.provider
      ? config.provider
      : typeof config.llmProvider === 'string'
        ? config.llmProvider
        : '';
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  return (
    (provider === 'anthropic' || provider === 'openai-responses') && apiKey.length > 0
  );
}

/**
 * Fields that will be sent for a classify call (Options / Settings field list — ADR #12).
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
  const lines = [
    'Classify this tab into one fine-grained English topic.',
    `URL: ${input.url ?? ''}`,
    `Title: ${input.title ?? ''}`,
    excerpt ? `Excerpt: ${excerpt}` : 'Excerpt: (none)',
  ];
  if (shouldPreferExistingTopics(input)) {
    const topics = normalizeExistingTopics(input.existingTopics);
    lines.push('Existing topics (prefer these when a good fit):');
    for (const topic of topics) {
      lines.push(`- ${topic}`);
    }
    lines.push('Only create a new topic if none of the above fit.');
  }
  return lines.join('\n');
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
  // Fallback: first non-empty line as topic (model output only — never hostname invent).
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

  /**
   * Lightweight connectivity check — one real classify against the configured endpoint.
   * @returns {Promise<ClassifyResult>}
   */
  async ping() {
    return this.classifyTopic({
      url: 'https://example.com/connection-test',
      title: 'Connection test',
      snippet: 'ping',
    });
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
    const base = resolveEndpointBaseUrl(
      this.config.endpointBaseUrl,
      'anthropic',
    ) || DEFAULT_ENDPOINT_BY_PROVIDER.anthropic;
    const url = joinEndpoint(base, '/v1/messages');
    const body = {
      model: this.config.model,
      max_tokens: 200,
      system: buildClassifySystemPrompt(input),
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
    const base = resolveEndpointBaseUrl(
      this.config.endpointBaseUrl,
      'openai-responses',
    ) || DEFAULT_ENDPOINT_BY_PROVIDER['openai-responses'];
    const url = joinEndpoint(base, '/v1/responses');
    const body = {
      model: this.config.model,
      instructions: buildClassifySystemPrompt(input),
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
 * Factory from user config. Refuses without a supported provider + apiKey (no mock).
 * @param {Partial<LlmClientConfig>} config
 * @returns {LlmClient}
 */
export function createLlmClient(config) {
  const provider = config?.provider;
  const apiKey = typeof config?.apiKey === 'string' ? config.apiKey.trim() : '';
  if (!provider || !apiKey) {
    throw new Error(LLM_CONFIG_REQUIRED_MESSAGE);
  }
  const normalized = {
    provider,
    endpointBaseUrl: config.endpointBaseUrl || '',
    apiKey,
    model: config.model || '',
  };
  if (provider === 'anthropic') {
    return new AnthropicLlmClient(/** @type {LlmClientConfig} */ (normalized));
  }
  if (provider === 'openai-responses') {
    return new OpenAiResponsesLlmClient(/** @type {LlmClientConfig} */ (normalized));
  }
  throw new Error(`Unsupported LLM provider: ${provider}`);
}
