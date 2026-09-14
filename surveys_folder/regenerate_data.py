#!/usr/bin/env python3
"""
Regenerate data/gsm_150MHz.bin and data/axes.json for the webpage from a
new sky map .npy file (must be the same 512x512 RA/Dec grid convention as
the original gsm_150MHz.npy: rows indexed by Dec (-90 to 90), columns by
RA (0 to 24h)).

Usage:
    python3 regenerate_data.py path/to/new_map.npy [--zmin 2.5] [--zmax 5]
"""
import argparse
import json
import numpy as np
from pathlib import Path

HERE = Path(__file__).parent


def downsample(a, factor=2):
    n = a.shape[0] // factor
    return a[: n * factor, : n * factor].reshape(n, factor, n, factor).mean(axis=(1, 3))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("npy_path", help="path to the new sky map .npy file (512x512)")
    ap.add_argument("--zmin", type=float, default=2.5, help="log10 color scale min")
    ap.add_argument("--zmax", type=float, default=5.0, help="log10 color scale max")
    ap.add_argument("--factor", type=int, default=2, help="downsample factor (2 -> 256x256)")
    args = ap.parse_args()

    data = np.load(args.npy_path)
    if data.ndim != 2 or data.shape[0] != data.shape[1]:
        raise ValueError(f"expected a square 2D grid, got shape {data.shape}")

    n = data.shape[0]
    DEC = np.linspace(-90, 90, n)
    RA = np.linspace(0, 24, n)

    data_ds = downsample(data, args.factor)
    RA_ds = RA[:: args.factor]
    DEC_ds = DEC[:: args.factor]

    log_data = np.log10(data_ds[::-1])  # match original script's vertical flip
    log_data.astype("<f4").tofile(HERE / "data" / "gsm_150MHz.bin")

    with open(HERE / "data" / "axes.json", "w") as f:
        json.dump(
            {
                "ra": RA_ds.tolist(),
                "dec": DEC_ds.tolist(),
                "nx": len(RA_ds),
                "ny": len(DEC_ds),
                "zmin": args.zmin,
                "zmax": args.zmax,
            },
            f,
        )

    print(f"Wrote data/gsm_150MHz.bin ({log_data.nbytes} bytes) and data/axes.json")
    print(f"log10 range in this map: {log_data.min():.3f} to {log_data.max():.3f}")


if __name__ == "__main__":
    main()
