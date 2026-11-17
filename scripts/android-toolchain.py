"""Bootstrap a checksum-verified Windows Android toolchain outside the repository.

Usage: py -3.12 scripts/android-toolchain.py --root <existing-parent>/android-toolchain [--emulator]
The SDK manager prompts are answered to accept the Android SDK licenses required to build.
"""

import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
import xml.etree.ElementTree as ET
import zipfile


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read()


def download(url: str, target: Path, checksum: str, algorithm: str = "sha256"):
    if target.exists() and hashlib.new(algorithm, target.read_bytes()).hexdigest() == checksum:
        return
    print(f"Downloading {target.name}", flush=True)
    with urllib.request.urlopen(url, timeout=90) as response, target.open("wb") as output:
        shutil.copyfileobj(response, output, length=1024 * 1024)
    if hashlib.new(algorithm, target.read_bytes()).hexdigest() != checksum:
        target.unlink()
        raise RuntimeError(f"Checksum mismatch: {target.name}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--emulator", action="store_true")
    parser.add_argument("--sdk-root", type=Path, help="Reuse an existing Android SDK")
    parser.add_argument("--gradle-only", action="store_true", help="Install only Gradle; leave an existing SDK untouched")
    args = parser.parse_args()
    root = args.root.resolve()
    if not root.parent.is_dir():
        parser.error("The toolchain's parent directory must already exist.")
    if sys.platform != "win32":
        parser.error("This bootstrap is for Windows; Linux CI uses android-actions/setup-android.")
    root.mkdir(exist_ok=True)
    sdk = args.sdk_root.resolve() if args.sdk_root else root / "sdk"
    # Pin the Java-based tools, including support for API 37's minor-version packages.
    current_tools = sdk / "cmdline-tools" / "22.0"
    manager = current_tools / "bin" / "sdkmanager.bat"
    if not manager.exists() and not args.gradle_only:
        repository = ET.fromstring(fetch("https://dl.google.com/android/repository/repository2-1.xml"))
        candidates = []
        for package in repository.findall(".//{*}remotePackage"):
            if package.get("path") != "cmdline-tools;22.0":
                continue
            channel = package.find("{*}channelRef")
            if channel is not None and channel.get("ref") != "channel-0":
                continue
            revision = int(package.findtext("{*}revision/{*}major", "0"))
            for archive in package.findall("{*}archives/{*}archive"):
                if archive.findtext("{*}host-os") == "windows":
                    candidates.append((revision, archive.find("{*}complete")))
        if not candidates:
            raise RuntimeError("Google's SDK repository did not list Windows command-line tools.")
        _, archive = max(candidates, key=lambda item: item[0])
        checksum_node = archive.find("{*}checksum")
        url = "https://dl.google.com/android/repository/" + archive.findtext("{*}url")
        tools_zip = root / "commandline-tools.zip"
        download(url, tools_zip, checksum_node.text, checksum_node.get("type", "sha1"))
        unpack = root / "commandline-unpack"
        with zipfile.ZipFile(tools_zip) as zipped:
            zipped.extractall(unpack)
        manager.parent.parent.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(unpack / "cmdline-tools"), str(manager.parent.parent))
        shutil.rmtree(unpack)

    env = dict(os.environ, ANDROID_HOME=str(sdk), ANDROID_SDK_ROOT=str(sdk))
    java = shutil.which("java")
    if java and not env.get("JAVA_HOME"):
        env["JAVA_HOME"] = str(Path(java).resolve().parent.parent)
    if not args.gradle_only:
        print("Accepting Android build tool licenses", flush=True)
        subprocess.run([str(manager), f"--sdk_root={sdk}", "--licenses"], input="y\n" * 100, text=True, env=env, check=True)
        packages = ["platform-tools", "platforms;android-37.0", "build-tools;36.0.0"]
        if args.emulator:
            packages.extend(["emulator", "system-images;android-36;google_apis;x86_64"])
        subprocess.run([str(manager), f"--sdk_root={sdk}", *packages], input="y\n" * 100, text=True, env=env, check=True)

    gradle_version = "9.3.1"
    gradle = root / f"gradle-{gradle_version}"
    if not gradle.exists():
        url = f"https://downloads.gradle.org/distributions/gradle-{gradle_version}-bin.zip"
        checksum = fetch(url + ".sha256").decode().strip()
        archive = root / "gradle.zip"
        download(url, archive, checksum)
        with zipfile.ZipFile(archive) as zipped:
            zipped.extractall(root)
    print(f"ANDROID_HOME={sdk}", flush=True)
    print(f"GRADLE={gradle / 'bin' / 'gradle.bat'}", flush=True)


if __name__ == "__main__":
    main()
