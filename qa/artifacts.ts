import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface EvidenceArtifact {
  id: string; path: string; sha256: string; evidenceKind: 'native' | 'fixture';
  buildId: string; runId: string;
}
export interface ArtifactCheck { id: string; status: 'pass' | 'fail' | 'blocked'; detail: string }
/** Verifies identity and bytes, not the honesty/accuracy of the native observer. */
export async function verifyArtifacts(root: string, artifacts: EvidenceArtifact[], identity: {buildId: string; runId: string}): Promise<ArtifactCheck[]> {
  const base = await realpath(root);
  const seen = new Set<string>();
  return Promise.all(artifacts.map(async a => {
    const result = (status: ArtifactCheck['status'], detail: string) => ({id:a.id,status,detail});
    if (!a.id || seen.has(a.id)) return result('fail','Duplicate or absent artifact ID');
    seen.add(a.id);
    if (a.buildId !== identity.buildId || a.runId !== identity.runId) return result('fail','Artifact belongs to another build/run');
    if (!['native','fixture'].includes(a.evidenceKind) || !/^[a-f0-9]{64}$/i.test(a.sha256)) return result('fail','Invalid artifact kind/hash');
    if (typeof a.path !== 'string' || isAbsolute(a.path)) return result('fail','Artifact path must be relative to its capture');
    try {
      const path = await realpath(resolve(base,a.path));
      const rel = relative(base,path);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return result('fail','Artifact escapes capture root');
      const bytes = await readFile(path);
      return createHash('sha256').update(bytes).digest('hex') === a.sha256.toLowerCase()
        ? result('pass','Artifact bytes and build/run identity match') : result('fail','Artifact hash mismatch');
    } catch { return result('blocked','Artifact missing or unreadable'); }
  }));
}
