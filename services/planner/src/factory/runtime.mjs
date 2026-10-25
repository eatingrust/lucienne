// Runs the pinned Factory binary within the configured sandbox policy.
import {createReadStream,mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {PINNED_TOOL_REGISTRY_CLI_SHA256 as sha, PINNED_TOOL_REGISTRY_CLI_VERSION as cliVersion} from './tool-registry.mjs';
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const sb=value=>JSON.stringify(value);
// A signal sent to a probe is not proof of exit. Each probe has its own process
// group; settlement requires both child close and absence of that complete group.
const groupAbsent = pid => {
  if (!pid) return true;
  try { process.kill(-pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function createProbeSupervisor() {
  const probes = new Set();
  const isQuiescent = () => {
    for (const probe of probes) {
      if (probe.closed && groupAbsent(probe.pid)) probes.delete(probe);
      else return false;
    }
    return true;
  };
  return {
    isQuiescent,
    run(file, args, { signal, timeout = 8000, maxBuffer = 16384, ...options } = {}) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      return new Promise((resolve, reject) => {
        const probe = { pid: undefined, closed: false };
        probes.add(probe);
        let child, stdout = '', stderr = '', callbackError, stopError;
        let timer, forceTimer, watchdog, finishing = false;
        const send = sig => {
          if (!probe.pid) return;
          try { process.kill(-probe.pid, sig); } catch { /* Absence checked below. */ }
        };
        const finish = async () => {
          if (finishing) return;
          finishing = true;
          clearTimeout(timer); clearTimeout(forceTimer); clearTimeout(watchdog);
          if (!groupAbsent(probe.pid)) send('SIGKILL');
          const deadline = performance.now() + 800;
          while ((!probe.closed || !groupAbsent(probe.pid)) && performance.now() < deadline) await delay(20);
          signal?.removeEventListener('abort', abort);
          if (!probe.closed || !groupAbsent(probe.pid)) {
            // Retain the probe record and runtime. Closing pipes only releases our
            // resources; it is never used as process/group termination evidence.
            child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
            reject(new Error('FACTORY_CLEANUP_INCOMPLETE'));
            return;
          }
          probes.delete(probe);
          if (signal?.aborted) reject(signal.reason);
          else if (stopError || callbackError) reject(stopError || callbackError);
          else resolve({ stdout, stderr });
        };
        const stop = error => {
          if (finishing || stopError) return;
          stopError = error;
          send('SIGTERM');
          forceTimer = setTimeout(() => send('SIGKILL'), 150);
          watchdog = setTimeout(() => { void finish(); }, 300);
        };
        const abort = () => stop(signal.reason ?? new Error('FACTORY_CANCELLED'));
        try {
          // spawn honors detached; execFile does not pass that option through.
          // Do not pass AbortSignal: its AbortError can precede child close.
          child = spawn(file, args, { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
          probe.pid = child.pid;
        } catch (error) {
          probes.delete(probe); reject(error); return;
        }
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        let stdoutBytes = 0, stderrBytes = 0;
        child.stdout.on('data', chunk => {
          stdoutBytes += Buffer.byteLength(chunk);
          if (stdoutBytes > maxBuffer) stop(new Error('FACTORY_PREFLIGHT_OUTPUT_TOO_LARGE'));
          else stdout += chunk;
        });
        child.stderr.on('data', chunk => {
          stderrBytes += Buffer.byteLength(chunk);
          if (stderrBytes > maxBuffer) stop(new Error('FACTORY_PREFLIGHT_OUTPUT_TOO_LARGE'));
          else stderr += chunk;
        });
        child.once('error', error => { callbackError = error; stop(error); });
        child.once('close', (code, exitSignal) => {
          probe.closed = true;
          if (!callbackError && (code !== 0 || exitSignal)) callbackError = new Error('FACTORY_PREFLIGHT_FAILED');
          void finish();
        });
        timer = setTimeout(() => stop(new Error('FACTORY_PREFLIGHT_TIMEOUT')), timeout);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    },
  };
}

export async function createRuntime({binary}={}){
  if(typeof binary !== 'string' || !binary.trim())throw new Error('FACTORY_BINARY_REQUIRED');
  binary=realpathSync(binary);
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(binary))hash.update(chunk);
  if(hash.digest('hex')!==sha)throw new Error('CLI_HASH_MISMATCH');
  const root=realpathSync(mkdtempSync('/private/tmp/lucienne-factory-run-'));
  try {
  const cwd=join(root,'scratch');mkdirSync(cwd,{mode:0o700});
  const settingsPath=join(cwd,'settings.json');
  writeFileSync(settingsPath,JSON.stringify({hooksDisabled:true,cloudSessionSync:false}),{mode:0o600});
  const policy=join(root,'runtime.sb');
  const systemPaths=['/System','/usr/lib','/usr/share','/bin','/usr/bin'];
  const systemFiles=['/dev/null','/dev/random','/dev/urandom','/private/etc/resolv.conf','/private/etc/hosts','/private/etc/ssl/cert.pem','/private/etc/ssl/openssl.cnf',realpathSync('/var/db/timezone/icutz/icutz44l.dat')];
  writeFileSync(policy,`(version 1)
(deny default)
(allow process*)
(allow sysctl-read)
(allow mach-lookup)
(allow file-read-metadata)
; dyld CacheFinder requires reading root-directory data. This is not recursive.
(allow file-read-data (literal "/"))
(allow file-read* ${systemPaths.map(p=>`(subpath ${sb(p)})`).join(' ')} ${systemFiles.map(p=>`(literal ${sb(p)})`).join(' ')} (literal ${sb(binary)}) (subpath ${sb(cwd)}))
(allow file-write* (subpath ${sb(cwd)}) (literal "/dev/null"))
(allow network-outbound (remote tcp "*:443"))
(allow network-outbound (literal "/private/var/run/mDNSResponder"))
`,{mode:0o600});
  const execPath=join(root,'droid-sandbox.sh');
  writeFileSync(execPath,`#!/bin/sh\ncd ${quote(cwd)} || exit 90\nexec /usr/bin/sandbox-exec -f ${quote(policy)} ${quote(binary)} "$@" --settings ${quote(settingsPath)}\n`,{mode:0o700});
  const sentinel=join(root,'outside-sentinel');writeFileSync(sentinel,'outside-unchanged',{mode:0o600});
  symlinkSync(sentinel,join(cwd,'escape-link'));
  // A harmless host-owned probe avoids depending on private repository files in exports.
  const deniedHostProbe=join(root,'outside-content-probe');
  writeFileSync(deniedHostProbe,'host-owned-boundary-probe',{mode:0o600});
  const probe=join(cwd,'probe.sh');
  writeFileSync(probe,`#!/bin/sh\nset -eu\nprintf inside > inside-file\n[ "$(/bin/cat inside-file)" = inside ]\nfor file in ${quote(sentinel)} ${quote(join(cwd,'escape-link'))} ${quote(deniedHostProbe)}; do\n  if /bin/cat "$file" >/dev/null 2>&1; then exit 21; fi\ndone\nfor file in ${quote(sentinel)} ${quote(join(cwd,'escape-link'))}; do\n  if (printf bad > "$file") 2>/dev/null; then exit 22; fi\ndone\nprintf 'inside-allowed,outside-and-symlink-denied,host-probe-content-denied'\n`,{mode:0o700});
  let disposed=false;
  const probes=createProbeSupervisor();
  const evidence={cliVersion,cliSha256:sha,policyVersion:3,rootDirectoryRead:'literal only',icuTimezoneData:realpathSync('/var/db/timezone/icutz/icutz44l.dat'),network:'outbound TCP 443 and system DNS socket',hooksDisabled:true,cloudSessionSync:false};
  return {root,cwd,execPath,policy,evidence,isQuiescent:probes.isQuiescent,
    async verify({signal}={}){
      if(disposed)throw new Error('RUNTIME_DISPOSED');
      const env={PATH:'/usr/bin:/bin',FACTORY_HOME_OVERRIDE:cwd,FACTORY_DROID_AUTO_UPDATE_ENABLED:'false',SSL_CERT_FILE:'/private/etc/ssl/cert.pem'};
      const probeResult=await probes.run('/usr/bin/sandbox-exec',['-f',policy,'/bin/sh',probe],{cwd,env,signal,timeout:8000,maxBuffer:16384});
      if(probeResult.stdout!=='inside-allowed,outside-and-symlink-denied,host-probe-content-denied'||readFileSync(sentinel,'utf8')!=='outside-unchanged')throw new Error('CONFINEMENT_PROBE_FAILED');
      const version=await probes.run(execPath,['--version'],{cwd,env,signal,timeout:8000,maxBuffer:16384});
      if(version.stdout.trim()!==cliVersion)throw new Error('CLI_VERSION_MISMATCH');
      const intl=await probes.run('/usr/bin/sandbox-exec',['-f',policy,binary,'-e',"if(Intl.supportedValuesOf('timeZone').length<1)process.exit(1);process.stdout.write('icu-ready')"],{cwd,env:{...env,BUN_BE_BUN:'1'},signal,timeout:3000,maxBuffer:16384});
      if(intl.stdout!=='icu-ready')throw new Error('ICU_TIMEZONE_PROBE_FAILED');
      evidence.probes={timezoneEnumeration:true,insideWriteRead:true,outsideReadDenied:true,outsideWriteDenied:true,symlinkReadDenied:true,symlinkWriteDenied:true,hostProbeContentReadDenied:true,cliStartup:true};
      return true;
    },
    diagnostics(){
      const path=join(cwd,'diagnostic.log');
      if(!existsSync(path))return {logPresent:false};
      const raw=readFileSync(path,'utf8');
      const names=['org_policy_join','prompt_submit_hooks','attachments','cloud_session_defaults','MCP','readiness','EACCES','EPERM','ETIMEDOUT','ECONNREFUSED','ENOTFOUND','Unauthorized','401','403','429'];
      const markers=Object.fromEntries(names.map(name=>[name,raw.split(name).length-1]).filter(([,count])=>count));
      return {logPresent:true,logBytes:Buffer.byteLength(raw),markers};
    },
    dispose(){if(!probes.isQuiescent())return false;if(!disposed){rmSync(root,{recursive:true,force:true});disposed=true;}return !existsSync(root);},
  };
  } catch(error) {rmSync(root,{recursive:true,force:true});throw error;}
}
