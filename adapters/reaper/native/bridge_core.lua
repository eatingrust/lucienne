-- Native operations only: tests inject an explicitly mocked REAPER API.
local M = {}
function M.new(api, protocol, actions, directory, token, run_id)
  local self = { initialized=false, touched=false, restored=false, closeRequested=false }
  local baseline, current_request, source, project, track, track_guid, commands
  local project_handle, project_master_guid
  local created_item, pending_media, fixture_complete
  local fixture = directory .. '/fixture.wav'
  local function check(request) protocol.assert_lease(directory, request) end
  local function write(request, fn, ...)
    check(request)
    self.touched = true
    return fn(...)
  end
  local function identity(value, code)
    assert(type(value) == 'string' and value:match('%S'), code)
    return value
  end
  local function only_project()
    local current, filename = api.EnumProjects(-1)
    assert(current and not api.EnumProjects(1), 'REAPER_UNOWNED_PROJECT')
    assert(not project or current == project, 'REAPER_PROJECT_CHANGED')
    assert(not filename or filename == '', 'REAPER_SAVED_PROJECT_REQUIRES_OPERATOR')
    local handle = identity(tostring(current), 'REAPER_PROJECT_IDENTITY_UNAVAILABLE')
    local master = assert(api.GetMasterTrack(current), 'REAPER_PROJECT_IDENTITY_UNAVAILABLE')
    local master_guid = identity(api.GetTrackGUID(master), 'REAPER_PROJECT_IDENTITY_UNAVAILABLE')
    assert(not project_handle or handle == project_handle, 'REAPER_PROJECT_CONTEXT_CHANGED')
    assert(not project_master_guid or master_guid == project_master_guid, 'REAPER_PROJECT_CONTEXT_CHANGED')
    return current, handle, master_guid
  end
  local function owned(allow_empty)
    local current = only_project()
    local count, item_count = api.CountTracks(current), api.CountMediaItems(current)
    if allow_empty and count == 0 then
      assert(item_count == 0, 'REAPER_UNOWNED_MEDIA')
      return
    end
    assert(track and count == 1 and api.GetTrack(current, 0) == track and api.GetTrackGUID(track) == track_guid, 'REAPER_UNOWNED_TRACKS')
    -- Validate the whole project, including unselected items and anything outside the owned track.
    for index = 0, item_count - 1 do
      local item = assert(api.GetMediaItem(current, index), 'REAPER_PROJECT_ITEM_ENUMERATION_FAILED')
      local item_track = api.GetMediaItemTrack(item)
      assert(item_track == track and api.GetTrackGUID(item_track) == track_guid, 'REAPER_UNOWNED_TRACKS')
      if allow_empty and not fixture_complete and item == created_item and api.CountTakes(item) <= 1 then
        -- An aborted initial creation still belongs to this adapter and must be reset.
        local take = api.GetActiveTake(item)
        local media = take and api.GetMediaItemTake_Source(take)
        local filename = media and api.GetMediaSourceFileName(media)
        assert(not filename or filename == '' or filename == fixture, 'REAPER_UNOWNED_MEDIA')
        assert(not media or not api.GetMediaSourceParent(media), 'REAPER_UNOWNED_MEDIA')
      else
        assert(api.CountTakes(item) == 1, 'REAPER_UNOWNED_MEDIA')
        local take = api.GetActiveTake(item)
        local media = take and api.GetMediaItemTake_Source(take)
        assert(media and api.GetMediaSourceFileName(media) == fixture and not api.GetMediaSourceParent(media), 'REAPER_UNOWNED_MEDIA')
      end
    end
  end
  local function shortcut(action)
    local command = api.NamedCommandLookup('_' .. actions.ids[action])
    assert(command and command > 0, 'REAPER_BINDING_SCRIPT_MISSING')
    local section = api.SectionFromUniqueID(0)
    local count = api.CountActionShortcuts(section, command)
    assert(count == 1, 'REAPER_BINDING_SHORTCUT_COUNT')
    local ok, description = api.GetActionShortcutDesc(section, command, 0)
    assert(ok and type(description) == 'string', 'REAPER_BINDING_READBACK_FAILED')
    if description:lower() == 'space' then return 'Space' end
    if description:match('^[A-Za-z]$') then return description:upper() end
    return description
  end
  local function validate_bindings(source_app)
    for action, key in pairs(actions.bindings[source_app]) do
      assert(shortcut(action) == key, 'REAPER_SOURCE_BINDING_NOT_INSTALLED')
    end
  end
  local function initialize(request)
    if self.initialized then
      assert(source == request.source, 'REAPER_SOURCE_CHANGED')
      return
    end
    assert(os.getenv('USER') == 'lucienne', 'REAPER_DEMO_PROCESS_REQUIRED')
    assert(api.GetAppVersion():match('^7%.83[/%.%s%-]') or api.GetAppVersion() == '7.83', 'REAPER_VERSION_UNSUPPORTED')
    project, project_handle, project_master_guid = only_project()
    assert(api.CountTracks(0) == 0 and api.CountMediaItems(0) == 0, 'REAPER_EXISTING_PROJECT_CONTENT')
    assert(api.GetPlayState() == 0, 'REAPER_EXISTING_PLAYBACK')
    local theme = api.GetLastColorThemeFile()
    assert(type(theme) == 'string' and theme:match('[/\\]Default_7%.0%.ReaperThemeZip$'), 'REAPER_DEFAULT_THEME_REQUIRED')
    for _, section in ipairs({'tcp','mcp'}) do
      local names = {}
      for index = 0, 255 do
        local ok, name = api.ThemeLayout_GetLayout(section, index)
        if not ok then break end
        names[name] = true
      end
      assert(names.A and names.B, 'REAPER_NATIVE_LAYOUTS_UNAVAILABLE')
    end
    commands = {
      side = actions.find_action(api, 'View: Show TCP on right side of arrange'),
      mixer = actions.find_action(api, 'View: Toggle Mixer visible'),
    }
    baseline = { mouse={}, side=api.GetToggleCommandStateEx(0, commands.side), mixer=api.GetToggleCommandStateEx(0, commands.mixer) }
    assert((baseline.side == 0 or baseline.side == 1) and (baseline.mixer == 0 or baseline.mixer == 1), 'REAPER_NATIVE_TOGGLE_UNAVAILABLE')
    for _, context in ipairs(actions.mouse_contexts) do
      baseline.mouse[context] = { action=api.GetMouseModifier(context, 0), flags=api.GetMouseModifier(context, 1024) }
    end
    validate_bindings(request.source)
    check(request)
    local mouse_file = assert(io.open(directory .. '/track-drag-baseline.txt','wb'),'REAPER_MOUSE_BASELINE_WRITE_FAILED')
    assert(mouse_file:write(baseline.mouse.MM_CTX_TRACK.action),'REAPER_MOUSE_BASELINE_WRITE_FAILED')
    assert(mouse_file:close(),'REAPER_MOUSE_BASELINE_WRITE_FAILED')
    source, self.initialized = request.source, true
  end
  local function set_toggle(request, command, desired)
    local actual = api.GetToggleCommandStateEx(0, command)
    assert(actual == 0 or actual == 1, 'REAPER_NATIVE_TOGGLE_UNAVAILABLE')
    if actual ~= desired then write(request, api.Main_OnCommand, command, 0) end
    assert(api.GetToggleCommandStateEx(0, command) == desired, 'REAPER_NATIVE_TOGGLE_FAILED')
  end
  local function create_fixture(request)
    if track then owned(false); return end
    assert(api.CountTracks(0) == 0 and api.CountMediaItems(0) == 0, 'REAPER_EXISTING_PROJECT_CONTENT')
    write(request, api.InsertTrackAtIndex, 0, true)
    track = assert(api.GetTrack(0, 0), 'REAPER_TRACK_CREATE_FAILED')
    track_guid = identity(api.GetTrackGUID(track), 'REAPER_TRACK_IDENTITY_UNAVAILABLE')
    write(request, api.GetSetMediaTrackInfo_String, track, 'P_NAME', 'Lucienne audio task', true)
    write(request, api.SetMediaTrackInfo_Value, track, 'D_VOL', 0.25)
    write(request, api.SetProjExtState, 0, 'Lucienne', 'runId', run_id)
    local item = write(request, api.AddMediaItemToTrack, track)
    assert(item, 'REAPER_ITEM_CREATE_FAILED')
    created_item = item
    local take = write(request, api.AddTakeToMediaItem, item)
    assert(take, 'REAPER_TAKE_CREATE_FAILED')
    local media = write(request, api.PCM_Source_CreateFromFile, fixture)
    pending_media = media
    assert(media and api.GetMediaSourceSampleRate(media) > 0, 'REAPER_MEDIA_OFFLINE')
    local length, beats = api.GetMediaSourceLength(media)
    assert(not beats and length >= 8, 'REAPER_FIXTURE_TOO_SHORT')
    write(request, api.SetMediaItemTake_Source, take, media)
    pending_media = nil
    write(request, api.SetMediaItemInfo_Value, item, 'D_POSITION', 0)
    write(request, api.SetMediaItemInfo_Value, item, 'D_LENGTH', 8)
    write(request, api.SetMediaItemSelected, item, true)
    write(request, api.SetOnlyTrackSelected, track)
    write(request, api.SetEditCurPos, 0, false, false)
    write(request, api.UpdateArrange)
    fixture_complete = true
    actions.perform(api, 'select', function() check(request); self.touched=true end, {trackDragBaseline=baseline.mouse.MM_CTX_TRACK.action})
  end
  local function validate_operations(request)
    local allowed = {
      ['reaper.layout.panel-side']={left=true,right=true},
      ['reaper.timeline.work-area']={normal=true,large=true},
      ['reaper.tool-layout.density']={full=true,simple=true},
    }
    for action, key in pairs(actions.bindings[request.source]) do allowed['reaper.binding.' .. action] = {[key]=true} end
    local result, count = {}, 0
    for _, operation in ipairs(request.operations) do
      assert(allowed[operation.capabilityId] and allowed[operation.capabilityId][operation.value] and not result[operation.capabilityId], 'REAPER_UNSUPPORTED_OPERATION')
      result[operation.capabilityId], count = operation.value, count + 1
    end
    assert(count == 6, 'REAPER_INCOMPLETE_PATCH')
    return result
  end
  local function observation(request)
    check(request)
    owned(false)
    local current, handle, master_guid = only_project()
    local item_count, track_count = api.CountMediaItems(current), api.CountTracks(current)
    local items, item_guids = protocol.array(), {}
    for index = 0, item_count - 1 do
      local item = assert(api.GetMediaItem(current, index), 'REAPER_PROJECT_ITEM_ENUMERATION_FAILED')
      local guid_ok, guid = api.GetSetMediaItemInfo_String(item, 'GUID', '', false)
      assert(guid_ok, 'REAPER_ITEM_IDENTITY_UNAVAILABLE')
      guid = identity(guid, 'REAPER_ITEM_IDENTITY_UNAVAILABLE')
      assert(not item_guids[guid], 'REAPER_DUPLICATE_ITEM_IDENTITY')
      item_guids[guid] = true
      local item_track = assert(api.GetMediaItemTrack(item), 'REAPER_TRACK_IDENTITY_UNAVAILABLE')
      local item_track_guid = identity(api.GetTrackGUID(item_track), 'REAPER_TRACK_IDENTITY_UNAVAILABLE')
      assert(item_track == track and item_track_guid == track_guid, 'REAPER_UNOWNED_TRACKS')
      local take = api.GetActiveTake(item)
      local media = api.GetMediaItemTake_Source(take)
      local source_file = identity(api.GetMediaSourceFileName(media), 'REAPER_MEDIA_IDENTITY_UNAVAILABLE')
      local source_type = identity(api.GetMediaSourceType(media), 'REAPER_MEDIA_IDENTITY_UNAVAILABLE')
      local source_has_parent = api.GetMediaSourceParent(media) ~= nil
      assert(source_file == fixture and not source_has_parent, 'REAPER_UNOWNED_MEDIA')
      items[#items + 1] = {
        itemGuid=guid, trackGuid=item_track_guid,
        sourceFile=source_file, sourceType=source_type, sourceHasParent=source_has_parent,
        -- Stable across split/trim and independent of transient item/take/source pointer values.
        mediaId=source_type .. ':' .. source_file,
        position=api.GetMediaItemInfo_Value(item, 'D_POSITION'),
        length=api.GetMediaItemInfo_Value(item, 'D_LENGTH'),
        sourceOffset=api.GetMediaItemTakeInfo_Value(take, 'D_STARTOFFS'),
        playRate=api.GetMediaItemTakeInfo_Value(take, 'D_PLAYRATE'),
        selected=api.IsMediaItemSelected(item), sourceOnline=api.GetMediaSourceSampleRate(media) > 0,
      }
    end
    local start_time, end_time = api.GetSet_ArrangeView2(0, false, 0, 0, 0, 0)
    local selection_start, selection_end = api.GetSet_LoopTimeRange2(0, false, false, 0, 0, false)
    local _, tcp = api.GetSetMediaTrackInfo_String(track, 'P_TCP_LAYOUT', '', false)
    local _, mcp = api.GetSetMediaTrackInfo_String(track, 'P_MCP_LAYOUT', '', false)
    local _, tcp_rect = api.GetSetMediaTrackInfo_String(track, 'P_UI_RECT:tcp.size', '', false)
    local _, mcp_rect = api.GetSetMediaTrackInfo_String(track, 'P_UI_RECT:mcp.size', '', false)
    local mouse = {}
    for _, context in ipairs(actions.mouse_contexts) do mouse[context] = api.GetMouseModifier(context, 0) end
    local observed = {
      items=items, projectItemCount=item_count, trackCount=track_count,
      trackGuid=identity(api.GetTrackGUID(track), 'REAPER_TRACK_IDENTITY_UNAVAILABLE'),
      projectHandle=handle, projectMasterTrackGuid=master_guid, projectContextId=handle .. ':' .. master_guid,
      playState=api.GetPlayState(), playPosition=api.GetPlayPosition(), cursor=api.GetCursorPosition(),
      timeSelection={startTime=selection_start,endTime=selection_end},
      timeline={startTime=start_time,endTime=end_time,trackHeightOverride=api.GetMediaTrackInfo_Value(track,'I_HEIGHTOVERRIDE'), renderedTrackHeight=api.GetMediaTrackInfo_Value(track,'I_TCPH')},
      layouts={tcp=tcp,mcp=mcp}, geometry={tcp=tcp_rect,mcp=mcp_rect}, mouse=mouse,
      mixerVisible=api.GetToggleCommandStateEx(0,commands.mixer) == 1,
      source=source, runId=run_id, evidenceRefs=protocol.array(),
    }
    only_project()
    assert(api.CountMediaItems(current) == item_count and api.CountTracks(current) == track_count, 'REAPER_PROJECT_CHANGED_DURING_OBSERVATION')
    check(request)
    return observed
  end
  function self.hello(request)
    check(request); initialize(request)
    return {nativeVersion=api.GetAppVersion(),resourcePath=api.GetResourcePath(),iniPath=api.get_ini_file(),account=os.getenv('USER'),bridgeReady=true}
  end
  function self.apply(request)
    check(request); initialize(request)
    assert(not self.restored, 'REAPER_RESET_REQUIRED')
    local values = validate_operations(request)
    validate_bindings(request.source)
    create_fixture(request)
    set_toggle(request, commands.side, values['reaper.layout.panel-side'] == 'right' and 1 or 0)
    set_toggle(request, commands.mixer, 1)
    local large = values['reaper.timeline.work-area'] == 'large'
    write(request, api.SetMediaTrackInfo_Value, track, 'I_HEIGHTOVERRIDE', large and 180 or 100)
    write(request, api.GetSet_ArrangeView2, 0, true, 0, 0, 0, large and 8 or 12)
    local layout = values['reaper.tool-layout.density'] == 'simple' and 'B' or 'A'
    write(request, api.GetSetMediaTrackInfo_String, track, 'P_TCP_LAYOUT', layout, true)
    write(request, api.GetSetMediaTrackInfo_String, track, 'P_MCP_LAYOUT', layout, true)
    write(request, api.TrackList_AdjustWindows, false)
    write(request, api.UpdateArrange)
    check(request)
    current_request = {requestId=request.requestId,generation=request.generation}
    return {applied=true}
  end
  function self.readback(request)
    check(request)
    assert(current_request and current_request.requestId == request.requestId and current_request.generation == request.generation, 'REAPER_READBACK_IDENTITY')
    local observed = observation(request)
    local operations = protocol.array()
    local function append(id,value) operations[#operations+1] = {capabilityId=id,value=value} end
    local side = api.GetToggleCommandStateEx(0, commands.side)
    append('reaper.layout.panel-side', side == 1 and 'right' or side == 0 and 'left' or 'unrecognized')
    local span = observed.timeline.endTime-observed.timeline.startTime
    local height = observed.timeline.trackHeightOverride
    append('reaper.timeline.work-area', height == 180 and math.abs(span-8)<0.01 and 'large' or height == 100 and math.abs(span-12)<0.01 and 'normal' or 'unrecognized')
    append('reaper.tool-layout.density', observed.layouts.tcp == 'A' and observed.layouts.mcp == 'A' and 'full' or observed.layouts.tcp == 'B' and observed.layouts.mcp == 'B' and 'simple' or 'unrecognized')
    local names = {}
    for action in pairs(actions.bindings[source]) do names[#names+1]=action end
    table.sort(names)
    for _, action in ipairs(names) do append('reaper.binding.'..action,shortcut(action)) end
    local ready = #observed.items > 0 and observed.mixerVisible and api.GetMainHwnd() ~= nil
    for _, item in ipairs(observed.items) do ready = ready and item.sourceOnline end
    check(request)
    -- A main-window handle is not visibility proof. The host independently probes AX/modal state.
    return {requestId=request.requestId,bridgeReady=true,ownedProjectReady=ready,operations=operations}
  end
  function self.observe(request)
    check(request)
    assert(current_request and current_request.requestId == request.requestId and current_request.generation == request.generation, 'REAPER_READBACK_IDENTITY')
    return observation(request)
  end
  function self.restore(request)
    check(request)
    only_project()
    if not self.touched then self.restored=true; return {nativeRestored=true,noNativeChanges=true} end
    owned(true)
    if pending_media then write(request, api.PCM_Source_Destroy, pending_media); pending_media=nil end
    if api.GetPlayState() ~= 0 then write(request, api.OnStopButton) end
    for _, context in ipairs(actions.mouse_contexts) do
      write(request, api.SetMouseModifier, context, 0, baseline.mouse[context].action)
      -- Preserve the command modifier's no-move/no-select option bits when present.
      if baseline.mouse[context].flags and baseline.mouse[context].flags ~= '' then
        write(request, api.SetMouseModifier, context, 1024, baseline.mouse[context].flags)
      end
      assert(api.GetMouseModifier(context,0) == baseline.mouse[context].action, 'REAPER_MOUSE_RESTORE_FAILED')
    end
    set_toggle(request, commands.side, baseline.side)
    set_toggle(request, commands.mixer, baseline.mixer)
    if api.CountTracks(0) == 1 then write(request, api.DeleteTrack, track) end
    write(request, api.SetProjExtState, 0, 'Lucienne', '', '')
    write(request, api.GetSet_LoopTimeRange2, 0, true, false, 0, 0, false)
    write(request, api.SetEditCurPos, 0, false, false)
    write(request, api.UpdateArrange)
    check(request)
    assert(api.CountTracks(0) == 0 and api.CountMediaItems(0) == 0 and api.GetPlayState() == 0, 'REAPER_NATIVE_RESTORE_FAILED')
    self.restored=true
    return {nativeRestored=true,ownedTrackRemoved=true,playbackStopped=true}
  end
  function self.close(request)
    check(request)
    only_project()
    assert(self.restored and api.CountTracks(0) == 0 and api.CountMediaItems(0) == 0, 'REAPER_RESTORE_REQUIRED')
    self.closeRequested=true
    -- Host terminates and reaps its owned process after this receipt, then restores files.
    return {readyToClose=true,ownedProjectsOnly=true}
  end
  return self
end
return M
