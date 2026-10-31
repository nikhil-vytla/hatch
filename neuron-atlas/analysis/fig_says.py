"""Figure: how often a push's reply contains the neuron's own lens tokens, by layer (says vs does)."""
import json, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

INK, MUTED, GRID = "#2b2a27", "#6b6a64", "#e6e4de"
COL = {"logit": "#2a78d6", "j": "#eb6834", "r": "#1baf7a"}
NAME = {"logit": "logit lens", "j": "J-lens", "r": "R-lens"}


def panel(ax, path, title):
    d = json.load(open(path))["by_layer"]
    Ls = sorted(d, key=int)
    x = [int(L) for L in Ls]
    for lens in ("logit", "j", "r"):
        if lens not in d[Ls[0]]:
            continue
        y = [100 * d[L][lens]["hit"] for L in Ls]
        ax.plot(x, y, color=COL[lens], lw=2, solid_capstyle="round", label=NAME[lens])
    null = [100 * d[L]["j"]["null"] for L in Ls]
    ax.plot(x, null, color=MUTED, lw=1.5, ls=(0, (3, 3)), label="another neuron's tokens (chance)")
    ax.legend(loc="upper left", frameon=False, fontsize=9, labelcolor=INK)
    ax.set_title(title, loc="left", color=INK, fontsize=11)
    ax.set_xlabel("layer of the pushed neuron", color=MUTED, fontsize=9)
    ax.grid(axis="y", color=GRID, lw=0.8)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color(GRID)
    ax.tick_params(colors=MUTED, labelsize=8)
    ax.set_ylim(0, None)


def main(a, b, out):
    fig, axes = plt.subplots(1, 2, figsize=(11, 3.8), dpi=150)
    panel(axes[0], a, "Qwen3.5-4B · published J/R-lenses · 1.09M pushes at ±0.8")
    panel(axes[1], b, "SmolLM2-135M · J-lens fitted here · 90k pushes at ±0.5")
    axes[0].set_ylabel("% of pushed replies that add\none of the neuron's top-10 tokens", color=MUTED, fontsize=9)
    fig.suptitle("A neuron's lens readout predicts what pushing it makes the model say", x=0.01, ha="left", color=INK, fontsize=12)
    fig.tight_layout()
    fig.savefig(out, facecolor="white")


if __name__ == "__main__":
    main(*sys.argv[1:4])
