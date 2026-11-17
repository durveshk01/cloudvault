"""Run native instrumentation or offline UI smoke checks on a dedicated emulator."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import time


ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk", type=Path, required=True)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--avd", help="Start and stop this dedicated test AVD")
    parser.add_argument("--ui-smoke", action="store_true", help="Run the bundled frontend/native UI smoke checks instead of instrumentation")
    parser.add_argument("--apk", type=Path, help="APK to install for UI smoke checks")
    parser.add_argument("--package", default="com.cloudvault.app.debug", help="UI smoke application ID")
    args = parser.parse_args()
    adb = args.sdk / "platform-tools" / ("adb.exe" if os.name == "nt" else "adb")
    report_dir = ROOT / "artifacts" / args.serial
    report_dir.mkdir(parents=True, exist_ok=True)
    emulator = None
    log = None

    def command(*parts, timeout=120, check=True):
        return subprocess.run([str(adb), "-s", args.serial, *map(str, parts)], capture_output=True, encoding="utf-8", errors="replace", timeout=timeout, check=check)

    try:
        if args.avd:
            if not args.serial.startswith("emulator-"):
                parser.error("An AVD needs an emulator-NNNN serial.")
            log = (report_dir / "emulator.log").open("w", encoding="utf-8")
            binary = args.sdk / "emulator" / ("emulator.exe" if os.name == "nt" else "emulator")
            env = dict(os.environ, ANDROID_HOME=str(args.sdk), ANDROID_SDK_ROOT=str(args.sdk))
            emulator = subprocess.Popen([str(binary), "-avd", args.avd, "-port", args.serial.split("-")[1], "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot", "-gpu", "swiftshader", "-memory", "1536", "-feature", "-Vulkan"], env=env, stdout=log, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                if command("shell", "getprop", "sys.boot_completed", timeout=10, check=False).stdout.strip() == "1":
                    break
                if emulator.poll() is not None:
                    raise RuntimeError(f"The emulator exited. See {report_dir / 'emulator.log'}.")
                time.sleep(2)
            else:
                raise RuntimeError("Android did not finish booting.")
        api = command("shell", "getprop", "ro.build.version.sdk").stdout.strip()
        print(f"Testing {args.serial}: Android API {api}", flush=True)
        command("shell", "settings", "put", "global", "window_animation_scale", "0")
        command("shell", "settings", "put", "global", "transition_animation_scale", "0")
        command("shell", "settings", "put", "global", "animator_duration_scale", "0")
        if args.ui_smoke:
            node = shutil.which("node")
            if not node:
                raise RuntimeError("UI smoke checks require Node.js 22 or newer.")
            smoke = [node, str(ROOT / "frontend/scripts/android-smoke.mjs"), "--sdk", str(args.sdk), "--serial", args.serial, "--package", args.package]
            if args.apk:
                smoke.extend(["--apk", str(args.apk.resolve())])
            subprocess.run(smoke, cwd=ROOT, check=True, timeout=600)
            return
        for apk in ("debug/app-debug.apk", "androidTest/debug/app-debug-androidTest.apk"):
            print(command("install", "-r", "-t", ROOT / "android-app/app/build/outputs/apk" / apk).stdout.strip(), flush=True)
        command("logcat", "-c")
        result = command("shell", "am", "instrument", "-w", "-r", "com.cloudvault.app.debug.test/androidx.test.runner.AndroidJUnitRunner", timeout=300, check=False)
        text = result.stdout + result.stderr
        (report_dir / "instrumentation.txt").write_text(text, encoding="utf-8")
        (report_dir / "instrumentation-logcat.txt").write_text(command("logcat", "-d", timeout=30).stdout, encoding="utf-8")
        print(text, flush=True)
        if result.returncode or "FAILURES!!!" in text or "INSTRUMENTATION_FAILED" in text or "OK (" not in text:
            raise RuntimeError(f"Native instrumentation failed. See {report_dir}.")
    finally:
        if emulator:
            command("emu", "kill", timeout=15, check=False)
            try:
                emulator.wait(timeout=30)
            except subprocess.TimeoutExpired:
                emulator.terminate()
        if log:
            log.close()


if __name__ == "__main__":
    main()
