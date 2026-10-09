defmodule Hatch.Sandbox do
  @moduledoc """
  Static allowlist check, compilation and isolated execution of model-written forms.

  Every evaluation (compile, run, migrate) happens in a throwaway process with a heap limit and a
  wall-clock timeout; on timeout the process is killed with `Process.exit(pid, :kill)`.
  """

  @allowed_mods [Kernel, Enum, Map, List, String, Float, Integer, Keyword, MapSet, Tuple, Range, Access, :math]
  @forbidden_calls ~w(apply spawn spawn_link spawn_monitor spawn_opt send exit throw binding import require alias use
    defmodule defmacro defmacrop defdelegate defstruct defexception defprotocol defimpl quote unquote unquote_splicing
    receive super self node make_ref var! def defp defguard defguardp @ __ENV__ __CALLER__ __MODULE__ __DIR__
    __STACKTRACE__)a
  @forbidden_fun %{String => [:to_atom, :to_existing_atom], List => [:to_atom, :to_existing_atom]}
  @heap_words 30_000_000

  @kernel_names MapSet.new(
                  for({n, _} <- Kernel.__info__(:functions) ++ Kernel.__info__(:macros), do: Atom.to_string(n)) ++
                    ~w(module_info migrate)
                )

  # ---------------------------------------------------------------- static check

  @doc "Parse one form source into %{name, kind, source}. `allow` = name that is exempt from the reserved-name rule."
  def parse(source, opts \\ []) when is_binary(source) do
    only = opts[:only]

    case Code.string_to_quoted(source) do
      {:error, {meta, msg, tok}} ->
        {:error, "syntax error line #{meta_line(meta)}: #{msg_s(msg)}#{tok}"}

      {:ok, ast} ->
        forms =
          case ast do
            {:__block__, _, list} -> list
            other -> [other]
          end

        with {:ok, defs} <- all_defs(forms),
             {:ok, name, kind} <- one_name(defs),
             :ok <- check_name(name, only),
             :ok <- walk_all(defs) do
          {:ok, %{"name" => name, "kind" => Atom.to_string(kind), "source" => source}}
        end
    end
  end

  defp meta_line(m) when is_list(m), do: m[:line]
  defp meta_line(m), do: m
  defp msg_s({a, b}), do: "#{a}#{b}"
  defp msg_s(m), do: to_string(m)

  defp all_defs([]), do: {:error, "empty form: expected exactly one `def name(state, ...) do ... end`"}

  defp all_defs(forms) do
    Enum.reduce_while(forms, {:ok, []}, fn
      {kind, _, [head | _]} = d, {:ok, acc} when kind in [:def, :defp] ->
        case head_info(head) do
          {name, arity} when arity >= 1 -> {:cont, {:ok, [{kind, name, d} | acc]}}
          {name, _} -> {:halt, {:error, "#{name} must take the state as its first argument"}}
          :error -> {:halt, {:error, "unsupported function head"}}
        end

      other, _ ->
        {:halt, {:error, "not a function definition (only `def`/`defp` allowed at top level, no side effects): #{short(other)}"}}
    end)
    |> case do
      {:ok, acc} -> {:ok, Enum.reverse(acc)}
      err -> err
    end
  end

  defp head_info({:when, _, [call | _]}), do: head_info(call)
  defp head_info({name, _, args}) when is_atom(name) and is_list(args), do: {name, length(args)}
  defp head_info({name, _, ctx}) when is_atom(name) and is_atom(ctx), do: {name, 0}
  defp head_info(_), do: :error

  defp one_name(defs) do
    names = defs |> Enum.map(fn {_, n, _} -> n end) |> Enum.uniq()
    kinds = defs |> Enum.map(fn {k, _, _} -> k end) |> Enum.uniq()

    case {names, kinds} do
      {[n], [k]} -> {:ok, Atom.to_string(n), k}
      _ -> {:error, "a form must define exactly one function (clauses of one name, all def or all defp)"}
    end
  end

  defp check_name(name, only) do
    cond do
      only != nil and name != only -> {:error, "expected a definition of #{only}, got #{name}"}
      only == nil and name == "migrate" -> {:error, "migrate is reserved: pass it in the `migrate` field"}
      not Regex.match?(~r/^[a-z][a-z0-9_]*$/, name) -> {:error, "function name #{name} must be snake_case"}
      only == nil and MapSet.member?(@kernel_names, name) -> {:error, "#{name} would redefine/shadow a Kernel builtin"}
      true -> :ok
    end
  end

  defp walk_all(defs) do
    errs = Enum.flat_map(defs, fn {_, _, {_, _, args}} -> walk(args) end)
    if errs == [], do: :ok, else: {:error, errs |> Enum.uniq() |> Enum.join("; ")}
  end

  defp walk(ast) do
    {_, errs} = Macro.prewalk(ast, [], fn node, acc -> {node, check(node) ++ acc} end)
    Enum.reverse(errs)
  end

  # anonymous function call: f.(x)
  defp check({{:., _, [_]}, _, _}), do: []

  defp check({{:., _, [mod, fun]}, _, _}) when is_atom(fun) do
    case resolve(mod) do
      {:ok, m} ->
        cond do
          m not in @allowed_mods -> ["call to #{inspect(m)}.#{fun} is not allowed (modules: Kernel Enum Map List String Float Integer Keyword MapSet Tuple Range)"]
          fun in Map.get(@forbidden_fun, m, []) -> ["#{inspect(m)}.#{fun} is not allowed"]
          m == Kernel and fun in @forbidden_calls -> ["Kernel.#{fun} is not allowed"]
          true -> []
        end

      :error ->
        ["dynamic/field call `.#{fun}` is not allowed; use Map.get(m, \"k\") or m[\"k\"]"]
    end
  end

  defp check({name, _, args}) when is_atom(name) and is_list(args) and name in @forbidden_calls,
    do: ["`#{name}` is not allowed"]

  defp check(_), do: []

  defp resolve({:__aliases__, _, parts}) do
    if Enum.all?(parts, &is_atom/1), do: {:ok, Module.concat(parts)}, else: :error
  end

  defp resolve(a) when is_atom(a), do: {:ok, a}
  defp resolve(_), do: :error

  defp short(ast), do: ast |> Macro.to_string() |> String.slice(0, 80)

  # ---------------------------------------------------------------- compile / install

  def temp_module, do: Module.concat(Hatch.Cand, "C#{:erlang.unique_integer([:positive])}")

  @doc "Compile fns (+ optional migrate form) into module `mod` in an isolated process. {:ok, mod} | {:error, msg}"
  def compile(mod, fns, migrate \\ nil) do
    parts = fns |> Enum.sort_by(& &1["name"]) |> Enum.map(& &1["source"])
    parts = if migrate, do: parts ++ [migrate["source"]], else: parts
    src = "defmodule #{inspect(mod)} do\n" <> Enum.join(parts, "\n\n") <> "\nend\n"

    case isolated(fn -> do_compile(src) end, 10_000) do
      {:ok, :ok} -> {:ok, mod}
      {:ok, {:error, msg}} -> {:error, msg}
      :timeout -> {:error, "compilation timed out"}
      {:error, r} -> {:error, "compiler process died: #{inspect(r)}"}
    end
  end

  defp do_compile(src) do
    Code.compile_string(src, "form")
    :ok
  rescue
    e -> {:error, "compile error: " <> (Exception.message(e) |> String.slice(0, 400))}
  catch
    k, v -> {:error, "compile #{k}: #{inspect(v)}"}
  end

  def discard(mod) do
    :code.purge(mod)
    :code.delete(mod)
    :code.purge(mod)
    :ok
  end

  # ---------------------------------------------------------------- isolated execution

  @doc "Run `fun` in a fresh process with a heap limit; kill it after `ms`. {:ok, result} | :timeout | {:error, reason}"
  def isolated(fun, ms) do
    parent = self()
    ref = make_ref()

    {pid, mref} =
      :erlang.spawn_opt(
        fn ->
          Process.flag(:max_heap_size, %{size: @heap_words, kill: true, error_logger: false})
          send(parent, {ref, fun.()})
        end,
        [:monitor]
      )

    receive do
      {^ref, r} ->
        Process.demonitor(mref, [:flush])
        {:ok, r}

      {:DOWN, ^mref, _, _, reason} ->
        {:error, reason}
    after
      ms ->
        Process.exit(pid, :kill)
        Process.demonitor(mref, [:flush])

        receive do
          {^ref, _} -> :ok
        after
          0 -> :ok
        end

        :timeout
    end
  end

  @doc "Run calls sequentially on `state` as transactions. Returns a protocol outcome map."
  def run(mod, publics, state, calls, ms \\ 1000) do
    state = if is_map(state), do: state, else: %{}

    case isolated(fn -> do_run(mod, publics, state, calls, nil) end, ms) do
      {:ok, outcome} -> outcome
      :timeout -> %{"timeout" => true}
      {:error, r} -> %{"throws" => true, "error" => "sandbox process died: #{inspect(r)}", "state" => state}
    end
  end

  defp do_run(_mod, _publics, state, [], value), do: %{"value" => value, "state" => state}

  defp do_run(mod, publics, state, [call | rest], _value) do
    case call_one(mod, publics, call, state) do
      {:ok, v, ns} -> do_run(mod, publics, ns, rest, v)
      {:error, msg} -> %{"throws" => true, "error" => msg, "state" => state}
    end
  end

  @doc "One call in-process (caller provides isolation). {:ok, value, new_state} | {:error, msg}"
  def call_one(mod, publics, call, state) do
    name = if is_map(call), do: call["fn"]
    args = if is_map(call), do: call["args"] || [], else: []

    cond do
      not is_binary(name) or not is_list(args) -> {:error, "malformed call"}
      not MapSet.member?(publics, name) -> {:error, "no function #{name}"}
      true ->
        fun = String.to_existing_atom(name)

        if function_exported?(mod, fun, length(args) + 1) do
          invoke(mod, fun, [state | args], state)
        else
          {:error, "#{name} does not take #{length(args)} argument(s)"}
        end
    end
  end

  defp invoke(mod, fun, args, state) do
    {v, ns} =
      case apply(mod, fun, args) do
        {v, ns} -> {v, ns}
        v -> {v, state}
      end

    ns = norm(ns)
    if is_map(ns), do: {:ok, norm(v), ns}, else: {:error, "the new state must be a map, got #{inspect(ns) |> String.slice(0, 80)}"}
  rescue
    e -> {:error, Exception.message(e) |> String.slice(0, 400)}
  catch
    k, v -> {:error, "#{k}: #{inspect(v) |> String.slice(0, 200)}"}
  end

  @doc "Apply the candidate module's migrate/1 to a state (isolated)."
  def migrate(mod, state) do
    case isolated(fn -> do_migrate(mod, state) end, 5000) do
      {:ok, r} -> r
      :timeout -> {:error, "migration timed out"}
      {:error, r} -> {:error, "migration process died: #{inspect(r)}"}
    end
  end

  defp do_migrate(mod, state) do
    ns = norm(apply(mod, :migrate, [state]))
    if is_map(ns), do: {:ok, ns}, else: {:error, "migrate must return a map"}
  rescue
    e -> {:error, "migration raised: " <> String.slice(Exception.message(e), 0, 300)}
  catch
    k, v -> {:error, "migration #{k}: #{inspect(v)}"}
  end

  # JSON-ify: atom keys/values -> strings, tuples -> lists.
  def norm(nil), do: nil
  def norm(v) when is_boolean(v) or is_number(v) or is_binary(v), do: v
  def norm(v) when is_atom(v), do: Atom.to_string(v)
  def norm(v) when is_list(v), do: Enum.map(v, &norm/1)
  def norm(v) when is_tuple(v), do: v |> Tuple.to_list() |> norm()
  def norm(%MapSet{} = v), do: v |> MapSet.to_list() |> norm()
  def norm(%{__struct__: _} = v), do: raise(ArgumentError, "structs are not JSON values: #{inspect(v)}")
  def norm(v) when is_map(v), do: Map.new(v, fn {k, x} -> {norm_key(k), norm(x)} end)
  def norm(v), do: raise(ArgumentError, "not a JSON value: #{inspect(v)}")

  defp norm_key(k) when is_binary(k), do: k
  defp norm_key(k) when is_atom(k), do: Atom.to_string(k)
  defp norm_key(k), do: to_string(k)
end
