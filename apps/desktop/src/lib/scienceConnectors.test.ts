import { describe, expect, it } from "vitest";
import { SCIENCE_CONNECTORS, connectorConfig } from "./scienceConnectors";

const byId = (id: string) => {
  const c = SCIENCE_CONNECTORS.find((x) => x.id === id);
  if (!c) throw new Error(`no connector ${id}`);
  return c;
};

describe("connectorConfig", () => {
  it("launches a `-m module` connector (paper-search)", () => {
    const cfg = connectorConfig(byId("paper-search"), "/env/bin/python");
    expect(cfg).toMatchObject({
      command: "/env/bin/python",
      args: ["-m", "paper_search_mcp.server"],
      approval: "dangerous",
    });
    expect(cfg.env).toBeUndefined();
  });

  it("launches a console-script connector beside the interpreter (unix)", () => {
    const cfg = connectorConfig(byId("materials-project"), "/env/bin/python");
    expect(cfg.command).toBe("/env/bin/mcp-materials-project");
    expect(cfg.args).toEqual([]);
  });

  it("resolves the console script on Windows with .exe", () => {
    const cfg = connectorConfig(byId("fred"), "C:\\env\\Scripts\\python.exe", "KEY");
    expect(cfg.command).toBe("C:\\env\\Scripts\\fred-mcp.exe");
  });

  it("passes an API key via env, trimmed", () => {
    const cfg = connectorConfig(byId("materials-project"), "/env/bin/python", "  mp-secret  ");
    expect(cfg.env).toEqual({ MP_API_KEY: "mp-secret" });
  });

  it("omits env when the key is blank", () => {
    const cfg = connectorConfig(byId("fred"), "/env/bin/python", "   ");
    expect(cfg.env).toBeUndefined();
  });

  it("every connector declares an id, discipline, package, and a launch path", () => {
    for (const c of SCIENCE_CONNECTORS) {
      expect(c.id && c.discipline && c.pkg && c.source).toBeTruthy();
      expect(Boolean(c.bin) || Boolean(c.module)).toBe(true);
      if (c.apiKeyEnv) expect(c.apiKeyUrl).toBeTruthy(); // key-needing → tell users where to get one
    }
  });

  it("ships at least two non-bio disciplines (P1-2 breadth)", () => {
    const disciplines = new Set(SCIENCE_CONNECTORS.map((c) => c.discipline));
    expect(disciplines.has("materials")).toBe(true);
    expect(disciplines.has("economics")).toBe(true);
  });
});
