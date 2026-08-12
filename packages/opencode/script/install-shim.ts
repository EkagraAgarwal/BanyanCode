/**
 * Generates the runtime JS shim shipped as `bin/banyancode.js` inside the
 * umbrella `banyancode` npm package. `publish.ts` calls `shimScript(binaries)`
 * at publish time and writes the result once — the content is identical across
 * all 11 CI platform jobs, keeping the tarball platform-invariant.
 *
 * The shim is the actual bin entry (`bin: { banyancode: "./bin/banyancode.js" }`).
 * It resolves the correct platform package (`banyancode-<platform>-<arch>
 * [-baseline][-musl]` from `optionalDependencies`) at first run and spawns the
 * real CLI, so the command works even when `postinstall.mjs` never runs
 * (npm 11 allow-scripts default-deny, `--ignore-scripts`, bun global installs,
 * pnpm's no-build default). The postinstall script is best-effort: when it
 * runs it copies the native binary to `bin/banyancode.exe`, which the shim
 * treats as a magic-checked fast path.
 *
 * The generated file is plain CommonJS running under node, zero deps beyond
 * node builtins, and starts with an esbuild-style polyglot header so it also
 * executes correctly when the kernel/shell dispatches it directly.
 */
export function shimScript(binaries: Record<string, string>): string {
  const entries = Object.entries(binaries)
    .map(([name, version]) => `  ${JSON.stringify(name)}: ${JSON.stringify(version)}`)
    .join(",\n")

  return `#!/bin/sh
':' //; exec "$(command -v nodejs || command -v node || echo node)" "$0" "$@"
"use strict";
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Native platform packages that provide the banyancode binary (name -> version).
const PACKAGES = {
${entries}
};
const PACKAGE_NAMES = Object.keys(PACKAGES);

const platformMap = { darwin: "darwin", linux: "linux", win32: "windows" };
const archMap = { x64: "x64", arm64: "arm64", arm: "arm" };
const platform = platformMap[os.platform()] || os.platform();
const arch = archMap[os.arch()] || os.arch();
const base = "banyancode-" + platform + "-" + arch;
const binaryName = platform === "windows" ? "banyancode.exe" : "banyancode";
const shimDir = __dirname;

function supportsAvx2() {
  if (arch !== "x64") return false;

  if (platform === "linux") {
    try {
      return /(^|\\s)avx2(\\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"));
    } catch {
      return false;
    }
  }

  if (platform === "darwin") {
    try {
      const result = childProcess.spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], {
        encoding: "utf8",
        timeout: 1500,
      });
      if (result.status !== 0) return false;
      return (result.stdout || "").trim() === "1";
    } catch {
      return false;
    }
  }

  if (platform === "windows") {
    const command =
      '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)';

    for (const executable of ["powershell.exe", "pwsh.exe", "pwsh", "powershell"]) {
      try {
        const result = childProcess.spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
          encoding: "utf8",
          timeout: 3000,
          windowsHide: true,
        });
        if (result.status !== 0) continue;
        const output = (result.stdout || "").trim().toLowerCase();
        if (output === "true" || output === "1") return true;
        if (output === "false" || output === "0") return false;
      } catch {
        continue;
      }
    }
  }

  return false;
}

function isMusl() {
  if (platform !== "linux") return false;

  try {
    if (fs.existsSync("/etc/alpine-release")) return true;
  } catch {
    // Ignore filesystem probes that are blocked by the host.
  }

  try {
    const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" });
    return (result.stdout + result.stderr).toLowerCase().includes("musl");
  } catch {
    return false;
  }
}

// Candidate platform-package names in priority order, mirroring postinstall.mjs.
function candidates() {
  const baseline = arch === "x64" && !supportsAvx2();
  let names = [];

  if (platform === "linux") {
    if (isMusl()) {
      if (arch === "x64")
        names = baseline
          ? [base + "-baseline-musl", base + "-musl", base + "-baseline", base]
          : [base + "-musl", base + "-baseline-musl", base, base + "-baseline"];
      else names = [base + "-musl", base];
    } else if (arch === "x64") {
      names = baseline
        ? [base + "-baseline", base, base + "-baseline-musl", base + "-musl"]
        : [base, base + "-baseline", base + "-musl", base + "-baseline-musl"];
    } else {
      names = [base, base + "-musl"];
    }
  } else if (arch === "x64") {
    names = baseline ? [base + "-baseline", base] : [base, base + "-baseline"];
  } else {
    names = [base];
  }

  return Array.from(new Set(names)).filter(function (name) {
    return PACKAGE_NAMES.indexOf(name) !== -1;
  });
}

function readNativeMagic(file) {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf;
  } catch {
    return null;
  }
}

// Only spawn the postinstall-copied local binary if it is a NATIVE executable
// (ELF or MZ magic). A stale text placeholder from an old version must fall
// through to platform-package resolution instead of being executed.
function isNativeExecutable(file) {
  if (!fs.existsSync(file)) return false;
  const magic = readNativeMagic(file);
  if (!magic) return false;
  return (
    (magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46) ||
    (magic[0] === 0x4d && magic[1] === 0x5a)
  );
}

function resolvePlatformBinary(name) {
  try {
    const packageJsonPath = require.resolve(name + "/package.json");
    const binPath = path.join(path.dirname(packageJsonPath), "bin", binaryName);
    return fs.existsSync(binPath) ? binPath : null;
  } catch {
    return null;
  }
}

// Spawn a binary with our argv (minus the shim itself) attached to our
// stdio. On success the child owns stdout/stderr for the lifetime of the
// process; when it exits we forward the exit code (or re-raise the signal).
// Resolves false only when the spawn itself fails, so the caller can try the
// next candidate.
function trySpawn(binPath, args) {
  return new Promise(function (resolve) {
    let child;
    try {
      child = childProcess.spawn(binPath, args, { stdio: "inherit" });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    child.on("error", function () {
      if (settled) return;
      settled = true;
      resolve(false);
    });
    child.on("exit", function (code, signal) {
      if (settled) return;
      settled = true;
      if (signal) {
        try {
          process.kill(process.pid, signal);
        } catch {
          process.exit(1);
        }
        return;
      }
      process.exit(code === null ? 1 : code);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);

  // Fast path: postinstall copied a native binary here.
  const fastPath = path.join(shimDir, "bin", "banyancode.exe");
  if (isNativeExecutable(fastPath)) {
    if (await trySpawn(fastPath, args)) return;
  }

  for (const name of candidates()) {
    const binPath = resolvePlatformBinary(name);
    if (binPath) {
      if (await trySpawn(binPath, args)) return;
      continue;
    }

    // Temp-install fallback: fetch the platform package directly.
    const version = PACKAGES[name];
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "banyancode-shim-"));
    const result = childProcess.spawnSync(
      "npm",
      ["install", "--ignore-scripts", "--no-save", "--loglevel=error", "--prefix", temp, name + "@" + version],
      { stdio: "ignore", windowsHide: true },
    );
    if (result.status === 0) {
      const installed = path.join(temp, "node_modules", name, "bin", binaryName);
      if (fs.existsSync(installed) && (await trySpawn(installed, args))) return;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }

  console.error(
    "banyancode: could not find or run a native banyancode binary.\\n" +
      "The postinstall script was not run (npm 11 allow-scripts default-deny, --ignore-scripts,\\n" +
      "bun global installs, or pnpm's no-build default), and no platform package was available.\\n" +
      "\\n" +
      "npm 11+ remedies:\\n" +
      "  npm install -g --allow-scripts=banyancode banyancode\\n" +
      "  npm config set allow-scripts=banyancode --location=user   (then reinstall)\\n" +
      "pnpm remedies:\\n" +
      "  pnpm approve-builds   (or add banyancode to onlyBuiltDependencies)\\n" +
      "Manual fix for an existing install:\\n" +
      "  cd node_modules/banyancode && node postinstall.mjs\\n",
  );
  process.exit(1);
}

main().catch(function (error) {
  console.error("banyancode: unexpected shim failure: " + (error && error.message ? error.message : String(error)));
  process.exit(1);
});
`
}
