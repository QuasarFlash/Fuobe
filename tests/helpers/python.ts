import { execFileSync, spawnSync, type ExecFileSyncOptions } from "node:child_process";

/**
 * A Python 3 for tests that run the repo's Python scripts: FUOBE_TEST_PYTHON, else python3, else python, else the
 * Windows launcher (py -3). Each is tried for real, since on Windows python3 and python can be Store stubs that only
 * print an install hint. Null when none runs; tests that need one skip then (CI's runner has python3).
 */
function find(): { cmd: string; args: string[] } | null {
  const tries: [string, string[]][] = [
    ...(process.env.FUOBE_TEST_PYTHON ? [[process.env.FUOBE_TEST_PYTHON, []] as [string, string[]]] : []),
    ["python3", []],
    ["python", []],
    ...(process.platform === "win32" ? [["py", ["-3"]] as [string, string[]]] : []),
  ];
  for (const [cmd, args] of tries) {
    const r = spawnSync(cmd, [...args, "-c", "import sys; assert sys.version_info >= (3, 9)"], { encoding: "utf8", timeout: 20_000 });
    if (r.status === 0) return { cmd, args };
  }
  return null;
}

export const python = find();

/**
 * Runs a Python script (as execFileSync does: throws on a non-zero exit, returns stdout). In UTF-8 mode, so what it
 * prints (→, ×) doesn't fail on a Windows console's code page.
 */
export function runPython(args: string[], options: ExecFileSyncOptions = {}): Buffer {
  if (!python) throw new Error("no Python 3 found");
  return execFileSync(python.cmd, [...python.args, ...args], { ...options, env: { ...(options.env ?? process.env), PYTHONUTF8: "1" }, encoding: "buffer" }) as Buffer;
}
