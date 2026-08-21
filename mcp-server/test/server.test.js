import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "path";

function callMcp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["src/server.js"], { cwd: path.resolve(import.meta.dirname, "..") });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    const payloads = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: method, params }),
    ];
    setTimeout(() => child.stdin.write(payloads.join("\n") + "\n"), 100);
    setTimeout(() => child.kill(), 8000);
    child.on("close", () => {
      for (const line of out.split("\n")) {
        if (line.includes('"id":3')) {
          try { resolve(JSON.parse(line)); return; } catch {}
        }
      }
      reject(new Error("no id:3 response: " + out.slice(0, 2000)));
    });
  });
}

test("tools/list exposes 6 tools", async () => {
  const res = await callMcp("tools/list", {});
  assert.ok(res.result.tools.length === 6, "expected 6 tools");
  assert.ok(res.result.tools.some((t) => t.name === "sp_financials"));
});

test("sp_financials dilution returns source", async () => {
  const res = await callMcp("tools/call", { name: "sp_financials", arguments: { ticker: "AAPL", tool: "dilution" } });
  const text = res.result.content[0].text;
  const payload = JSON.parse(text);
  assert.equal(payload.symbol, "AAPL");
  assert.ok(payload.source.url.includes("sec.gov"));
  assert.ok(payload.data.percentageChange !== null);
});

test("sp_fund returns fund-data source", async () => {
  const res = await callMcp("tools/call", { name: "sp_fund", arguments: { symbol: "SPY" } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.source.type, "fund-data");
});
