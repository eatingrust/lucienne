/** Direct Messages transport. The caller must validate `value` with host contracts. */
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';
const APPROVED_MODEL = 'claude-opus-5-5';
const MAX_REQUEST_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 131_072;
const MAX_JSON_BYTES = 65_536;

type SchemaRequest = { prompt: string; schema: Record<string, unknown> };
type GenerateOptions = {
  signal?: AbortSignal;
  onProgress?: (event: { phase: string }) => void;
};
type ClaudeOptions = {
  apiKey?: string;
  modelId?: string;
  workspaceId?: string;
  timeoutMs?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  onDiagnostics?: (diagnostics: ClaudeResponseDiagnostics) => void;
};

export interface ClaudeResponseDiagnostics {
  model: string;
  stopReason: string;
  blockCount: number | null;
  blockTypes: { text: number; thinking: number; redacted_thinking: number; tool_use: number; server_tool_use: number; other: number };
}

/** Errors contain stable codes only; no provider response, prompt, or secret. */
export class ClaudeTransportError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'ClaudeTransportError';
    this.code = code;
  }
}

function fail(code: string): never { throw new ClaudeTransportError(code); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function headerValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192
    && !/[\s\x00-\x1f\x7f]/.test(value);
}

/**
 * Claude's grammar accepts a JSON Schema subset. Lower only documented numeric,
 * string-length and array constraints; host validates the original schema locally.
 * https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 */
export function lowerClaudeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  let wire: unknown;
  try { wire = JSON.parse(JSON.stringify(schema)); } catch { fail('CLAUDE_REQUEST_INVALID'); }
  if (!object(wire)) fail('CLAUDE_REQUEST_INVALID');
  const unsupported = [
    'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
    'minLength', 'maxLength', 'maxItems', 'uniqueItems', 'minContains', 'maxContains',
  ];
  const visit = (node: unknown): void => {
    if (!object(node)) return;
    const constraints: Record<string, unknown> = {};
    for (const key of unsupported) {
      if (Object.hasOwn(node, key)) { constraints[key] = node[key]; delete node[key]; }
    }
    if (Object.hasOwn(node, 'minItems') && node.minItems !== 0 && node.minItems !== 1) {
      constraints.minItems = node.minItems;
      delete node.minItems;
    }
    if (Object.keys(constraints).length) {
      const hint = `Locally validated constraints: ${JSON.stringify(constraints)}.`;
      node.description = typeof node.description === 'string' ? `${node.description}\n${hint}` : hint;
    }
    // Traverse schema positions only: an actual property named `maxLength`, or a
    // literal object in enum/const/default, must not be rewritten as a keyword.
    for (const key of ['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas']) {
      if (object(node[key])) for (const child of Object.values(node[key])) visit(child);
    }
    for (const key of ['items', 'additionalProperties', 'unevaluatedProperties', 'contains', 'not', 'if', 'then', 'else', 'propertyNames']) {
      if (Array.isArray(node[key])) node[key].forEach(visit);
      else visit(node[key]);
    }
    for (const key of ['anyOf', 'allOf', 'oneOf', 'prefixItems']) {
      if (Array.isArray(node[key])) node[key].forEach(visit);
    }
  };
  visit(wire);
  return wire;
}

async function readBounded(response: Response, signal: AbortSignal): Promise<string> {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => {});
    fail('CLAUDE_OUTPUT_TOO_LARGE');
  }
  if (!response.body) fail('CLAUDE_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        cancel();
        fail('CLAUDE_OUTPUT_TOO_LARGE');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function parseResponse(raw: string, modelId: string, onDiagnostics: (diagnostics: ClaudeResponseDiagnostics) => void) {
  let envelope: unknown;
  try { envelope = JSON.parse(raw); } catch { fail('CLAUDE_RESPONSE_INVALID'); }
  if (!object(envelope) || envelope.type !== 'message' || envelope.role !== 'assistant') {
    fail('CLAUDE_RESPONSE_INVALID');
  }
  const blockTypes = { text: 0, thinking: 0, redacted_thinking: 0, tool_use: 0, server_tool_use: 0, other: 0 };
  if (Array.isArray(envelope.content)) for (const block of envelope.content) {
    const type = object(block) && typeof block.type === 'string' && Object.hasOwn(blockTypes, block.type)
      ? block.type as keyof typeof blockTypes : 'other';
    blockTypes[type]++;
  }
  const knownStops = ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal', 'model_context_window_exceeded'];
  try { onDiagnostics({
    model: envelope.model === modelId ? modelId : 'unexpected',
    stopReason: typeof envelope.stop_reason === 'string' && knownStops.includes(envelope.stop_reason) ? envelope.stop_reason : 'other',
    blockCount: Array.isArray(envelope.content) ? envelope.content.length : null,
    blockTypes,
  }); } catch {}
  if (envelope.model !== modelId) fail('CLAUDE_MODEL_MISMATCH');
  if (envelope.stop_reason === 'refusal'
    || (object(envelope.stop_details) && envelope.stop_details.type === 'refusal')) {
    fail('CLAUDE_REFUSED');
  }
  if (envelope.stop_reason === 'max_tokens') fail('CLAUDE_OUTPUT_TRUNCATED');
  if (envelope.stop_reason !== 'end_turn') fail('CLAUDE_RESPONSE_INCOMPLETE');
  if (!Array.isArray(envelope.content)) fail('CLAUDE_UNEXPECTED_CONTENT');
  let jsonText: string | undefined;
  // Opus 5.5 always uses adaptive thinking, including an opaque thinking block
  // when its display is omitted. Read exactly one answer; never retain thinking.
  // https://platform.claude.com/docs/en/build-with-claude/thinking
  for (const block of envelope.content) {
    if (!object(block)) fail('CLAUDE_UNEXPECTED_CONTENT');
    if (block.type === 'text' && typeof block.text === 'string' && jsonText === undefined) jsonText = block.text;
    else if (block.type === 'thinking' && typeof block.thinking === 'string' && typeof block.signature === 'string') continue;
    else if (block.type === 'redacted_thinking' && typeof block.data === 'string') continue;
    else fail('CLAUDE_UNEXPECTED_CONTENT');
  }
  if (jsonText === undefined) fail('CLAUDE_UNEXPECTED_CONTENT');
  if (new TextEncoder().encode(jsonText).byteLength > MAX_JSON_BYTES) {
    fail('CLAUDE_OUTPUT_TOO_LARGE');
  }
  let value: unknown;
  try { value = JSON.parse(jsonText); } catch { fail('CLAUDE_JSON_INVALID'); }
  // The provider ID is metadata, never model-supplied content or display text.
  const sessionId = typeof envelope.id === 'string'
    && /^msg_[A-Za-z0-9_-]{1,128}$/.test(envelope.id) ? envelope.id : undefined;
  if (!sessionId) fail('CLAUDE_RESPONSE_INVALID');
  return { value, provenance: {
    mode: 'live' as const, provider: 'claude' as const, model: modelId, sessionId,
  } };
}

export function createClaudeTransport({
  apiKey, modelId = APPROVED_MODEL, workspaceId,
  timeoutMs = 30_000, maxTokens = 2048, fetchImpl = fetch,
  onDiagnostics = () => {},
}: ClaudeOptions = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    fail('CLAUDE_INVALID_TIMEOUT');
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
    fail('CLAUDE_INVALID_TOKEN_LIMIT');
  }
  // The planner requires Opus 5.5 or better. Pin the verified model until another model
  // is explicitly verified and approved; never downgrade or silently substitute.
  if (modelId !== APPROVED_MODEL) {
    fail('CLAUDE_INVALID_MODEL');
  }
  if (workspaceId !== undefined && !headerValue(workspaceId)) fail('CLAUDE_INVALID_WORKSPACE');

  return {
    mode: 'live' as const,
    provider: 'claude' as const,
    async generate(request: SchemaRequest, { signal, onProgress = () => {} }: GenerateOptions = {}) {
      if (signal?.aborted) fail('CLAUDE_CANCELLED');
      if (!headerValue(apiKey)) fail('CLAUDE_AUTH_REQUIRED');
      if (!object(request) || typeof request.prompt !== 'string' || !request.prompt.trim()
        || !object(request.schema)) fail('CLAUDE_REQUEST_INVALID');
      let body: string;
      try {
        body = JSON.stringify({
          model: modelId, max_tokens: maxTokens, stream: false,
          messages: [{ role: 'user', content: request.prompt }],
          output_config: { format: { type: 'json_schema', schema: lowerClaudeSchema(request.schema) } },
        });
      } catch { fail('CLAUDE_REQUEST_INVALID'); }
      if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) fail('CLAUDE_INPUT_TOO_LARGE');
      const controller = new AbortController();
      const cancel = () => controller.abort(new ClaudeTransportError('CLAUDE_CANCELLED'));
      signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => controller.abort(new ClaudeTransportError('CLAUDE_TIMEOUT')), timeoutMs);
      let abortListener: (() => void) | undefined;
      const interrupted = new Promise<never>((_, reject) => {
        abortListener = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', abortListener, { once: true });
      });
      const progress = (phase: string) => {
        if (!controller.signal.aborted) { try { onProgress({ phase }); } catch {} }
      };
      const operation = async () => {
        controller.signal.throwIfAborted();
        progress('request-started');
        controller.signal.throwIfAborted();
        const response = await fetchImpl(MESSAGES_URL, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: {
            'content-type': 'application/json', 'anthropic-version': API_VERSION,
            Authorization: `Bearer ${apiKey}`,
            ...(workspaceId ? { 'anthropic-workspace-id': workspaceId } : {}),
          },
          body,
        });
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          controller.signal.throwIfAborted();
        }
        if (response.redirected || (response.url && response.url !== MESSAGES_URL)) {
          void response.body?.cancel().catch(() => {});
          fail('CLAUDE_REDIRECT_REJECTED');
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          fail(response.status === 401 || response.status === 403 ? 'CLAUDE_AUTH_FAILED'
            : response.status === 429 ? 'CLAUDE_RATE_LIMITED' : 'CLAUDE_HTTP_FAILED');
        }
        const raw = await readBounded(response, controller.signal);
        controller.signal.throwIfAborted();
        const result = parseResponse(raw, modelId, onDiagnostics);
        progress('response-received');
        controller.signal.throwIfAborted();
        return result;
      };
      try {
        if (signal?.aborted) cancel();
        return await Promise.race([operation(), interrupted]);
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (error instanceof ClaudeTransportError) throw error;
        fail('CLAUDE_REQUEST_FAILED');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (abortListener) controller.signal.removeEventListener('abort', abortListener);
      }
    },
  };
}
