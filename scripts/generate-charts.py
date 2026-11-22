#!/usr/bin/env python3
"""Generate clean, dependency-free SVG charts from the T8 benchmark and CloudWatch JSON files."""
import datetime
import json
import math
import pathlib
import sys
import xml.etree.ElementTree as ET


def nice_ceil(value: float, step: float) -> float:
    return max(step, math.ceil(value * 1.12 / step) * step)

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "dados"
OUT = ROOT / "docs" / "imagens"


def esc(text: str) -> str:
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def grouped_bar_svg(
    title: str,
    subtitle: str,
    groups: list[str],
    series: list[tuple[str, str, list[float]]],
    y_unit: str,
    y_max: float,
    ref_line: tuple[float, str, str] | None = None,
    val_fmt: str = ".0f",
) -> str:
    w, h = 780, 420
    ml, mr, mt, mb = 74, 30, 82, 76
    pw, ph = w - ml - mr, h - mt - mb

    def y_pos(v: float) -> float:
        return mt + ph - (min(v, y_max) / y_max) * ph

    def fmt_val(v: float) -> str:
        if val_fmt == ".0f":
            return str(int(v + 0.5))
        return format(v, val_fmt).replace(".", ",")

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="{esc(title)}">',
        "<style>",
        "text { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; fill: #1f2937; }",
        ".title { font-size: 16px; font-weight: 700; }",
        ".sub { font-size: 12px; fill: #4b5563; }",
        ".axis { font-size: 11px; fill: #4b5563; }",
        ".val { font-size: 10px; font-weight: 600; fill: #111827; }",
        ".ref { font-size: 10px; font-weight: 600; }",
        ".legend { font-size: 11px; }",
        "</style>",
        f'<rect width="{w}" height="{h}" rx="8" fill="#ffffff" stroke="#e5e7eb"/>',
        f'<text x="{ml}" y="28" class="title">{esc(title)}</text>',
        f'<text x="{ml}" y="46" class="sub">{esc(subtitle)}</text>',
    ]

    # Grid lines
    ticks = 5
    for i in range(ticks + 1):
        val = (y_max / ticks) * i
        yp = y_pos(val)
        parts.append(f'<line x1="{ml}" y1="{yp:.1f}" x2="{w - mr}" y2="{yp:.1f}" stroke="#e5e7eb"/>')
        parts.append(
            f'<text x="{ml - 10}" y="{yp + 4:.1f}" text-anchor="end" class="axis">{val:.0f} {esc(y_unit)}</text>'
        )

    # Optional reference line behind bars; label placed on the left over the low-load group
    if ref_line:
        rv, rlabel, rcolor = ref_line
        ry = y_pos(rv)
        parts.append(
            f'<line x1="{ml}" y1="{ry:.1f}" x2="{w - mr}" y2="{ry:.1f}" stroke="{rcolor}" stroke-width="1.8" stroke-dasharray="6,4"/>'
        )
        parts.append(
            f'<text x="{ml + 6}" y="{ry - 6:.1f}" text-anchor="start" class="ref" fill="{rcolor}">{esc(rlabel)}</text>'
        )

    # Axes
    parts.append(f'<line x1="{ml}" y1="{mt}" x2="{ml}" y2="{mt + ph}" stroke="#9ca3af"/>')
    parts.append(f'<line x1="{ml}" y1="{mt + ph}" x2="{w - mr}" y2="{mt + ph}" stroke="#9ca3af"/>')

    # Grouped bars
    n_groups = len(groups)
    n_series = len(series)
    group_w = pw / n_groups
    bar_area = group_w * 0.72
    gap = 4
    bar_w = (bar_area - gap * (n_series - 1)) / n_series

    for gi, glabel in enumerate(groups):
        gx = ml + gi * group_w + (group_w - bar_area) / 2
        for si, (_sname, color, values) in enumerate(series):
            val = values[gi]
            bx = gx + si * (bar_w + gap)
            by = y_pos(val)
            bh = max(1.0, (mt + ph) - by)
            parts.append(
                f'<rect x="{bx:.1f}" y="{by:.1f}" width="{bar_w:.1f}" height="{bh:.1f}" rx="3" fill="{color}"/>'
            )
            parts.append(
                f'<text x="{bx + bar_w / 2:.1f}" y="{by - 5:.1f}" text-anchor="middle" class="val">{esc(fmt_val(val))}</text>'
            )
        cx = ml + gi * group_w + group_w / 2
        parts.append(
            f'<text x="{cx:.1f}" y="{mt + ph + 20}" text-anchor="middle" class="axis" font-weight="600">{esc(glabel)}</text>'
        )

    # Legend
    lx = ml
    ly = h - 22
    for sname, color, _ in series:
        parts.append(f'<rect x="{lx}" y="{ly - 10}" width="12" height="12" rx="2" fill="{color}"/>')
        parts.append(f'<text x="{lx + 17}" y="{ly}" class="legend">{esc(sname)}</text>')
        lx += 17 + len(sname) * 6.8 + 20

    parts.append("</svg>\n")
    return "\n".join(parts)


def main() -> None:
    if "--self-test" in sys.argv:
        svg = grouped_bar_svg(
            "T", "S", ["A"], [("X", "#2563eb", [10.5])], "ms", 100.0, ref_line=(50.0, "Meta", "#b91c1c"), val_fmt=".1f"
        )
        root = ET.fromstring(svg)
        assert root.tag.endswith("svg")
        assert "10,5" in svg and 'class="ref" fill="#b91c1c"' in svg
        print("Self-test passed")
        return

    b2 = json.loads((DATA / "t8-benchmark-2u.json").read_text())
    b5 = json.loads((DATA / "t8-benchmark-5u.json").read_text())
    b10 = json.loads((DATA / "t8-benchmark-10u.json").read_text())
    cw = json.loads((DATA / "cloudwatch-metrics-dev.json").read_text())
    runs = [b2, b5, b10]
    labels = ["2 usuários (40 entregas)", "5 usuários (250 entregas)", "10 usuários — T8 (1.000 entregas)"]

    OUT.mkdir(parents=True, exist_ok=True)

    # 1. Latency by load
    lat_series = [
        ("Média", "#2563eb", [r["measured"]["allDeliveries"]["avgMs"] for r in runs]),
        ("p50", "#0891b2", [r["measured"]["allDeliveries"]["p50Ms"] for r in runs]),
        ("p95", "#f59e0b", [r["measured"]["allDeliveries"]["p95Ms"] for r in runs]),
        ("p99", "#dc2626", [r["measured"]["allDeliveries"]["p99Ms"] for r in runs]),
    ]
    lat_max = nice_ceil(max([500.0] + [v for _, _, vals in lat_series for v in vals]), 100.0)
    lat_svg = grouped_bar_svg(
        "Latência ponta a ponta por carga de usuários simultâneos (rodada medida)",
        "HubWebSocket-dev (sa-east-1, Lambdas ARM64 512 MB) — confirmações + destinatários",
        labels,
        lat_series,
        "ms",
        lat_max,
        ref_line=(500.0, "Meta RNF02: p95 < 500 ms", "#b91c1c"),
    )
    (OUT / "t8-latencia-por-carga.svg").write_text(lat_svg)

    # 2. Warm-up vs measured (R05)
    warm_series = [
        ("Aquecimento (média)", "#94a3b8", [r["warmup"]["allDeliveries"]["avgMs"] for r in runs]),
        ("Medido (média)", "#2563eb", [r["measured"]["allDeliveries"]["avgMs"] for r in runs]),
        ("Aquecimento (p95)", "#fb923c", [r["warmup"]["allDeliveries"]["p95Ms"] for r in runs]),
        ("Medido (p95)", "#0d9488", [r["measured"]["allDeliveries"]["p95Ms"] for r in runs]),
    ]
    warm_max = nice_ceil(max([500.0] + [v for _, _, vals in warm_series for v in vals]), 200.0)
    warm_svg = grouped_bar_svg(
        "Efeito do início a frio (R05): rodada de aquecimento vs. rodada medida",
        "Comparação da latência média e p95 com e sem aquecimento prévio das Lambdas",
        ["2 usuários", "5 usuários", "10 usuários (T8)"],
        warm_series,
        "ms",
        warm_max,
        ref_line=(500.0, "Meta RNF02: 500 ms", "#b91c1c"),
    )
    (OUT / "t8-warmup-vs-medido.svg").write_text(warm_svg)

    # 3. Throughput (deliveries/s and messages/s)
    thr_series = [
        ("Mensagens/s", "#2563eb", [r["measured"]["throughputMessagesPerSec"] for r in runs]),
        ("Entregas fan-out/s", "#16a34a", [r["measured"]["throughputDeliveriesPerSec"] for r in runs]),
    ]
    thr_max = nice_ceil(max(v for _, _, vals in thr_series for v in vals), 50.0)
    thr_svg = grouped_bar_svg(
        "Vazão observada por carga (mensagens enviadas/s e entregas fan-out/s)",
        "10 mensagens sequenciais por cliente em paralelo no mesmo grupo (R06)",
        ["2 usuários", "5 usuários", "10 usuários (T8)"],
        thr_series,
        "/s",
        thr_max,
        val_fmt=".1f",
    )
    (OUT / "t8-vazao-por-carga.svg").write_text(thr_svg)

    # 4. DynamoDB RCU/WCU consumption
    by_label = {m["label"]: m["sum"] for m in cw["metrics"]}
    tables = ["Users", "Conversations", "Connections", "Memberships", "Messages"]
    t0 = datetime.datetime.fromisoformat(cw["startTime"].replace("Z", "+00:00"))
    t1 = datetime.datetime.fromisoformat(cw["endTime"].replace("Z", "+00:00"))
    win_min = max(1, round((t1 - t0).total_seconds() / 60))
    ddb_series = [
        ("RCU consumidas", "#2563eb", [by_label.get(f"DynamoDB {t} RCU", 0.0) or 0.0 for t in tables]),
        ("WCU consumidas", "#7c3aed", [by_label.get(f"DynamoDB {t} WCU", 0.0) or 0.0 for t in tables]),
    ]
    ddb_max = nice_ceil(max(v for _, _, vals in ddb_series for v in vals), 200.0)
    ddb_svg = grouped_bar_svg(
        "Consumo de capacidade do DynamoDB durante a bateria T8",
        f"Total de RCU e WCU consumidas na janela de {win_min} minutos (ThrottledRequests = 0 em todas)",
        tables,
        ddb_series,
        "un",
        ddb_max,
    )
    (OUT / "t8-consumo-dynamodb.svg").write_text(ddb_svg)
    print("Generated 4 SVG charts in", OUT)


if __name__ == "__main__":
    main()
