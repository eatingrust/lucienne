import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { SourceProfile } from '../../contracts/index.js';

export interface PreparedProjectFile { relativePath: string; contents: string }
export interface NativeTaskRecipe {
  profileId: string;
  sourceApp: SourceProfile['sourceApp'];
  personaId: string;
  prepared: true;
  nativeVerified: false;
  objective: string;
  steps: { id: string; instruction: string; observedResult: string }[];
}
export interface PreparedProject {
  mode: 'prepared';
  nativeVerified: false;
  projectPath: string;
  projectXml: string;
  files: PreparedProjectFile[];
  task: NativeTaskRecipe;
  evidenceRefs: string[];
}

const PERSONAS: Record<SourceProfile['sourceApp'], Readonly<Record<string, string>>> = {
  photoshop: { essentials: 'Create a short image montage', retoucher: 'Sequence prepared product-image cards', collage: 'Arrange a layered image montage' },
  illustrator: { essentials: 'Sequence a graphic storyboard', 'type-poster': 'Edit a poster title over a storyboard', 'vector-collage': 'Arrange a graphic collage sequence' },
  gimp: { default: 'Create a short image montage', retoucher: 'Sequence prepared photo cards', collage: 'Arrange a layered image montage' },
  premiere: { editing: 'Cut and trim a short sequence', dialogue: 'Adjust the timing of a documentary storyboard', color: 'Compare prepared colour cards in the monitor' },
  'after-effects': { standard: 'Preview a short title composition', motion: 'Time a title over a graphic sequence', compositor: 'Adjust a title over layered stills' },
  resolve: { edit: 'Cut and trim a short sequence', dialogue: 'Adjust the timing of a documentary storyboard', color: 'Compare prepared colour cards in the monitor' },
};

const escapeXml = (value: string): string => value.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
const property = (name: string, value: string | number): string => `<property name="${escapeXml(name)}">${escapeXml(String(value))}</property>`;
const props = (values: Record<string, string | number>): string => Object.entries(values).map(([k, v]) => property(k, v)).join('\n');

export function nativeTaskRecipe(source: SourceProfile): NativeTaskRecipe {
  const objective = PERSONAS[source.sourceApp]?.[source.personaId];
  if (!objective) throw new Error('KDENLIVE_UNKNOWN_PERSONA');
  const imageRoute = ['photoshop', 'illustrator', 'gimp'].includes(source.sourceApp);
  return {
    profileId: source.profileId, sourceApp: source.sourceApp, personaId: source.personaId,
    prepared: true, nativeVerified: false, objective,
    steps: [
      ...(imageRoute ? [{ id: 'montage', instruction: 'Capture native montage/title BEFORE state with the loaded three stills and title, then move the second still to change their chronological order.', observedResult: 'The native timeline order and Project Monitor show the changed still sequence.' },
        { id: 'title', instruction: 'Edit the existing title text and accept the editor; capture native montage/title AFTER state now, before the separate cut/trim tasks.', observedResult: 'The Project Monitor shows the new text; reopening the native title editor retains the editable text.' }] : []),
      { id: 'cut', instruction: 'Place the playhead inside the first clip, select Razor Tool, and split that clip.', observedResult: 'The timeline contains two editable clips at the cut, without changing sequence duration.' },
      { id: 'trim', instruction: 'Return to Selection Tool and drag one split clip edge to shorten it.', observedResult: 'The native clip edge and duration change; this is an actual timeline edit.' },
      { id: 'play', instruction: 'Play across the cut and pause from the Project Monitor.', observedResult: 'The playhead advances through the edited sequence and stops when paused.' },
      { id: 'save-reopen', instruction: 'Save the visitor project, close it, and reopen it during the assigned native QA slot.', observedResult: 'Native cut/trim changes and any montage/title edits remain present without missing-media warnings.' },
    ],
  };
}

function imageSvg(index: number): string {
  const colours = ['#365B79', '#8A6641', '#526D5B'];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><rect width="1920" height="1080" fill="${colours[index]}"/><circle cx="${460 + index * 280}" cy="470" r="220" fill="#e5dfd0"/><rect x="190" y="840" width="1540" height="8" fill="#f3f0e8"/><text x="190" y="965" font-family="sans-serif" font-size="62" fill="#ffffff">Prepared demonstration still ${index + 1}</text></svg>`;
}

/** Pure preparation. This never opens Kdenlive, changes preferences, or reports readiness. */
export function buildPreparedProject(options: { runId: string; source: SourceProfile; directory: string }): PreparedProject {
  const { runId, source, directory } = options;
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(runId)) throw new Error('KDENLIVE_INVALID_RUN_ID');
  if (!isAbsolute(directory) || /[\u0000-\u001f]/.test(directory)) throw new Error('KDENLIVE_INVALID_PROJECT_DIRECTORY');
  const task = nativeTaskRecipe(source);
  const digest = createHash('sha256').update(`${runId}:${source.profileId}`).digest('hex');
  const sequence = `{${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}}`;
  const documentId = String(parseInt(digest.slice(0, 12), 16));
  const fps = 25;
  const frameCount = fps * 12;
  const stillFrames = frameCount / 3;
  const titleXml = `<kdenlivetitle width="1920" height="1080" out="${frameCount - 1}"><item z-index="0" type="QGraphicsTextItem"><position x="180" y="90"><transform>1,0,0,0,1,0,0,0,1</transform></position><content font-color="255,255,255,255" font-outline-color="0,0,0,255" font-pixel-size="72" font-italic="0" font-underline="0" font-weight="50" font="Arial" font-outline="2">Editable demonstration title</content></item><startviewport rect="0,0,1920,1080"/><endviewport rect="0,0,1920,1080"/><background color="0,0,0,0"/></kdenlivetitle>`;
  const files: PreparedProjectFile[] = [0, 1, 2].map(index => ({ relativePath: `still-${index + 1}.svg`, contents: imageSvg(index) }));
  const producers = files.map((file, index) => `<producer id="still${index}" in="0" out="${stillFrames - 1}">${props({ length: stillFrames, eof: 'pause', resource: join(directory, file.relativePath), mlt_service: 'qimage', 'kdenlive:clipname': `Prepared still ${index + 1}`, 'kdenlive:duration': stillFrames, 'kdenlive:id': index + 4, 'kdenlive:clip_type': 2, 'kdenlive:folderid': -1, seekable: 1 })}</producer>`).join('\n');
  const titleProducer = `<producer id="title" in="0" out="${frameCount - 1}">${props({ length: frameCount, eof: 'pause', mlt_service: 'kdenlivetitle', xmldata: titleXml, 'kdenlive:clipname': 'Editable demonstration title', 'kdenlive:duration': frameCount, 'kdenlive:id': 7, 'kdenlive:clip_type': 2, 'kdenlive:folderid': -1, seekable: 1 })}</producer>`;
  const emptyAudioTrack = (id: number): string => `<playlist id="a${id}a">${property('kdenlive:audio_track', 1)}</playlist><playlist id="a${id}b">${property('kdenlive:audio_track', 1)}</playlist><tractor id="audio${id}" in="0">${props({ 'kdenlive:audio_track': 1, 'kdenlive:trackheight': 57, 'kdenlive:timeline_active': 1, 'kdenlive:collapsed': 0 })}<track hide="video" producer="a${id}a"/><track hide="video" producer="a${id}b"/></tractor>`;
  const videoTrack = (id: number, contents: string): string => `<playlist id="v${id}a">${contents}</playlist><playlist id="v${id}b"/><tractor id="video${id}" in="0" out="${frameCount - 1}">${props({ 'kdenlive:trackheight': 90, 'kdenlive:timeline_active': 1, 'kdenlive:collapsed': 0 })}<track hide="audio" producer="v${id}a"/><track hide="audio" producer="v${id}b"/></tractor>`;
  const imageEntries = files.map((_, index) => `<entry producer="still${index}" in="0" out="${stillFrames - 1}">${property('kdenlive:id', index + 4)}</entry>`).join('\n');
  const transitions = [1, 2, 3, 4].map(track => `<transition in="0" out="${frameCount - 1}">${props({ a_track: 0, b_track: track, mlt_service: track <= 2 ? 'mix' : 'qtblend', kdenlive_id: track <= 2 ? 'mix' : 'qtblend', internal_added: 237, always_active: 1, ...(track <= 2 ? { sum: 1, accepts_blanks: 1 } : { compositing: 0, distort: 0, rotate_center: 0 }) })}</transition>`).join('\n');
  const sequenceProperties = {
    'kdenlive:uuid': sequence, 'kdenlive:clipname': 'Prepared demonstration montage', 'kdenlive:sequenceproperties.hasAudio': 1,
    'kdenlive:sequenceproperties.hasVideo': 1, 'kdenlive:sequenceproperties.activeTrack': 2, 'kdenlive:sequenceproperties.tracksCount': 4,
    'kdenlive:sequenceproperties.documentuuid': sequence, 'kdenlive:control_uuid': sequence, 'kdenlive:duration': frameCount,
    'kdenlive:maxduration': frameCount, 'kdenlive:producer_type': 17, 'kdenlive:id': 3, 'kdenlive:clip_type': 0,
    'kdenlive:folderid': 2, 'kdenlive:sequenceproperties.audioTarget': 1, 'kdenlive:sequenceproperties.videoTarget': 2,
    'kdenlive:sequenceproperties.position': 0, 'kdenlive:sequenceproperties.scrollPos': 0, 'kdenlive:sequenceproperties.tracks': 4,
    'kdenlive:sequenceproperties.zonein': 0, 'kdenlive:sequenceproperties.zoneout': frameCount, 'kdenlive:sequenceproperties.zoom': 8,
    'kdenlive:sequenceproperties.groups': '[]', 'kdenlive:sequenceproperties.guides': '[]',
  };
  const binProperties = {
    'kdenlive:folder.-1.2': 'Sequences', 'kdenlive:sequenceFolder': 2, 'kdenlive:docproperties.audioChannels': 2,
    'kdenlive:docproperties.documentid': documentId, 'kdenlive:docproperties.kdenliveversion': '24.08.1',
    'kdenlive:docproperties.version': '1.1', 'kdenlive:docproperties.profile': 'atsc_1080p_25',
    'kdenlive:docproperties.enableproxy': 0, 'kdenlive:docproperties.generateproxy': 0,
    'kdenlive:docproperties.storagefolder': join(directory, 'cache'), 'kdenlive:docproperties.browserurl': directory,
    'kdenlive:docproperties.uuid': sequence, 'kdenlive:docproperties.opensequences': sequence,
    'kdenlive:docproperties.activetimeline': sequence, 'kdenlive:extraBins': 'project_bin:-1:0',
    'kdenlive:documentnotes': 'Prepared synthetic demonstration assets; not visitor media or a live translation result.', 'kdenlive:documentnotesversion': 2,
    xml_retain: 1,
  };
  const projectXml = `<?xml version="1.0" encoding="utf-8"?>\n<mlt LC_NUMERIC="C" producer="main_bin" root="${escapeXml(directory)}" version="7.26.0">
<profile colorspace="709" description="HD 1080p 25 fps" display_aspect_den="9" display_aspect_num="16" frame_rate_den="1" frame_rate_num="25" height="1080" progressive="1" sample_aspect_den="1" sample_aspect_num="1" width="1920"/>
<producer id="black" in="0" out="${frameCount - 1}">${props({ length: 2147483647, eof: 'continue', resource: 'black', mlt_service: 'color', 'kdenlive:playlistid': 'black_track', 'set.test_audio': 0 })}</producer>
${producers}\n${titleProducer}\n${emptyAudioTrack(0)}\n${emptyAudioTrack(1)}
${videoTrack(0, imageEntries)}\n${videoTrack(1, `<entry producer="title" in="0" out="${frameCount - 1}">${property('kdenlive:id', 7)}</entry>`)}
<tractor id="${sequence}" in="0" out="${frameCount - 1}">${props(sequenceProperties)}<track producer="black"/><track producer="audio0"/><track producer="audio1"/><track producer="video0"/><track producer="video1"/>${transitions}</tractor>
<playlist id="main_bin">${props(binProperties)}<entry producer="${sequence}" in="0" out="0"/>${imageEntries}<entry producer="title" in="0" out="${frameCount - 1}"/></playlist>
<tractor id="project" in="0" out="${frameCount - 1}">${property('kdenlive:projectTractor', 1)}<track producer="${sequence}" in="0" out="${frameCount - 1}"/></tractor>
</mlt>\n`;
  files.push({ relativePath: 'montage.kdenlive', contents: projectXml });
  files.push({ relativePath: 'prepared-assets.json', contents: `${JSON.stringify({ mode: 'prepared', nativeVerified: false, runId, profileId: source.profileId, sourceApp: source.sourceApp, personaId: source.personaId, frameCount, fps, task }, null, 2)}\n` });
  return { mode: 'prepared', nativeVerified: false, projectPath: join(directory, 'montage.kdenlive'), projectXml, files, task, evidenceRefs: ['kdenlive:prepared-montage:v1', 'kdenlive:native-project-reference:24.08.1'] };
}

/** Caller owns run/generation and cleanup. Never overwrites an existing visitor directory. */
export async function writePreparedProject(options: { runId: string; source: SourceProfile; directory: string }, checkCurrent: () => void): Promise<PreparedProject> {
  const result = buildPreparedProject(options);
  checkCurrent();
  await mkdir(options.directory, { recursive: false });
  checkCurrent();
  for (const file of result.files) {
    checkCurrent();
    await writeFile(join(options.directory, file.relativePath), file.contents, { flag: 'wx', mode: 0o600 });
    checkCurrent();
  }
  return result;
}
