local directory = assert(os.getenv('LUCIENNE_REAPER_DIR'), 'REAPER_BRIDGE_DIRECTORY_REQUIRED')
local token = assert(os.getenv('LUCIENNE_REAPER_TOKEN'), 'REAPER_BRIDGE_TOKEN_REQUIRED')
local run_id = assert(os.getenv('LUCIENNE_REAPER_RUN'), 'REAPER_BRIDGE_RUN_REQUIRED')
assert(directory:match('^/PUBLIC_NATIVE_HOME_REQUIRED/Library/Application Support/Lucienne/') and not directory:find('[%z\1-\31]'), 'REAPER_INVALID_BRIDGE_DIRECTORY')
local protocol = dofile(directory .. '/native/protocol.lua')
local actions = dofile(directory .. '/native/actions.lua')
local core = dofile(directory .. '/native/bridge_core.lua').new(reaper,protocol,actions,directory,token,run_id)
local accept = protocol.new_guard(token,run_id)
local last_text
local function tick()
  local text = protocol.read(directory .. '/request.tsv')
  if text and text ~= last_text then
    last_text = text
    local request = protocol.parse(text,'request')
    if request then
      local ok,result = pcall(function()
        accept(request)
        protocol.assert_lease(directory,request)
        return core[request.command](request)
      end)
      local response = {protocol=1,token=token,sequence=request.sequence,runId=request.runId,requestId=request.requestId,generation=request.generation,ok=ok}
      if ok then response.result=result else response.error=tostring(result):match('REAPER_[A-Z_]+') or 'REAPER_NATIVE_COMMAND_FAILED' end
      protocol.write_json(directory .. '/response-' .. request.sequence .. '.json',response)
    end
  end
  if not core.closeRequested then reaper.defer(tick) end
end
tick()
