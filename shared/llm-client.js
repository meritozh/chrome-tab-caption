/**
 * LLM client abstraction — Anthropic Messages + OpenAI Responses-style (ADR §3.3).
 * No real network calls in Phase 0/1; interfaces + mock only.
 * Do NOT use chat/completions-only or Gemini Nano as the primary abstraction.
 */

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

/** Mock client — deterministic stub for UI / tests; no network. */
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
      topic: topic.replace(/\b\w/g, (c) => c.toUpperCase()),
      synonyms: [],
      confidence: 0,
      raw: { mock: true, title: input.title },
    };
  }
}

/**
 * Anthropic Messages adapter stub — real fetch in later phase.
 * @extends {LlmClient}
 */
export class AnthropicLlmClient extends LlmClient {
  /** @param {LlmClientConfig} config */
  constructor(config) {
    super();
    this.config = config;
  }

  /** @param {ClassifyInput} _input */
  async classifyTopic(_input) {
    throw new Error(
      'AnthropicLlmClient: real classifyTopic not wired yet (Phase 2). Use MockLlmClient or TEST_LLM stub.',
    );
  }
}

/**
 * OpenAI Responses-style adapter stub — not chat/completions.
 * @extends {LlmClient}
 */
export class OpenAiResponsesLlmClient extends LlmClient {
  /** @param {LlmClientConfig} config */
  constructor(config) {
    super();
    this.config = config;
  }

  /** @param {ClassifyInput} _input */
  async classifyTopic(_input) {
    throw new Error(
      'OpenAiResponsesLlmClient: real classifyTopic not wired yet (Phase 2). Use MockLlmClient or TEST_LLM stub.',
    );
  }
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
