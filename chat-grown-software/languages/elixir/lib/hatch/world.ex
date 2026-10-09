defmodule Hatch.World do
  @moduledoc """
  The live kernel: code (a hot-loaded module `Hatch.App`), state, revisions, examples, traces, exactly-once results.
  All mutations are serialized through this GenServer; each execute is one transaction.
  """
  use GenServer
  alias Hatch.{Cmp, Invariants, Sandbox}

  @app Hatch.App

  def start_link(dir, opts \\ []), do: GenServer.start_link(__MODULE__, dir, opts)
  def request(pid, req), do: GenServer.call(pid, {:req, req}, :infinity)

  # ------------------------------------------------------------------ server

  @impl true
  def init(dir) do
    Code.compiler_options(ignore_module_conflict: true, ignore_already_consolidated: true)
    File.mkdir_p!(dir)
    w = load(dir)

    if w["fns"] != [] do
      {:ok, _} = Sandbox.compile(@app, w["fns"])
    end

    {:ok, %{dir: dir, w: w}}
  end

  @impl true
  def handle_call({:req, req}, _from, %{dir: dir, w: w} = s) do
    {reply, w2} =
      try do
        dispatch(req, w)
      rescue
        e -> {%{"error" => "internal error: " <> Exception.message(e)}, w}
      end

    if w2 != w, do: save(dir, w2)
    {:reply, reply, %{s | w: w2}}
  end

  defp fresh,
    do: %{
      "generation" => 0,
      "revision" => nil,
      "revisions" => [],
      "fns" => [],
      "state" => %{},
      "examples" => [],
      "traces" => [],
      "results" => %{}
    }

  defp load(dir) do
    case File.read(Path.join(dir, "world.json")) do
      {:ok, bin} -> Map.merge(fresh(), Jason.decode!(bin))
      _ -> fresh()
    end
  end

  defp save(dir, w) do
    tmp = Path.join(dir, "world.json.tmp")
    File.write!(tmp, Jason.encode!(w))
    File.rename!(tmp, Path.join(dir, "world.json"))
  end

  # ------------------------------------------------------------------ dispatch

  defp dispatch(%{"op" => "observe"}, w) do
    {%{
       "generation" => w["generation"],
       "revision" => w["revision"],
       "functions" => Map.new(w["fns"], &{&1["name"], &1["source"]}),
       "state" => w["state"]
     }, w}
  end

  defp dispatch(%{"op" => "try"} = req, w), do: {try_forms(req, w), w}
  defp dispatch(%{"op" => "develop"} = req, w), do: develop(req, w)
  defp dispatch(%{"op" => "execute"} = req, w), do: execute(req, w)
  defp dispatch(%{"op" => "rollback"} = req, w), do: rollback(req, w)

  defp dispatch(%{"op" => "why", "fn" => name}, w) when is_binary(name), do: {why(name, w), w}
  defp dispatch(%{"op" => op}, w), do: {%{"error" => "unknown or malformed op #{inspect(op)}"}, w}
  defp dispatch(_, w), do: {%{"error" => "request must be an object with an op"}, w}

  # ------------------------------------------------------------------ helpers

  defp publics(fns), do: for(%{"kind" => "def", "name" => n} <- fns, into: MapSet.new(), do: n)

  defp parse_all(forms) when is_list(forms) do
    Enum.reduce_while(forms, {:ok, []}, fn src, {:ok, acc} ->
      case if(is_binary(src), do: Sandbox.parse(src), else: {:error, "form is not a string"}) do
        {:ok, f} -> {:cont, {:ok, acc ++ [f]}}
        {:error, m} -> {:halt, {:error, m}}
      end
    end)
  end

  defp parse_all(_), do: {:error, "forms must be a list of strings"}

  defp candidate_fns(w, forms, removes) do
    names = Enum.map(forms, & &1["name"])
    kept = Enum.reject(w["fns"], &(&1["name"] in removes or &1["name"] in names))
    kept ++ forms
  end

  defp build(w, req) do
    with {:ok, forms} <- parse_all(req["forms"] || []),
         {:ok, mig} <- parse_migrate(req["migrate"]),
         fns = candidate_fns(w, forms, List.wrap(req["removes"])),
         mod = Sandbox.temp_module(),
         {:ok, _} <- Sandbox.compile(mod, fns, mig) do
      {:ok, %{mod: mod, fns: fns, mig: mig, publics: publics(fns)}}
    end
  end

  defp parse_migrate(nil), do: {:ok, nil}
  defp parse_migrate(src) when is_binary(src), do: Sandbox.parse(src, only: "migrate")
  defp parse_migrate(_), do: {:error, "migrate must be a string"}

  defp fixture_state(f) when is_map(f), do: f
  defp fixture_state(_), do: %{}

  defp calls_fns(calls), do: calls |> Enum.map(& &1["fn"]) |> Enum.uniq()
  defp trunc_s(v, n \\ 160), do: v |> Jason.encode!() |> String.slice(0, n)

  # ------------------------------------------------------------------ try

  defp try_forms(req, w) do
    case build(w, req) do
      {:error, msg} ->
        %{"ok" => false, "error" => msg}

      {:ok, c} ->
        outcomes =
          for q <- List.wrap(req["questions"]),
              do:
                Sandbox.run(c.mod, c.publics, fixture_state(q["fixture"]), List.wrap(q["calls"]))

        Sandbox.discard(c.mod)
        %{"ok" => true, "outcomes" => outcomes}
    end
  end

  # ------------------------------------------------------------------ develop

  defp develop(req, w) do
    if req["generation"] != w["generation"] do
      {%{"status" => "stale", "generation" => w["generation"], "failed" => []}, w}
    else
      case build(w, req) do
        {:error, msg} ->
          {rejected(w, [%{"layer" => "static", "detail" => msg}]), w}

        {:ok, c} ->
          try do
            gate_and_accept(req, w, c)
          after
            Sandbox.discard(c.mod)
          end
      end
    end
  end

  defp rejected(w, failed),
    do: %{"status" => "rejected", "generation" => w["generation"], "failed" => failed}

  defp gate_and_accept(req, w, c) do
    scope = List.wrap(req["scope"])
    identity = fn st -> {:ok, st} end
    mig = if c.mig, do: fn st -> Sandbox.migrate(c.mod, st) end, else: identity

    # layer 5 (beam): the live state, the contract and the traces are carried through migrate/1
    with {:ok, state} <- mig.(w["state"]),
         {:ok, old_examples} <- map_ok(w["examples"], &migrate_example(&1, mig)),
         {:ok, traces} <-
           map_ok(w["traces"], fn t ->
             with {:ok, b} <- mig.(t["before"]), do: {:ok, %{t | "before" => b}}
           end) do
      new_examples =
        for e <- List.wrap(req["examples"]), do: Map.take(e, ["fixture", "calls", "expect"])

      kept = Enum.reject(old_examples, &superseded?(&1, new_examples, scope))
      examples = kept ++ new_examples

      # run examples in order, stop at the first that disagrees (a looping candidate costs one timeout, not N)
      {ran, ratchet} =
        Enum.reduce_while(examples, {[], []}, fn e, {acc, _} ->
          got = Sandbox.run(c.mod, c.publics, fixture_state(e["fixture"]), e["calls"])

          if Cmp.same(e["expect"], got),
            do: {:cont, {[{e, got} | acc], []}},
            else:
              {:halt,
               {acc,
                [
                  %{
                    "layer" => "ratchet",
                    "detail" =>
                      "#{trunc_s(e["calls"], 80)} on #{trunc_s(e["fixture"], 80)}: expected #{trunc_s(e["expect"])}, got #{trunc_s(got)}"
                  }
                ]}}
        end)

      inv_states = [
        {"live state", state}
        | for({e, %{"state" => s}} <- ran, do: {"example #{trunc_s(e["calls"], 60)}", s})
      ]

      {trace_fail, trace_states} = trace_results(c, traces, scope)

      inv =
        Enum.find_value(inv_states ++ trace_states, [], fn {what, s} ->
          case Invariants.check(s) do
            :ok -> nil
            {:error, m} -> [%{"layer" => "invariants", "detail" => "#{what}: #{m}"}]
          end
        end)

      failed = ratchet ++ inv ++ trace_fail

      if failed == [] do
        accept(req, w, c, state, examples, traces)
      else
        {rejected(w, failed), w}
      end
    else
      {:error, msg} -> {rejected(w, [%{"layer" => "beam", "detail" => msg}]), w}
    end
  end

  defp trace_results(c, traces, scope) do
    Enum.reduce(traces, {[], []}, fn
      _t, {[_ | _], _} = acc ->
        acc

      t, {fails, states} ->
        out = Sandbox.run(c.mod, c.publics, t["before"], [t["call"]])
        fnname = t["call"]["fn"]

        cond do
          fails != [] ->
            {fails, states}

          out["timeout"] ->
            {[
               %{
                 "layer" => "traces",
                 "detail" => "replay of #{trunc_s(t["call"], 80)} now times out"
               }
             ], states}

          out["throws"] ->
            {[
               %{
                 "layer" => "traces",
                 "detail" => "replay of #{trunc_s(t["call"], 80)} now throws: #{out["error"]}"
               }
             ], states}

          fnname not in scope and not Cmp.same(out["value"], t["value"]) ->
            {[
               %{
                 "layer" => "traces",
                 "detail" =>
                   "replay of #{trunc_s(t["call"], 80)} changed #{trunc_s(t["value"], 60)} -> #{trunc_s(out["value"], 60)} outside scope"
               }
             ], states}

          true ->
            {fails, [{"trace replay #{trunc_s(t["call"], 60)}", out["state"]} | states]}
        end
    end)
  end

  defp map_ok(list, f) do
    Enum.reduce_while(list, {:ok, []}, fn x, {:ok, acc} ->
      case f.(x) do
        {:ok, y} -> {:cont, {:ok, acc ++ [y]}}
        {:error, m} -> {:halt, {:error, m}}
      end
    end)
  end

  defp migrate_example(e, mig) do
    with {:ok, fx} <- mig.(fixture_state(e["fixture"])),
         {:ok, ex} <- migrate_expect(e["expect"], mig) do
      {:ok, %{e | "fixture" => fx, "expect" => ex}}
    end
  end

  defp migrate_expect(%{"state" => s} = ex, mig) when is_map(s),
    do: with({:ok, ns} <- mig.(s), do: {:ok, %{ex | "state" => ns}})

  defp migrate_expect(ex, _), do: {:ok, ex}

  # An earlier example is superseded when every function it calls is in scope and a new example
  # asks the same question with a different answer.
  defp superseded?(old, news, scope) do
    Enum.all?(calls_fns(old["calls"]), &(&1 in scope)) and
      Enum.any?(news, fn n ->
        n["fixture"] == old["fixture"] and n["calls"] == old["calls"] and
          not Cmp.same(n["expect"], old["expect"])
      end)
  end

  defp accept(req, w, c, state, examples, traces) do
    case Sandbox.compile(@app, c.fns) do
      {:error, msg} ->
        {rejected(w, [%{"layer" => "static", "detail" => "install failed: " <> msg}]), w}

      {:ok, _} ->
        gen = w["generation"] + 1
        id = "rev-" <> String.pad_leading(Integer.to_string(length(w["revisions"]) + 1), 4, "0")

        rev = %{
          "id" => id,
          "generation" => gen,
          "code_id" => hash(Enum.map(Enum.sort_by(c.fns, & &1["name"]), & &1["source"])),
          "data_id" => hash(state),
          "intent" => req["intent"],
          "scope" => List.wrap(req["scope"]),
          "asked" => req["asked"],
          "fns" => c.fns,
          "migrated" => c.mig != nil
        }

        w2 = %{
          w
          | "generation" => gen,
            "revision" => id,
            "revisions" => w["revisions"] ++ [rev],
            "fns" => c.fns,
            "state" => state,
            "examples" => examples,
            "traces" => traces
        }

        {%{"status" => "accepted", "revision" => id, "generation" => gen, "failed" => []}, w2}
    end
  end

  defp hash(term),
    do:
      :crypto.hash(:sha256, Jason.encode!(term))
      |> Base.encode16(case: :lower)
      |> binary_part(0, 12)

  # ------------------------------------------------------------------ execute

  defp execute(%{"call" => call} = req, w) do
    rid = req["request_id"]

    case rid && Map.get(w["results"], rid) do
      cached when is_map(cached) ->
        {Map.put(cached, "replayed", true), w}

      _ ->
        out = Sandbox.run(@app, publics(w["fns"]), w["state"], [call])

        {resp, w2} =
          cond do
            out["timeout"] ->
              {%{"ok" => false, "error" => "timed out after 1000 ms"}, w}

            out["throws"] ->
              {%{"ok" => false, "error" => out["error"]}, w}

            true ->
              case Invariants.check(out["state"]) do
                :ok ->
                  trace = %{"before" => w["state"], "call" => call, "value" => out["value"]}

                  {%{"ok" => true, "value" => out["value"], "replayed" => false},
                   %{w | "state" => out["state"], "traces" => Enum.take(w["traces"] ++ [trace], -max_traces())}}

                {:error, m} ->
                  {%{"ok" => false, "error" => "invariant violated, nothing committed: " <> m}, w}
              end
          end

        w2 = if rid, do: %{w2 | "results" => Map.put(w2["results"], rid, resp)}, else: w2
        {resp, w2}
    end
  end

  defp execute(_, w), do: {%{"ok" => false, "error" => "execute needs a call"}, w}

  # only the most recent traces are kept (HATCH_MAX_TRACES, default 1000) so persistence stays bounded
  defp max_traces, do: String.to_integer(System.get_env("HATCH_MAX_TRACES") || "1000")

  # ------------------------------------------------------------------ rollback / why

  defp rollback(req, w) do
    revs = w["revisions"]
    cur = Enum.find_index(revs, &(&1["id"] == w["revision"]))

    target =
      case req["revision"] do
        nil -> if cur && cur > 0, do: Enum.at(revs, cur - 1)
        id -> Enum.find(revs, &(&1["id"] == id))
      end

    if target == nil do
      {%{"ok" => false, "error" => "no such revision to roll back to"}, w}
    else
      mod = Sandbox.temp_module()

      try do
        case Sandbox.compile(mod, target["fns"]) do
          {:error, m} ->
            {%{"ok" => false, "error" => "old code does not load: " <> m}, w}

          {:ok, _} ->
            pubs = publics(target["fns"])

            problem =
              with :ok <- Invariants.check(w["state"]) |> tag("invariants on today's data") do
                Enum.find_value(w["traces"], fn t ->
                  out = Sandbox.run(mod, pubs, t["before"], [t["call"]])

                  cond do
                    out["timeout"] || out["throws"] ->
                      "trace #{trunc_s(t["call"], 80)} fails under #{target["id"]}: #{out["error"] || "timeout"}"

                    not Cmp.same(out["value"], t["value"]) ->
                      "trace #{trunc_s(t["call"], 80)} gives a different value under #{target["id"]}"

                    true ->
                      nil
                  end
                end)
              else
                {:error, m} -> m
              end

            if problem do
              {%{"ok" => false, "error" => "rollback refused: " <> problem}, w}
            else
              {:ok, _} = Sandbox.compile(@app, target["fns"])
              gen = w["generation"] + 1
              w2 = %{w | "generation" => gen, "revision" => target["id"], "fns" => target["fns"]}
              {%{"ok" => true, "revision" => target["id"], "generation" => gen}, w2}
            end
        end
      after
        Sandbox.discard(mod)
      end
    end
  end

  defp tag(:ok, _), do: :ok
  defp tag({:error, m}, what), do: {:error, what <> ": " <> m}

  defp why(name, w) do
    revs = w["revisions"]
    cur = Enum.find_index(revs, &(&1["id"] == w["revision"]))

    src = fn rev ->
      rev && Enum.find_value(rev["fns"], fn f -> if f["name"] == name, do: f["source"] end)
    end

    if cur == nil do
      nil
    else
      Enum.find_value(cur..0//-1, fn i ->
        if src.(Enum.at(revs, i)) != src.(if(i > 0, do: Enum.at(revs, i - 1))) do
          r = Enum.at(revs, i)
          %{"revision" => r["id"], "intent" => r["intent"], "asked" => r["asked"]}
        end
      end)
    end
  end
end
