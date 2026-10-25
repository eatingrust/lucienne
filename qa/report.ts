import { createHash } from 'node:crypto';
import type { SourceProfile, QAResult } from '../contracts/index.js';
import type { RunAudit } from './audit.ts';
import { matrix, routes, sources, type PersonaRoster } from './matrix.ts';
import { summarizeMeasurements, type Distribution } from './performance.ts';

export type CaseStatus = 'not-run' | 'blocked' | 'failed' | 'live-native-pass' |
  'prepared-native-pass' | 'replay-native-pass' | 'simulated-native-pass' | 'fixture-pass';
export interface CaseCoverage {
  caseId: string; sourceApp: string; targetApp: string; personaId: string; profileId: string; profileRevision: string;
  status: CaseStatus; runId: string | null; capturedAt: string | null;
  evidenceKind: string | null; mode: string | null; limitations: string[];
}
export interface BuildCoverage {
  buildId: string; latestCapturedAt: string; liveNativePasses: number; expectedCases: 54;
  fixturePasses: number; preparedNativePasses: number; replayNativePasses: number;
  simulatedNativePasses: number; failedCases: number; blockedCases: number; notRunCases: number;
  cases: CaseCoverage[];
  measurements: { mode: string; evidenceKind: string; targetApp: string; adapterVersion: string; qaStatus: QAResult['status']; name: string; unit: string; distribution: Distribution }[];
}
export interface QualityReport {
  version: 1; generatedAt: string; expectedRoutes: 18; expectedCases: 54;
  selectedBuildId: string | null; liveNativePasses: number; complete: boolean;
  builds: BuildCoverage[]; unrunCases: CaseCoverage[];
  telemetryScope: {buildId:string;runKey:string;scenarioKey:string;sourceApp:string;personaId:string;mode:string;evidenceKind:string;targetApp:string;capturedAt:string}[];
  excludedAttempts: { buildId: string; runId: string; reason: string }[];
  limits: string[];
}
const key = (source: string, target: string, persona: string) => `${source}--${target}--${persona}`;
const requiredChecks: readonly QAResult['check'][] = ['native-task','chat','reset','relaunch','layout','performance'];
const profileKey = (source: string, persona: string) => `${source}--${persona}`;
// IDs, labels, evidence and preference origins do not prove distinct native values.
const behaviorKey = (profile: SourceProfile): string => JSON.stringify([
  Object.entries(profile.bindings).sort(([a], [b]) => a.localeCompare(b)),
  profile.preferences.map(({key,value}) => [key,value]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
]);
function timestamp(audit: RunAudit): string {
  const times = new Set(audit.results.map(r => r.measuredAt));
  if (times.size !== 1) throw new Error('QA_RESULTS_REQUIRE_ONE_CAPTURE_TIMESTAMP');
  const time = [...times][0];
  if (!Number.isFinite(Date.parse(time))) throw new Error('INVALID_CAPTURE_TIMESTAMP');
  return time;
}
function statusOf(a: RunAudit): CaseStatus {
  if (a.findings.some(f => f.status === 'fail') || a.results.some(r => r.status === 'fail')) return 'failed';
  if (!a.findings.length || a.results.length !== requiredChecks.length || !requiredChecks.every(check=>a.results.filter(r=>r.check===check).length===1) || a.findings.some(f => f.status !== 'pass') || a.results.some(r => r.status !== 'pass')) return 'blocked';
  if (a.evidenceKind === 'fixture') return 'fixture-pass';
  if (a.mode === 'live' && a.liveNativePass) return 'live-native-pass';
  if (a.mode === 'prepared') return 'prepared-native-pass';
  if (a.mode === 'replay') return 'replay-native-pass';
  if (a.mode === 'simulated') return 'simulated-native-pass';
  return 'blocked';
}
/** Select latest attempts within each build/case only. A newer failed attempt
 * replaces an older pass. No build can borrow passing cases from another build. */
export function buildQualityReport(profiles: SourceProfile[], audits: RunAudit[], options: {
  generatedAt?: string; selectedBuildId?: string;
} = {}): QualityReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error('INVALID_REPORT_TIMESTAMP');
  if (profiles.length !== 18 || new Set(profiles.map(p=>p.profileId)).size !== 18) throw new Error('EXPECTED_18_DISTINCT_PROFILES');
  const roster = Object.fromEntries(sources.map(source => [source, profiles.filter(p=>p.sourceApp===source).map(p=>p.personaId)])) as unknown as PersonaRoster;
  const cases = matrix(roster);
  for (const source of sources) {
    const behaviors = profiles.filter(profile => profile.sourceApp === source).map(behaviorKey);
    if (new Set(behaviors).size !== behaviors.length) throw new Error(`DUPLICATE_PERSONA_BEHAVIOR:${source}`);
  }
  const profileMap = new Map(profiles.map(p=>[profileKey(p.sourceApp,p.personaId),p]));
  const template = cases.map(c => ({caseId:c.caseId,sourceApp:c.source,targetApp:c.target,personaId:c.personaId,
    profileId:profileMap.get(profileKey(c.source,c.personaId))!.profileId,profileRevision:profileMap.get(profileKey(c.source,c.personaId))!.revision,status:'not-run' as CaseStatus,
    runId:null,capturedAt:null,evidenceKind:null,mode:null,limitations:['No run evidence supplied for this build/case.']}));
  const expected = new Map(template.map(c=>[c.caseId,c]));
  const groups = new Map<string, {audit:RunAudit; at:string}[]>();
  const seen = new Set<string>();
  const excludedAttempts: QualityReport['excludedAttempts'] = [];
  for (const audit of audits) {
    const unique = `${audit.buildId}\0${audit.runId}`;
    if (!audit.buildId || !audit.runId || seen.has(unique)) throw new Error('DUPLICATE_OR_MISSING_BUILD_RUN_ID');
    seen.add(unique);
    const at=timestamp(audit);
    const c=expected.get(key(audit.sourceApp,audit.target.appId,audit.personaId));
    if(c&&audit.profileRevision!==c.profileRevision) {
      excludedAttempts.push({buildId:audit.buildId,runId:audit.runId,reason:'Source profile revision differs from the current roster; excluded from coverage.'});
      continue;
    }
    if (!c || audit.results.some(r=>r.profileId!==c.profileId || r.runId!==audit.runId || r.scenarioId!==audit.scenarioId ||
      r.target.appId!==audit.target.appId || r.target.adapterVersion!==audit.target.adapterVersion || r.evidenceKind!==audit.evidenceKind)) {
      excludedAttempts.push({buildId:audit.buildId,runId:audit.runId,reason:'Unknown roster case or mismatched result identity/profile; excluded from coverage.'});
      continue;
    }
    const group=groups.get(audit.buildId)??[];
    group.push({audit,at}); groups.set(audit.buildId,group);
  }
  const telemetryScope: QualityReport['telemetryScope']=[];
  const identityKey=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
  const builds: BuildCoverage[] = [...groups.entries()].map(([buildId,attempts])=> {
    const current: typeof attempts=[];
    const rows: CaseCoverage[]=template.map(c=> {
      const matches=attempts.filter(a=>key(a.audit.sourceApp,a.audit.target.appId,a.audit.personaId)===c.caseId)
        .sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
      if (!matches.length) return {...c};
      const latest=matches[0];
      if (matches.length>1&&Date.parse(matches[1].at)===Date.parse(latest.at)) return {...c,status:'blocked',capturedAt:latest.at,
        limitations:['Multiple attempts share the newest timestamp; ordering is ambiguous.'],runId:null};
      current.push(latest);
      telemetryScope.push({buildId,runKey:identityKey(latest.audit.runId),scenarioKey:identityKey(latest.audit.scenarioId),
        sourceApp:latest.audit.sourceApp,personaId:latest.audit.personaId,mode:latest.audit.mode,evidenceKind:latest.audit.evidenceKind,
        targetApp:latest.audit.target.appId,capturedAt:latest.at});
      return {...c,status:statusOf(latest.audit),runId:latest.audit.runId,capturedAt:latest.at,evidenceKind:latest.audit.evidenceKind,mode:latest.audit.mode,
        limitations:[...new Set([...(latest.audit.bindingLimitations ?? []),...latest.audit.findings.filter(f=>f.status!=='pass').map(f=>f.detail),
          ...latest.audit.results.flatMap(r=>r.limitations)])]};
    });
    const measurements = new Map<string,{mode:string;evidenceKind:string;targetApp:string;adapterVersion:string;qaStatus:QAResult['status'];name:string;unit:string;values:number[]}>();
    for(const {audit} of current) {
      const performanceResults=audit.results.filter(r=>r.check==='performance');
      // A malformed/duplicate check set must never multiply the sample count.
      if(performanceResults.length!==1) continue;
      const result=performanceResults[0];
      if(!['pass','fail','blocked','not-run'].includes(result.status)) throw new Error('INVALID_QA_STATUS');
      const metricNames=new Set<string>();
      for(const m of result.metrics) {
        if(metricNames.has(m.name)||!Number.isFinite(m.value)||m.value<0) throw new Error('INVALID_PERFORMANCE_METRIC');
        metricNames.add(m.name);
        const id=JSON.stringify([audit.mode,audit.evidenceKind,audit.target.appId,audit.target.adapterVersion,result.status,m.name,m.unit]);
        const group=measurements.get(id)??{mode:audit.mode,evidenceKind:audit.evidenceKind,targetApp:audit.target.appId,
          adapterVersion:audit.target.adapterVersion,qaStatus:result.status,name:m.name,unit:m.unit,values:[]};
        group.values.push(m.value);measurements.set(id,group);
      }
    }
    const count=(status:CaseStatus)=>rows.filter(c=>c.status===status).length;
    return {buildId,latestCapturedAt:attempts.reduce((latest,a)=>Date.parse(a.at)>Date.parse(latest)?a.at:latest,attempts[0].at),
      liveNativePasses:count('live-native-pass'),expectedCases:54 as const,fixturePasses:count('fixture-pass'),preparedNativePasses:count('prepared-native-pass'),
      replayNativePasses:count('replay-native-pass'),simulatedNativePasses:count('simulated-native-pass'),failedCases:count('failed'),
      blockedCases:count('blocked'),notRunCases:count('not-run'),cases:rows,
      measurements:[...measurements.values()].map(({values,...rest})=>({...rest,distribution:summarizeMeasurements(values)}))};
  }).sort((a,b)=>a.buildId.localeCompare(b.buildId));
  if(options.selectedBuildId&&!builds.some(b=>b.buildId===options.selectedBuildId)) throw new Error('SELECTED_BUILD_HAS_NO_ACCEPTED_CAPTURE');
  const selectedBuildId=options.selectedBuildId??(builds.length===1?builds[0].buildId:null);
  const liveNativePasses=builds.find(b=>b.buildId===selectedBuildId)?.liveNativePasses??0;
  return {version:1,generatedAt,expectedRoutes:18,expectedCases:54,selectedBuildId,liveNativePasses,
    complete:!!selectedBuildId&&liveNativePasses===54&&excludedAttempts.length===0,builds,telemetryScope,unrunCases:builds.length?[]:template,excludedAttempts,
    limits:['Fixture passes never count as live native passes. Prepared, replay and simulated native runs are separate.',
      'Coverage uses only the latest unambiguously ordered attempt for each case within the same build. Builds are never combined.',
      'Every distribution keeps its sample count and build, target, adapter, mode, evidence and QA-status grouping; measured spans from failed/blocked runs are not success claims. No performance SLO is implied.',
      ...(builds.length>1&&!selectedBuildId?['Select one build explicitly with --build before claiming overall completion.']:[])]};
}
const cell = (value: unknown) => String(value??'—').replaceAll('|','\\|').replaceAll('\n',' ');
export function renderQualityMarkdown(report: QualityReport): string {
  const lines=[`# Lucienne QA — ${report.generatedAt}`, '',
    `**${report.liveNativePasses}/54 live native cases passed** for ${report.selectedBuildId?`build \`${report.selectedBuildId}\``:'no selected build'}. Approved scope: 18 routes, three personas per source.`, '',
    '| Build | Live native | Fixture | Prepared native | Replay/simulated | Failed | Blocked | Not run |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for(const b of report.builds) lines.push(`| ${cell(b.buildId)} | ${b.liveNativePasses}/54 | ${b.fixturePasses} | ${b.preparedNativePasses} | ${b.replayNativePasses+b.simulatedNativePasses} | ${b.failedCases} | ${b.blockedCases} | ${b.notRunCases} |`);
  if(!report.builds.length) lines.push('| No run capture | 0/54 | 0 | 0 | 0 | 0 | 0 | 54 |');
  const selected=report.builds.find(b=>b.buildId===report.selectedBuildId);
  const rows=selected?.cases??report.unrunCases;
  if(rows.length) {
    lines.push('', '| Route | Persona results |', '| --- | --- |');
    for(const route of routes) lines.push(`| ${route.source} → ${route.target} | ${rows.filter(c=>c.sourceApp===route.source&&c.targetApp===route.target).map(c=>`${cell(c.personaId)}: ${c.status}${c.runId?` (${cell(c.runId)})`:''}`).join('; ')} |`);
  }
  if(report.excludedAttempts.length) lines.push('',`Excluded attempts: ${report.excludedAttempts.map(a=>`${cell(a.buildId)}/${cell(a.runId)} — ${a.reason}`).join('; ')}`);
  lines.push('',...report.limits.map(l=>`- ${l}`),'','The companion JSON retains every case, build/run identity, check limitations and grouped measurements.','');
  return lines.join('\n');
}
export function reportExitCode(report: QualityReport): 0|1|2 {
  if(report.excludedAttempts.length || report.builds.some(b=>(!report.selectedBuildId||b.buildId===report.selectedBuildId)&&b.failedCases>0)) return 1;
  return report.complete?0:2;
}
