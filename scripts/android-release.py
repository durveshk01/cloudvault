"""Build, sign, and verify the server-free Android release.

Use --create-key once to create a private signing key in .release-secrets/.
CI supplies the four ANDROID_KEY* environment variables instead.
"""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import zipfile


ROOT = Path(__file__).resolve().parent.parent
SIGNING_NAMES = (
    "ANDROID_KEYSTORE_PATH", "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD",
)


def run(command, *, env=None, cwd=ROOT, capture=False):
    return subprocess.run(
        [str(part) for part in command], cwd=cwd, env=env, check=True,
        text=True, stdout=subprocess.PIPE if capture else None,
    )


def signing_environment(create_key):
    env = dict(os.environ)
    if all(env.get(name) for name in SIGNING_NAMES):
        return env
    if any(env.get(name) for name in SIGNING_NAMES):
        raise RuntimeError("Supply all four Android signing environment variables.")
    directory = ROOT / ".release-secrets"
    record = directory / "signing.json"
    if not record.exists():
        if not create_key:
            raise RuntimeError("Supply signing variables or use --create-key for the first release.")
        directory.mkdir(exist_ok=True)
        key = directory / "cloudvault-release.p12"
        if key.exists():
            raise RuntimeError("A signing key already exists. Restore its signing.json; do not replace it.")
        password = secrets.token_urlsafe(48)
        values = dict(zip(SIGNING_NAMES, (str(key), password, "cloudvault", password)))
        env.update(values)
        java_home = env.get("JAVA_HOME")
        keytool = Path(java_home) / "bin" / "keytool.exe" if os.name == "nt" and java_home else shutil.which("keytool")
        if not keytool:
            raise RuntimeError("Install Java 21 with keytool.")
        run([
            keytool, "-genkeypair", "-keystore", key, "-storetype", "PKCS12",
            "-alias", "cloudvault", "-keyalg", "RSA", "-keysize", "3072",
            "-validity", "10000", "-dname", "CN=CloudVault,OU=Android,O=CloudVault",
            "-storepass:env", "ANDROID_KEYSTORE_PASSWORD",
            "-keypass:env", "ANDROID_KEY_PASSWORD",
        ], env=env)
        record.write_text(json.dumps(values, indent=2) + "\n", encoding="utf-8")
        if os.name != "nt":
            key.chmod(0o600)
            record.chmod(0o600)
        print("Created private release signing files in .release-secrets/.", flush=True)
    env.update(json.loads(record.read_text(encoding="utf-8")))
    if not Path(env["ANDROID_KEYSTORE_PATH"]).is_file():
        raise RuntimeError("The configured release keystore is missing.")
    return env


def configure_github(repo, env):
    values = {
        "ANDROID_KEYSTORE_BASE64": base64.b64encode(Path(env["ANDROID_KEYSTORE_PATH"]).read_bytes()).decode("ascii"),
        **{name: env[name] for name in SIGNING_NAMES if name != "ANDROID_KEYSTORE_PATH"},
    }
    for name, value in values.items():
        subprocess.run(["gh", "secret", "set", name, "--repo", repo], input=value, text=True, check=True)
    print("Configured GitHub Actions release signing secrets.", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--create-key", action="store_true")
    parser.add_argument("--configure-github", metavar="OWNER/REPO")
    parser.add_argument("--gradle", default=shutil.which("gradle"))
    parser.add_argument("--sdk", type=Path, default=os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT"))
    parser.add_argument("--skip-frontend", action="store_true", help="Reuse an already synchronized device-mode frontend")
    parser.add_argument("--package-only", action="store_true", help="Verify and package an already completed signed release build")
    args = parser.parse_args()
    if not args.gradle or not args.sdk or not args.sdk.is_dir():
        parser.error("Supply --gradle and an existing --sdk (or use PATH and ANDROID_HOME).")
    env = signing_environment(args.create_key)
    env.update(ANDROID_HOME=str(args.sdk.resolve()), ANDROID_SDK_ROOT=str(args.sdk.resolve()),
               VAULT_MODE="device", NEXT_PUBLIC_VAULT_MODE="device", NEXT_PUBLIC_API_URL="", NEXT_TELEMETRY_DISABLED="1")
    if args.configure_github:
        configure_github(args.configure_github, env)
    if not args.skip_frontend and not args.package_only:
        npm = "npm.cmd" if os.name == "nt" else "npm"
        run([npm, "run", "lint"], cwd=ROOT / "frontend", env=env)
        run([npm, "run", "build:android"], cwd=ROOT / "frontend", env=env)
    config_path = ROOT / "android-app/app/src/main/assets/capacitor.config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    if config.get("plugins", {}).get("Vault", {}).get("apiUrl"):
        raise RuntimeError("Release APKs must use the native device vault.")
    if config.get("webDir") != ".next-android" or config.get("server", {}).get("url"):
        raise RuntimeError("Release APKs must bundle the current Android static export.")
    if not args.package_only:
        run([args.gradle, "--console=plain", "--no-daemon", ":app:testDebugUnitTest", ":app:lintRelease", ":app:assembleRelease"], cwd=ROOT / "android-app", env=env)
    output = ROOT / "android-app/app/build/outputs/apk/release"
    metadata = json.loads((output / "output-metadata.json").read_text(encoding="utf-8"))
    element = metadata["elements"][0]
    version = element["versionName"]
    if version != json.loads((ROOT / "frontend/package.json").read_text(encoding="utf-8"))["version"]:
        raise RuntimeError("Android and frontend release versions differ.")
    source = output / element["outputFile"]
    tools = args.sdk / "build-tools/36.0.0"
    signer = tools / ("apksigner.bat" if os.name == "nt" else "apksigner")
    aapt = tools / ("aapt.exe" if os.name == "nt" else "aapt")
    verified = run([signer, "verify", "--verbose", "--print-certs", source], env=env, capture=True).stdout
    badging = run([aapt, "dump", "badging", source], env=env, capture=True).stdout
    if "application-debuggable" in badging:
        raise RuntimeError("Refusing to distribute a debuggable release.")
    if "CN=Android Debug" in verified:
        raise RuntimeError("Refusing to distribute an Android debug-key release.")
    resources = run([aapt, "dump", "resources", source], env=env, capture=True).stdout
    if not re.search(r":xml/config(?:\s|:)", resources):
        raise RuntimeError("The release APK is missing its dynamically loaded Cordova xml/config resource.")
    with zipfile.ZipFile(source) as apk:
        packaged = json.loads(apk.read("assets/capacitor.config.json"))
        if packaged.get("plugins", {}).get("Vault", {}).get("apiUrl"):
            raise RuntimeError("Packaged APK unexpectedly uses a cloud backend.")
        for route in ("index.html", "files/index.html", "login/index.html", "register/index.html", "offline/index.html", "share/index.html"):
            if "assets/public/" + route not in apk.namelist():
                raise RuntimeError(f"The APK is missing its bundled {route} route.")
        exported = ROOT / "frontend/.next-android"
        if not exported.is_dir():
            raise RuntimeError("Build the Android static export before packaging the release.")
        for asset in exported.rglob("*"):
            if not asset.is_file():
                continue
            name = "assets/public/" + asset.relative_to(exported).as_posix()
            if name not in apk.namelist() or apk.read(name) != asset.read_bytes():
                raise RuntimeError(f"The APK contains a missing or stale frontend asset: {name}.")
        if "assets/index.html" in apk.namelist():
            raise RuntimeError("The APK contains the obsolete frontend bundle.")
    artifacts = ROOT / "artifacts"
    artifacts.mkdir(exist_ok=True)
    target = artifacts / f"CloudVault-v{version}.apk"
    shutil.copyfile(source, target)
    checksum = hashlib.sha256(target.read_bytes()).hexdigest()
    (artifacts / f"{target.name}.sha256").write_text(f"{checksum}  {target.name}\n", encoding="utf-8")
    fingerprint = re.search(r"certificate SHA-256 digest: ([a-f0-9]+)", verified)
    report = {
        "apk": target.name, "version": version, "version_code": element["versionCode"],
        "package": metadata["applicationId"], "mode": "device", "debuggable": False,
        "size_bytes": target.stat().st_size, "sha256": checksum,
        "signing_certificate_sha256": fingerprint.group(1) if fingerprint else None,
        "source_commit": run(["git", "rev-parse", "HEAD"], capture=True).stdout.strip(),
        "source_has_local_changes": bool(run(["git", "status", "--porcelain"], capture=True).stdout.strip()),
    }
    (artifacts / "android-release.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(verified, flush=True)
    print(f"Verified signed release: {target}\nSHA-256: {checksum}", flush=True)


if __name__ == "__main__":
    main()
