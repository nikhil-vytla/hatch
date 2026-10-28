"""Summary figure for the README: label quality by labeler confidence, and push outcomes vs random controls.

    python figure.py --out-dir <atlas out dir> --png summary.png
"""
import argparse, os
import duckdb
import matplotlib.pyplot as plt

MODELS = [("openai-community__gpt2", "GPT-2"), ("HuggingFaceTB__SmolLM2-135M-Instruct", "SmolLM2-135M"),
          ("Qwen__Qwen3-0.6B", "Qwen3-0.6B")]
COLORS = ["#2a78d6", "#eb6834", "#1baf7a"]  # validated categorical slots 1-3
INK, INK2, GRID = "#1f1c2c", "#6b6680", "#e6e3ec"


def main(out, png):
    con = duckdb.connect()
    fig, axes = plt.subplots(1, 3, figsize=(13, 4.2), gridspec_kw={"width_ratios": [1.3, 1, 1]})
    plt.rcParams.update({"font.size": 10})
    ax = axes[0]
    for (slug, name), c in zip(MODELS, COLORS):
        rows = con.sql(f"""select confidence, avg(detect), avg(detect_null), count(*) from '{out}/{slug}/labels.parquet'
                           where confidence between 2 and 5 group by 1 order by 1""").fetchall()
        x = [r[0] for r in rows]; y = [r[1] for r in rows]
        ax.plot(x, y, color=c, lw=2, marker="o", ms=6, mec="white", mew=1.5)
        ax.annotate(name, (x[-1], y[-1]), xytext=(8, 0), textcoords="offset points", va="center", color=INK, fontsize=9)
        ax.plot(x, [r[2] for r in rows], color=c, lw=1, ls=":", alpha=.7)
    ax.axhline(.5, color=INK2, lw=1, ls="--")
    ax.text(2, .515, "chance / shuffled-label null (dotted)", color=INK2, fontsize=8.5)
    ax.set_xticks([2, 3, 4, 5]); ax.set_xlim(1.8, 5.9); ax.set_ylim(.4, 1)
    ax.set_xlabel("labeler confidence (1-5)", color=INK2); ax.set_ylabel("held-out detection accuracy", color=INK2)
    ax.set_title("Labels: held-out check rises with confidence", loc="left", color=INK, fontsize=11)
    for ax, kind, title in [(axes[1], "persona", "Pushes that make a persona"),
                            (axes[2], "incoherent", "Pushes that break the text")]:
        for i, ((slug, name), c) in enumerate(zip(MODELS, COLORS)):
            r = dict(con.sql(f"""select kind, avg((reply_kind = '{kind}')::int) from '{out}/{slug}/steer.parquet'
                                 where layer >= 0 group by 1""").fetchall())
            ax.plot([r["random"], r["top"]], [i, i], color=GRID, lw=3, zorder=1)
            ax.scatter([r["random"]], [i], s=70, facecolor="white", edgecolor=c, lw=2, zorder=2)
            ax.scatter([r["top"]], [i], s=70, color=c, edgecolor="white", lw=1.5, zorder=3)
        ax.set_yticks(range(len(MODELS))); ax.set_yticklabels([m[1] for m in MODELS])
        ax.set_xlim(0, .45); ax.set_ylim(-.6, len(MODELS) - .4)
        ax.xaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v:.0%}"))
        ax.set_title(title, loc="left", color=INK, fontsize=11)
    axes[1].text(.0, -.55, "filled = most peaked neurons (12/layer, Qwen 8)   hollow = 4 random/layer", fontsize=8, color=INK2)
    for ax in axes:
        ax.grid(axis="x" if ax is not axes[0] else "y", color=GRID, lw=.8); ax.set_axisbelow(True)
        for s in ["top", "right"]:
            ax.spines[s].set_visible(False)
        for s in ["left", "bottom"]:
            ax.spines[s].set_color(GRID)
        ax.tick_params(colors=INK2)
    fig.tight_layout()
    fig.savefig(png, dpi=130, facecolor="white")
    print(png, os.path.getsize(png))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--png", default="summary.png")
    a = ap.parse_args()
    main(a.out_dir, a.png)
