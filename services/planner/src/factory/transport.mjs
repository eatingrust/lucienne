// Factory JSON-RPC transport for the pinned local runtime.
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FACTORY_INFERENCE_MODEL, assertFactoryInferenceModel } from './model.mjs';

function validateInput(input) {
  if (!input || typeof input !== 'object' || typeof input.prompt !== 'string' || !input.prompt.trim() || !input.schema || typeof input.schema !== 'object' || Array.isArray(input.schema) || Object.keys(input).some(key => !['prompt','schema'].includes(key))) throw new Error('FACTORY_INPUT_INVALID');
  let serialized;
  try { serialized = JSON.stringify({input}); } catch { throw new Error('FACTORY_INPUT_INVALID'); }
  if (Buffer.byteLength(serialized) > 60_000) throw new Error('FACTORY_INPUT_TOO_LARGE');
  return JSON.parse(serialized).input;
}

// A verification Promise settling is necessary but production runtimes also confirm
// that every probe process group has stopped. Trusted in-memory test runtimes need
// no process hook; a hung verification is never presumed quiescent.
async function verifyWithinDeadline(runtime, signal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('FACTORY_CANCELLED'));
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('FACTORY_TIMEOUT')), timeoutMs);
  let listener, verificationStarted = false, verificationSettled = false;
  const task = Promise.resolve().then(() => {
    controller.signal.throwIfAborted();
    verificationStarted = true;
    return runtime.verify({ signal: controller.signal });
  }).then(value => { verificationSettled = true; return value; }, error => {
    verificationSettled = true; throw error;
  });
  const quiescent = () => {
    if (!verificationStarted) return true;
    if (!verificationSettled) return false;
    try { return typeof runtime.isQuiescent !== 'function' || runtime.isQuiescent() === true; }
    catch { return false; }
  };
  try {
    const cancelled = new Promise((_, reject) => {
      listener = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', listener, { once: true });
    });
    if (signal?.aborted) abort();
    const verified = await Promise.race([task, cancelled]);
    if (controller.signal.aborted) throw controller.signal.reason;
    if (verified !== true) throw new Error('FACTORY_ISOLATION_UNVERIFIED');
    if (!quiescent()) throw new Error('FACTORY_CLEANUP_INCOMPLETE');
  } catch (cause) {
    // Cancellation requests cleanup; it does not establish that verify or its
    // children stopped. Allow a bounded drain, then retain uncertain runtimes.
    if (!controller.signal.aborted) controller.abort(cause);
    let drainTimer;
    if (!verificationSettled) {
      try { await Promise.race([task.catch(() => undefined), new Promise(resolve => { drainTimer = setTimeout(resolve, 1500); })]); }
      finally { clearTimeout(drainTimer); }
    }
    const safe = quiescent();
    const error = safe ? cause : new Error('FACTORY_CLEANUP_INCOMPLETE');
    throw Object.assign(error instanceof Error ? error : new Error('FACTORY_PREFLIGHT_FAILED'), {
      verificationStarted, verificationSettled, preflightQuiescent: safe,
    });
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', listener);
  }
}

// Inspect only PIDs and counters, never process arguments or environment.
function inspectGroup(pgid) {
  return new Promise(resolve => {
    try {execFile('/bin/ps',['-axo','pid=,pgid=,stat=,rss=,%cpu='],{timeout:500,maxBuffer:2097152},(error,stdout)=>{
      if(error)return resolve({ok:false,code:error.code==='EPERM'?'EPERM':'PS_FAILED'});
      const members=stdout.trim().split('\n').map(line=>line.trim().split(/\s+/))
        .filter(row=>Number(row[1])===pgid)
        .map(row=>({pid:Number(row[0]),state:row[2],rssKiB:Number(row[3]),cpuPercent:Number(row[4])}));
      resolve({ok:true,members});
    });}catch(error){resolve({ok:false,code:error.code==='EPERM'?'EPERM':'PS_FAILED'});}
  });
}

export function createFactoryTransport({runtime, apiKey = process.env.FACTORY_API_KEY, timeoutMs = 30000, onEvidence = () => {}, onLifecycle = () => {}, modelId = FACTORY_INFERENCE_MODEL} = {}) {
  assertFactoryInferenceModel(modelId);
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>120000)throw new Error('FACTORY_INVALID_TIMEOUT');
  return {provider:'factory',async generate(input, {signal, onProgress = () => {}} = {}) {
    input = validateInput(input);
    const started=performance.now();
    const publish=info=>{try{onEvidence(info);}catch{}};
    let preflightStarted = false, preflightCompleted = false;
    try {
      signal?.throwIfAborted();
      if (!apiKey) throw new Error('FACTORY_AUTH_REQUIRED');
      if (!runtime?.execPath || !runtime?.cwd || typeof runtime.verify !== 'function') throw new Error('FACTORY_ISOLATION_REQUIRED');
      preflightStarted = true;
      await verifyWithinDeadline(runtime,signal,timeoutMs);
      preflightCompleted = true;
      publish({ stage:'preflight-verified', preflightStarted:true, verificationSettled:true, preflightQuiescent:true });
      signal?.throwIfAborted();
    } catch(error) {
      // A cancellation from the verified observer is already quiescent.
      const knownQuiescent = !preflightStarted || preflightCompleted || error?.preflightQuiescent === true;
      publish({stage:'preflight',preflightStarted,verificationSettled:error?.verificationSettled === true,
        preflightQuiescent:knownQuiescent,workerStarted:false,processExited:false,groupEmpty:null,remoteInferenceStopped:null,totalElapsedMs:performance.now()-started});
      throw error;
    }
    return new Promise((resolve,reject) => {
      let child;
      try {
        child=spawn(process.execPath,[fileURLToPath(new URL('./factory-worker.mjs',import.meta.url)),runtime.execPath],{
          cwd:runtime.cwd,detached:true,stdio:['pipe','pipe','pipe'],
          // Electron main's process.execPath is Electron. This fixed worker must run as Node.
          // Packaged builds must retain the Electron RunAsNode fuse or supply a trusted helper.
          env:{ELECTRON_RUN_AS_NODE:'1',PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8',FACTORY_API_KEY:apiKey,FACTORY_HOME_OVERRIDE:runtime.cwd,FACTORY_LOG_FILE:runtime.cwd+'/diagnostic.log',FACTORY_DROID_AUTO_UPDATE_ENABLED:'false',SSL_CERT_FILE:'/private/etc/ssl/cert.pem'},
        });
      } catch {
        publish({stage:'spawn',workerStarted:false,processExited:false,groupEmpty:null,remoteInferenceStopped:null,totalElapsedMs:performance.now()-started});
        reject(new Error('FACTORY_PROCESS_FAILED'));return;
      }
      let settled=false,finishing=false,workerExited=false,output='',payload,stopError,forceTimer,exitWatchdog;
      const lifecycle=[],signalErrors=[];
      try{onLifecycle({type:'lifecycle',phase:'worker-spawned',pid:child.pid});}catch{}
      let workerFailure,hardKilled=false,cleanupKillSent=false;
      const resources={samples:0,peakRssKiB:0,peakCpuPercent:0};
      const resourceTimer=setInterval(async()=>{
        if(finishing||!child.pid)return;
        const snapshot=await inspectGroup(child.pid);
        if(!snapshot.ok||finishing)return;
        resources.samples++;resources.lastCpuPercent=snapshot.members.reduce((n,r)=>n+r.cpuPercent,0);resources.peakRssKiB=Math.max(resources.peakRssKiB,snapshot.members.reduce((n,r)=>n+r.rssKiB,0));
        resources.peakCpuPercent=Math.max(resources.peakCpuPercent,snapshot.members.reduce((n,r)=>n+r.cpuPercent,0));
      },500);
      const sendSignal=(target,sig)=>{
        if(!child.pid)return false;
        try {process.kill(target==='group'?-child.pid:child.pid,sig);return true;}
        catch(error){if(error.code!=='ESRCH')signalErrors.push({target,signal:sig,code:error.code==='EPERM'?'EPERM':'SIGNAL_FAILED'});return false;}
      };
      const stop = (error) => {
        if (finishing || stopError) return;
        stopError=error;
        // Ask the SDK to abort/close first. This alone does not prove remote cancellation.
        sendSignal('worker','SIGTERM');
        forceTimer=setTimeout(()=>{hardKilled=sendSignal('group','SIGKILL')||hardKilled;},2000);
        // Permission failures must become evidence, not an unbounded wait or uncaught throw.
        exitWatchdog=setTimeout(()=>finish(null,null),4000);
      };
      const abort=()=>{
        const error=new Error('FACTORY_CANCELLED');
        if(finishing)stopError=error;else stop(error);
      };
      signal?.addEventListener('abort',abort,{once:true});
      const timer=setTimeout(()=>stop(new Error('FACTORY_TIMEOUT')),Math.max(1,timeoutMs-(performance.now()-started)));
      const finish=async(code,exitSignal)=>{
        if(finishing)return;finishing=true;
        clearInterval(resourceTimer);clearTimeout(timer);clearTimeout(forceTimer);clearTimeout(exitWatchdog);
        try{onLifecycle({type:'lifecycle',phase:'cleanup-started'});}catch{}
        let groupEmpty=child.pid?null:true,remainingGroupPids=[],groupCheckCode;
        const cleanupStart=performance.now();
        try {
          if(child.pid){
            let snapshot=await inspectGroup(child.pid);
            if(snapshot.ok&&snapshot.members.length){
              cleanupKillSent=sendSignal('group','SIGKILL');
              hardKilled=cleanupKillSent||hardKilled;
            }
            // Verify absence after any cleanup signal. A signal successfully sent is not an exit.
            while(true){
              if(snapshot.ok){
                remainingGroupPids=snapshot.members.map(row=>row.pid);
                groupEmpty=remainingGroupPids.length===0;
                if(groupEmpty)break;
              }else{groupCheckCode=snapshot.code;groupEmpty=null;break;}
              if(performance.now()-cleanupStart>=1500)break;
              await new Promise(r=>setTimeout(r,50));snapshot=await inspectGroup(child.pid);
            }
          }
        } catch {groupEmpty=null;groupCheckCode='GROUP_CHECK_FAILED';}
        const supervision={resources,workerStarted:!!child.pid,processExited:workerExited,exitCode:code,exitSignal,hardKilled,cleanupKillSent,signalErrors,groupEmpty,remainingGroupPids,groupCheckCode,cleanupVerificationMs:performance.now()-cleanupStart,remoteInferenceStopped:null,lifecycle,workerFailure,totalElapsedMs:performance.now()-started};
        let failure=signal?.aborted ? new Error('FACTORY_CANCELLED') : stopError;
        if(!failure&&(groupEmpty!==true||!workerExited))failure=new Error('FACTORY_CLEANUP_INCOMPLETE');
        if(!failure&&(code!==0||!payload||output.trim()))failure=new Error('FACTORY_PROCESS_FAILED');
        if(!failure && (!payload || typeof payload !== 'object' || !Object.hasOwn(payload,'value') || !payload.provenance || payload.provenance.provider !== 'factory' || payload.provenance.mode !== 'live' || payload.provenance.model !== modelId)) failure=new Error('FACTORY_RESULT_INVALID');
        publish({...(!failure?payload.metrics:{}),...supervision,...(failure?{failureCode:/^FACTORY_[A-Z_]+$/.test(failure.message??'')?failure.message:'FACTORY_REQUEST_FAILED'}:{})});
        // An observer may synchronously abort during publication; never return that result.
        if(signal?.aborted)failure=new Error('FACTORY_CANCELLED');
        signal?.removeEventListener('abort',abort);
        settled=true;
        // A failed cleanup remains explicitly failed; allow the caller to regain control.
        if(!workerExited){child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.unref();}
        if(failure)reject(failure);else resolve({value:payload.value,provenance:payload.provenance,metrics:payload.metrics});
      };
      child.on('error',()=>stop(new Error('FACTORY_PROCESS_FAILED')));
      child.stderr.resume(); // May contain provider/credential information; never save it.
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',chunk=>{
        if(finishing||settled)return;
        output+=chunk;
        if(output.length>131072) return stop(new Error('FACTORY_OUTPUT_TOO_LARGE'));
        let newline;
        while((newline=output.indexOf('\n'))>=0){
          const line=output.slice(0,newline);output=output.slice(newline+1);
          try {
            const msg=JSON.parse(line);
            if(msg.type==='progress') { try {onProgress({phase:msg.phase});} catch {} }
            else if(msg.type==='lifecycle') { lifecycle.push(msg);try{onLifecycle(msg);}catch{} }
            else if(msg.type==='result') payload=msg.value;
            else if(msg.type==='error') {workerFailure=msg;stop(new Error(/^FACTORY_[A-Z_]+$/.test(msg.code)?msg.code:'FACTORY_REQUEST_FAILED'));}
            else stop(new Error('FACTORY_PROTOCOL_INVALID'));
          } catch {stop(new Error('FACTORY_PROTOCOL_INVALID'));}
        }
      });
      child.on('close',(code,exitSignal)=>{workerExited=true;void finish(code,exitSignal);});
      child.stdin.on('error',()=>stop(new Error('FACTORY_PROCESS_FAILED')));
      try{child.stdin.end(JSON.stringify({input,modelId}));}catch{stop(new Error('FACTORY_PROTOCOL_INVALID'));}
      if(signal?.aborted) abort();
    });
  }};
}
