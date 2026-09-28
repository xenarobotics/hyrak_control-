#!/usr/bin/env python3
"""Generate the indoor GPS-denied test world: worlds/hyrak_indoor.sdf plus the
floor / ceiling textures in models/hyrak_indoor_assets/.

    python3 simulation/worlds/gen_hyrak_indoor.py

A single-storey building, 30 x 20 m, ceiling slab at 3 m:
  Room A  x -5..9,  y -10..10   the big room; take-off area clear around (0, 0)
  corridor x 9..25, y -0.9..0.9 (1.8 m wide), open to room A
  Room B  x 9..25,  y 1..10     shelving rows, desk - door at x 16..17
  Room C  x 9..25,  y -10..-1   boxes, cabinet, pillar - door at x 20..21
Every surface a camera or the optical-flow sensor looks at has texture:
  - floor: 25 cm tiles in mixed colours with grout and speckle (a uniform
    floor gives optical flow nothing to track - the drone drifts)
  - ceiling: 60 cm ceiling tiles with grid lines (monocular depth and the
    indoor/outdoor detector see a ceiling, not a void)
  - walls: a different colour per wall, with frames/panels on them
Lighting is indoor: point lights under the ceiling, no sun.

Edit the layout here and re-run; the .sdf is generated, not hand-edited.
"""
from __future__ import annotations

import math
import random
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent / "models" / "hyrak_indoor_assets"
TEX = ASSETS / "materials" / "textures"
OUT = HERE / "hyrak_indoor.sdf"

X0, X1, Y0, Y1 = -5.0, 25.0, -10.0, 10.0      # building interior
H = 3.0                                        # ceiling height
T = 0.2                                        # wall thickness
rng = random.Random(11)


# -- textures ---------------------------------------------------------------
def floor_texture(px_per_m: int = 136) -> Image.Image:
    w, h = int((X1 - X0) * px_per_m), int((Y1 - Y0) * px_per_m)
    tile = px_per_m // 4                                   # 25 cm tiles
    palette = np.array([[176, 164, 140], [140, 128, 112], [196, 190, 176],
                        [120, 110, 98], [158, 150, 132], [102, 96, 90]], np.float32)
    nr = np.random.default_rng(3)
    ty, tx = h // tile + 1, w // tile + 1
    idx = nr.integers(0, len(palette), (ty, tx))
    img = palette[idx].repeat(tile, 0).repeat(tile, 1)[:h, :w]
    img += nr.normal(0, 9, (h, w, 1))                      # speckle: texture inside a tile
    grout = np.zeros((h, w), bool)
    grout[::tile, :] = grout[1::tile, :] = True
    grout[:, ::tile] = grout[:, 1::tile] = True
    img[grout] = (60, 58, 55)
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))


def ceiling_texture(px_per_m: int = 60) -> Image.Image:
    w, h = int((X1 - X0) * px_per_m), int((Y1 - Y0) * px_per_m)
    tile = int(0.6 * px_per_m)
    nr = np.random.default_rng(5)
    img = np.full((h, w, 3), 222.0, np.float32) + nr.normal(0, 6, (h, w, 1))
    img[::tile, :] = img[1::tile, :] = (150, 150, 150)
    img[:, ::tile] = img[:, 1::tile] = (150, 150, 150)
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))


# -- sdf pieces -------------------------------------------------------------
def material(rgb, albedo: str | None = None) -> str:
    r, g, b = rgb
    pbr = (f"<pbr><metal><albedo_map>model://hyrak_indoor_assets/materials/textures/{albedo}</albedo_map>"
           f"<roughness>0.9</roughness><metalness>0</metalness></metal></pbr>") if albedo else ""
    return (f"<material><ambient>{r} {g} {b} 1</ambient><diffuse>{r} {g} {b} 1</diffuse>"
            f"<specular>0.05 0.05 0.05 1</specular>{pbr}</material>")


def box(name, cx, cy, cz, sx, sy, sz, rgb, yaw=0.0, albedo=None) -> str:
    geo = f"<geometry><box><size>{sx:.3f} {sy:.3f} {sz:.3f}</size></box></geometry>"
    return (f'    <model name="{name}"><static>true</static>\n'
            f"      <pose>{cx:.3f} {cy:.3f} {cz:.3f} 0 0 {yaw:.4f}</pose>\n"
            f'      <link name="link"><collision name="c">{geo}</collision>\n'
            f'        <visual name="v">{geo}{material(rgb, albedo)}<cast_shadows>false</cast_shadows></visual></link></model>\n')


def cylinder(name, cx, cy, r, h, rgb) -> str:
    geo = f"<geometry><cylinder><radius>{r}</radius><length>{h}</length></cylinder></geometry>"
    return (f'    <model name="{name}"><static>true</static>\n'
            f"      <pose>{cx:.3f} {cy:.3f} {h / 2:.3f} 0 0 0</pose>\n"
            f'      <link name="link"><collision name="c">{geo}</collision>\n'
            f'        <visual name="v">{geo}{material(rgb)}<cast_shadows>false</cast_shadows></visual></link></model>\n')


def wall_x(name, x, ya, yb, rgb, gaps=()) -> list[str]:
    """Wall along y at x, from ya to yb, with door gaps (y ranges) cut out."""
    out, cur = [], ya
    for g0, g1 in sorted(gaps) + [(yb, yb)]:
        if g0 - cur > 0.05:
            out.append(box(f"{name}_{len(out)}", x, (cur + g0) / 2, H / 2, T, g0 - cur, H, rgb))
        cur = g1
    return out


def wall_y(name, y, xa, xb, rgb, gaps=()) -> list[str]:
    out, cur = [], xa
    for g0, g1 in sorted(gaps) + [(xb, xb)]:
        if g0 - cur > 0.05:
            out.append(box(f"{name}_{len(out)}", (cur + g0) / 2, y, H / 2, g0 - cur, T, H, rgb))
        cur = g1
    return out


def panels(prefix, n, along, fixed, lo, hi, z0, face, rgb_list) -> list[str]:
    """Thin frames/posters on a wall: along='x' -> wall at y=fixed."""
    out = []
    for i in range(n):
        c = lo + (i + 0.5) * (hi - lo) / n + rng.uniform(-0.4, 0.4)
        w, hgt = rng.uniform(0.5, 1.2), rng.uniform(0.4, 0.9)
        z = z0 + rng.uniform(0, 0.6)
        col = rng.choice(rgb_list)
        if along == "x":
            out.append(box(f"{prefix}{i}", c, fixed + face * 0.13, z, w, 0.04, hgt, col))
        else:
            out.append(box(f"{prefix}{i}", fixed + face * 0.13, c, z, 0.04, w, hgt, col))
    return out


def build() -> str:
    m: list[str] = []
    xm, ym = (X0 + X1) / 2, (Y0 + Y1) / 2
    # floor (textured slab) and ceiling slab
    m.append(box("floor", xm, ym, -0.01, X1 - X0 + 2 * T, Y1 - Y0 + 2 * T, 0.02, (0.7, 0.66, 0.6), albedo="floor.jpg"))
    m.append(box("ceiling", xm, ym, H + 0.05, X1 - X0 + 2 * T, Y1 - Y0 + 2 * T, 0.1, (0.87, 0.87, 0.87), albedo="ceiling.jpg"))
    # outer walls, one colour each
    m += wall_y("wall_south", Y0 - T / 2, X0 - T, X1 + T, (0.55, 0.62, 0.72))
    m += wall_y("wall_north", Y1 + T / 2, X0 - T, X1 + T, (0.72, 0.6, 0.45))
    m += wall_x("wall_west", X0 - T / 2, Y0, Y1, (0.5, 0.66, 0.52))
    m += wall_x("wall_east", X1 + T / 2, Y0, Y1, (0.68, 0.5, 0.55))
    # room A | east wing, open at the corridor
    m += wall_x("wall_a", 9.0, Y0, Y1, (0.78, 0.74, 0.62), gaps=[(-0.9, 0.9)])
    # corridor walls with the doors into B and C
    m += wall_y("wall_corr_n", 1.0, 9.0, X1, (0.62, 0.7, 0.78), gaps=[(16.0, 17.0)])
    m += wall_y("wall_corr_s", -1.0, 9.0, X1, (0.8, 0.66, 0.6), gaps=[(20.0, 21.0)])
    # panels / frames on the walls (texture for monocular depth)
    cols = [(0.2, 0.3, 0.6), (0.7, 0.2, 0.2), (0.15, 0.5, 0.35), (0.85, 0.7, 0.2), (0.35, 0.2, 0.45)]
    m += panels("pan_s", 6, "x", Y0, X0, X1, 1.0, +1, cols)
    m += panels("pan_n", 6, "x", Y1, X0, X1, 1.0, -1, cols)
    m += panels("pan_w", 4, "y", X0, Y0, Y1, 1.0, +1, cols)
    m += panels("pan_e", 4, "y", X1, Y0, Y1, 1.0, -1, cols)
    # room A furniture (take-off area around (0, 0) kept clear, 2.5 m)
    m.append(box("a_table", 4.5, 5.0, 0.375, 1.6, 0.8, 0.75, (0.45, 0.3, 0.18)))
    m.append(box("a_shelf", -4.55, -6.0, 1.0, 0.4, 2.0, 2.0, (0.35, 0.25, 0.15)))
    m.append(box("a_sofa", -2.0, 8.5, 0.4, 2.0, 0.9, 0.8, (0.3, 0.35, 0.55)))
    m.append(box("a_crates", 6.5, 1.8, 0.6, 0.6, 0.6, 1.2, (0.6, 0.45, 0.25)))
    m.append(box("a_cabinet", 7.0, -8.0, 1.1, 1.2, 0.6, 2.2, (0.5, 0.52, 0.55)))
    m.append(cylinder("a_pillar_1", 4.5, -4.0, 0.25, H, (0.8, 0.8, 0.78)))
    m.append(cylinder("a_pillar_2", 1.5, 6.5, 0.25, H, (0.8, 0.8, 0.78)))
    # room B: shelving rows + desk + pillar
    for i, x in enumerate((13.0, 17.5, 22.0)):
        m.append(box(f"b_shelf_{i}", x, 5.8, 0.9, 0.5, 3.0, 1.8, (0.3 + 0.1 * i, 0.3, 0.35)))
    m.append(box("b_desk", 11.5, 8.8, 0.375, 1.4, 0.7, 0.75, (0.5, 0.35, 0.2)))
    m.append(cylinder("b_pillar", 20.0, 8.5, 0.25, H, (0.8, 0.8, 0.78)))
    # room C: boxes, a tall cabinet, a pillar
    for i, (x, y, s) in enumerate(((12.0, -4.0, 1.0), (15.0, -7.5, 0.8), (19.0, -3.5, 1.2))):
        m.append(box(f"c_box_{i}", x, y, s / 2, s, s, s, (0.7, 0.5 - 0.1 * i, 0.3)))
    m.append(box("c_cabinet", 23.5, -8.5, 1.1, 0.6, 1.2, 2.2, (0.4, 0.42, 0.45)))
    m.append(cylinder("c_pillar", 17.0, -5.0, 0.25, H, (0.8, 0.8, 0.78)))
    # corridor: a plant narrowing it (1.8 m -> ~1.4 m)
    m.append(cylinder("corr_plant", 14.0, 0.6, 0.2, 1.2, (0.2, 0.55, 0.25)))
    return "".join(m)


def lights() -> str:
    spots = [(0, -5), (0, 5), (6, 0), (13, 5.5), (21, 5.5), (13, -5.5), (21, -5.5), (17, 0)]
    out = []
    for i, (x, y) in enumerate(spots):
        out.append(f"""    <light name="lamp_{i}" type="point">
      <pose>{x} {y} {H - 0.2} 0 0 0</pose>
      <diffuse>0.95 0.92 0.85 1</diffuse><specular>0.2 0.2 0.2 1</specular>
      <attenuation><range>14</range><constant>0.4</constant><linear>0.05</linear><quadratic>0.01</quadratic></attenuation>
      <cast_shadows>false</cast_shadows>
    </light>
""")
    return "".join(out)


def world() -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!-- GENERATED by gen_hyrak_indoor.py - edit that, then re-run it. -->
<sdf version="1.9">
  <world name="hyrak_indoor">
    <physics type="ode">
      <max_step_size>0.004</max_step_size>
      <real_time_factor>1.0</real_time_factor>
      <real_time_update_rate>250</real_time_update_rate>
    </physics>
    <gravity>0 0 -9.8</gravity>
    <magnetic_field>6e-06 2.3e-05 -4.2e-05</magnetic_field>
    <atmosphere type="adiabatic"/>
    <scene>
      <grid>false</grid>
      <ambient>0.45 0.45 0.45 1</ambient>
      <background>0.05 0.05 0.05 1</background>
      <shadows>false</shadows>
    </scene>
{build()}{lights()}    <spherical_coordinates>
      <surface_model>EARTH_WGS84</surface_model>
      <world_frame_orientation>ENU</world_frame_orientation>
      <latitude_deg>47.397971057728974</latitude_deg>
      <longitude_deg> 8.546163739800146</longitude_deg>
      <elevation>0</elevation>
    </spherical_coordinates>
  </world>
</sdf>
"""


def main() -> None:
    TEX.mkdir(parents=True, exist_ok=True)
    floor_texture().save(TEX / "floor.jpg", quality=88)
    ceiling_texture().save(TEX / "ceiling.jpg", quality=85)
    (ASSETS / "model.config").write_text(
        '<?xml version="1.0"?>\n<model>\n  <name>hyrak_indoor_assets</name>\n  <version>1.0</version>\n'
        '  <sdf version="1.9">model.sdf</sdf>\n  <description>Textures for worlds/hyrak_indoor.sdf '
        '(generated by worlds/gen_hyrak_indoor.py).</description>\n</model>\n')
    (ASSETS / "model.sdf").write_text(
        '<?xml version="1.0"?>\n<sdf version="1.9">\n  <model name="hyrak_indoor_assets"><static>true</static>'
        '<link name="link"/></model>\n</sdf>\n')
    OUT.write_text(world())
    print(f"wrote {OUT} and textures in {TEX}")


if __name__ == "__main__":
    main()
