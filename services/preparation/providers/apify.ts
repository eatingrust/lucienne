import { createHash } from 'node:crypto';

const ACTOR_URL = 'https://api.apify.com/v2/actors/apify~website-content-crawler/runs';
const OFFICIAL_HOSTS = new Set(['helpx.adobe.com', 'docs.krita.org', 'docs.blender.org',
  'docs.kdenlive.org', 'www.reaper.fm', 'docs.gimp.org', 'documents.blackmagicdesign.com']);
const MAX_DOCUMENTS = 12;
const MAX_MARKDOWN_BYTES = 256 * 1024;

export interface OfficialDocumentSpec {
  id: string;
  url: string;
  appId: string;
  /** Version of the retrieved manual, never substituted with the installed app version. */
  documentationVersion: string;
  targetAppVersion: string;
  expectedTopic: string;
}

export interface ImportedOfficialDocument extends OfficialDocumentSpec {
  provider: 'apify';
  provenance: 'official-documentation';
  nativeCompatibility: 'unverified';
  markdown: string;
  sha256: string;
  retrievedAt: string;
  runId: string;
  actorId: string;
  buildId: string;
}

export class ApifyPreparationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Apify preparation failed: ${code}`);
    this.name = 'ApifyPreparationError';
    this.code = code;
  }
}

function fail(code: string): never { throw new ApifyPreparationError(code); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max = 160): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}
function safeUrl(value: unknown): value is string {
  if (!text(value, 2048)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && OFFICIAL_HOSTS.has(url.hostname) && !url.port
      && !url.username && !url.password && !url.search && !url.hash && url.href === value;
  } catch { return false; }
}
function validateSpecs(documents: readonly OfficialDocumentSpec[]): void {
  if (!Array.isArray(documents) || documents.length < 1 || documents.length > MAX_DOCUMENTS) return fail('invalid_document_count');
  const ids = new Set<string>(), urls = new Set<string>();
  for (const document of documents) {
    if (!record(document) || !text(document.id) || !/^[a-zA-Z0-9._-]+$/.test(document.id)
        || !safeUrl(document.url) || !text(document.appId) || !text(document.documentationVersion)
        || !text(document.targetAppVersion) || !text(document.expectedTopic, 200)) return fail('invalid_document_specification');
    if (ids.has(document.id) || urls.has(document.url)) return fail('duplicate_document');
    ids.add(document.id); urls.add(document.url);
  }
}

/** Builds a reviewable request only. It never starts a crawl or claims provider success. */
export function buildApifyPreparationRequest(input: {
  documents: readonly OfficialDocumentSpec[];
  buildNumber: string;
}) {
  validateSpecs(input.documents);
  if (!/^\d+\.\d+\.\d+$/.test(input.buildNumber)) return fail('invalid_build_number');
  return {
    liveExecuted: false as const,
    url: ACTOR_URL,
    method: 'POST' as const,
    query: { build: input.buildNumber, timeout: 60, memory: 512, maxTotalChargeUsd: 0.10, restartOnError: false },
    body: {
      startUrls: input.documents.map(document => ({ url: document.url })),
      crawlerType: 'cheerio', maxCrawlDepth: 0, maxCrawlPages: input.documents.length,
      initialConcurrency: 1, maxConcurrency: 1, requestTimeoutSecs: 20,
      maxRequestRetries: 0, maxSessionRotations: 0, useSitemaps: false, useLlmsTxt: false,
      respectRobotsTxtFile: true, proxyConfiguration: { useApifyProxy: true },
      saveMarkdown: true, saveHtml: false, saveFiles: false, saveContentTypes: '',
      saveScreenshots: false, summarize: false,
    },
  };
}

/** Import a completed, identity-verified dataset before its disposable remote stores are removed. */
export function importApifyDataset(input: {
  documents: readonly OfficialDocumentSpec[];
  run: unknown;
  expectedRun: { runId: string; actorId: string; buildId: string };
  items: unknown;
  retrievedAt: string;
  /** Independently reviewed version evidence per URL, not a model inference or installed version. */
  observedDocumentVersions: Readonly<Record<string, string>>;
}): ImportedOfficialDocument[] {
  validateSpecs(input.documents);
  if (!record(input.expectedRun) || !Object.values(input.expectedRun).every(value => text(value))
      || !text(input.expectedRun.runId) || !text(input.expectedRun.actorId) || !text(input.expectedRun.buildId)
      || !record(input.run)) return fail('invalid_run_identity');
  if (input.run.id !== input.expectedRun.runId || input.run.actId !== input.expectedRun.actorId
      || input.run.buildId !== input.expectedRun.buildId) return fail('run_identity_mismatch');
  const statuses = ['READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMING-OUT', 'TIMED-OUT', 'ABORTING', 'ABORTED'];
  if (typeof input.run.status !== 'string' || !statuses.includes(input.run.status)) return fail('unknown_run_status');
  if (input.run.status !== 'SUCCEEDED') return fail('run_not_succeeded');
  if (!text(input.retrievedAt) || !Number.isFinite(Date.parse(input.retrievedAt))) return fail('invalid_retrieval_time');
  if (!Array.isArray(input.items) || input.items.length !== input.documents.length
      || !record(input.observedDocumentVersions)) return fail('invalid_dataset_shape');
  const specs = new Map(input.documents.map(document => [document.url, document]));
  const seen = new Set<string>();
  const result: ImportedOfficialDocument[] = [];
  for (const item of input.items) {
    if (!record(item) || !safeUrl(item.url) || !record(item.crawl) || item.crawl.loadedUrl !== item.url) return fail('unexpected_document_url');
    const document = specs.get(item.url);
    if (!document) return fail('unexpected_document_url');
    if (seen.has(document.id)) return fail('duplicate_document');
    seen.add(document.id);
    if (input.observedDocumentVersions[item.url] !== document.documentationVersion
        || (item.documentationVersion !== undefined && item.documentationVersion !== document.documentationVersion)) {
      return fail('documentation_version_mismatch');
    }
    const markdown = item.markdown;
    if (typeof markdown !== 'string' || Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN_BYTES
        || /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(markdown)
        || markdown.replace(/<[^>]*>/g, '').replace(/[\s#*_`~>\-]+/g, '').length < 40) return fail('invalid_markdown');
    if (!markdown.toLowerCase().includes(document.expectedTopic.toLowerCase())) return fail('expected_topic_missing');
    // Copy only the allowlisted, reviewed provenance and source text, never dataset-supplied preferences.
    result.push({ id: document.id, url: document.url, appId: document.appId,
      documentationVersion: document.documentationVersion, targetAppVersion: document.targetAppVersion,
      expectedTopic: document.expectedTopic, provider: 'apify', provenance: 'official-documentation',
      nativeCompatibility: 'unverified', markdown,
      sha256: createHash('sha256').update(markdown, 'utf8').digest('hex'), retrievedAt: input.retrievedAt,
      runId: input.expectedRun.runId, actorId: input.expectedRun.actorId, buildId: input.expectedRun.buildId });
  }
  return result;
}
