#!/usr/bin/env python3
"""生成 ai-browser-bridge chrome 扩展图标。
设计: 圆角方块底 + 白色"两点一弧"桥形符号 (左右两个节点 + 顶部弧线连接)。
两种状态: idle (蓝) / active (绿)。3 个尺寸: 16 / 48 / 128。
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT_DIR = Path(__file__).parent.parent / "extension" / "icons"

IDLE_BG = (37, 99, 235, 255)     # #2563eb tailwind blue-600
ACTIVE_BG = (22, 163, 74, 255)   # #16a34a tailwind green-600
FG = (255, 255, 255, 255)


def rounded_rect_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def draw_bridge_glyph(canvas: Image.Image, size: int) -> None:
    """桥形符号: 左右两个圆点 + 顶部连接弧线 (从左点到右点)。"""
    d = ImageDraw.Draw(canvas)
    # 参数按 size 归一化, 保证 16 / 48 / 128 视觉一致
    padding = size * 0.22
    node_r = size * 0.11
    arc_thickness = max(1, int(round(size * 0.09)))

    left_c = (padding + node_r, size * 0.62)
    right_c = (size - padding - node_r, size * 0.62)

    # 桥面弧: 从左节点上方开始到右节点上方结束
    arc_bbox = (
        left_c[0] - node_r * 0.4,
        size * 0.20,
        right_c[0] + node_r * 0.4,
        size * 0.85,
    )
    d.arc(arc_bbox, start=180, end=360, fill=FG, width=arc_thickness)

    # 左右节点圆
    for cx, cy in (left_c, right_c):
        d.ellipse(
            (cx - node_r, cy - node_r, cx + node_r, cy + node_r),
            fill=FG,
        )


def make_icon(size: int, bg_color: tuple[int, int, int, int], out_path: Path) -> None:
    # 高分辨率画布再缩放 = 抗锯齿, 尤其 16 尺寸下必须
    scale = 4
    big = size * scale
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    mask = rounded_rect_mask(big, radius=int(big * 0.22))
    solid = Image.new("RGBA", (big, big), bg_color)
    canvas.paste(solid, (0, 0), mask=mask)
    draw_bridge_glyph(canvas, big)
    icon = canvas.resize((size, size), Image.LANCZOS)
    icon.save(out_path, "PNG")
    print(f"wrote {out_path} ({size}×{size})")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in (16, 48, 128):
        make_icon(size, IDLE_BG, OUT_DIR / f"icon{size}.png")
        make_icon(size, ACTIVE_BG, OUT_DIR / f"icon{size}_active.png")


if __name__ == "__main__":
    main()
