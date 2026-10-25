// Fixed trusted subprocess entry point; never accepts a worker/module path.
import {runFactorySession} from './session.mjs';
const chunks=[];
const controller=new AbortController();
const emit=(message)=>process.stdout.write(JSON.stringify(message)+'\n');
process.on('SIGTERM',()=>{emit({type:'lifecycle',phase:'sdk-abort-requested'});controller.abort(new Error('FACTORY_CANCELLED'));});
for await(const chunk of process.stdin) {chunks.push(chunk);if(chunks.reduce((n,b)=>n+b.length,0)>65536) process.exit(2);}
try {
  const {input,modelId}=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const value=await runFactorySession(input,{execPath:process.argv[2],cwd:process.cwd(),modelId,signal:controller.signal,onProgress:({phase})=>emit({type:'progress',phase}),onLifecycle:info=>emit({type:'lifecycle',...info})});
  emit({type:'result',value});
} catch(error) {
  const code=/^FACTORY_[A-Z_]+$/.test(error.message??'')?error.message:'FACTORY_REQUEST_FAILED';
  emit({type:'error',code,stage:error.stage??'worker',resultSubtype:error.resultSubtype,structuredCode:error.structuredCode});process.exitCode=1;
}
