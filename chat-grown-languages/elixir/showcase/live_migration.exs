# Live state migration on the BEAM: while 4 client processes keep calling `execute`, a change that stores amounts
# as integer cents is applied to the running world together with a migrate/1 function. Run: showcase/run.sh
alias Hatch.World

dir = Path.join(System.tmp_dir!(), "hatch-showcase-#{System.os_time(:millisecond)}")
{:ok, w} = World.start_link(dir)
req = fn r -> World.request(w, r) end
ms = fn t0 -> Float.round((System.monotonic_time(:microsecond) - t0) / 1000, 1) end
vsn = fn -> Hatch.App.module_info(:md5) |> Base.encode16(case: :lower) |> binary_part(0, 8) end

IO.puts("== 1. grow the app with the 8 reference turns (dollar floats in state)")
ref = Jason.decode!(File.read!("reference.json"))

for t <- ref["turns"] do
  g = req.(%{"op" => "observe"})["generation"]
  r = req.(%{"op" => "develop", "generation" => g, "intent" => t["intent"], "scope" => t["scope"], "forms" => t["forms"], "removes" => [], "examples" => [], "asked" => %{"message" => g, "text" => t["intent"]}})
  IO.puts("   develop #{String.pad_trailing(t["intent"], 16)} -> #{r["status"]} #{r["revision"]}")
end

for {a, c} <- [{12.5, "food"}, {40, "transport"}, {0.5, "coffee"}, {7.25, "food"}],
    do: %{"ok" => true} = req.(%{"op" => "execute", "call" => %{"fn" => "add_expense", "args" => [a, c]}, "request_id" => "seed-#{a}"})

req.(%{"op" => "execute", "call" => %{"fn" => "set_budget", "args" => ["food", 15]}, "request_id" => "seed-budget"})
before = req.(%{"op" => "observe"})
IO.puts("   state shape now: #{Jason.encode!(before["state"]["expenses"] |> hd())}  (amount in dollars)")
IO.puts("   module Hatch.App version #{vsn.()}  generation #{before["generation"]}")

IO.puts("\n== 2. start 4 clients hammering execute (add_expense / total / by_category / over_budget)")
stop = :atomics.new(1, [])
seed_total = before["state"]["expenses"] |> Enum.map(&round(&1["amount"] * 100)) |> Enum.sum()

client = fn id ->
  Task.async(fn ->
    Enum.reduce_while(Stream.iterate(0, &(&1 + 1)), %{id: id, n: 0, fails: [], added: 0, max_us: 0, last_total: 0.0, regress: 0}, fn i, acc ->
      if :atomics.get(stop, 1) == 1 do
        {:halt, acc}
      else
        cents = 5 * (1 + rem(i, 40))
        {call, add} =
          case rem(i, 4) do
            0 -> {%{"fn" => "add_expense", "args" => [cents / 100, "load"]}, cents}
            1 -> {%{"fn" => "total", "args" => []}, 0}
            2 -> {%{"fn" => "by_category", "args" => []}, 0}
            3 -> {%{"fn" => "over_budget", "args" => []}, 0}
          end

        t0 = System.monotonic_time(:microsecond)
        r = World.request(w, %{"op" => "execute", "call" => call, "request_id" => "c#{id}-#{i}"})
        us = System.monotonic_time(:microsecond) - t0
        acc = %{acc | n: acc.n + 1, max_us: max(acc.max_us, us)}

        acc =
          case r do
            %{"ok" => true, "value" => v} ->
              acc = %{acc | added: acc.added + add}
              if call["fn"] == "total", do: (if v + 1.0e-9 < acc.last_total, do: %{acc | regress: acc.regress + 1, last_total: v}, else: %{acc | last_total: v}), else: acc

            other ->
              %{acc | fails: [other | acc.fails]}
          end

        Process.sleep(1)
        {:cont, acc}
      end
    end)
  end)
end

tasks = for id <- 1..4, do: client.(id)
Process.sleep(300)

IO.puts("\n== 3. a BAD migration (truncates dollars, so 0.50 becomes 0) arrives while the clients run")
new_forms = [
  ~S"""
  defp to_cents(x), do: round(x * 100)
  """,
  ~S"""
  def add_expense(state, amount, category, note \\ nil) do
    if not (is_number(amount) and amount > 0), do: raise("amount must be positive")
    if not (is_binary(category) and category != ""), do: raise("category required")
    if to_cents(amount) < 1, do: raise("amount is below one cent")
    expense = %{"amount" => to_cents(amount), "category" => category}
    expense = if is_binary(note), do: Map.put(expense, "note", note), else: expense
    expenses = Map.get(state, "expenses", [])
    {length(expenses) + 1, Map.put(state, "expenses", expenses ++ [expense])}
  end
  """,
  ~S"""
  def total(state) do
    (state |> Map.get("expenses", []) |> Enum.reduce(0, fn e, sum -> sum + e["amount"] end)) / 100
  end
  """,
  ~S"""
  def by_category(state) do
    state
    |> Map.get("expenses", [])
    |> Enum.reduce(%{}, fn e, acc -> Map.update(acc, e["category"], e["amount"], fn s -> s + e["amount"] end) end)
    |> Map.new(fn {c, cents} -> {c, cents / 100} end)
  end
  """
]

good = ~S"""
def migrate(state) do
  expenses = Map.get(state, "expenses", [])
  Map.put(state, "expenses", Enum.map(expenses, fn e -> Map.put(e, "amount", round(e["amount"] * 100)) end))
end
"""

bad = String.replace(good, ~S|round(e["amount"] * 100)|, ~S|trunc(e["amount"])|)

# examples for THIS change are written in the NEW shape (cents in state); earlier examples/traces are migrated by migrate/1
examples = [
  %{"fixture" => %{"expenses" => [%{"amount" => 1250, "category" => "food"}, %{"amount" => 725, "category" => "food"}]}, "calls" => [%{"fn" => "total", "args" => []}], "expect" => %{"value" => 19.75, "state" => %{"expenses" => [%{"amount" => 1250, "category" => "food"}, %{"amount" => 725, "category" => "food"}]}}},
  %{"fixture" => %{}, "calls" => [%{"fn" => "add_expense", "args" => [0.1, "a"]}, %{"fn" => "add_expense", "args" => [0.2, "a"]}, %{"fn" => "total", "args" => []}], "expect" => %{"value" => 0.3, "state" => %{"expenses" => [%{"amount" => 10, "category" => "a"}, %{"amount" => 20, "category" => "a"}]}}}
]

develop = fn migrate_src ->
  g = req.(%{"op" => "observe"})["generation"]
  req.(%{"op" => "develop", "generation" => g, "intent" => "store amounts as integer cents", "scope" => ["add_expense", "total", "by_category"], "forms" => new_forms, "removes" => ["cents"], "migrate" => migrate_src, "examples" => examples, "asked" => %{"message" => 99, "text" => "no more float drift: keep money as integer cents"}})
end

t0 = System.monotonic_time(:microsecond)
r = develop.(bad)
IO.puts("   -> #{r["status"]} in #{ms.(t0)} ms; failed: #{inspect(r["failed"], limit: :infinity, printable_limit: 400)}")
mid = req.(%{"op" => "observe"})
IO.puts("   world unchanged: generation #{mid["generation"]}, module #{vsn.()}, first expense #{Jason.encode!(hd(mid["state"]["expenses"]))}")

IO.puts("\n== 4. the GOOD migration (round(amount * 100)) is applied to the running world")
v_before = vsn.()
t0 = System.monotonic_time(:microsecond)
r = develop.(good)
IO.puts("   -> #{r["status"]} #{r["revision"]} generation #{r["generation"]} in #{ms.(t0)} ms")
IO.puts("   Hatch.App code version #{v_before} -> #{vsn.()}; old version still loaded beside it: #{:erlang.check_old_code(Hatch.App)}")
after_ = req.(%{"op" => "observe"})
IO.puts("   first expense now #{Jason.encode!(hd(after_["state"]["expenses"]))}  (amount in integer cents)")

Process.sleep(300)
:atomics.put(stop, 1, 1)
results = Enum.map(tasks, &Task.await(&1, 10_000))

IO.puts("\n== 5. results")
total_n = results |> Enum.map(& &1.n) |> Enum.sum()
fails = results |> Enum.flat_map(& &1.fails)
added = results |> Enum.map(& &1.added) |> Enum.sum()
IO.puts("   execute requests served: #{total_n}, failed: #{length(fails)}, total() regressions seen by any client: #{results |> Enum.map(& &1.regress) |> Enum.sum()}")
IO.puts("   slowest single execute (the one that waited for the swap): #{Float.round(results |> Enum.map(& &1.max_us) |> Enum.max() |> Kernel./(1000), 1)} ms")
final = req.(%{"op" => "observe"})
cents_in_state = final["state"]["expenses"] |> Enum.map(& &1["amount"]) |> Enum.sum()
IO.puts("   cents in state #{cents_in_state} = seed #{seed_total} + acknowledged adds #{added}: #{cents_in_state == seed_total + added}")
IO.puts("   invariants on the migrated state: #{inspect(Hatch.Invariants.check(final["state"]))}")
IO.puts("   total() = #{req.(%{"op" => "execute", "call" => %{"fn" => "total", "args" => []}, "request_id" => "final"})["value"]}, top_category() = #{req.(%{"op" => "execute", "call" => %{"fn" => "top_category", "args" => []}, "request_id" => "final2"})["value"]}")
IO.puts("   why(total): #{inspect(req.(%{"op" => "why", "fn" => "total"})["asked"]["text"])}")
rb = req.(%{"op" => "rollback"})
IO.puts("   rollback across the migration: #{inspect(rb["ok"])} -- #{rb["error"] && String.slice(rb["error"], 0, 110)}")
