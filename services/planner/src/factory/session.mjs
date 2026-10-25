// Receives the host-authored prompt and structured output schema.
// This returns unknown data. host validation owns product semantics; no native writes.

import {FACTORY_INFERENCE_MODEL, assertFactoryInferenceModel} from './model.mjs';
import {PINNED_DISABLED_TOOL_IDS} from './tool-registry.mjs';
export const supplementalDisabledToolIds = PINNED_DISABLED_TOOL_IDS;

export async function runFactorySession({prompt, schema}, {execPath, cwd, signal, modelId = FACTORY_INFERENCE_MODEL, onProgress = () => {}, onLifecycle = () => {}, sdkLoader = () => import('@factory/droid-sdk/node')} = {}) {
  signal?.throwIfAborted();
  assertFactoryInferenceModel(modelId);
  const {createSession, AutonomyLevel, ToolConfirmationOutcome, OutputFormatType} = await sdkLoader();
  signal?.throwIfAborted();
  let session;
  const started = performance.now();
  let sessionReadyMs = null, firstModelProgressMs = null;
  let stage = 'initialization';
  let deniedPermissions = 0;
  const diagnosticFlags = new Set();
  const diagnosticLog = event => {
    const text=JSON.stringify(event);
    const categories={tls:/certificate|TLS|CERT_/i,permission:/EACCES|EPERM|operation not permitted/i,authentication:/unauthorized|invalid.{0,8}api.{0,5}key|authentication failed/i,network:/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONN|network error/i,orgPolicyJoin:/org_policy_join|waitForOrgSettingsApplied/i,cloudDefaults:/cloud.{0,2}session.{0,2}defaults/i,schema:/invalid.{0,8}schema|parse error/i};
    for(const [category,pattern] of Object.entries(categories))if(pattern.test(text)&&!diagnosticFlags.has(category)){
      diagnosticFlags.add(category);try{onLifecycle({phase:'diagnostic-category',category});}catch{}
    }
  };
  const progress = (phase) => {
    if (phase === 'planner-ready') sessionReadyMs = performance.now() - started;
    if (phase === 'model-progress' && firstModelProgressMs === null) firstModelProgressMs = performance.now() - started;
    try {onProgress({phase});} catch {}
  };
  try {
    session = await createSession({
      execPath, cwd, abortSignal: signal, modelId,
      autonomyLevel: AutonomyLevel.Off,
      disableBuiltinSkills: true,
      mcpServers: [],
      observability:{logger:{log:diagnosticLog}},
      permissionHandler() { deniedPermissions++; return ToolConfirmationOutcome.Cancel; },
    });
    const verifyModel = () => { if (session.settings?.modelId !== modelId) throw new Error('FACTORY_MODEL_MISMATCH'); };
    stage = 'model-verification';
    verifyModel();
    stage = 'tool-inventory';
    session.onNotification?.(diagnosticLog);
    try {onLifecycle({phase:'session-created',sessionId:session.id,model:session.settings?.modelId});} catch {}
    // These model IDs request hypothetical TOOL INVENTORIES only; no inference or model switch.
    // Inventory across model families catches deferred tools omitted by the active Opus model.
    const inventories = await Promise.all([undefined, 'gpt-6.1-sol', 'gemini-3.8-flash'].map(modelId => session.listTools({includeSchemas:true, ...(modelId ? {modelId} : {})})));
    if (inventories.some(items => !Array.isArray(items) || items.some(t => !t || typeof t.id !== 'string' || !t.id || typeof t.allowed !== 'boolean'))) throw new Error('FACTORY_TOOL_INVENTORY_INVALID');
    const inventory = [...new Map(inventories.flat().map(t=>[t.id,t])).values()];
    await session.updateSettings({autonomyLevel: AutonomyLevel.Off, disabledToolIds: [...new Set([...inventory.map(t => t.id), ...supplementalDisabledToolIds])]});
    const after = await session.listTools({includeSchemas: true});
    try {onLifecycle({phase:'tool-control-checked',before:inventory.map(t=>({id:t.id,allowed:t.allowed})),after:Array.isArray(after)?after.map(t=>t && ({id:t.id,allowed:t.allowed})):null,disabledToolIds:session.settings?.disabledToolIds});} catch {}
    if (!Array.isArray(after) || after.some(t => !t || typeof t.id !== 'string' || t.allowed !== false)) throw new Error('FACTORY_TOOLS_NOT_DISABLED');
    signal?.throwIfAborted();
    verifyModel();
    progress('planner-ready');
    verifyModel();
    let result;
    stage = 'inference';
    for await (const event of session.stream(prompt, {abortSignal: signal, includePartialMessages:true, outputFormat: {type: OutputFormatType.JsonSchema, schema}})) {
      signal?.throwIfAborted();
      // Never retain assistant/thinking/tool bodies or provider error strings.
      if (event.type === 'tool_call' || event.type === 'hook') throw new Error('FACTORY_UNEXPECTED_AUTHORITY');
      if (event.type === 'result') result = event;
      else if (event.type === 'user') progress('prompt-accepted');
      else if (['assistant', 'assistant_text_delta', 'thinking_text_delta'].includes(event.type) && firstModelProgressMs === null) {
        try {onLifecycle({phase:'first-model-event',eventType:event.type});} catch {}
        progress('model-progress');
      }
    }
    verifyModel();
    stage = 'structured-result';
    if (!result?.success || result.structuredOutput == null) {
      const error=new Error('FACTORY_NO_VALID_RESULT');
      error.resultSubtype=typeof result?.subtype==='string'?result.subtype:undefined;
      error.structuredCode=typeof result?.structuredOutputError?.code==='string'?result.structuredOutputError.code:undefined;
      throw error;
    }
    const value = result.structuredOutput;
    const provenance = {mode:'live', provider:'factory', sessionId:session.id};
    provenance.model = modelId;
    return {value, provenance, metrics:{elapsedMs:performance.now()-started, sessionReadyMs, firstModelProgressMs, sdkDurationMs:result.durationMs, tokenUsage:Object.fromEntries(Object.entries(result.tokenUsage??{}).filter(([,v])=>typeof v==='number')), deniedPermissions, toolInventory:inventory.map(t=>({id:t.id,allowed:t.allowed})), toolsAfterDisable:after.map(t=>t && ({id:t.id,allowed:t.allowed}))}};
  } catch(error) {
    error.stage=stage;throw error;
  } finally {
    // The outer process supervisor provides a hard stop if SDK cleanup stalls.
    if (session) {
      await session.close();
      try {onLifecycle({phase:'sdk-closed'});} catch {}
    }
  }
}
