// Exercise the bundled React interface and real Android picker/camera/export flows.
// Run only on a dedicated CloudVaultVerification AVD with a debuggable WebView.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  sdk: { type: "string" }, serial: { type: "string" }, apk: { type: "string" },
  package: { type: "string", default: "com.cloudvault.app.debug" },
} });
assert(values.sdk && values.serial, "Supply --sdk and --serial.");
assert(["com.cloudvault.app", "com.cloudvault.app.debug"].includes(values.package));
const adb = path.join(values.sdk, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
const root = fileURLToPath(new URL("../../", import.meta.url));
const reportDir = path.join(root, "artifacts", values.serial, "ui-smoke");
mkdirSync(reportDir, { recursive: true });
const results = [];
const errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const command = (...args) => execFileSync(adb, ["-s", values.serial, ...args], { encoding: "utf8", timeout: 60000 });
const shell = (...args) => command("shell", ...args);
let socket;
let port;
let nextId = 0;
const pending = new Map();

function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 60000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function connect() {
  const pid = shell("pidof", values.package).trim();
  port = command("forward", "tcp:0", `localabstract:webview_devtools_remote_${pid}`).trim();
  let target;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === "page"); }
    catch { /* The WebView may still be starting. */ }
    if (target) break;
    await delay(500);
  }
  assert(target, "The WebView must be debuggable. Use the debug APK; never enable debugging in a release for this test.");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
    const request = pending.get(message.id);
    if (request) {
      clearTimeout(request.timer); pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
    }
  };
  await send("Runtime.enable");
}

async function disconnect() {
  socket?.close();
  if (port) command("forward", "--remove", `tcp:${port}`);
  port = null;
}

async function wait(expression, description, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (errors.length) throw new Error(`Uncaught JavaScript error: ${errors[0].exception?.description || errors[0].text}`);
    if (await evaluate(expression)) return;
    await delay(300);
  }
  writeFileSync(path.join(reportDir, "failure-page.txt"), await evaluate("document.body.innerText"));
  throw new Error(`Timed out: ${description}`);
}

const hasText = text => `document.body.innerText.indexOf(${JSON.stringify(text)}) !== -1`;
const waitText = text => wait(hasText(text), text);
async function click(selector, text) {
  const matches = text === undefined ? "true" : `(item.textContent.trim() === ${JSON.stringify(text)} || Array.from(item.children).some(function(child) { return child.textContent.trim() === ${JSON.stringify(text)}; }))`;
  const find = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(function (item) { return ${matches} && item.getClientRects().length && !item.disabled; })`;
  await wait(`!!(${find})`, `control ${text || selector}`);
  const expression = `(function () { var element = ${find}; element.click(); return true; })()`;
  await evaluate(expression);
  await delay(250);
}
async function fill(selector, value) {
  await evaluate(`(function () { var element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Missing input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await delay(100);
}
async function request(endpoint) {
  const reply = await evaluate(`window.Capacitor.Plugins.Vault.request({ endpoint: ${JSON.stringify(endpoint)}, method: 'GET' })`);
  assert.equal(reply.status, 200, JSON.stringify(reply));
  return reply.data;
}
async function step(name, operation) {
  console.log(name);
  await operation();
  results.push(name);
}

function nativeNodes() {
  command("shell", "uiautomator", "dump", "/sdcard/cloudvault-smoke-ui.xml");
  const xml = command("exec-out", "cat", "/sdcard/cloudvault-smoke-ui.xml");
  writeFileSync(path.join(reportDir, "native-ui.xml"), xml);
  const nodes = Array.from(xml.matchAll(/<node\b([^>]+)>?/g), match => Object.fromEntries(
    Array.from(match[1].matchAll(/([\w-]+)="([^"]*)"/g), attribute => [attribute[1], attribute[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")]),
  ));
  writeFileSync(path.join(reportDir, "native-nodes.json"), JSON.stringify(nodes, null, 2));
  return nodes;
}
function tap(node) {
  const bounds = Array.from(node.bounds.matchAll(/\d+/g), match => Number(match[0]));
  assert.equal(bounds.length, 4);
  shell("input", "tap", String(Math.round((bounds[0] + bounds[2]) / 2)), String(Math.round((bounds[1] + bounds[3]) / 2)));
}
async function nativeFind(predicate, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const node = nativeNodes().find(predicate);
    if (node) return node;
    await delay(300);
  }
  throw new Error("Native Android control was not found; inspect native-ui.xml.");
}
async function pick(filename) {
  await nativeFind(node => node.package === "com.android.documentsui");
  let nodes = nativeNodes();
  let file = nodes.find(node => node.text === filename);
  if (!file) {
    const roots = nodes.find(node => /Show roots|Open navigation drawer/i.test(node["content-desc"] || ""));
    if (roots) { tap(roots); await delay(400); }
    const downloads = await nativeFind(node => node.text === "Downloads");
    tap(downloads);
    file = await nativeFind(node => node.text === filename);
  }
  tap(file);
  await delay(1000);
}
async function fileAction(filename, action) {
  await click(`button[aria-label=${JSON.stringify(`Actions for ${filename}`)}]`);
  await click("button", action);
}
async function files() {
  await click('nav[aria-label="Quick navigation"] a[href^="/files"]');
  await waitText("My Files");
}
async function fixture(name, content) {
  const local = path.join(reportDir, name);
  writeFileSync(local, content);
  command("push", local, `/sdcard/Download/${name}`);
  shell("am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", `file:///sdcard/Download/${name}`);
}

const first = "CloudVault offline UI smoke fixture. Encrypted import and verified export.\n";
const second = "CloudVault immutable second revision.\n";
const email = "smoke@example.com";
const password = "VaultSmoke42!";
const filename = `offline-proof-${Date.now()}.txt`;
let fileId;
let folderId;
let failure;
let androidApi;
try {
  assert.equal(shell("getprop", "ro.kernel.qemu").trim(), "1", "Use a dedicated emulator, never a physical phone.");
  assert(command("emu", "avd", "name").startsWith("CloudVaultVerification"), "Use a dedicated CloudVaultVerification AVD.");
  androidApi = shell("getprop", "ro.build.version.sdk").trim();
  if (values.apk) command("install", "-r", "-t", path.resolve(values.apk));
  assert(shell("pm", "clear", values.package).includes("Success"));
  shell("svc", "wifi", "disable"); shell("svc", "data", "disable");
  shell("settings", "put", "system", "screen_off_timeout", "2147483647");
  shell("input", "keyevent", "KEYCODE_WAKEUP"); shell("wm", "dismiss-keyguard");
  command("logcat", "-c");
  shell("am", "start", "-W", "-n", `${values.package}/com.cloudvault.app.MainActivity`);
  await connect();
  await step("Offline startup and native bridge", async () => {
    await waitText("No internet needed.");
    assert.equal(await evaluate("navigator.onLine"), false);
    assert.equal(await evaluate("window.Capacitor.isNativePlatform()"), true);
  });
  await step("Local account registration and sign-in", async () => {
    await click('a[href^="/register"]'); await waitText("Create your account");
    await fill("#register-name", "Android Smoke"); await fill("#register-email", email);
    await fill("#register-password", password); await fill("#register-confirm-password", password);
    await click("button", "Create Free Account"); await waitText("On-device vault");
    assert.equal((await request("/api/auth/me")).email, email);
  });
  await step("Folder creation and navigation", async () => {
    await files(); await click("main button", "New Folder"); await fill("#new-folder-name", "Smoke folder");
    await click("button", "Create Folder"); await waitText("Smoke folder");
    folderId = (await request("/api/folders")).find(item => item.name === "Smoke folder").id;
    await click("button", "Smoke folder");
    await wait(`location.search.indexOf(${JSON.stringify(folderId)}) !== -1`, "folder navigation");
  });
  await step("Android document picker and offline background import", async () => {
    await fixture("cloudvault-smoke.txt", first);
    await click("main button", "Upload File"); await click("button", "Choose files"); await pick("cloudvault-smoke.txt");
    await waitText("Saved to device vault"); await click("button", "Done"); await waitText("cloudvault-smoke.txt");
    const file = (await request(`/api/files?folder_id=${folderId}`)).items.find(item => item.original_filename === "cloudvault-smoke.txt");
    assert.equal(file.checksum, createHash("sha256").update(first).digest("hex")); fileId = file.id;
  });
  await step("File rename and isolated text preview", async () => {
    await fileAction("cloudvault-smoke.txt", "Rename"); await fill("#organize-name", filename);
    await click('form[role="dialog"] button[type="submit"]'); await waitText(filename);
    await click("button", filename); await waitText(first.trim());
  });
  await step("Android Save to device and byte-exact export", async () => {
    await click('button[aria-label="Download file"]');
    tap(await nativeFind(node => node.text.toLowerCase() === "save" && node.enabled === "true"));
    // Creating the destination precedes the asynchronous encrypted-file export.
    // Verify the bytes of this run's unique destination rather than a fixed delay.
    const deadline = Date.now() + 30000;
    let exported;
    while (Date.now() < deadline) {
      try { exported = command("exec-out", "cat", `/sdcard/Download/${filename}`); }
      catch { /* DocumentsUI may not have created the destination yet. */ }
      if (exported === first) break;
      await delay(300);
    }
    assert.equal(exported, first, "The completed export must match the original bytes");
    await click('button[aria-label="Close file preview"]');
  });
  await step("Native new-version import and immutable version history", async () => {
    await fixture("cloudvault-version.txt", second);
    await fileAction(filename, "Version History"); await click("button", "Upload New Version");
    await click("button", "Choose files"); await pick("cloudvault-version.txt");
    await waitText("Saved to device vault");
    await wait(`window.Capacitor.Plugins.Vault.request({endpoint:${JSON.stringify(`/api/files/${fileId}`)},method:'GET'}).then(function(r){return r.data.current_version===2;})`, "second version import");
    await click("button", "Done");
    assert.equal((await request(`/api/files/${fileId}/versions`)).length, 2);
  });
  await step("Version rollback with Android confirmation", async () => {
    const confirming = click('button[aria-label="Restore version 1"]');
    tap(await nativeFind(node => node.text.toLowerCase() === "ok"));
    await confirming;
    await wait(`window.Capacitor.Plugins.Vault.request({endpoint:${JSON.stringify(`/api/files/${fileId}`)},method:'GET'}).then(function(r){return r.data.current_version===1;})`, "version rollback");
    await click("button", "Close");
    assert.equal((await request(`/api/files/${fileId}/versions`)).length, 2);
  });
  await step("Android share chooser", async () => {
    await fileAction(filename, "Share"); await click("button", "Share with Android");
    await nativeFind(node => node.package === "android" && node["resource-id"] === "android:id/content_preview_filename" && node.text === filename);
    shell("input", "keyevent", "KEYCODE_BACK");
    await click('button[aria-label="Close sharing dialog"]');
  });
  await step("Camera permission, emulated capture and encrypted photo import", async () => {
    await click("main button", "Upload File"); await click("button", "Take photo");
    for (let attempt = 0; attempt < 12; attempt++) {
      const nodes = nativeNodes();
      const allow = nodes.find(node => /permission_allow_foreground_only_button|permission_allow_button/.test(node["resource-id"] || ""));
      if (allow) { tap(allow); await delay(600); continue; }
      const dismiss = nodes.find(node => /^(Got it|No thanks)$/i.test(node.text));
      if (dismiss) { tap(dismiss); await delay(600); continue; }
      const shutter = nodes.find(node => /shutter/i.test(`${node["resource-id"]} ${node["content-desc"]}`) && node.enabled === "true");
      if (shutter) { tap(shutter); break; }
      await delay(500);
    }
    tap(await nativeFind(node => /done|confirm|review_done/i.test(`${node["content-desc"]} ${node["resource-id"]}`) && node.enabled === "true"));
    await wait(`window.Capacitor.Plugins.Vault.request({endpoint:${JSON.stringify(`/api/files?folder_id=${folderId}`)},method:'GET'}).then(function(r){return r.data.items.some(function(f){return f.mime_type==='image/jpeg';});})`, "camera import");
    await click("button", "Done");
    const photo = (await request(`/api/files?folder_id=${folderId}`)).items.find(item => item.mime_type === "image/jpeg");
    await waitText(photo.original_filename); await click("button", photo.original_filename);
    await wait("Array.from(document.querySelectorAll('[role=dialog] img')).some(function(image){return image.complete && image.naturalWidth>0;})", "photo preview");
    await click('button[aria-label="Close file preview"]');
  });
  await step("Trash and file recovery", async () => {
    await fileAction(filename, "Move to Trash");
    await click('button[aria-label="Open navigation menu"]'); await click('#mobile-navigation-drawer a[href^="/trash"]');
    await waitText("Trash & Recovery"); await waitText(filename); await click("button", "Restore");
    await files(); await click("button", "Smoke folder"); await waitText(filename);
  });
  await step("Process-death recovery and persistent encrypted library", async () => {
    await disconnect(); shell("am", "force-stop", values.package);
    shell("am", "start", "-W", "-n", `${values.package}/com.cloudvault.app.MainActivity`); await connect();
    await waitText("On-device vault"); await files(); await waitText("Smoke folder");
    await click("button", "Smoke folder"); await waitText(filename);
    assert.equal((await request(`/api/files/${fileId}`)).checksum, createHash("sha256").update(first).digest("hex"));
  });
  await step("Logout, restart, and offline account unlock", async () => {
    await click('button[aria-label="Open account menu"]'); await click("button", "Sign Out"); await waitText("Welcome back");
    await disconnect(); shell("am", "force-stop", values.package);
    shell("am", "start", "-W", "-n", `${values.package}/com.cloudvault.app.MainActivity`); await connect(); await waitText("Welcome back");
    await fill("#email", email); await fill("#password", password); await click("button", "Sign In to Vault");
    await waitText("On-device vault"); assert.equal((await request(`/api/files/${fileId}`)).current_version, 1);
    assert.equal(await evaluate("navigator.onLine"), false);
  });
  assert.deepEqual(errors, [], "Uncaught JavaScript exceptions occurred.");
  console.log(`OK (${results.length} Android UI smoke checks)`);
} catch (error) {
  failure = error;
  try {
    writeFileSync(path.join(reportDir, "failure-page.txt"), await evaluate("document.body.innerText"));
    writeFileSync(path.join(reportDir, "failure-dom.json"), JSON.stringify(await evaluate("({url:location.href,buttons:Array.from(document.querySelectorAll('button,a,input')).map(function(element){return {tag:element.tagName,text:element.textContent.trim(),label:element.getAttribute('aria-label'),id:element.id,type:element.type,visible:!!element.getClientRects().length,disabled:element.disabled};})})"), null, 2));
  } catch { /* The original error is more useful if Android/CDP has disconnected. */ }
  throw error;
} finally {
  writeFileSync(path.join(reportDir, "results.json"), JSON.stringify({ package: values.package, api: androidApi, success: !failure, failure: failure?.message, passed: results, javascript_errors: errors }, null, 2) + "\n");
  try { writeFileSync(path.join(reportDir, "logcat.txt"), command("logcat", "-d")); } catch { /* Retain the original failure if the emulator disconnected. */ }
  try { await disconnect(); } catch { /* A disconnected emulator has already removed its forwarding. */ }
}
