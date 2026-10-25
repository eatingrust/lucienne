-- Strict data-only filesystem protocol. This module does not call REAPER APIs.
local M = {}
local array_mt = {}
function M.array(values) return setmetatable(values or {}, array_mt) end
local function quote(value)
  return '"' .. value:gsub('[%z\1-\31\\"]', function(c)
    if c == '\\' then return '\\\\' end
    if c == '"' then return '\\"' end
    return string.format('\\u%04x', c:byte())
  end) .. '"'
end
function M.json(value)
  local kind = type(value)
  if kind == 'nil' then return 'null' end
  if kind == 'boolean' then return value and 'true' or 'false' end
  if kind == 'number' then
    assert(value == value and value ~= math.huge and value ~= -math.huge, 'NONFINITE_JSON')
    return string.format('%.17g', value)
  end
  if kind == 'string' then return quote(value) end
  assert(kind == 'table', 'INVALID_JSON_TYPE')
  local output = {}
  if getmetatable(value) == array_mt then
    for i = 1, #value do output[#output + 1] = M.json(value[i]) end
    return '[' .. table.concat(output, ',') .. ']'
  end
  local keys = {}
  for key in pairs(value) do assert(type(key) == 'string', 'INVALID_JSON_KEY'); keys[#keys + 1] = key end
  table.sort(keys)
  for _, key in ipairs(keys) do output[#output + 1] = quote(key) .. ':' .. M.json(value[key]) end
  return '{' .. table.concat(output, ',') .. '}'
end
function M.read(path, maximum)
  local file = io.open(path, 'rb')
  if not file then return nil end
  local text = file:read((maximum or 16384) + 1)
  file:close()
  if not text or #text > (maximum or 16384) then return nil end
  return text
end
function M.write_json(path, value)
  local encoded = M.json(value)
  assert(#encoded <= 131072, 'RESPONSE_TOO_LARGE')
  local file = assert(io.open(path .. '.tmp', 'wb'), 'RESPONSE_WRITE_FAILED')
  assert(file:write(encoded .. '\n'), 'RESPONSE_WRITE_FAILED')
  assert(file:close(), 'RESPONSE_WRITE_FAILED')
  assert(os.rename(path .. '.tmp', path), 'RESPONSE_RENAME_FAILED')
end
local function identifier(value)
  return type(value) == 'string' and #value > 0 and #value <= 160 and value:match('^[%w._:/%-]+$') ~= nil
end
local function integer(value)
  if not value or not value:match('^%d+$') then return nil end
  local result = tonumber(value)
  if not result or result > 9007199254740991 then return nil end
  return result
end
local fields = { protocol=true, token=true, sequence=true, command=true, runId=true,
  requestId=true, generation=true, source=true }
local commands = { hello=true, apply=true, readback=true, observe=true, restore=true, close=true }
local sources = { premiere=true, ['after-effects']=true, resolve=true }
function M.parse(text, kind)
  if type(text) ~= 'string' or #text > 16384 or #text == 0 or text:sub(-1) ~= '\n' or
      text:find('[%z\1-\8\11-\31\127]') then return nil, 'MALFORMED_PROTOCOL' end
  local result = { operations = M.array() }
  local seen_operations = {}
  for line in text:gmatch('([^\n]+)\n') do
    local key, value, extra = line:match('^([^\t]+)\t([^\t]+)\t?(.*)$')
    if not key then return nil, 'MALFORMED_PROTOCOL' end
    if key == 'op' and kind == 'request' then
      if not identifier(value) or #extra == 0 or #extra > 160 or extra:find('\t') or seen_operations[value] then
        return nil, 'INVALID_OPERATION'
      end
      seen_operations[value] = true
      result.operations[#result.operations + 1] = { capabilityId=value, value=extra }
      if #result.operations > 64 then return nil, 'TOO_MANY_OPERATIONS' end
    else
      local allowed = fields[key] and kind == 'request' or
        kind == 'lease' and ({ protocol=true, token=true, sequence=true, runId=true, requestId=true, generation=true, expiresAt=true })[key] or
        kind == 'active' and ({ protocol=true, token=true, runId=true, generation=true })[key]
      if not allowed or result[key] ~= nil or extra ~= '' then return nil, 'UNKNOWN_OR_DUPLICATE_FIELD' end
      result[key] = value
    end
  end
  if result.protocol ~= '1' or type(result.token) ~= 'string' or #result.token ~= 64 or not result.token:match('^[a-f0-9]+$') or not identifier(result.runId) then
    return nil, 'INVALID_IDENTITY'
  end
  result.protocol = 1
  if kind == 'active' then
    if result.generation then result.generation = integer(result.generation); if not result.generation then return nil, 'INVALID_GENERATION' end end
    return result
  end
  if not identifier(result.requestId) then return nil, 'INVALID_IDENTITY' end
  result.sequence, result.generation = integer(result.sequence), integer(result.generation)
  if not result.sequence or result.sequence < 1 or not result.generation then return nil, 'INVALID_GENERATION' end
  if kind == 'lease' then
    result.expiresAt = integer(result.expiresAt)
    if not result.expiresAt then return nil, 'INVALID_LEASE' end
  elseif not commands[result.command] or not sources[result.source] or (#result.operations > 0 and result.command ~= 'apply') then
    return nil, 'INVALID_COMMAND'
  end
  return result
end
function M.same_identity(left, right)
  if not left or not right then return false end
  for _, key in ipairs({'protocol','token','sequence','runId','requestId','generation'}) do
    if left[key] ~= right[key] then return false end
  end
  return true
end
function M.assert_lease(directory, request, now_ms)
  local lease = M.parse(M.read(directory .. '/lease.tsv'), 'lease')
  assert(M.same_identity(request, lease) and (now_ms or os.time() * 1000) <= lease.expiresAt, 'REAPER_STALE_LEASE')
end
function M.active(directory, token, run_id)
  local value = M.parse(M.read(directory .. '/active.tsv'), 'active')
  return value and value.token == token and value.runId == run_id
end
function M.new_guard(token, run_id)
  local last_sequence, generation, source = 0, -1, nil
  return function(request)
    assert(request.token == token and request.runId == run_id, 'REAPER_WRONG_SESSION')
    assert(request.sequence > last_sequence, 'REAPER_REPLAYED_SEQUENCE')
    assert(request.generation >= generation, 'REAPER_STALE_GENERATION')
    assert(not source or request.source == source, 'REAPER_SOURCE_CHANGED')
    last_sequence, generation, source = request.sequence, request.generation, request.source
  end
end
return M
