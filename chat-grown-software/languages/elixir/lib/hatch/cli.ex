defmodule Hatch.CLI do
  @moduledoc "JSON-lines kernel on stdin/stdout. Everything else goes to stderr."

  def main(args) do
    dir = List.first(args) || "data"
    {:ok, pid} = Hatch.World.start_link(dir)
    loop(pid)
  end

  defp loop(pid) do
    case IO.binread(:stdio, :line) do
      line when is_binary(line) ->
        line = String.trim(line)
        if line != "", do: IO.binwrite(:stdio, [respond(pid, line), "\n"])
        loop(pid)

      _ ->
        :ok
    end
  end

  defp respond(pid, line) do
    case Jason.decode(line) do
      {:ok, req} when is_map(req) -> Jason.encode!(Hatch.World.request(pid, req))
      {:ok, _} -> Jason.encode!(%{"error" => "request must be a JSON object"})
      {:error, _} -> Jason.encode!(%{"error" => "malformed JSON"})
    end
  rescue
    e -> Jason.encode!(%{"error" => "internal error: " <> Exception.message(e)})
  end
end
