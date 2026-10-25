-- The seven source actions are finite, reviewed native behavior recipes.
local M = {}
M.ids = {
  select='RSef6329fc97cffc88230b1de4489afc5ab19d2c46',
  ['razor-tool']='RS4dc9fde0ad97db907ca504a37c333199b9ff4209',
  ['blade-tool']='RSa35bb298ea9e37240ba7f3158d838a17f5aa0870',
  pan='RS805bd63f1a0a6bbcdaf9743618019f73f9acaf10',
  ['play-pause']='RS7379ace2fa313455b0509833fe88127e3bc6343d',
  ['preview-toggle']='RScdf273a495ff57b40784d4e86f1a58072fb77d8b',
  ['mark-in']='RSf2cd7cd12daf49aecf16fb2b6752e6197c12a989',
}
M.bindings = {
  premiere = { select='V', ['razor-tool']='C', ['play-pause']='Space' },
  ['after-effects'] = { select='V', pan='H', ['preview-toggle']='Space' },
  resolve = { ['blade-tool']='B', ['mark-in']='I', ['play-pause']='Space' },
}
M.mouse_contexts = {'MM_CTX_ITEM_CLK', 'MM_CTX_ITEM', 'MM_CTX_TRACK'}
function M.find_action(api, name)
  local section = api.SectionFromUniqueID(0)
  assert(section, 'REAPER_MAIN_SECTION_UNAVAILABLE')
  for index = 0, 65535 do
    local command, text = api.kbd_enumerateActions(section, index)
    if command == 0 then break end
    if text == name then return command end
  end
  error('REAPER_NATIVE_ACTION_UNAVAILABLE:' .. name)
end
local function set_mouse(api, check, context, action)
  check(); api.SetMouseModifier(context, 0, action)
  local actual = api.GetMouseModifier(context, 0)
  assert(type(actual) == 'string' and #actual > 0, 'REAPER_MOUSE_READBACK_FAILED')
  return actual
end
function M.perform(api, action, check, options)
  assert(M.ids[action], 'REAPER_UNKNOWN_ACTION')
  check()
  if action == 'select' then
    assert(options and type(options.trackDragBaseline) == 'string' and #options.trackDragBaseline > 0, 'REAPER_MOUSE_BASELINE_MISSING')
    local select = M.find_action(api, 'Item: Select item under mouse cursor')
    local click = set_mouse(api, check, 'MM_CTX_ITEM_CLK', tostring(select) .. ' c')
    assert(tonumber(click:match('^%d+')) == select, 'REAPER_SELECTION_MAPPING_FAILED')
    -- The official SetMouseModifier API explicitly documents Move item as 1 m.
    local drag = set_mouse(api, check, 'MM_CTX_ITEM', 'Move item')
    assert(tonumber(drag:match('^%d+')) == 1 and not drag:match(' c$'), 'REAPER_MOVE_MAPPING_FAILED')
    local track_drag = set_mouse(api, check, 'MM_CTX_TRACK', options.trackDragBaseline)
    assert(track_drag == options.trackDragBaseline, 'REAPER_SELECTION_NAVIGATION_RESTORE_FAILED')
  elseif action == 'razor-tool' or action == 'blade-tool' then
    local split = M.find_action(api, 'Item: Split item under mouse cursor (no change selection)')
    local actual = set_mouse(api, check, 'MM_CTX_ITEM_CLK', tostring(split) .. ' c')
    assert(tonumber(actual:match('^%d+')) == split, 'REAPER_SPLIT_MAPPING_FAILED')
    -- Dragging an edge still uses REAPER's native trim behavior.
  elseif action == 'pan' then
    -- H activates native hand navigation on empty track space. Item-edge trimming remains intact.
    local before = set_mouse(api, check, 'MM_CTX_TRACK', 'Marquee select items')
    local after = set_mouse(api, check, 'MM_CTX_TRACK', 'Just hand scroll')
    assert(before ~= after, 'REAPER_PAN_MAPPING_UNAVAILABLE')
  elseif action == 'play-pause' or action == 'preview-toggle' then
    if api.GetPlayState() & 1 == 1 then check(); api.OnPauseButton() else check(); api.OnPlayButton() end
  elseif action == 'mark-in' then
    local cursor = api.GetCursorPosition()
    local _, finish = api.GetSet_LoopTimeRange2(0, false, false, 0, 0, false)
    if finish <= cursor then finish = api.GetProjectLength(0) end
    assert(finish > cursor, 'REAPER_MARK_IN_REQUIRES_LATER_OUT_POINT')
    check(); api.GetSet_LoopTimeRange2(0, true, false, cursor, finish, false)
    local actual_start, actual_finish = api.GetSet_LoopTimeRange2(0, false, false, 0, 0, false)
    assert(math.abs(actual_start-cursor)<0.000001 and math.abs(actual_finish-finish)<0.000001, 'REAPER_MARK_IN_READBACK_FAILED')
  end
end
function M.run(action)
  local directory, token, run_id = os.getenv('LUCIENNE_REAPER_DIR'), os.getenv('LUCIENNE_REAPER_TOKEN'), os.getenv('LUCIENNE_REAPER_RUN')
  if not directory or not token or not run_id then return end
  local protocol = dofile(directory .. '/native/protocol.lua')
  local function check()
    assert(protocol.active(directory, token, run_id), 'REAPER_SESSION_INACTIVE')
    local _, current_run = reaper.GetProjExtState(0, 'Lucienne', 'runId')
    assert(current_run == run_id and reaper.EnumProjects(1) == nil and reaper.CountTracks(0) == 1, 'REAPER_UNOWNED_PROJECT')
  end
  -- No modal dialog from an inactive shortcut; reset revokes the marker before stopping the process.
  return pcall(function()
    local baseline = protocol.read(directory .. '/track-drag-baseline.txt',160)
    M.perform(reaper, action, check, {trackDragBaseline=baseline})
  end)
end
return M
