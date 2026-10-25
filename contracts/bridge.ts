import { z } from 'zod';
import { ChatIntentSchema, QuizResultSchema, QuizTurnSchema } from './index.js';
import type { BindingApplicability, Capability, ChatIntent, SourceApp, SourceProfile, Target, TargetApp } from './index.js';
import type { SessionSnapshot } from '../core/session.js';
import type { SourceThumbnail } from '../profiles/source-thumbnails.js';
const quizId = z.string().min(1).max(160).regex(/^[a-zA-Z0-9._:/-]+$/);
const quizSource = { sourceProfileId: quizId, sourceRevision: quizId };
const quizIdentity = { ...quizSource, quizId: z.string().uuid(), requestId: z.string().uuid() };
export const CommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('select-fixture') }),
  z.strictObject({ type: z.literal('select-krita') }),
  z.strictObject({ type: z.literal('select-scenario'), scenarioId: z.string().min(1).max(160).regex(/^[a-zA-Z0-9-]+$/) }),
  z.strictObject({ type: z.literal('start-native-qa') }),
  z.strictObject({ type: z.literal('complete-qa-step'), id: z.string().uuid() }),
  z.strictObject({ type: z.literal('translate') }),
  z.strictObject({ type: z.literal('open-chat') }),
  z.strictObject({ type: z.literal('chat'), intent: ChatIntentSchema }),
  z.strictObject({ type: z.literal('close-chat') }),
  z.strictObject({ type: z.literal('preparation-status') }),
  z.strictObject({ type: z.literal('prepare-context'),
    recipe: z.enum(['source-reference', 'target-reference', 'persona', 'apify-reference']),
    retrieval: z.enum(['local-curated', 'moss']) }),
  z.strictObject({ type: z.literal('cancel-preparation') }),
  z.strictObject({ type: z.literal('quiz-start'), ...quizSource }),
  z.strictObject({ type: z.literal('quiz-answer'), ...quizIdentity, text: z.string().trim().min(1).max(2000) }),
  z.strictObject({ type: z.literal('quiz-cancel'), ...quizIdentity }),
  z.strictObject({ type: z.literal('quiz-accept'), ...quizIdentity, resultRevision: quizId }),
  z.strictObject({ type: z.literal('reset') }),
]);
export type Command = z.infer<typeof CommandSchema>;
export interface RuntimeScenario {
  readonly scenarioId: string; readonly qaCaseId: string; readonly profileId: string; readonly personaId: string;
  readonly label: string; readonly sourceApp: SourceApp; readonly targetApp: TargetApp;
  readonly source: SourceProfile; readonly target: Target; readonly catalog: readonly Capability[];
  readonly bindingApplicability?: BindingApplicability; readonly trustedEvidenceRefs: readonly string[];
  readonly sourceThumbnail: SourceThumbnail;
  readonly selectable: boolean; readonly reasonCode: string | null; readonly reason: string | null;
  readonly initialModes: readonly ('live' | 'prepared')[];
  readonly chatIntents: readonly { readonly intent: ChatIntent; readonly label: string; readonly instruction: string }[];
  readonly nativeStatus: 'not-run';
}
export interface RuntimeCatalog { readonly profiles: readonly SourceProfile[]; readonly cases: readonly RuntimeScenario[] }
export interface RuntimeSelection {
  scenarioId: string; profileId: string; profileRevision: string; sourceApp: SourceApp; target: Target;
  planner: { mode: 'live' | 'prepared' | 'replay' | 'simulated'; provider: string };
}
export interface RuntimeServices {
  session: { status: 'starting' | 'connected' | 'offline' | 'overflow' | 'closed' | 'disabled' | 'unavailable'; queued: number };
  preparation: {
    status: 'starting' | 'available' | 'unavailable' | 'recovery-required' | 'closed';
    mode: 'local' | 'hosted'; busy: boolean; recoveryRequired: boolean; code: string | null;
    capabilities: { context: 'local-curated'; moss: boolean; quiz: boolean; image: boolean; apifyArtifact: boolean };
    context: { status: 'none' | 'preparing' | 'ready' | 'failed';
      recipe: 'source-reference' | 'target-reference' | 'persona' | 'apify-reference' | null;
      retrieval: 'local-curated' | 'moss' | null; evidenceCount: number };
  };
}
export interface RuntimeQuiz {
  available: boolean; recoveryRequired: boolean; resetKey: number;
  state: {
    quizId: string; requestId: string; sourceProfileId: string; sourceRevision: string;
    status: 'idle' | 'running' | 'question' | 'complete' | 'error' | 'cancelled';
    turns: z.infer<typeof QuizTurnSchema>[]; result: z.infer<typeof QuizResultSchema> | null; errorCode: string | null;
  } | null;
}
export interface RuntimeState {
  fixtureEnabled: boolean; nativeAdapterAvailable: boolean; nativePrepared: boolean;
  nativeStartupError: string | null; chatAvailable: boolean; snapshot: SessionSnapshot;
  qa: { enabled: boolean; running: boolean; stage: string; pending: { id: string; instruction: string } | null; result: string | null };
  /** Optional for older fixture clients; all rows are authored by the trusted main process. */
  catalog?: RuntimeCatalog; selection?: RuntimeSelection | null;
  desktopBlockers?: Array<{ appId: string; pid: number; layer: number }>;
  /** Main-owned summaries only; never endpoints, credentials, job payloads or pairing capabilities. */
  services?: RuntimeServices;
  quiz?: RuntimeQuiz;
}
export interface DesktopBridge {
  getState(): Promise<RuntimeState>;
  command(command: Command): Promise<{ ok: boolean; code?: string }>;
  subscribe(listener: (state: RuntimeState) => void): () => void;
}
