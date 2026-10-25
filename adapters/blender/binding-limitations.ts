/** Product runtime disclosures for existing Blender equivalents; not native acceptance evidence. */
export const BLENDER_BINDING_LIMITATIONS: Readonly<Record<string, string>> = Object.freeze({
  "brush": "Sculpts mesh geometry rather than painting image pixels. Select a practice mesh first; select/transform controls return to Object Mode.",
  "select-rectangle": "Selects Blender objects rather than image pixels.",
  "transform": "Transforms Blender objects rather than a raster free-transform box; the approved headline task is object select/move.",
  "select": "Selection targets objects or strips according to editor context.",
  "pan": "Finish or cancel native modal navigation before requesting chat/readback.",
  "zoom": "Finish or cancel native modal navigation before requesting chat/readback.",
  "razor-tool": "Native split command, not a persistent Premiere razor cursor; a real practice color strip supplies editable content.",
  "play-pause": "Plays the native practice scene/sequence; no source-media or project conversion is implied.",
  "preview-toggle": "Native playback is not an After Effects cached/RAM preview.",
  "blade-tool": "Native split command, not a persistent Resolve blade cursor.",
  "mark-in": "Marks the native preview playback range; does not assign media-source in metadata or trim the strip."
});
