#!/usr/bin/env bash
# Build a synthetic "environment dependencies" layer (numpy + pandas) the way
# a real env image would carry one, register it in layers.json, and overlay
# it onto the extracted rootfs. Idempotent-ish: re-running rebuilds it.
set -euo pipefail
cd "$(dirname "$0")"

IMG=./image
STAGE=./deps_stage
LAYER_ID="L4-deps-synthetic"

rm -rf "$STAGE"
mkdir -p "$STAGE/opt/pylibs"

pip3 install --quiet --target "$STAGE/opt/pylibs" --no-compile numpy pandas

tar -C "$STAGE" -czf "$IMG/blobs/$LAYER_ID.tar.gz" opt
cp -r "$STAGE/opt" "$IMG/rootfs/"

python3 - << 'EOF'
import json, os, tarfile

img = "./image"
layer_id = "L4-deps-synthetic"
meta_path = os.path.join(img, "layers.json")
with open(meta_path) as f:
    meta = json.load(f)

files = 0
total = 0
with tarfile.open(os.path.join(img, "blobs", layer_id + ".tar.gz")) as tar:
    for m in tar:
        if m.isfile():
            name = m.name.lstrip("./")
            meta["ownership"][name] = {"layer": layer_id, "size": m.size}
            files += 1
            total += m.size

compressed = os.path.getsize(os.path.join(img, "blobs", layer_id + ".tar.gz"))
meta["layers"] = [l for l in meta["layers"] if l["id"] != layer_id]
meta["layers"].append({"id": layer_id, "digest": "synthetic", "index": len(meta["layers"]),
                       "compressed_bytes": compressed, "files": files, "bytes": total})
with open(meta_path, "w") as f:
    json.dump(meta, f)
print(f"{layer_id}: {files} files, {total/1e6:.1f} MB uncompressed, {compressed/1e6:.1f} MB compressed")
EOF

rm -rf "$STAGE"
