defmodule Hatch.MixProject do
  use Mix.Project

  def project do
    [
      app: :hatch,
      version: "0.1.0",
      elixir: "~> 1.14",
      deps: [{:jason, "~> 1.4"}],
      escript: [main_module: Hatch.CLI, path: "_build/hatch"]
    ]
  end

  def application, do: [extra_applications: [:crypto]]
end
