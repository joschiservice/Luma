// Each app/shop has one hash. Reservations are bounded by concurrency; query-shape cache is bounded.
// Expiring a reservation frees concurrency, never refunds a possibly consumed provider cost.
export const sharedBudgetScript = `
local key = KEYS[1]
local op, id, shape, purpose = ARGV[1], ARGV[2], ARGV[3], ARGV[4]
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local function n(field, fallback) return tonumber(redis.call('HGET', key, field)) or fallback end
local capacity, rate, available = n('capacity', 1000), n('rate', 100), n('available', 0)
local ceiling = n('ceiling', capacity)
local epoch = string.match(redis.call('INFO', 'server'), 'run_id:(%w+)')
local oldEpoch = redis.call('HGET', key, 'epoch')
local changed = oldEpoch ~= epoch
if changed then
  available = 0
  ceiling = 0
  redis.call('HSET', key, 'epoch', epoch, 'known', 0, 'available', 0, 'at', now, 'recovery', oldEpoch and 1 or 0)
end
local restored = math.max(0, now - n('at', now)) * rate / 1000
ceiling = math.min(capacity, ceiling + restored)
available = math.min(capacity, ceiling, available + restored)
local active, outstanding, mutations = 0, 0, 0
local entries = redis.call('HGETALL', key)
for i = 1, #entries, 2 do
  if string.sub(entries[i], 1, 2) == 'r:' then
    local r = cjson.decode(entries[i + 1])
    if changed or r.untilAt <= now then redis.call('HDEL', key, entries[i])
    else active = active + 1; outstanding = outstanding + r.cost; if r.mutation then mutations = mutations + 1 end end
  end
end
local cooldown = n('cooldown', 0)
local function save()
  redis.call('HSET', key, 'available', available, 'ceiling', ceiling, 'at', now)
  redis.call('PEXPIRE', key, 86400000)
end
if op == 'acquire' then
  local existing = redis.call('HGET', key, 'r:' .. id)
  if existing then local r = cjson.decode(existing); save(); return {1, r.cost, r.untilAt} end
  local cost = n('c:' .. shape, 1000)
  local known = n('known', 0) == 1
  local reserve = 0
  if purpose ~= 'foreground' and known then
    -- A first background probe may borrow one second of restore; requiring a completely full bucket would starve cost discovery.
    local measured = redis.call('HEXISTS', key, 'c:' .. shape) == 1
    reserve = math.min(measured and 1000 or math.max(0, 1000 - rate), math.max(0, capacity - cost))
  end
  local mutation = ARGV[7] == '1'
  local wait = math.max(0, cooldown - now)
  -- Serialize mutations so an admitted action can still read fresh preconditions.
  if mutation and mutations > 0 then wait = math.max(wait, 50) end
  -- Background requests leave transport slots for investigation and verification.
  if purpose ~= 'foreground' and active >= math.max(1, tonumber(ARGV[6]) - 2) then wait = math.max(wait, 50) end
  if purpose ~= 'foreground' and n('foregroundWaiting', 0) > now then wait = math.max(wait, 50) end
  if purpose == 'history' and n('incrementalWaiting', 0) > now then wait = math.max(wait, 50) end
  if active >= tonumber(ARGV[6]) or (not known and active > 0) then wait = math.max(wait, 50) end
  if known then
    local costWait = math.max(0, math.ceil((cost + reserve - available) * 1000 / rate))
    -- Outstanding requests may refund before restore alone could refill the bucket.
    if active > 0 then costWait = math.min(costWait, 50) end
    wait = math.max(wait, costWait)
  end
  if wait > 0 then
    if purpose == 'foreground' then redis.call('HSET', key, 'foregroundWaiting', now + 2000) end
    if purpose == 'incremental' then redis.call('HSET', key, 'incrementalWaiting', now + 2000) end
    save(); return {0, wait, 0}
  end
  available = math.max(0, available - cost)
  local untilAt = now + tonumber(ARGV[5])
  redis.call('HSET', key, 'r:' .. id, cjson.encode({cost=cost, untilAt=untilAt, mutation=mutation, sole=active == 0, feedbackVersion=n('feedbackVersion', 0)}))
  save(); return {1, cost, untilAt}
elseif op == 'complete' then
  local value = redis.call('HGET', key, 'r:' .. id)
  if not value then save(); return {1, 0, 0} end
  local r = cjson.decode(value)
  redis.call('HDEL', key, 'r:' .. id)
  outstanding = math.max(0, outstanding - r.cost)
  local requested, actual, observed, newRate, newCapacity = tonumber(ARGV[5]), tonumber(ARGV[6]), tonumber(ARGV[7]), tonumber(ARGV[8]), tonumber(ARGV[9])
  local advised = tonumber(ARGV[10]) or 0
  redis.call('HSET', key, 'cooldown', math.max(cooldown, now + advised))
  if requested and requested >= 0 and observed and newRate and newCapacity then
    capacity = newCapacity
    -- Concurrent responses have no provider ordering token. Never raise a restore rate while other requests are outstanding.
    rate = active > 1 and math.min(rate, newRate) or newRate
    -- Refund the local reservation once. A separate provider ceiling prevents a late response from raising a newer lower balance.
    local refunded = available + r.cost - (actual or requested)
    if n('known', 0) == 0 then
      ceiling = observed
      if n('recovery', 0) == 0 then refunded = observed - outstanding end
    elseif r.sole and r.feedbackVersion == n('feedbackVersion', 0) and active == 1 then
      -- This isolated request was sent after previous feedback. Its fresh snapshot can correct conservative drift.
      ceiling = observed
      refunded = observed
    else ceiling = math.min(ceiling, observed) end
    available = math.max(0, math.min(capacity, ceiling, refunded, observed - outstanding))
    redis.call('HSET', key, 'capacity', capacity, 'rate', rate, 'known', 1)
    redis.call('HINCRBY', key, 'feedbackVersion', 1)
    if redis.call('HEXISTS', key, 'c:' .. shape) == 1 or n('shapes', 0) < 256 then
      if redis.call('HEXISTS', key, 'c:' .. shape) == 0 then redis.call('HINCRBY', key, 'shapes', 1) end
      redis.call('HSET', key, 'c:' .. shape, math.min(1000, requested))
    end
  elseif n('known', 0) == 0 then
    -- No usable throttle evidence: serialize probes and pace by a full unknown query.
    redis.call('HSET', key, 'cooldown', math.max(cooldown, now + 10000))
  end
  save(); return {1, 0, 0}
elseif op == 'cooldown' then
  redis.call('HSET', key, 'cooldown', math.max(cooldown, now + tonumber(ARGV[5])))
  save(); return {1, 0, 0}
elseif op == 'cancel' then
  local value = redis.call('HGET', key, 'r:' .. id)
  if value then
    local r = cjson.decode(value)
    available = math.min(capacity, ceiling, available + r.cost)
    redis.call('HDEL', key, 'r:' .. id)
  end
  save(); return {1, 0, 0}
elseif op == 'check' then
  local value = redis.call('HGET', key, 'r:' .. id)
  if value then
    local r = cjson.decode(value)
    r.sole = active == 1
    r.feedbackVersion = n('feedbackVersion', 0)
    redis.call('HSET', key, 'r:' .. id, cjson.encode(r))
  end
  save()
  return {value and 1 or 0, 0, 0}
end
return redis.error_reply('Unknown Shopify admission operation')
`;
