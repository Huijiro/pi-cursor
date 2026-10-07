import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist/index.js");
if (existsSync(dist)) process.exit(0);

const win = process.platform === "win32";
const pathSep = win ? ";" : ":";
const localTsup = join(root, "node_modules", ".bin", win ? "tsup.cmd" : "tsup");

/** Matches package.json; keep these in sync when bumping the local toolchain. */
const TOOLCHAIN = ["typescript@^6.0.3", "tsup@^8.5.0"];

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: root,
    shell: win,
    ...opts,
  });
  return result.status ?? 1;
}

function ensureBuilt(tsupBin, env) {
  const status = run(tsupBin, [], env ? { env } : {});
  if (status !== 0) return status;
  if (!existsSync(dist)) {
    console.error("[pi-cursor] prepare: tsup exited 0 but dist/index.js is missing");
    return 1;
  }
  return 0;
}

if (existsSync(localTsup)) {
  process.exit(ensureBuilt(localTsup));
}

// Pi installs packages with `npm install --omit=dev`, so tsup/typescript are absent on
// git installs. Bootstrap a disposable toolchain and link it into node_modules long
// enough for tsup.config.ts to resolve the `tsup` package.
const tools = mkdtempSync(join(tmpdir(), "pi-cursor-prepare-"));
const linked = [];
try {
  const installStatus = run(win ? "npm.cmd" : "npm", [
    "install",
    "--prefix",
    tools,
    "--no-fund",
    "--no-audit",
    ...TOOLCHAIN,
  ]);
  if (installStatus !== 0) {
    console.error(
      "[pi-cursor] prepare: could not install a temporary TypeScript build toolchain.\n" +
        "Git installs under --omit=dev (e.g. `pi install git:...`) need network access for this step.\n" +
        "Workaround: npm install --include=dev && npm run build",
    );
    process.exit(installStatus);
  }

  const nm = join(root, "node_modules");
  mkdirSync(nm, { recursive: true });
  for (const pkg of ["typescript", "tsup", "esbuild"]) {
    const target = join(tools, "node_modules", pkg);
    const link = join(nm, pkg);
    if (!existsSync(target) || existsSync(link)) continue;
    symlinkSync(target, link, win ? "junction" : "dir");
    linked.push(link);
  }

  const tsupBin = join(tools, "node_modules", ".bin", win ? "tsup.cmd" : "tsup");
  if (!existsSync(tsupBin)) {
    console.error(`[pi-cursor] prepare: temporary tsup binary missing at ${tsupBin}`);
    process.exit(1);
  }

  process.exit(
    ensureBuilt(tsupBin, {
      ...process.env,
      PATH: `${join(tools, "node_modules", ".bin")}${pathSep}${process.env.PATH ?? ""}`,
    }),
  );
} finally {
  for (const link of linked) {
    try {
      rmSync(link, { force: true, recursive: true });
    } catch {
      // Best-effort cleanup of temporary resolution links.
    }
  }
  rmSync(tools, { recursive: true, force: true });
}
