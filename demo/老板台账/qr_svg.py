#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
零依赖标准 ISO/IEC 18004 二维码 SVG 生成器（Byte 模式，EC Level L，支持 Version 1~10，最高 271 字节）
用于生成 iPhone 相机 / Google Authenticator / 苹果自带「密码」App 可直接扫描的 otpauth:// 及扫码确认二维码
"""

from __future__ import annotations

# Version 1..10, Error Correction Level L: (total_codewords, ec_codewords_per_block, num_blocks, alignment_centers)
QR_VER_L = {
    1: (26, 7, 1, []),
    2: (44, 10, 1, [6, 18]),
    3: (70, 15, 1, [6, 22]),
    4: (100, 20, 1, [6, 26]),
    5: (134, 26, 1, [6, 30]),
    6: (172, 18, 2, [6, 34]),
    7: (196, 20, 2, [6, 22, 38]),
    8: (242, 24, 2, [6, 24, 42]),
    9: (292, 30, 2, [6, 26, 46]),
    10: (346, 18, 4, [6, 28, 50]),  # Note: v10-L has 2 blocks of 68 data + 2 blocks of 69 data (total 346, 4*18=72 ec)
}

# Version 7..10 18-bit version info (BCH(18,6))
VER_INFO_BITS = {
    7: 0x07C94,
    8: 0x085BC,
    9: 0x09A99,
    10: 0x0A4D3,
}

# GF(256) tables with primitive polynomial 0x11D
GF_EXP = [0] * 512
GF_LOG = [0] * 256
_x = 1
for _i in range(255):
    GF_EXP[_i] = _x
    GF_LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:
        _x ^= 0x11D
for _i in range(255, 512):
    GF_EXP[_i] = GF_EXP[_i - 255]


def _gf_mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return GF_EXP[GF_LOG[a] + GF_LOG[b]]


def _rs_gen_poly(degree: int) -> list[int]:
    poly = [1]
    for i in range(degree):
        nxt = [0] * (len(poly) + 1)
        factor = GF_EXP[i]
        for j, coef in enumerate(poly):
            nxt[j] ^= coef
            nxt[j + 1] ^= _gf_mul(coef, factor)
        poly = nxt
    return poly


def _rs_encode(data: list[int], ec_len: int) -> list[int]:
    gen = _rs_gen_poly(ec_len)
    res = [0] * ec_len
    for b in data:
        factor = b ^ res[0]
        res = res[1:] + [0]
        if factor != 0:
            for j in range(ec_len):
                res[j] ^= _gf_mul(gen[j + 1], factor)
    return res


def _choose_version(byte_len: int) -> int:
    for v in range(1, 11):
        total_cw, ec_cw, blocks, _ = QR_VER_L[v]
        data_cw = total_cw - ec_cw * blocks
        header_bits = 4 + (8 if v <= 9 else 16)
        max_bytes = (data_cw * 8 - header_bits) // 8
        if byte_len <= max_bytes:
            return v
    raise ValueError(f"QR payload too long ({byte_len} bytes)")


def _encode_codewords(payload: bytes, ver: int) -> list[int]:
    total_cw, ec_cw, num_blocks, _ = QR_VER_L[ver]
    data_cw_total = total_cw - ec_cw * num_blocks

    bits: list[int] = []

    def push_bits(val: int, length: int) -> None:
        for i in range(length - 1, -1, -1):
            bits.append((val >> i) & 1)

    # Byte mode = 0b0100
    push_bits(0b0100, 4)
    push_bits(len(payload), 8 if ver <= 9 else 16)
    for b in payload:
        push_bits(b, 8)

    capacity_bits = data_cw_total * 8
    term = min(4, capacity_bits - len(bits))
    push_bits(0, term)
    while len(bits) % 8 != 0:
        bits.append(0)

    data_bytes = [int("".join(str(bit) for bit in bits[i:i + 8]), 2) for i in range(0, len(bits), 8)]
    pad_seq = [0xEC, 0x11]
    idx = 0
    while len(data_bytes) < data_cw_total:
        data_bytes.append(pad_seq[idx % 2])
        idx += 1

    # Split blocks (handles v10 2 short + 2 long blocks cleanly)
    short_block_len = data_cw_total // num_blocks
    num_long_blocks = data_cw_total % num_blocks
    num_short_blocks = num_blocks - num_long_blocks

    data_blocks: list[list[int]] = []
    ec_blocks: list[list[int]] = []
    pos = 0
    for b_idx in range(num_blocks):
        blen = short_block_len + (0 if b_idx < num_short_blocks else 1)
        blk = data_bytes[pos:pos + blen]
        pos += blen
        data_blocks.append(blk)
        ec_blocks.append(_rs_encode(blk, ec_cw))

    # Interleave data codewords then EC codewords
    result: list[int] = []
    max_dlen = short_block_len + (1 if num_long_blocks > 0 else 0)
    for col in range(max_dlen):
        for blk in data_blocks:
            if col < len(blk):
                result.append(blk[col])
    for col in range(ec_cw):
        for eblk in ec_blocks:
            result.append(eblk[col])
    return result


def _format_bits_level_l(mask: int) -> int:
    # EC Level L = 01, plus 3-bit mask -> BCH(15,5) masked with 0x5412
    data = (0b01 << 3) | mask
    rem = data << 10
    for i in range(14, 9, -1):
        if (rem >> i) & 1:
            rem ^= 0x537 << (i - 10)
    return ((data << 10) | rem) ^ 0x5412


def make_qr_matrix(text: str) -> list[list[bool]]:
    raw = text.encode("utf-8")
    ver = _choose_version(len(raw))
    size = 17 + 4 * ver
    _, _, _, align_coords = QR_VER_L[ver]

    modules: list[list[bool | None]] = [[None] * size for _ in range(size)]
    is_func: list[list[bool]] = [[False] * size for _ in range(size)]

    def set_func(r: int, c: int, dark: bool) -> None:
        if 0 <= r < size and 0 <= c < size:
            modules[r][c] = dark
            is_func[r][c] = True

    # Finder patterns + separators
    def draw_finder(top: int, left: int) -> None:
        for dr in range(-1, 8):
            for dc in range(-1, 8):
                r, c = top + dr, left + dc
                if 0 <= r < size and 0 <= c < size:
                    in_outer = 0 <= dr <= 6 and 0 <= dc <= 6
                    on_ring = dr in (0, 6) or dc in (0, 6)
                    in_core = 2 <= dr <= 4 and 2 <= dc <= 4
                    set_func(r, c, in_outer and (on_ring or in_core))

    draw_finder(0, 0)
    draw_finder(0, size - 7)
    draw_finder(size - 7, 0)

    # Timing patterns
    for i in range(8, size - 8):
        set_func(6, i, i % 2 == 0)
        set_func(i, 6, i % 2 == 0)

    # Alignment patterns
    for ar in align_coords:
        for ac in align_coords:
            if (ar == 6 and ac == 6) or (ar == 6 and ac == size - 7) or (ar == size - 7 and ac == 6):
                continue
            for dr in range(-2, 3):
                for dc in range(-2, 3):
                    dist = max(abs(dr), abs(dc))
                    set_func(ar + dr, ac + dc, dist != 1)

    # Dark module & reserved format areas
    set_func(4 * ver + 9, 8, True)
    for i in range(9):
        if not is_func[8][i]:
            set_func(8, i, False)
        if not is_func[i][8]:
            set_func(i, 8, False)
    for i in range(8):
        if not is_func[8][size - 1 - i]:
            set_func(8, size - 1 - i, False)
        if not is_func[size - 1 - i][8]:
            set_func(size - 1 - i, 8, False)

    # Version info (v >= 7)
    if ver >= 7:
        vbits = VER_INFO_BITS[ver]
        for i in range(18):
            bit = bool((vbits >> i) & 1)
            a, b = i // 3, i % 3
            set_func(size - 11 + b, a, bit)
            set_func(a, size - 11 + b, bit)

    # Place data + EC bits in upward/downward 2-column zig-zag
    codewords = _encode_codewords(raw, ver)
    all_bits: list[bool] = []
    for cw in codewords:
        for shift in range(7, -1, -1):
            all_bits.append(bool((cw >> shift) & 1))

    bit_idx = 0
    right = size - 1
    upward = True
    while right >= 1:
        if right == 6:
            right -= 1
        row_iter = range(size - 1, -1, -1) if upward else range(size)
        for r in row_iter:
            for c in (right, right - 1):
                if not is_func[r][c]:
                    dark = all_bits[bit_idx] if bit_idx < len(all_bits) else False
                    bit_idx += 1
                    # Apply Mask 0: (r + c) % 2 == 0
                    if (r + c) % 2 == 0:
                        dark = not dark
                    modules[r][c] = dark
        upward = not upward
        right -= 2

    # Write Format bits for Level L + Mask 0 (ISO/IEC 18004 Fig. 25: bit 14 is MSB, bit 0 is LSB)
    fbits = _format_bits_level_l(0)
    # Top-left around finder: bit 14..0
    tl_coords = [
        (8, 0), (8, 1), (8, 2), (8, 3), (8, 4), (8, 5), (8, 7), (8, 8),
        (7, 8), (5, 8), (4, 8), (3, 8), (2, 8), (1, 8), (0, 8),
    ]
    for idx_b, (rr, cc) in enumerate(tl_coords):
        bit = bool((fbits >> (14 - idx_b)) & 1)
        set_func(rr, cc, bit)

    # Bottom-left vertical (bit 14..8) + Top-right horizontal (bit 7..0)
    split_coords = [
        (size - 1, 8), (size - 2, 8), (size - 3, 8), (size - 4, 8),
        (size - 5, 8), (size - 6, 8), (size - 7, 8),
        (8, size - 8), (8, size - 7), (8, size - 6), (8, size - 5),
        (8, size - 4), (8, size - 3), (8, size - 2), (8, size - 1),
    ]
    for idx_b, (rr, cc) in enumerate(split_coords):
        bit = bool((fbits >> (14 - idx_b)) & 1)
        set_func(rr, cc, bit)

    return [[bool(cell) for cell in row] for row in modules]


def render_qr_svg(text: str, border: int = 3) -> str:
    mat = make_qr_matrix(text)
    n = len(mat)
    dim = n + border * 2
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {dim} {dim}" width="196" height="196" shape-rendering="crispEdges">',
        f'<rect width="{dim}" height="{dim}" fill="#ffffff" rx="2"/>',
        '<path fill="#0f172a" d="',
    ]
    cmds = []
    for r, row in enumerate(mat):
        y = r + border
        for c, dark in enumerate(row):
            if dark:
                x = c + border
                cmds.append(f"M{x},{y}h1v1h-1z")
    parts.append("".join(cmds))
    parts.append('"/></svg>')
    return "".join(parts)
