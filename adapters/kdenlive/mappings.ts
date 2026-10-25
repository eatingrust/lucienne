/** Evidence dispositions for host's host-trusted applicability contract.
 * Unproven equivalents are NOT unavailable capabilities or offered bindings. */
export const KDENLIVE_MAPPING_EVIDENCE = [
  {action:'select', disposition:'mapped', native:'select_tool', evidenceRef:'kdenlive:24.08.1:shortcut-actions', evidence:'installed24.08.1:shortcuts/Premiere', limitation:'Selects timeline clips, rather than source image/vector objects.'},
  {action:'razor-tool', disposition:'mapped', native:'razor_tool', evidenceRef:'kdenlive:24.08.1:shortcut-actions', evidence:'installed24.08.1:shortcuts/Premiere', limitation:''},
  {action:'blade-tool', disposition:'mapped', native:'razor_tool', evidenceRef:'kdenlive:24.08.1:shortcut-actions', evidence:'installed24.08.1:shortcuts/Premiere', limitation:''},
  {action:'play-pause', disposition:'mapped', native:'monitor_play', evidenceRef:'kdenlive:24.08.1:shortcut-actions', evidence:'installed24.08.1:shortcuts/Premiere', limitation:''},
  {action:'preview-toggle', disposition:'mapped', native:'monitor_play', evidenceRef:'kdenlive:24.08.1:shortcut-actions', evidence:'installed24.08.1:shortcuts/Premiere', limitation:'Plays the active Kdenlive monitor; not After Effects RAM preview controls.'},
  {action:'mark-in', disposition:'mapped', native:'mark_in', evidenceRef:'kdenlive:24.08.1:shortcut-actions', evidence:'installed24.08.1:shortcuts/Premiere', limitation:''},
  {action:'brush', evidenceRef:'kdenlive:24.08.1:brush-absent', disposition:'unavailable', native:null, evidence:'https://github.com/KDE/kdenlive/blob/v24.08.1/src/titler/graphicsscenerectmove.h#L15', limitation:'Kdenlive timeline/title tools do not include a raster paint brush. Editable montage and title tasks remain available.'},
  {action:'select-rectangle', evidenceRef:'kdenlive:24.08.1:title-selection-candidate', disposition:'unproven', native:'title editor rubber-band object selection', evidence:'https://github.com/KDE/kdenlive/blob/v24.08.1/src/titler/titlewidget.cpp#L390', limitation:'Source M/R routing is implemented locally; title-only native input delivery, Selection Tool selector and selected-tool readback remain unverified.'},
  {action:'transform', evidenceRef:'kdenlive:24.08.1:title-transform-candidate', disposition:'unproven', native:'title item scale and rotation controls', evidence:'https://github.com/KDE/kdenlive/blob/v24.08.1/src/titler/titlewidget.cpp#L1859', limitation:'Source Meta+T/Shift+T routing targets selected-object scale/rotation properties, not unified transform. Native object identity, control focus and scoped input delivery remain unverified.'},
  {action:'pan', evidenceRef:'kdenlive:24.08.1:title-pan-candidate', disposition:'unproven', native:'title viewport middle-button drag', evidence:'https://github.com/KDE/kdenlive/blob/v24.08.1/src/titler/graphicsscenerectmove.cpp#L759', limitation:'Persistent H-mode routing is implemented locally. Native input delivery, physical button state, canvas coordinates and pan readback remain unverified; native pan clears object selection.'},
  {action:'zoom', disposition:'unproven', native:'title viewport zoom percentage', evidenceRef:'kdenlive:24.08.1:title-zoom-candidate', evidence:'https://github.com/KDE/kdenlive/blob/v24.08.1/src/titler/titlewidget.cpp#L1076', limitation:'Persistent Z-mode viewport-step routing is implemented locally; native percentage selector, scoped input delivery and independent zoom readback remain unverified.'},
] as const;

for (const finding of KDENLIVE_MAPPING_EVIDENCE) Object.freeze(finding);
Object.freeze(KDENLIVE_MAPPING_EVIDENCE);
