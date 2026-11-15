import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkDsh,
  ensureNodeConfig,
  installQuestions,
  installService,
  needsNodeConfig,
  optionalInstallQuestions,
  planInstall,
  promptForInstall,
  renderUnit,
  resolveEnvironment,
  systemdQuote,
  type CommandRunner,
  type InstallEnvironment,
  type InstallOptions,
  type PromptQuestion,
} from "../src/install.ts";
import { isInteractiveInvocation, main, parseArguments } from "../src/orca-pod.ts";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orca-install-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

function environment(root: string): InstallEnvironment {
  return {
    home: join(root, "home"),
    nodeBin: "/usr/bin/node",
    packageEntry: "/opt/orca-pod/src/cli.ts",
    dshBin: "/usr/local/bin/dsh",
  };
}

function hostOptions(overrides: Partial<InstallOptions> = {}): InstallOptions {
  return {
    workgroupId: "lab",
    password: "lab-secret",
    dataRoot: "/srv/orca-pod",
    port: 11811,
    ...overrides,
  };
}

describe("install plan", () => {
  it("plans a user service that runs the host node", () => {
    const env = environment("/home/u");
    const plan = planInstall(hostOptions({ dataRoot: "/srv/orca-pod" }), env);
    expect(plan.unitPath).toBe(join(env.home, ".config", "systemd", "user", "orca-pod.service"));
    expect(plan.configPath).toBe(join("/srv/orca-pod", "config.json"));
    expect(plan.execStart).toEqual([
      "/usr/bin/node",
      "/opt/orca-pod/src/cli.ts",
      "serve",
      "--config",
      join("/srv/orca-pod", "config.json"),
    ]);
    expect(plan.commands).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "orca-pod"],
    ]);
    const unit = renderUnit(plan);
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("WorkingDirectory=/srv/orca-pod");
    expect(unit).toContain("Environment=NODE_ENV=production");
    expect(unit).toContain(`ExecStart=${plan.execStart.map(systemdQuote).join(" ")}`);
  });

  it("joins the given peers from the service unit", () => {
    const env = environment("/home/u");
    const dataRoot = "/srv/orca-pod";
    const plan = planInstall(
      hostOptions({
        dataRoot,
        peers: ["http://192.168.86.152:11811", "http://192.168.86.252:11811"],
      }),
      env,
    );
    expect(plan.execStart).toEqual([
      "/usr/bin/node",
      "/opt/orca-pod/src/cli.ts",
      "serve",
      "--config",
      join(dataRoot, "config.json"),
      "--peer",
      "http://192.168.86.152:11811",
      "--peer",
      "http://192.168.86.252:11811",
    ]);
    expect(renderUnit(plan)).toContain("ExecStart=");
  });

  it("plans a system service under /etc/systemd/system", () => {
    const plan = planInstall(hostOptions({ system: true, serviceName: "org.example.orca" }), environment("/home/u"));
    expect(plan.unitPath).toBe(join("/etc/systemd/system", "org.example.orca.service"));
    expect(plan.commands).toEqual([
      ["systemctl", "daemon-reload"],
      ["systemctl", "enable", "--now", "org.example.orca"],
    ]);
    expect(renderUnit(plan)).toContain("WantedBy=multi-user.target");
  });

  it("quotes argv entries systemd would split", () => {
    expect(systemdQuote("/usr/bin/node")).toBe("/usr/bin/node");
    expect(systemdQuote("/opt/my node/cli.ts")).toBe('"/opt/my node/cli.ts"');
    expect(systemdQuote('a"b')).toBe('"a\\"b"');
  });

  it("resolves node and entry defaults from the environment", () => {
    const env = resolveEnvironment({ home: "/home/u", packageEntry: "/pkg/cli.ts" });
    expect(env.home).toBe("/home/u");
    expect(env.nodeBin).toBe(process.execPath);
    expect(env.dshBin).toBe("dsh");
    expect(env.packageEntry).toBe("/pkg/cli.ts");
  });
});

describe("dsh check", () => {
  it("reports the version from a successful run", () => {
    const run: CommandRunner = () => ({ ok: true, stdout: "0.4.2\n", stderr: "" });
    expect(checkDsh("dsh", run)).toEqual({ ok: true, version: "0.4.2" });
  });

  it("explains a failing or missing dsh", () => {
    const failing: CommandRunner = () => ({ ok: false, stdout: "", stderr: "not found" });
    expect(checkDsh("dsh", failing)).toMatchObject({ ok: false });
    expect(checkDsh("dsh", failing).message).toContain("not found");
    const throwing: CommandRunner = () => {
      throw new Error("ENOENT");
    };
    expect(checkDsh("dsh", throwing)).toMatchObject({ ok: false });
    expect(checkDsh("dsh", throwing).message).toContain("ENOENT");
  });
});

describe("host config", () => {
  it("creates a config once and keeps the identity on re-runs", async () => {
    const root = await tempRoot();
    const plan = planInstall(hostOptions({ dataRoot: root }), environment(root));
    const first = await ensureNodeConfig(plan, hostOptions({ dataRoot: root }));
    expect(first.created).toBe(true);
    const config = JSON.parse(await readFile(plan.configPath, "utf8")) as Record<string, unknown>;
    expect(config["workgroup_id"]).toBe("lab");
    expect(config["executor"]).toBe("acp");
    expect(config["bind"]).toEqual({ host: "::", port: 11811 });
    expect(typeof config["orca_node_id"]).toBe("string");
    const nodeId = config["orca_node_id"];

    const second = await ensureNodeConfig(plan, hostOptions({ dataRoot: root }));
    expect(second.created).toBe(false);
    const again = JSON.parse(await readFile(plan.configPath, "utf8")) as Record<string, unknown>;
    expect(again["orca_node_id"]).toBe(nodeId);
    await expect(access(plan.configPath)).resolves.toBeUndefined();
    const mode = (await stat(plan.configPath)).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });

  it("requires a workgroup and password before creating a host config", async () => {
    const root = await tempRoot();
    const plan = planInstall(hostOptions({ dataRoot: root }), environment(root));
    await expect(ensureNodeConfig(plan, { dataRoot: root })).rejects.toThrow(/workgroup/);
  });
});

describe("interactive setup", () => {
  it("asks only when a fresh config has to be written", () => {
    const root = "/srv/orca-pod";
    const plan = planInstall(hostOptions({ dataRoot: root }), environment("/home/u"));
    const fresh = installQuestions(plan, { dataRoot: root }, () => false);
    expect(fresh.map((question) => question.option)).toEqual(["workgroup", "password"]);
    expect(fresh.find((question) => question.option === "password")?.secret).toBe(true);
    expect(optionalInstallQuestions({ dataRoot: root }).map((question) => question.option)).toEqual(["bind-host", "port"]);
    expect(installQuestions(plan, hostOptions({ dataRoot: root }), () => true)).toEqual([]);
    expect(needsNodeConfig(plan, hostOptions({ dataRoot: root }), () => true)).toBe(false);
    expect(needsNodeConfig(plan, hostOptions({ dataRoot: root, force: true }), () => true)).toBe(true);
  });

  it("fills the answers into the options object", async () => {
    const root = "/srv/orca-pod";
    const plan = planInstall(hostOptions({ dataRoot: root }), environment("/home/u"));
    const answers: Record<string, string> = {
      workgroup: "home",
      password: "home-secret",
      "bind-host": "127.0.0.1",
      port: "11900",
    };
    const prompt = async (question: PromptQuestion): Promise<string> => answers[question.option] ?? "";
    const options = await promptForInstall(plan, { dataRoot: root }, prompt, () => false);
    expect(options.workgroupId).toBe("home");
    expect(options.password).toBe("home-secret");
    expect(options.bindHost).toBe("127.0.0.1");
    expect(options.port).toBe(11900);
  });

  it("rejects an invalid port answer", async () => {
    const root = "/srv/orca-pod";
    const plan = planInstall(hostOptions({ dataRoot: root }), environment("/home/u"));
    const prompt = async (question: PromptQuestion): Promise<string> =>
      question.option === "port" ? "not-a-port" : "value";
    await expect(promptForInstall(plan, { dataRoot: root }, prompt, () => false)).rejects.toThrow(/port/i);
  });
});

describe("service installation", () => {
  it("writes the unit and runs the activation commands", async () => {
    const root = await tempRoot();
    const written: Array<{ path: string; text: string }> = [];
    const mkdirs: string[] = [];
    const commands: string[][] = [];
    const plan = planInstall(hostOptions({ dataRoot: join(root, "data") }), environment(root));
    const result = await installService(plan, hostOptions({ dataRoot: join(root, "data") }), {
      mkdir: async (path) => {
        mkdirs.push(path);
        return undefined;
      },
      writeFile: async (path, text) => {
        written.push({ path, text });
      },
      exists: () => false,
      save: async () => undefined,
      chmod: async () => undefined,
      run: (command, args) => {
        commands.push([command, ...args]);
        return { ok: true, stdout: "", stderr: "" };
      },
    });
    expect(mkdirs).toEqual([dirname(plan.unitPath)]);
    expect(written).toHaveLength(1);
    expect(written[0]!.path).toBe(plan.unitPath);
    expect(written[0]!.text).toContain("ExecStart=");
    expect(result.configCreated).toBe(true);
    expect(commands).toEqual(plan.commands);
  });

  it("can write the unit without starting it", async () => {
    const root = await tempRoot();
    const commands: string[][] = [];
    const plan = planInstall(hostOptions({ dataRoot: join(root, "data") }), environment(root));
    const result = await installService(plan, { ...hostOptions({ dataRoot: join(root, "data") }), noStart: true }, {
      mkdir: async () => undefined,
      writeFile: async () => undefined,
      exists: () => false,
      save: async () => undefined,
      chmod: async () => undefined,
      run: (command, args) => {
        commands.push([command, ...args]);
        return { ok: true, stdout: "", stderr: "" };
      },
    });
    expect(result.commands).toEqual([]);
    expect(commands).toEqual([]);
  });
});

describe("install invocation", () => {
  it("treats only a bare install or --dry-run as interactive", () => {
    expect(isInteractiveInvocation(parseArguments(["install"]))).toBe(true);
    expect(isInteractiveInvocation(parseArguments(["install", "--dry-run"]))).toBe(true);
    expect(isInteractiveInvocation(parseArguments(["install", "--workgroup", "lab"]))).toBe(false);
    expect(isInteractiveInvocation(parseArguments(["install", "--no-start"]))).toBe(false);
  });

  it("accepts -p as the password flag", () => {
    expect(parseArguments(["install", "-p", "lab-secret"]).values.get("password")).toEqual(["lab-secret"]);
  });

  it("accepts repeated --peer flags for startup joins", () => {
    const parsed = parseArguments([
      "install",
      "--peer",
      "http://192.168.86.152:11811",
      "--peer",
      "http://192.168.86.252:11811",
    ]);
    expect(parsed.values.get("peer")).toEqual(["http://192.168.86.152:11811", "http://192.168.86.252:11811"]);
    expect(isInteractiveInvocation(parsed)).toBe(false);
  });

  it("fails a flag-driven install that lacks required answers", async () => {
    const root = await tempRoot();
    const errors: string[] = [];
    const code = await main(["install", "--dry-run", "--data-root", join(root, "data")], {
      environment: environment(root),
      write: () => undefined,
      writeError: (text) => errors.push(text),
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("--workgroup");
    expect(errors.join("\n")).not.toContain("interactively?");
  });

  it("refuses to prompt without a terminal", async () => {
    const root = await tempRoot();
    const errors: string[] = [];
    const code = await main(["install", "--dry-run"], {
      environment: environment(root),
      canPrompt: false,
      write: () => undefined,
      writeError: (text) => errors.push(text),
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("needs a terminal");
  });

  it("asks the four setup questions for a bare dry-run", async () => {
    const root = await tempRoot();
    const output: string[] = [];
    const asked: string[] = [];
    const answers: Record<string, string> = { workgroup: "lab", password: "lab-secret", "bind-host": "", port: "" };
    const code = await main(["install", "--dry-run"], {
      environment: environment(root),
      write: (text) => output.push(text),
      prompt: async (question: PromptQuestion) => {
        asked.push(question.option);
        return answers[question.option] ?? "";
      },
    });
    expect(code).toBe(0);
    expect(asked).toEqual(["workgroup", "password", "bind-host", "port"]);
    expect(output.join("\n")).toContain("[Unit]");
    expect(output.join("\n")).toContain("listen:    [::]:11811");
  });
});
