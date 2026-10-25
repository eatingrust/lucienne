import type { ChatIntent, SourceProfile } from '../contracts/index.js';
import { validateKritaTask, type KritaTaskAction, type NativeKritaObservation } from './krita-observations.ts';
import { runObservedQA, type ObservedQAAdapter, type ObservedQARuntime, type ObservedRunOptions, type ObservedRunResult } from './observed-runner.ts';

export type { QASnapshot, QACoordinator, RunnerScheduler } from './observed-runner.ts';
export interface ObservedKritaState extends NativeKritaObservation { geometry?: unknown; evidenceRefs: string[] }
export interface ObservedKritaAdapter extends ObservedQAAdapter<ObservedKritaState> {}
export interface KritaQARuntime extends ObservedQARuntime<KritaTaskAction,ObservedKritaState> {
  adapter:ObservedKritaAdapter;
}
export interface KritaRunOptions extends Pick<ObservedRunOptions<KritaTaskAction,ObservedKritaState>,
  'buildId'|'outputRoot'|'createCoordinator'|'clock'|'scheduler'|'runId'|'clockId'|'maxRunMs'|'pollMs'|'signal'|'onStage'> {
  source:SourceProfile;scenarioId:string;runtime:KritaQARuntime;
}
export interface KritaRunResult extends ObservedRunResult {}
function fail(code:string):never{throw new Error(code);}
const tasks:readonly [KritaTaskAction,string][]=[
  ['paint','Press B and paint a short accent on the selected scratch layer. Leave every other layer unchanged.'],
  ['select','Press M and drag a rectangle around the painted accent. Leave the selection active.'],
  ['transform','Press Command+T, move or scale the selected accent, and commit the transform. Leave every other layer unchanged.'],
];
const chats:readonly {intent:ChatIntent;instruction:string;key:string;value:string}[]=[
  {intent:'move-key-panels',instruction:'Move Layers to the right.',key:'panel-side',value:'right'},
  {intent:'enlarge-work-area',instruction:'Give the canvas more room.',key:'work-area',value:'large'},
  {intent:'simplify-tools',instruction:'Simplify the visible controls for this task.',key:'tool-density',value:'simple'},
];
/** First-route wrapper retains the approved Photoshop collage gestures and chat
 * recipes. The shared engine owns bounded timing, capture and settled cleanup. */
export async function runKritaQA(options:KritaRunOptions):Promise<KritaRunResult>{
  const {runtime}=options;
  if(options.source.sourceApp!=='photoshop'||options.source.personaId!=='collage'||options.source.profileId!=='photoshop-collage'||runtime.adapter.target.appId!=='krita')fail('WRONG_FIRST_LOOP_SCENARIO');
  return runObservedQA({...options,
    selection:{source:options.source,target:runtime.adapter.target,scenarioId:options.scenarioId},
    tasks,validateTask:validateKritaTask,
    chatRecipe:(intent,_operations,catalog)=>{
      const chat=chats.find(value=>value.intent===intent)!;
      const capability=catalog.find(cap=>cap.preferenceKey===chat.key);
      if(!capability)fail('CHAT_CAPABILITY_UNAVAILABLE');
      return {intent:chat.intent,instruction:chat.instruction,explicit:[{key:chat.key,value:chat.value}],
        expectedOperation:{capabilityId:capability.id,value:chat.value}};
    },
  });
}
