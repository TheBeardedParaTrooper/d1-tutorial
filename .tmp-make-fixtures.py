#!/usr/bin/env python3
"""Build tiny but real upload fixtures for the marketplace test."""
import os, struct, zlib

out = os.path.join(os.path.dirname(__file__), '.tmp-fixtures')
os.makedirs(out, exist_ok=True)

def chunk(tag, data):
    body = tag + data
    return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)

W = H = 96
raw = b''
for y in range(H):
    row = b'\x00'
    for x in range(W):
        if (x // 12 + y // 12) % 2 == 0:
            row += b'\x30\x7b\x5f'
        else:
            row += b'\xe8\x59\x0c'
    raw += row

png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(raw, 9))
       + chunk(b'IEND', b''))
open(os.path.join(out, 'mini-switch-photo.png'), 'wb').write(png)

pdf = b"""%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 62>>stream
BT /F1 18 Tf 40 80 Td (MikroTik RB931GX - datasheet) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
"""
open(os.path.join(out, 'rb931gs-datasheet.pdf'), 'wb').write(pdf)

text = 'Flat Coin ISP - wholesale bandwidth tariff sheet\n30 Mbps / 24h = 500 TZS\n100 Mbps / 24h = 1000 TZS\n'
open(os.path.join(out, 'tariff-sheet.csv'), 'w').write(text)

for name in ('mini-switch-photo.png', 'rb931gs-datasheet.pdf', 'tariff-sheet.csv'):
    p = os.path.join(out, name)
    print(f'{name}: {os.path.getsize(p)} bytes')
