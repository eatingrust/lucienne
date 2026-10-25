import { createHash } from 'node:crypto';
import { ApifyPreparationError, buildApifyPreparationRequest, importApifyDataset } from './apify.js';
import type { ImportedOfficialDocument, OfficialDocumentSpec } from './apify.js';

const BASE = 'https://api.apify.com/v2/';
const ACTOR = 'apify~website-content-crawler';
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);
const STATUSES = new Set([...TERMINAL, 'READY', 'RUNNING', 'TIMING-OUT', 'ABORTING']);
const STORE_PATHS = { defaultDatasetId: 'datasets', defaultKeyValueStoreId: 'key-value-stores',
  defaultRequestQueueId: 'request-queues' } as const;
type StoreField = keyof typeof STORE_PATHS;
type Stores = Record<StoreField, string>;

export interface ApifyRunJournalEntry {
  phase: 'prepared' | 'create-pending' | 'create-received' | 'dataset-observed' | 'corpus-persisted' | 'additional-storage-verified' | 'cleanup-finished';
  at: string;
  ownershipVerified: boolean;
  runId?: string;
  stores?: Partial<Stores>;
  datasetMetadata?: { idMatches: boolean; ownerMatches: boolean; itemCount: number | null; cleanItemCount: number | null };
  additionalDataset?: { alias: 'errors'; id: string; ownerMatches: true; createdDuringRun: true; unnamed: true; itemCount: number | null };
}

export interface ApifyPreparationRunResult {
  provider: 'apify';
  retrievalSuccess: boolean;
  persistence: 'not-attempted' | 'saved' | 'failed-or-unknown';
  createOutcome: 'not-attempted' | 'unknown' | 'received-unverified' | 'owned';
  ownershipVerified: boolean;
  runId?: string;
  stores?: Partial<Stores>;
  documents?: ImportedOfficialDocument[];
  cleanup: {
    status: 'not-needed' | 'verified-absent' | 'blocked' | 'unknown';
    abortRequested: boolean;
    deletedStoreIds: string[];
    errorCodes: string[];
  };
  accounting: {
    status: 'not-observed' | 'reported-preliminary' | 'unavailable';
    /** Provider-reported run cost, not an invoice or a complete account-balance check. */
    usageTotalUsd?: number;
    exceedsRequestedRunCap?: boolean;
    errorCode?: string;
  };
  errorCodes: string[];
  requestsAttempted: number;
}

export interface ApifyRunnerInput {
  document: OfficialDocumentSpec;
  observedDocumentationVersion: string;
  token: string;
  expectedAccountId: string;
  expectedActorId: string;
  reviewedBuild: { id: string; number: string; inputSchemaSha256: string };
  /** Existing usable included allowance, supplied from the account observation. */
  confirmedIncludedCreditUsd: number;
  journal: (entry: ApifyRunJournalEntry, signal: AbortSignal) => Promise<void>;
  persistCorpus: (documents: ImportedOfficialDocument[], signal: AbortSignal) => Promise<void>;
}

export interface ApifyRunnerOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** May lower, never increase the reviewed bounds. */
  requestTimeoutMs?: number;
  callbackTimeoutMs?: number;
  maxPolls?: number;
}

function fail(code: string): never { throw new ApifyPreparationError(code); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function id(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9]{10,40}$/.test(value);
}
function safeCode(error: unknown): string {
  return error instanceof ApifyPreparationError ? error.code : 'unexpected_response';
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return fail('invalid_schema');
  return encoded;
}

/** Use this when recording the reviewed exact-build schema; object key order is immaterial. */
export function apifySchemaSha256(schema: unknown): string {
  return createHash('sha256').update(canonical(schema)).digest('hex');
}

async function boundedCallback(action: (signal: AbortSignal) => Promise<void>, timeoutMs: number, code: string): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => action(controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new ApifyPreparationError(code)); }, timeoutMs);
      }),
    ]);
  } catch { return fail(code); }
  finally { if (timer) clearTimeout(timer); controller.abort(); }
}

class Api {
  count = 0;
  private token: string;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  private callerSignal?: AbortSignal;
  constructor(token: string, options: ApifyRunnerOptions) {
    this.token = token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.requestTimeoutMs ?? 8_000;
    this.callerSignal = options.signal;
  }
  async call(method: 'GET' | 'POST' | 'DELETE', path: string, options: {
    body?: unknown; query?: Record<string, string | number | boolean>; absentOk?: boolean; cleanup?: boolean;
  } = {}): Promise<unknown> {
    if (!/^[A-Za-z0-9~/_-]+$/.test(path) || path.startsWith('/')) return fail('invalid_api_path');
    const query = new URLSearchParams(Object.entries(options.query ?? {}).map(([key, value]) => [key, String(value)]));
    const url = BASE + path + (query.size ? `?${query}` : '');
    const controller = new AbortController();
    const signal = !options.cleanup && this.callerSignal
      ? AbortSignal.any([controller.signal, this.callerSignal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => { void reader?.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted();
      this.count++;
      const response = await this.fetchImpl(url, { method, redirect: 'error', signal,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
      if (response.redirected || (response.url && response.url !== url)) return fail('unexpected_response_url');
      if (options.absentOk && response.status === 404) return null;
      if (!response.ok) return fail(`http_${response.status}`);
      if (!response.body) return null;
      if (Number(response.headers.get('content-length')) > 2_000_000) return fail('response_too_large');
      reader = response.body.getReader();
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read();
        signal.throwIfAborted();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 2_000_000) return fail('response_too_large');
        chunks.push(part.value);
      }
      return bytes === 0 ? null : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch (error) {
      if (error instanceof ApifyPreparationError) throw error;
      if (signal.aborted) return fail(!options.cleanup && this.callerSignal?.aborted ? 'cancelled' : 'request_timeout');
      return fail(error instanceof SyntaxError ? 'invalid_json' : 'transport_failure');
    } finally {
      clearTimeout(timer);
      controller.abort();
      signal.removeEventListener('abort', cancel);
      reader?.releaseLock();
    }
  }
}

function data(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.data)) return fail('invalid_response_shape');
  return value.data;
}
function assertOwned(run: Record<string, unknown>, input: ApifyRunnerInput, runId?: string): void {
  if (!id(run.id) || (runId !== undefined && run.id !== runId) || run.userId !== input.expectedAccountId
      || run.actId !== input.expectedActorId || run.buildId !== input.reviewedBuild.id) return fail('run_identity_mismatch');
}
function runStatus(run: Record<string, unknown>): string {
  if (typeof run.status !== 'string' || !STATUSES.has(run.status)) return fail('unknown_run_status');
  return run.status;
}
function storesFrom(run: Record<string, unknown>): Stores {
  const result: Partial<Stores> = {};
  for (const field of Object.keys(STORE_PATHS) as StoreField[]) {
    if (!id(run[field])) return fail('invalid_storage_identity');
    result[field] = run[field];
  }
  if (new Set(Object.values(result)).size !== 3) return fail('invalid_storage_identity');
  return result as Stores;
}
function assertStores(run: Record<string, unknown>, stores: Stores): void {
  if ((Object.keys(STORE_PATHS) as StoreField[]).some(field => run[field] !== stores[field])) return fail('storage_identity_mismatch');
}
function assertCaps(run: Record<string, unknown>): void {
  if (!isRecord(run.options) || run.options.timeoutSecs !== 60 || run.options.memoryMbytes !== 512
      || run.options.maxTotalChargeUsd !== 0.10) return fail('run_caps_unconfirmed');
}

/** One official document per run. Network preparation never belongs on Translate's critical path. */
export async function runApifyPreparation(input: ApifyRunnerInput, options: ApifyRunnerOptions = {}): Promise<ApifyPreparationRunResult> {
  const result: ApifyPreparationRunResult = { provider: 'apify', retrievalSuccess: false,
    persistence: 'not-attempted', createOutcome: 'not-attempted', ownershipVerified: false,
    cleanup: { status: 'not-needed', abortRequested: false, deletedStoreIds: [], errorCodes: [] },
    accounting: { status: 'not-observed' }, errorCodes: [], requestsAttempted: 0 };
  let api: Api | undefined;
  let ownedRunId: string | undefined;
  let stores: Stores | undefined;
  let run: Record<string, unknown> | undefined;
  const callbackTimeoutMs = options.callbackTimeoutMs ?? 5_000;
  const journal = async (phase: ApifyRunJournalEntry['phase'], observed: Pick<ApifyRunJournalEntry, 'datasetMetadata' | 'additionalDataset'> = {}) => {
    await boundedCallback(signal => input.journal({ phase, at: new Date().toISOString(),
      ownershipVerified: result.ownershipVerified,
      ...(result.runId ? { runId: result.runId } : {}), ...(result.stores ? { stores: { ...result.stores } } : {}), ...observed }, signal),
    callbackTimeoutMs, 'journal_failed_or_unknown');
  };
  try {
    const request = buildApifyPreparationRequest({ documents: [input.document], buildNumber: input.reviewedBuild.number });
    if (!id(input.expectedAccountId) || !id(input.expectedActorId) || !id(input.reviewedBuild.id)
        || !/^[a-f0-9]{64}$/.test(input.reviewedBuild.inputSchemaSha256)
        || typeof input.token !== 'string' || !/^[!-~]{8,8192}$/.test(input.token)
        || !Number.isFinite(input.confirmedIncludedCreditUsd) || input.confirmedIncludedCreditUsd < 0.20
        || input.observedDocumentationVersion !== input.document.documentationVersion
        || typeof input.journal !== 'function' || typeof input.persistCorpus !== 'function') return fail('invalid_runner_configuration');
    const maxPolls = options.maxPolls ?? 10;
    if (!Number.isSafeInteger(maxPolls) || maxPolls < 1 || maxPolls > 10
        || !Number.isSafeInteger(callbackTimeoutMs) || callbackTimeoutMs < 1 || callbackTimeoutMs > 5_000
        || !Number.isSafeInteger(options.requestTimeoutMs ?? 8_000)
        || (options.requestTimeoutMs ?? 8_000) < 1 || (options.requestTimeoutMs ?? 8_000) > 8_000) return fail('invalid_runner_limits');
    api = new Api(input.token, options);
    const account = data(await api.call('GET', 'users/me'));
    // isPaying is true on the observed credit-funded $0 plan; validate the actual base fee.
    if (account.id !== input.expectedAccountId || !isRecord(account.plan)
        || account.plan.isEnabled !== true || account.plan.monthlyBasePriceUsd !== 0) return fail('account_or_free_plan_mismatch');
    const actor = data(await api.call('GET', `actors/${ACTOR}`));
    if (actor.id !== input.expectedActorId || actor.username !== 'apify' || actor.name !== 'website-content-crawler') return fail('actor_identity_mismatch');
    if (Object.hasOwn(actor, 'pricingInfos')) {
      if (!Array.isArray(actor.pricingInfos)) return fail('actor_pricing_unverified');
      const now = Date.now();
      const prices = actor.pricingInfos.filter((price): price is Record<string, unknown> => isRecord(price)
        && typeof price.startedAt === 'string' && Number.isFinite(Date.parse(price.startedAt)) && Date.parse(price.startedAt) <= now);
      prices.sort((a, b) => Date.parse(b.startedAt as string) - Date.parse(a.startedAt as string));
      if (prices[0]?.pricingModel !== 'FREE') return fail('actor_pricing_unverified');
    } else {
      // Public Actor metadata can omit pricingInfos; the Store exposes currentPricingInfo.
      const store = data(await api.call('GET', 'store', { query: { search: 'website-content-crawler', limit: 20 } }));
      if (!Array.isArray(store.items) || store.items.length > 20) return fail('actor_pricing_unverified');
      const matches = store.items.filter((item): item is Record<string, unknown> => isRecord(item)
        && item.id === input.expectedActorId);
      if (matches.length !== 1 || matches[0].username !== actor.username || matches[0].name !== actor.name
          || !isRecord(matches[0].currentPricingInfo)
          || matches[0].currentPricingInfo.pricingModel !== 'FREE') return fail('actor_pricing_unverified');
    }
    const build = data(await api.call('GET', `actors/${ACTOR}/builds/default`));
    if (build.id !== input.reviewedBuild.id || build.buildNumber !== input.reviewedBuild.number || build.status !== 'SUCCEEDED') return fail('reviewed_build_mismatch');
    let schema: unknown = isRecord(build.actorDefinition) ? build.actorDefinition.input : undefined;
    if (schema === undefined) schema = build.inputSchema;
    if (typeof schema === 'string') {
      try { schema = JSON.parse(schema); } catch { return fail('invalid_schema'); }
    }
    if (!isRecord(schema) || !isRecord(schema.properties)
        || Object.keys(request.body).some(key => !Object.hasOwn(schema.properties as object, key))
        || apifySchemaSha256(schema) !== input.reviewedBuild.inputSchemaSha256) return fail('reviewed_schema_mismatch');
    const validation = await api.call('POST', `actors/${ACTOR}/validate-input`, { body: request.body,
      query: { build: input.reviewedBuild.number } });
    if (!isRecord(validation) || validation.valid !== true || Object.keys(validation).length !== 1) return fail('input_validation_unconfirmed');
    await journal('prepared');
    await journal('create-pending');
    result.createOutcome = 'unknown';
    result.cleanup.status = 'unknown';
    const created = await api.call('POST', `actors/${ACTOR}/runs`, { body: request.body, query: request.query });
    run = data(created);
    result.createOutcome = 'received-unverified';
    if (id(run.id)) result.runId = run.id;
    // Establish authority from this create response before any abort or delete is possible.
    try {
      assertOwned(run, input);
      ownedRunId = run.id as string;
      result.ownershipVerified = true;
      result.createOutcome = 'owned';
      const partial: Partial<Stores> = {};
      for (const field of Object.keys(STORE_PATHS) as StoreField[]) if (id(run[field])) partial[field] = run[field];
      result.stores = partial;
      stores = storesFrom(run);
    } finally {
      // Durable caller journal receives returned IDs before status/caps, polling, or data work.
      await journal('create-received');
    }
    assertCaps(run);
    const pollStarted = performance.now();
    for (let poll = 0; !TERMINAL.has(runStatus(run)) && poll < maxPolls && performance.now() - pollStarted < 55_000; poll++) {
      run = data(await api.call('GET', `actor-runs/${ownedRunId}`, { query: { waitForFinish: 5 } }));
      assertOwned(run, input, ownedRunId); assertStores(run, stores); assertCaps(run);
    }
    if (runStatus(run) !== 'SUCCEEDED') return fail(TERMINAL.has(runStatus(run)) ? 'run_not_succeeded' : 'poll_bound_reached');
    const metadata = data(await api.call('GET', `datasets/${stores.defaultDatasetId}`));
    const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
    const observed = { idMatches: metadata.id === stores.defaultDatasetId, ownerMatches: metadata.userId === input.expectedAccountId,
      itemCount: count(metadata.itemCount), cleanItemCount: count(metadata.cleanItemCount) };
    await journal('dataset-observed', { datasetMetadata: observed });
    if (!observed.idMatches || !observed.ownerMatches) return fail('dataset_identity_mismatch');
    // Metadata counts can lag by five seconds; actual unfiltered items establish the bounded count.
    const itemQuery = { format: 'json', limit: 2, clean: false };
    const items = await api.call('GET', `datasets/${stores.defaultDatasetId}/items`, { query: itemQuery });
    const again = await api.call('GET', `datasets/${stores.defaultDatasetId}/items`, { query: itemQuery });
    if (!Array.isArray(items) || !Array.isArray(again) || items.length !== 1 || again.length !== 1) return fail('dataset_item_count_mismatch');
    if (apifySchemaSha256(items) !== apifySchemaSha256(again)) return fail('unstable_dataset_readback');
    const documents = importApifyDataset({ documents: [input.document], run,
      expectedRun: { runId: ownedRunId, actorId: input.expectedActorId, buildId: input.reviewedBuild.id }, items,
      retrievedAt: new Date().toISOString(), observedDocumentVersions: { [input.document.url]: input.observedDocumentationVersion } });
    result.retrievalSuccess = true;
    result.persistence = 'failed-or-unknown';
    await boundedCallback(signal => input.persistCorpus(structuredClone(documents), signal), callbackTimeoutMs, 'corpus_persistence_failed_or_unknown');
    result.persistence = 'saved';
    result.documents = documents;
    await journal('corpus-persisted');
  } catch (error) {
    result.errorCodes.push(safeCode(error));
  } finally {
    if (ownedRunId && api) {
      // A caller cancellation must not prevent bounded cleanup of this verified owned run.
      try {
        run = data(await api.call('GET', `actor-runs/${ownedRunId}`, { cleanup: true }));
        assertOwned(run, input, ownedRunId);
        if (stores) assertStores(run, stores);
        if (!TERMINAL.has(runStatus(run))) {
          result.cleanup.abortRequested = true;
          run = data(await api.call('POST', `actor-runs/${ownedRunId}/abort`, { query: { gracefully: false }, cleanup: true }));
          assertOwned(run, input, ownedRunId);
          if (!TERMINAL.has(runStatus(run))) {
            run = data(await api.call('GET', `actor-runs/${ownedRunId}`, { query: { waitForFinish: 5 }, cleanup: true }));
            assertOwned(run, input, ownedRunId);
          }
        }
        if (!TERMINAL.has(runStatus(run))) returnCleanupFailure('run_termination_unverified');
        if (!stores) returnCleanupFailure('storage_ownership_unverified');
        assertStores(run, stores as Stores);
        // Accounting is independent from retrieval and cleanup. Immediate costs can be preliminary.
        let accountingStorageIds: unknown;
        try {
          const accountingRun = data(await api.call('GET', `actor-runs/${ownedRunId}`, { cleanup: true }));
          assertOwned(accountingRun, input, ownedRunId); assertStores(accountingRun, stores as Stores);
          if (!TERMINAL.has(runStatus(accountingRun))) return fail('run_termination_unverified');
          accountingStorageIds = accountingRun.storageIds;
          if (typeof accountingRun.usageTotalUsd !== 'number' || !Number.isFinite(accountingRun.usageTotalUsd)
              || accountingRun.usageTotalUsd < 0) return fail('usage_unavailable');
          result.accounting = { status: 'reported-preliminary', usageTotalUsd: accountingRun.usageTotalUsd,
            exceedsRequestedRunCap: accountingRun.usageTotalUsd > 0.10 };
        } catch (error) {
          result.accounting = { status: 'unavailable', errorCode: safeCode(error) };
          // Conflicting fresh identity/state evidence is a cleanup blocker, not just a missing cost.
          if (['run_identity_mismatch', 'storage_identity_mismatch', 'unknown_run_status', 'run_termination_unverified'].includes(safeCode(error))) throw error;
        }
        let errorsDatasetId: string | undefined;
        let hasUnreviewedAlias = false;
        const groups = { datasets: 'defaultDatasetId', keyValueStores: 'defaultKeyValueStoreId', requestQueues: 'defaultRequestQueueId' } as const;
        function inspectStorageIds(value: unknown): void {
          if (value === undefined) return;
          if (!isRecord(value)) returnCleanupFailure('unrecognized_storage_report');
          for (const [group, aliases] of Object.entries(value as Record<string, unknown>)) {
            if (!Object.hasOwn(groups, group) || !isRecord(aliases)
                || Object.keys(aliases).length > 20) returnCleanupFailure('unrecognized_storage_report');
            const expectedDefault = (stores as Stores)[groups[group as keyof typeof groups]];
            if ((aliases as Record<string, unknown>).default !== expectedDefault) returnCleanupFailure('storage_identity_mismatch');
            for (const [alias, storeId] of Object.entries(aliases as Record<string, unknown>)) {
              if (!/^[A-Za-z0-9_-]{1,80}$/.test(alias) || !id(storeId)) returnCleanupFailure('unrecognized_storage_report');
              if (alias === 'default') continue;
              if (group === 'datasets' && alias === 'errors') {
                if (Object.values(stores as Stores).includes(storeId as string)
                    || (errorsDatasetId !== undefined && errorsDatasetId !== storeId)) returnCleanupFailure('storage_identity_mismatch');
                errorsDatasetId = storeId as string;
              } else hasUnreviewedAlias = true;
            }
          }
        }
        inspectStorageIds(run.storageIds);
        inspectStorageIds(accountingStorageIds);
        if (hasUnreviewedAlias) returnCleanupFailure('additional_storage_unresolved');
        if (errorsDatasetId) {
          const extra = data(await api.call('GET', `datasets/${errorsDatasetId}`, { cleanup: true }));
          const createdAt = typeof extra.createdAt === 'string' ? Date.parse(extra.createdAt) : NaN;
          const startedAt = typeof run.startedAt === 'string' ? Date.parse(run.startedAt) : NaN;
          const finishedAt = typeof run.finishedAt === 'string' ? Date.parse(run.finishedAt) : NaN;
          if (extra.id !== errorsDatasetId || extra.userId !== input.expectedAccountId
              || (extra.name !== undefined && extra.name !== null)
              || !Number.isFinite(createdAt) || !Number.isFinite(startedAt) || !Number.isFinite(finishedAt)
              || createdAt < startedAt || createdAt > finishedAt) returnCleanupFailure('additional_storage_ownership_unverified');
          await journal('additional-storage-verified', { additionalDataset: { alias: 'errors', id: errorsDatasetId,
            ownerMatches: true, createdDuringRun: true, unnamed: true,
            itemCount: typeof extra.itemCount === 'number' && Number.isSafeInteger(extra.itemCount) && extra.itemCount >= 0 ? extra.itemCount : null } });
        }
        for (const field of Object.keys(STORE_PATHS) as StoreField[]) {
          const storeId = (stores as Stores)[field];
          const path = `${STORE_PATHS[field]}/${storeId}`;
          await api.call('DELETE', path, { absentOk: true, cleanup: true });
          if (await api.call('GET', path, { absentOk: true, cleanup: true }) !== null) returnCleanupFailure('storage_deletion_unverified');
          result.cleanup.deletedStoreIds.push(storeId);
        }
        if (errorsDatasetId) {
          const path = `datasets/${errorsDatasetId}`;
          await api.call('DELETE', path, { absentOk: true, cleanup: true });
          if (await api.call('GET', path, { absentOk: true, cleanup: true }) !== null) returnCleanupFailure('storage_deletion_unverified');
          result.cleanup.deletedStoreIds.push(errorsDatasetId);
        }
        await api.call('DELETE', `actor-runs/${ownedRunId}`, { cleanup: true });
        if (await api.call('GET', `actor-runs/${ownedRunId}`, { absentOk: true, cleanup: true }) !== null) returnCleanupFailure('run_deletion_unverified');
        result.cleanup.status = 'verified-absent';
      } catch (error) {
        result.cleanup.status = 'blocked';
        result.cleanup.errorCodes.push(safeCode(error));
      }
      try { await journal('cleanup-finished'); }
      catch (error) { result.errorCodes.push(safeCode(error)); }
    } else if (result.createOutcome !== 'not-attempted') {
      result.cleanup.status = 'unknown';
    }
    result.requestsAttempted = api?.count ?? 0;
  }
  return result;
}

function returnCleanupFailure(code: string): never { return fail(code); }
