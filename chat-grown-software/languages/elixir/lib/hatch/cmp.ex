defmodule Hatch.Cmp do
  @moduledoc "Deep JSON equality: numbers within 1e-9, `error` keys ignored (map key order is irrelevant by nature)."
  def same(a, b) when is_number(a) and is_number(b), do: abs(a - b) <= 1.0e-9

  def same(a, b) when is_map(a) and is_map(b) do
    a = Map.delete(a, "error")
    b = Map.delete(b, "error")
    map_size(a) == map_size(b) and Enum.all?(a, fn {k, v} -> Map.has_key?(b, k) and same(v, Map.fetch!(b, k)) end)
  end

  def same(a, b) when is_list(a) and is_list(b), do: length(a) == length(b) and Enum.zip(a, b) |> Enum.all?(fn {x, y} -> same(x, y) end)
  def same(a, b), do: a === b
end

defmodule Hatch.Invariants do
  @moduledoc "The three scenario invariants, natively."
  def check(state) when is_map(state) do
    if System.get_env("SCENARIO") == "gateway", do: gateway(state), else: expenses_check(state)
  end

  def check(_), do: {:error, "known-keys: state is not an object"}

  # ---- gateway scenario: calls-shape, prices-shape, quotas-shape, within-quota, known-keys
  defp gateway(state) do
    calls = Map.get(state, "calls", [])
    prices = Map.get(state, "prices", %{})
    quotas = Map.get(state, "quotas", %{})

    cond do
      Map.keys(state) -- ["calls", "prices", "quotas"] != [] -> {:error, "known-keys: unexpected top-level keys"}
      not is_list(calls) or not Enum.all?(calls, &call_ok?/1) -> {:error, "calls-shape: every call must be exactly {key, model, tokens} with positive integer tokens"}
      not is_map(prices) or not Enum.all?(prices, fn {_, p} -> is_number(p) and p >= 0 end) -> {:error, "prices-shape: prices must be numbers >= 0"}
      not is_map(quotas) or not Enum.all?(quotas, fn {_, q} -> is_integer(q) and q >= 0 end) -> {:error, "quotas-shape: quotas must be whole numbers >= 0"}
      true ->
        used = Enum.reduce(calls, %{}, fn c, acc -> Map.update(acc, c["key"], c["tokens"], &(&1 + c["tokens"])) end)

        case Enum.find(quotas, fn {k, q} -> Map.get(used, k, 0) > q end) do
          nil -> :ok
          {k, q} -> {:error, "within-quota: #{k} used #{used[k]} > quota #{q}"}
        end
    end
  end

  defp call_ok?(%{"key" => k, "model" => m, "tokens" => t} = c),
    do: map_size(c) == 3 and is_binary(k) and k != "" and is_binary(m) and m != "" and is_integer(t) and t > 0

  defp call_ok?(_), do: false

  defp expenses_check(state) do
    with :ok <- keys(state), :ok <- expenses(Map.get(state, "expenses", [])), do: budgets(Map.get(state, "budgets", %{}))
  end

  defp keys(state) do
    case Map.keys(state) -- ["expenses", "budgets"] do
      [] -> :ok
      extra -> {:error, "known-keys: unexpected top-level keys #{inspect(extra)}"}
    end
  end

  defp expenses(list) when is_list(list) do
    Enum.find_value(list, :ok, fn e ->
      case expense(e) do
        :ok -> nil
        err -> err
      end
    end)
  end

  defp expenses(_), do: {:error, "expenses-shape: expenses is not a list"}

  defp expense(%{"amount" => a, "category" => c} = e) do
    extra = Map.keys(e) -- ["amount", "category", "note"]

    cond do
      extra != [] -> {:error, "expenses-shape: unexpected keys #{inspect(extra)}"}
      not (is_number(a) and a > 0) -> {:error, "expenses-shape: amount must be a number > 0, got #{inspect(a)}"}
      not (is_binary(c) and c != "") -> {:error, "expenses-shape: category must be a non-empty string"}
      Map.has_key?(e, "note") and not is_binary(e["note"]) -> {:error, "expenses-shape: note must be a string"}
      true -> :ok
    end
  end

  defp expense(e), do: {:error, "expenses-shape: bad expense #{inspect(e)}"}

  defp budgets(b) when is_map(b) do
    case Enum.find(b, fn {_, v} -> not (is_number(v) and v >= 0) end) do
      nil -> :ok
      {k, v} -> {:error, "budgets-shape: budget #{k} is #{inspect(v)}"}
    end
  end

  defp budgets(_), do: {:error, "budgets-shape: budgets is not an object"}
end
