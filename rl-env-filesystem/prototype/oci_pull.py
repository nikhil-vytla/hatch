"""Pull an OCI image from a public registry with no container runtime.

Speaks the registry HTTP API directly (token auth, manifest negotiation,
blob download), then extracts the layers in order into a rootfs directory,
applying whiteouts. Produces:

  <out>/blobs/<digest>.tar.gz   raw layer blobs
  <out>/rootfs/                 extracted filesystem
  <out>/layers.json             layer metadata + file->layer ownership map

The ownership map is the ground truth the analyzer joins access traces
against: for every path in the final rootfs, which layer's bytes serve it
(last layer to write a path wins, exactly as overlay semantics dictate).

Usage: python3 oci_pull.py python:3.12-slim --out ./image
"""

import argparse
import gzip
import hashlib
import io
import json
import os
import sys
import tarfile
import urllib.request

REGISTRY = "https://registry-1.docker.io"
AUTH = "https://auth.docker.io/token?service=registry.docker.io&scope=repository:{repo}:pull"

MANIFEST_ACCEPT = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])


class _DropAuthOnRedirect(urllib.request.HTTPRedirectHandler):
    """Blob GETs redirect to presigned CDN URLs, which reject requests that
    still carry the registry Authorization header. Strip it on redirect."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None:
            new.remove_header("Authorization")
        return new


_OPENER = urllib.request.build_opener(_DropAuthOnRedirect)


def http_get(url: str, headers: dict) -> bytes:
    req = urllib.request.Request(url, headers=headers)
    with _OPENER.open(req) as resp:
        return resp.read()


def get_token(repo: str) -> str:
    data = json.loads(http_get(AUTH.format(repo=repo), {}))
    return data["token"]


def get_manifest(repo: str, ref: str, token: str) -> dict:
    raw = http_get(
        f"{REGISTRY}/v2/{repo}/manifests/{ref}",
        {"Authorization": f"Bearer {token}", "Accept": MANIFEST_ACCEPT},
    )
    manifest = json.loads(raw)
    # Multi-arch index: descend into the linux/amd64 entry.
    if manifest.get("manifests"):
        for entry in manifest["manifests"]:
            plat = entry.get("platform", {})
            if plat.get("os") == "linux" and plat.get("architecture") == "amd64":
                return get_manifest(repo, entry["digest"], token)
        raise SystemExit("no linux/amd64 manifest in index")
    return manifest


def fetch_blob(repo: str, digest: str, token: str, dest: str) -> int:
    if os.path.exists(dest):
        return os.path.getsize(dest)
    blob = http_get(
        f"{REGISTRY}/v2/{repo}/blobs/{digest}",
        {"Authorization": f"Bearer {token}"},
    )
    if hashlib.sha256(blob).hexdigest() != digest.split(":", 1)[1]:
        raise SystemExit(f"digest mismatch for {digest}")
    with open(dest, "wb") as f:
        f.write(blob)
    return len(blob)


def safe_member(member: tarfile.TarInfo) -> bool:
    name = member.name
    return not (name.startswith("/") or ".." in name.split("/"))


def apply_layer(tar_bytes: bytes, rootfs: str, layer_id: str,
                ownership: dict) -> dict:
    """Extract one layer over rootfs, handling whiteouts, recording ownership.

    Returns per-layer stats: file count and uncompressed byte total.
    """
    stats = {"files": 0, "bytes": 0}
    with tarfile.open(fileobj=io.BytesIO(tar_bytes)) as tar:
        for member in tar:
            if not safe_member(member):
                continue
            name = member.name.lstrip("./")
            base = os.path.basename(name)
            target = os.path.join(rootfs, name)

            if base.startswith(".wh."):
                if base == ".wh..wh..opq":
                    # Opaque dir: drop lower-layer contents of this directory.
                    opq_dir = os.path.dirname(name)
                    for owned in [p for p in ownership if
                                  p.startswith(opq_dir + "/")]:
                        del ownership[owned]
                    continue
                victim = os.path.join(os.path.dirname(name), base[len(".wh."):])
                victim_path = os.path.join(rootfs, victim)
                if os.path.isdir(victim_path) and not os.path.islink(victim_path):
                    import shutil
                    shutil.rmtree(victim_path, ignore_errors=True)
                elif os.path.lexists(victim_path):
                    os.unlink(victim_path)
                ownership.pop(victim, None)
                continue

            if member.isdir():
                os.makedirs(target, exist_ok=True)
                continue
            if member.issym() or member.islnk():
                if os.path.lexists(target):
                    os.unlink(target)
                try:
                    if member.issym():
                        os.symlink(member.linkname, target)
                    else:
                        src = os.path.join(rootfs, member.linkname.lstrip("./"))
                        os.link(src, target)
                except OSError:
                    pass
                ownership[name] = {"layer": layer_id, "size": 0}
                continue
            if not member.isfile():
                continue  # devices, fifos: irrelevant to the analysis
            os.makedirs(os.path.dirname(target), exist_ok=True)
            src = tar.extractfile(member)
            if src is None:
                continue
            if os.path.lexists(target):
                os.unlink(target)
            with open(target, "wb") as dst:
                dst.write(src.read())
            # Preserve exec bits so binaries still run in the chroot.
            os.chmod(target, (member.mode & 0o777) | 0o600)
            ownership[name] = {"layer": layer_id, "size": member.size}
            stats["files"] += 1
            stats["bytes"] += member.size
    return stats


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("image", help="e.g. python:3.12-slim")
    ap.add_argument("--out", default="./image")
    args = ap.parse_args()

    name, _, tag = args.image.partition(":")
    tag = tag or "latest"
    repo = name if "/" in name else f"library/{name}"

    blobs_dir = os.path.join(args.out, "blobs")
    rootfs = os.path.join(args.out, "rootfs")
    os.makedirs(blobs_dir, exist_ok=True)
    os.makedirs(rootfs, exist_ok=True)

    token = get_token(repo)
    manifest = get_manifest(repo, tag, token)

    ownership: dict = {}
    layers_meta = []
    for i, layer in enumerate(manifest["layers"]):
        digest = layer["digest"]
        short = digest.split(":", 1)[1][:12]
        layer_id = f"L{i}-{short}"
        blob_path = os.path.join(blobs_dir, f"{layer_id}.tar.gz")
        compressed = fetch_blob(repo, digest, token, blob_path)
        with open(blob_path, "rb") as f:
            tar_bytes = gzip.decompress(f.read())
        stats = apply_layer(tar_bytes, rootfs, layer_id, ownership)
        layers_meta.append({
            "id": layer_id, "digest": digest, "index": i,
            "compressed_bytes": compressed, **stats,
        })
        print(f"{layer_id}: {stats['files']} files, "
              f"{stats['bytes']/1e6:.1f} MB uncompressed, "
              f"{compressed/1e6:.1f} MB compressed", file=sys.stderr)

    with open(os.path.join(args.out, "layers.json"), "w") as f:
        json.dump({"image": args.image, "layers": layers_meta,
                   "ownership": ownership}, f)
    total = sum(m["bytes"] for m in layers_meta)
    print(f"done: {len(layers_meta)} layers, {total/1e6:.1f} MB uncompressed,"
          f" {len(ownership)} owned paths", file=sys.stderr)


if __name__ == "__main__":
    main()
