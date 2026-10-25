import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export type RecoveryTrees = Map<string, Map<string, {kind:'directory'} | {kind:'file';bytes:Buffer}>>;
export interface RecoveryClaim {dev:number;ino:number}
interface Options {directory:string;home:string;session:string;runId:string;statePaths:readonly string[];assertClosed:()=>void}
const MANIFEST = 'manifest.json', NEXT = '.manifest-next', STAGE = 'session-claim', MARKER = '.lucienne-kdenlive-session.json';
const MAX_BYTES = 128 * 1024 * 1024, MAX_MANIFEST = 32 * 1024 * 1024, MAX_ENTRIES = 20_000;
const digest = (bytes:Buffer|string) => createHash('sha256').update(bytes).digest('hex');
const identity = z.strictObject({dev:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),ino:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)});
const relative = z.string().max(2048).refine(s => s === '' || (!s.includes('\0') && !s.startsWith('/') && s.split('/').every(p => p !== '' && p !== '.' && p !== '..')));
const entry = z.discriminatedUnion('kind',[
  z.strictObject({name:relative,kind:z.literal('directory')}),
  z.strictObject({name:relative,kind:z.literal('file'),sha256:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().nonnegative().max(MAX_BYTES)}),
]);
const schema = z.strictObject({version:z.literal(1),target:z.literal('kdenlive'),nonce:z.string().uuid(),
  home:z.string().min(1),session:z.string().min(1),runId:z.string().regex(/^[a-zA-Z0-9._:/-]{1,160}$/),root:identity,
  roots:z.array(z.strictObject({path:relative,entries:z.array(entry).max(MAX_ENTRIES)})).min(1).max(32),claim:identity.optional()});
type Manifest = z.infer<typeof schema>;
function fail(reason:string):never {throw new Error(`KDENLIVE_RECOVERY_${reason}`);}

function safe(file:string):void {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) fail('PATH');
  let cursor = path.parse(file).root;
  for (const part of file.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor,part);
    try {const stat=lstatSync(cursor);if(stat.isSymbolicLink() || cursor !== file && !stat.isDirectory()) fail('SYMLINK');}
    catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
  }
}
function owned(file:string, directory:boolean):Stats {
  safe(file); const stat=lstatSync(file);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail('OWNERSHIP');
  return stat;
}
function read(file:string, max:number):Buffer {
  const before=owned(file,false);
  if(before.size>max) fail('SIZE');
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const opened=fstatSync(fd);
    if(opened.dev!==before.dev || opened.ino!==before.ino || opened.size!==before.size) fail('REPLACED');
    const bytes=readFileSync(fd),after=owned(file,false);
    if(bytes.length>max || after.dev!==before.dev || after.ino!==before.ino || after.size!==before.size) fail('REPLACED');
    return bytes;
  } finally {closeSync(fd);}
}
function readManifest(directory:string, guard:()=>void):Manifest {
  guard();const root=owned(directory,true);
  let value:unknown;
  try {value=JSON.parse(read(path.join(directory,MANIFEST),MAX_MANIFEST).toString('utf8'));}
  catch(error) {if(error instanceof SyntaxError) fail('MANIFEST');if((error as NodeJS.ErrnoException).code==='ENOENT')fail('INCOMPLETE');throw error;}
  const parsed=schema.safeParse(value);if(!parsed.success) fail('MANIFEST');
  const result=parsed.data;
  if(result.root.dev!==root.dev || result.root.ino!==root.ino) fail('REPLACED');
  guard();return result;
}
function exists(file:string):boolean {
  safe(file);try {lstatSync(file);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
}

/** Private, bounded baseline storage. Caller owns the one native mutation lane.
 * No journal PID is trusted, no target process is launched or killed here. */
export class KdenliveRecoveryStore {
  private readonly options:Options;
  private manifest?:Manifest;
  private finished?:{retainedArchive?:string};
  constructor(options:Options) {
    this.options={...options,statePaths:[...options.statePaths]};
    for(const p of [options.directory,options.home,options.session]) safe(p);
  }
  get nonce():string {if(!this.manifest)fail('NOT_LOADED');return this.manifest.nonce;}
  static pendingRun(directory:string,assertClosed:()=>void):string|undefined {
    assertClosed();if(!exists(directory))return undefined;
    return readManifest(directory,assertClosed).runId;
  }
  private sync(file:string):void {
    this.options.assertClosed();safe(file);const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{fsyncSync(fd);}finally{closeSync(fd);}
  }
  private write(file:string,bytes:Buffer|string):void {
    this.options.assertClosed();safe(file);
    const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
  }
  private validate(manifest:Manifest):void {
    if(manifest.home!==this.options.home || manifest.session!==this.options.session || manifest.runId!==this.options.runId ||
      manifest.roots.length!==this.options.statePaths.length || manifest.roots.some((r,i)=>r.path!==this.options.statePaths[i])) fail('IDENTITY');
    let count=0,bytes=0;
    for(const root of manifest.roots) {
      const entries=new Map(root.entries.map(e=>[e.name,e]));
      if(entries.size!==root.entries.length || root.entries.length && !entries.has('')) fail('TREE');
      if(new Set(root.entries.map(e=>e.name.normalize('NFC').toLocaleLowerCase('en-US'))).size!==entries.size)fail('TREE_ALIAS');
      for(const e of root.entries) {
        if(++count>MAX_ENTRIES || (e.kind==='file' && (bytes+=e.size)>MAX_BYTES)) fail('SIZE');
        if(e.name!=='' && entries.get(path.posix.dirname(e.name)==='.'?'':path.posix.dirname(e.name))?.kind!=='directory') fail('TREE');
      }
    }
  }
  private inventory(manifest:Manifest,allowUncommittedStage=false):void {
    const expected=new Set([MANIFEST,NEXT,...manifest.roots.flatMap(r=>r.entries.flatMap(e=>e.kind==='file'?[`blob-${e.sha256}`]:[]))]);
    for(const name of readdirSync(this.options.directory)) {
      const file=path.join(this.options.directory,name);
      if(name===STAGE) {
        if(!manifest.claim && !allowUncommittedStage) fail('UNCOMMITTED_CLAIM');
        const stat=owned(file,true);
        if(manifest.claim && (stat.dev!==manifest.claim.dev || stat.ino!==manifest.claim.ino)) fail('CLAIM_REPLACED');
        if(readdirSync(file).some(n=>n!==MARKER)) fail('STAGED_CONTENT');
        const marker=JSON.parse(read(path.join(file,MARKER),4096).toString('utf8'));
        if(marker.version!==1 || marker.target!=='kdenlive' || marker.runId!==manifest.runId || marker.nonce!==manifest.nonce) fail('CLAIM_IDENTITY');
      } else {
        if(!expected.has(name)) fail('UNKNOWN_FILE');
        const stat=owned(file,false);
        if(stat.size>(name===MANIFEST || name===NEXT ? MAX_MANIFEST : MAX_BYTES)) fail('SIZE');
      }
    }
  }
  private commit(manifest:Manifest):void {
    const directory=this.options.directory, next=path.join(directory,NEXT);
    const root=owned(directory,true);
    if(root.dev!==manifest.root.dev || root.ino!==manifest.root.ino)fail('REPLACED');
    const text=JSON.stringify(manifest);if(Buffer.byteLength(text)>MAX_MANIFEST)fail('SIZE');
    if(exists(next)){owned(next,false);this.options.assertClosed();unlinkSync(next);}
    this.write(next,text);
    this.options.assertClosed();owned(directory,true);safe(path.join(directory,MANIFEST));
    if(exists(path.join(directory,MANIFEST)))owned(path.join(directory,MANIFEST),false);
    renameSync(next,path.join(directory,MANIFEST));this.sync(directory);
    this.manifest=manifest;
  }
  create(trees:RecoveryTrees):void {
    this.options.assertClosed();if(exists(this.options.directory))fail('REQUIRED');
    const blobs=new Map<string,Buffer>();
    const roots=this.options.statePaths.map(p=>{
      const tree=trees.get(p);if(!tree)fail('TREE');
      return {path:p,entries:[...tree].map(([name,e])=>{
        if(e.kind==='directory')return {name,kind:'directory' as const};
        const sha256=digest(e.bytes);blobs.set(sha256,e.bytes);return {name,kind:'file' as const,sha256,size:e.bytes.length};
      })};
    });
    const nonce=randomUUID();
    const proposed={version:1 as const,target:'kdenlive' as const,nonce,home:this.options.home,session:this.options.session,runId:this.options.runId,
      root:{dev:0,ino:1},roots};
    const parsed=schema.safeParse(proposed);if(!parsed.success)fail('MANIFEST');this.validate(parsed.data);
    if(trees.size!==this.options.statePaths.length)fail('TREE');
    this.options.assertClosed();mkdirSync(this.options.directory,{mode:0o700});
    const stat=owned(this.options.directory,true),manifest={...parsed.data,root:{dev:stat.dev,ino:stat.ino}};
    for(const [sha,bytes]of blobs)this.write(path.join(this.options.directory,`blob-${sha}`),bytes);
    this.sync(this.options.directory);this.commit(manifest);this.sync(path.dirname(this.options.directory));
  }
  load():{trees:RecoveryTrees;claim?:RecoveryClaim} {
    const manifest=readManifest(this.options.directory,this.options.assertClosed);
    this.validate(manifest);this.inventory(manifest);
    const trees:RecoveryTrees=new Map(),cache=new Map<string,Buffer>();
    for(const root of manifest.roots) {
      const tree:RecoveryTrees extends Map<string,infer T>?T:never=new Map();
      for(const e of [...root.entries].sort((a,b)=>a.name.split('/').length-b.name.split('/').length || a.name.localeCompare(b.name))) {
        if(e.kind==='directory')tree.set(e.name,{kind:'directory'});
        else {
          let bytes=cache.get(e.sha256);
          if(!bytes){bytes=read(path.join(this.options.directory,`blob-${e.sha256}`),e.size);if(bytes.length!==e.size || digest(bytes)!==e.sha256)fail('BLOB_DIGEST');cache.set(e.sha256,bytes);}
          if(bytes.length!==e.size)fail('BLOB_DIGEST');
          tree.set(e.name,{kind:'file',bytes});
        }
      }
      trees.set(root.path,tree);
    }
    const after=owned(this.options.directory,true);
    if(after.dev!==manifest.root.dev || after.ino!==manifest.root.ino)fail('REPLACED');
    this.options.assertClosed();this.manifest=manifest;
    return {trees,...(manifest.claim?{claim:{...manifest.claim}}:{})};
  }
  setClaim(claim:RecoveryClaim):void {
    const manifest=readManifest(this.options.directory,this.options.assertClosed);this.validate(manifest);this.inventory(manifest,true);
    if(manifest.claim || !identity.safeParse(claim).success)fail('CLAIM');
    const stage=owned(path.join(this.options.directory,STAGE),true);
    if(stage.dev!==claim.dev || stage.ino!==claim.ino)fail('CLAIM_REPLACED');
    this.commit({...manifest,claim:{...claim}});
  }
  finish():{retainedArchive?:string} {
    if(this.finished)return {...this.finished};
    this.load();const manifest=this.manifest!;
    if(exists(this.options.session) || exists(path.join(this.options.directory,STAGE)))fail('SESSION_REMAINS');
    const archive=`${this.options.directory}.complete-${manifest.nonce}`;
    if(exists(archive))fail('ARCHIVE_EXISTS');
    this.options.assertClosed();renameSync(this.options.directory,archive);
    this.finished={retainedArchive:archive};
    try {
      this.sync(path.dirname(archive));
      const stat=owned(archive,true);if(stat.dev!==manifest.root.dev || stat.ino!==manifest.root.ino)fail('REPLACED');
      const allowed=new Set([MANIFEST,NEXT,...manifest.roots.flatMap(r=>r.entries.flatMap(e=>e.kind==='file'?[`blob-${e.sha256}`]:[]))]);
      const names=readdirSync(archive);
      for(const name of names){if(!allowed.has(name))fail('UNKNOWN_FILE');owned(path.join(archive,name),false);}
      for(const name of names) {const file=path.join(archive,name);owned(file,false);this.options.assertClosed();unlinkSync(file);}
      this.options.assertClosed();rmdirSync(archive);this.sync(path.dirname(archive));this.finished={};
    } catch { /* Completed journal stays private; never reactivate partial cleanup. */ }
    return {...this.finished};
  }
}
