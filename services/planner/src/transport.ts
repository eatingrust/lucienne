/** Internal transport seam. Product request/patch contracts belong to host. */
export interface StructuredRequest {
  prompt: string;
  schema: Record<string, unknown>;
}

export interface TransportOptions {
  signal?: AbortSignal;
  onProgress?: (event: { phase: string }) => void;
}

export interface TransportResult {
  value: unknown;
  provenance: {
    mode: 'live';
    provider: string;
    model?: string;
    sessionId?: string;
  };
}

/** No tools, writes, native adapter access, retry, or fallback are exposed here. */
export interface StructuredTransport {
  generate(request: StructuredRequest, options?: TransportOptions): Promise<TransportResult>;
}
