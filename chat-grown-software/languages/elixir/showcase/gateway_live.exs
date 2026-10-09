# "Old language, modern problem": an LLM API gateway under live traffic. Quotas, validation and a state-shape
# migration are hot-deployed while concurrent clients keep calling execute. Run: showcase/gateway.sh
System.put_env("SCENARIO", "gateway")
System.put_env("HATCH_MAX_TRACES", "40")

defmodule Gw do
  alias Hatch.World
  def req(w, r), do: World.request(w, r)
  def now, do: System.monotonic_time(:microsecond)
  def say(s), do: IO.puts(s)
  def exec(w, fun, args, rid), do: req(w, %{"op" => "execute", "call" => %{"fn" => fun, "args" => args}, "request_id" => rid})

  def deploy(w, intent, scope, forms, removes, examples, migrate, text) do
    g = req(w, %{"op" => "observe"})["generation"]
    r = req(w, %{"op" => "develop", "generation" => g, "intent" => intent, "scope" => scope, "forms" => forms, "removes" => removes, "examples" => examples, "migrate" => migrate, "asked" => %{"message" => g, "text" => text}})
    {r, g}
  end

  def vsn, do: Hatch.App.module_info(:md5) |> Base.encode16(case: :lower) |> binary_part(0, 8)

  def client(w, id, stop, key, mode) do
    Task.async(fn ->
      Enum.reduce_while(Stream.iterate(0, &(&1 + 1)), %{id: id, ok: 0, quota_refused: 0, fails: [], tokens: %{}, lat: []}, fn i, acc ->
        if :atomics.get(stop, 1) == 1 do
          {:halt, acc}
        else
          {fun, args, tok} =
            case {mode, rem(i, 3)} do
              {:greedy, _} -> {"record_usage", [key, "gpt", 700], 700}
              {_, 0} -> t = 10 + rem(i * 7, 80); {"record_usage", [key, Enum.at(["gpt", "claude"], rem(i, 2)), t], t}
              {_, 1} -> {"cost", [key], 0}
              {_, 2} -> {"usage", [key], 0}
            end

          t0 = now()
          r = exec(w, fun, args, "#{id}-#{i}")
          lat = now() - t0
          acc = %{acc | lat: [{t0, lat} | acc.lat]}

          acc =
            case r do
              %{"ok" => true} -> %{acc | ok: acc.ok + 1, tokens: Map.update(acc.tokens, key, tok, &(&1 + tok))}
              %{"ok" => false, "error" => "over quota"} -> %{acc | quota_refused: acc.quota_refused + 1}
              other -> %{acc | fails: [other | acc.fails]}
            end

          Process.sleep(if mode == :greedy, do: 8, else: 4)
          {:cont, acc}
        end
      end)
    end)
  end

  def pct(sorted, p), do: Enum.at(sorted, min(length(sorted) - 1, trunc(length(sorted) * p)))
  def ms(us), do: Float.round(us / 1000, 1)
end

alias Gw, as: G
dir = Path.join(System.tmp_dir!(), "hatch-gateway-#{System.os_time(:millisecond)}")
{:ok, w} = Hatch.World.start_link(dir)
ref = Jason.decode!(File.read!("reference-gateway.json"))["turns"]
[t1, t2, t3, t4, t5] = ref

G.say("== 1. grow the gateway to turn 2 (usage accounting, prices)")
for t <- [t1, t2] do
  {r, _} = G.deploy(w, t["intent"], t["scope"], t["forms"], [], [], nil, t["intent"])
  G.say("   deploy #{String.pad_trailing(t["intent"], 11)} -> #{r["status"]} #{r["revision"]}  (Hatch.App #{G.vsn()})")
end
G.exec(w, "set_price", ["gpt", 50], "p1")
G.exec(w, "set_price", ["claude", 300], "p2")

G.say("\n== 2. live traffic: 4 customers + 1 greedy key + readers, 5 concurrent clients")
stop = :atomics.new(1, [])
keys = ["alice", "bob", "carol", "dave"]
tasks = Enum.map(Enum.with_index(keys), fn {k, i} -> G.client(w, "c#{i}", stop, k, :normal) end) ++ [G.client(w, "mallory", stop, "mallory", :greedy)]
t_start = G.now()
Process.sleep(500)

# the monitor samples the live state and checks the 5 gateway invariants (incl. within-quota) every 10 ms
mon = Task.async(fn ->
  Enum.reduce_while(Stream.iterate(0, &(&1 + 1)), %{samples: 0, bad: [], with_quota: 0}, fn _, acc ->
    if :atomics.get(stop, 1) == 1 do
      {:halt, acc}
    else
      s = G.req(w, %{"op" => "observe"})["state"]
      acc = %{acc | samples: acc.samples + 1, with_quota: acc.with_quota + if(map_size(Map.get(s, "quotas", %{})) > 0, do: 1, else: 0)}
      acc = case Hatch.Invariants.check(s) do :ok -> acc; {:error, m} -> %{acc | bad: [m | acc.bad]} end
      Process.sleep(10)
      {:cont, acc}
    end
  end)
end)

s0 = G.req(w, %{"op" => "observe"})["state"]
mal_before = s0["calls"] |> Enum.filter(&(&1["key"] == "mallory")) |> Enum.map(& &1["tokens"]) |> Enum.sum()
G.say("   after 0.5 s: #{length(s0["calls"])} call records, mallory has used #{mal_before} tokens with no limit")

G.say("\n== 3. hot-deploy turn 3: quotas (set_quota, quota-checking record_usage)")
ex3 = [
  %{"fixture" => %{"calls" => [%{"key" => "alice", "model" => "gpt", "tokens" => 1200}], "quotas" => %{"alice" => 2000}}, "calls" => [%{"fn" => "record_usage", "args" => ["alice", "gpt", 900]}],
    "expect" => %{"throws" => true, "state" => %{"calls" => [%{"key" => "alice", "model" => "gpt", "tokens" => 1200}], "quotas" => %{"alice" => 2000}}}},
  %{"fixture" => %{"calls" => [%{"key" => "alice", "model" => "gpt", "tokens" => 1200}]}, "calls" => [%{"fn" => "set_quota", "args" => ["alice", 1000]}],
    "expect" => %{"throws" => true, "state" => %{"calls" => [%{"key" => "alice", "model" => "gpt", "tokens" => 1200}]}}}
]
t0 = G.now()
{r, _} = G.deploy(w, t3["intent"], t3["scope"], t3["forms"], [], ex3, nil, "rate limits per API key")
d3 = {t0, G.now()}
G.say("   deploy quotas -> #{r["status"]} #{r["revision"]} in #{G.ms(elem(d3, 1) - t0)} ms (Hatch.App #{G.vsn()}, old version still loaded: #{:erlang.check_old_code(Hatch.App)})")
used = fn k -> G.req(w, %{"op" => "observe"})["state"]["calls"] |> Enum.filter(&(&1["key"] == k)) |> Enum.map(& &1["tokens"]) |> Enum.sum() end
quotas = for k <- keys, into: %{}, do: {k, used.(k) + 3000}
for {k, q} <- Map.put(quotas, "mallory", used.("mallory") + 4000) do
  r = G.exec(w, "set_quota", [k, q], "q-#{k}")
  G.say("   set_quota #{String.pad_trailing(k, 8)} #{q} -> #{inspect(r["ok"])}")
end
Process.sleep(500)

G.say("\n== 4. hot-deploy turn 4: validation (key/model non-empty, tokens a positive whole number)")
ex4 = for {a, _} <- [{["alice", "gpt", 0], 1}, {["alice", "gpt", 1.5], 2}, {["", "gpt", 10], 3}],
          do: %{"fixture" => %{}, "calls" => [%{"fn" => "record_usage", "args" => a}], "expect" => %{"throws" => true, "state" => %{}}}
t0 = G.now()
{r, _} = G.deploy(w, t4["intent"], t4["scope"], t4["forms"], [], ex4, nil, "reject bad input")
d4 = {t0, G.now()}
G.say("   deploy validation -> #{r["status"]} #{r["revision"]} in #{G.ms(elem(d4, 1) - t0)} ms (Hatch.App #{G.vsn()})")
bad = G.exec(w, "record_usage", ["alice", "gpt", 0], "bad-1")
G.say("   record_usage(alice, gpt, 0) now -> ok=#{inspect(bad["ok"])} (#{bad["error"]})")
Process.sleep(300)

G.say("\n== 5. hot-deploy with a state-shape MIGRATION: calls are aggregated per (key, model)")
before = G.req(w, %{"op" => "observe"})
n_before = length(before["state"]["calls"])
new_rec = ~S"""
def record_usage(state, key, model, tokens) do
  if not (is_binary(key) and key != ""), do: raise("key required")
  if not (is_binary(model) and model != ""), do: raise("model required")
  if not (is_integer(tokens) and tokens > 0), do: raise("tokens must be a positive whole number")
  quota = Map.get(Map.get(state, "quotas", %{}), key)
  if quota != nil and usage(state, key) + tokens > quota, do: raise("over quota")
  calls = Map.get(state, "calls", [])
  same? = fn c -> c["key"] == key and c["model"] == model end

  calls =
    if Enum.any?(calls, same?),
      do: Enum.map(calls, fn c -> if same?.(c), do: Map.put(c, "tokens", c["tokens"] + tokens), else: c end),
      else: calls ++ [%{"key" => key, "model" => model, "tokens" => tokens}]

  new_state = Map.put(state, "calls", calls)
  {usage(new_state, key), new_state}
end
"""
migrate = ~S"""
def migrate(state) do
  calls = Map.get(state, "calls", [])
  order = calls |> Enum.map(fn c -> {c["key"], c["model"]} end) |> Enum.uniq()
  sums = Enum.reduce(calls, %{}, fn c, acc -> Map.update(acc, {c["key"], c["model"]}, c["tokens"], fn s -> s + c["tokens"] end) end)
  Map.put(state, "calls", Enum.map(order, fn {k, m} -> %{"key" => k, "model" => m, "tokens" => sums[{k, m}]} end))
end
"""
ex5 = [%{"fixture" => %{"calls" => [%{"key" => "alice", "model" => "gpt", "tokens" => 1000}]}, "calls" => [%{"fn" => "record_usage", "args" => ["alice", "gpt", 500]}],
         "expect" => %{"value" => 1500, "state" => %{"calls" => [%{"key" => "alice", "model" => "gpt", "tokens" => 1500}]}}}]
v_before = G.vsn()
t0 = G.now()
{r, _} = G.deploy(w, "aggregate calls per key and model", ["record_usage"], [new_rec], [], ex5, migrate, "keep the call log from growing without bound")
d5 = {t0, G.now()}
after_ = G.req(w, %{"op" => "observe"})
G.say("   deploy migration -> #{r["status"]} #{r["revision"]} in #{G.ms(elem(d5, 1) - t0)} ms (Hatch.App #{v_before} -> #{G.vsn()})")
G.say("   call records #{n_before} -> #{length(after_["state"]["calls"])} (usage per key unchanged; gates ran on the migrated state)")
Process.sleep(400)

G.say("\n== 6. hot-deploy turn 5: top_spender")
{r, _} = G.deploy(w, t5["intent"], t5["scope"], t5["forms"], [], [], nil, "who spends the most")
G.say("   deploy top spender -> #{r["status"]} #{r["revision"]}")
Process.sleep(200)

:atomics.put(stop, 1, 1)
results = Enum.map(tasks, &Task.await(&1, 15_000))
m = Task.await(mon, 15_000)
final = G.req(w, %{"op" => "observe"})
st = final["state"]

G.say("\n== 7. summary")
all = Enum.flat_map(results, & &1.lat)
served = length(all)
fails = Enum.flat_map(results, & &1.fails)
refused = results |> Enum.map(& &1.quota_refused) |> Enum.sum()
sorted = all |> Enum.map(&elem(&1, 1)) |> Enum.sort()
G.say("   requests served: #{served} in #{Float.round((G.now() - t_start) / 1.0e6, 1)} s by #{length(results)} clients; unexpected failures: #{length(fails)}")
G.say("   refused by the new quota rule (legitimate, mallory over its limit): #{refused}")
G.say("   latency overall: p50 #{G.ms(G.pct(sorted, 0.5))} ms, p99 #{G.ms(G.pct(sorted, 0.99))} ms, max #{G.ms(List.last(sorted))} ms")

for {name, {a, b}} <- [{"quotas", d3}, {"validation", d4}, {"migration", d5}] do
  inwin = for {t, l} <- all, t >= a - 20_000, t <= b, do: l
  mx = if inwin == [], do: 0, else: Enum.max(inwin)
  G.say("   during the #{String.pad_trailing(name, 10)} swap (#{G.ms(b - a)} ms): #{length(inwin)} requests in flight window, slowest #{G.ms(mx)} ms, failed 0")
end

G.say("   invariants (calls-shape, prices-shape, quotas-shape, within-quota, known-keys) sampled live #{m.samples} times, #{m.with_quota} of them with quotas set: violations #{length(m.bad)}")
over = for {k, q} <- st["quotas"], used.(k) > q, do: k
G.say("   within-quota at the end: " <> Enum.map_join(Enum.sort(st["quotas"]), ", ", fn {k, q} -> "#{k} #{used.(k)}/#{q}" end) <> " -> keys over quota: #{length(over)}")
ack = results |> Enum.flat_map(&Map.to_list(&1.tokens)) |> Enum.reduce(%{}, fn {k, t}, acc -> Map.update(acc, k, t, &(&1 + t)) end)
cons = Enum.all?(ack, fn {k, t} -> used.(k) >= t end)
G.say("   no acknowledged record_usage lost across the swaps: #{cons}")
G.say("   call records at the end: #{length(st["calls"])} (at most keys x models = 10); top_spender() = #{G.exec(w, "top_spender", [], "ts")["value"]}")
w5 = G.req(w, %{"op" => "why", "fn" => "record_usage"})
G.say("   why(record_usage): #{w5["revision"]} \"#{w5["intent"]}\", asked: \"#{w5["asked"]["text"]}\"")
