"use strict";

/*
 OpenAI Runner for Vibe Trading
 - Reads prompt.md
 - Loads MCP config from CONFIG_DIR/settings.json (defaults to .agent/settings.json)
 - Fetches optional ticker via --ticker flag
 - Calls OpenAI Chat Completions API using OPENAI_API_KEY
 - Provides hooks to call MCP servers (PlusE over HTTP, AntV Chart via npx) — minimal example included for PlusE
 - Outputs a markdown report to stdout

 Usage:
   OPENAI_API_KEY=sk-... node runner.js --ticker CCJ
   CONFIG_DIR=.agent OPENAI_API_KEY=sk-... node runner.js --ticker CCJ
   node runner.js --ticker AAPL > Equity_Research_Report.md
   node runner.js --ticker AAPL --out reports/AAPL_Report.md
   node runner.js --ticker AAPL --out reports/AAPL_Report.md --pdf
   node runner.js --ticker AAPL --provider claude

 Requirements:
   - Node 18+ (recommended Node 20+)
   - npm i openai dotenv node-fetch (we will import fetch from node >=18 global)
   - For --pdf: npm i puppeteer marked
   - For Claude: npm i @anthropic-ai/sdk
*/

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config();
// We will dynamically import OpenAI and Anthropic SDK when needed

// Simple CLI arg parsing for --ticker
const args = process.argv.slice(2);
let ticker = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--ticker" && i + 1 < args.length) {
    ticker = args[i + 1];
  }
}

let outPath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out" && i + 1 < args.length) {
    outPath = args[i + 1];
  }
}

let exportPdf = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--pdf") {
    exportPdf = true;
  }
}

let provider = process.env.PROVIDER || null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--provider" && i + 1 < args.length) {
    provider = args[i + 1];
  }
}
if (!provider) provider = "openai"; // default

function readFileOrThrow(p) {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) {
    throw new Error(`File not found: ${abs}`);
  }
  return fs.readFileSync(abs, "utf8");
}

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadMcpConfig() {
  const configDir = process.env.CONFIG_DIR || ".agent";
  const configPath = path.resolve(configDir, "settings.json");
  if (!fs.existsSync(configPath)) {
    return null;
  }
  const raw = fs.readFileSync(configPath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to parse settings.json in configured directory: ${e.message}`);
  }
}

// Helper to invoke MCP HTTP endpoints with a tool and args
// Tool names are placeholders and should be updated per PlusE docs once available.
async function mcpInvoke(httpUrl, tool, args = {}) {
  if (!httpUrl) return null;
  try {
    const res = await fetch(httpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, args })
    });
    if (!res.ok) {
      const text = await res.text();
      return { error: `MCP invoke failed: ${res.status} ${text}` };
    }
    return await res.json();
  } catch (e) {
    return { error: `MCP invoke error: ${e.message}` };
  }
}

async function fetchPlusE(mcpConfig, symbol) {
  if (!mcpConfig || !mcpConfig.mcpServers || !mcpConfig.mcpServers["fin-data-mcp"]) return null;
  const srv = mcpConfig.mcpServers["fin-data-mcp"]; 
  const httpUrl = srv.httpUrl;
  if (!httpUrl) return null;
  return await mcpInvoke(httpUrl, "get_ticker_data", { ticker: symbol });
}

async function fetchHistoricalSeries(mcpConfig, symbol, period = "1y") {
  if (!mcpConfig || !mcpConfig.mcpServers || !mcpConfig.mcpServers["fin-data-mcp"]) return null;
  const srv = mcpConfig.mcpServers["fin-data-mcp"]; 
  const httpUrl = srv.httpUrl;
  if (!httpUrl) return null;
  // No explicit historical price series tool provided yet; leave charts placeholder.
  // Fetch financial statements as additional context instead.
  const stmt = await mcpInvoke(httpUrl, "get_financial_statements", { ticker: symbol, statement_type: "income", frequency: "quarterly" });
  return { series: null, financials: stmt };
}

async function fetchEarningsHistory(mcpConfig, symbol) {
  if (!mcpConfig || !mcpConfig.mcpServers || !mcpConfig.mcpServers["fin-data-mcp"]) return null;
  const srv = mcpConfig.mcpServers["fin-data-mcp"]; 
  const httpUrl = srv.httpUrl;
  if (!httpUrl) return null;
  return await mcpInvoke(httpUrl, "get_earnings_history", { ticker: symbol });
}

async function generateChartViaMcp(mcpConfig, spec) {
  // Expect chart-mcp to be configured with command and args
  if (!mcpConfig || !mcpConfig.mcpServers || !mcpConfig.mcpServers["chart-mcp"]) return null;
  const srv = mcpConfig.mcpServers["chart-mcp"];
  const cmd = srv.command;
  const args = Array.isArray(srv.args) ? srv.args : [];

  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("error", () => resolve(null));

    proc.on("close", () => {
      // Try to parse stdout as JSON or detect a data URL
      try {
        const trimmed = stdout.trim();
        if (trimmed.startsWith("data:image")) {
          resolve({ dataUrl: trimmed });
          return;
        }
        const json = JSON.parse(trimmed);
        resolve(json);
      } catch {
        resolve(null);
      }
    });

    // Send a simple spec to stdin; adjust to actual chart-mcp protocol as needed
    const payload = JSON.stringify({ action: "render", spec });
    proc.stdin.write(payload);
    proc.stdin.end();
  });
}

async function markdownToPdf(markdown, pdfPath) {
  // Lazy import to avoid requiring puppeteer unless needed
  const { marked } = await import('marked');
  const puppeteer = await import('puppeteer');

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif; padding: 24px; }
    pre, code { background: #f6f8fa; }
    img { max-width: 100%; }
    h1,h2,h3 { margin-top: 1.2em; }
  </style>
  </head><body>${marked.parse(markdown)}</body></html>`;

  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.pdf({ path: pdfPath, format: 'A4', printBackground: true });
  await browser.close();
}

async function sendToModel(provider, systemPreamble, userContent) {
  if (provider === 'claude') {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
    const resp = await anthropic.messages.create({
      model,
      max_tokens: 4000,
      system: systemPreamble,
      messages: [
        { role: 'user', content: userContent }
      ]
    });
    const content = resp?.content?.[0]?.text || '';
    return content;
  } else {
    const { OpenAI } = require('openai');
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPreamble },
        { role: 'user', content: userContent }
      ],
      temperature: 0.3
    });
    return response.choices?.[0]?.message?.content || '';
  }
}

async function main() {
  if (provider === 'openai') {
    if (!process.env.OPENAI_API_KEY) {
      console.error('Missing OPENAI_API_KEY. Set it in .env or export it.');
      process.exit(1);
    }
  } else if (provider === 'claude') {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('Missing ANTHROPIC_API_KEY. Set it in .env or export it.');
      process.exit(1);
    }
  }

  // Load prompt.md
  const promptPath = path.resolve("prompt.md");
  const prompt = readFileOrThrow(promptPath);

  // Load MCP config
  const mcpConfig = loadMcpConfig();

  // Optionally fetch PlusE data and historical series for ticker
  let plusEData = null;
  let historical = null;
  let earnings = null;
  if (ticker) {
    plusEData = await fetchPlusE(mcpConfig, ticker);
    historical = await fetchHistoricalSeries(mcpConfig, ticker, "1y");
    earnings = await fetchEarningsHistory(mcpConfig, ticker);
  }

  // Attempt to generate a simple chart (using placeholder data as no historical price series tool yet)
  // Once a historical price series tool name is available, we will render a real chart.
  let chartImageMarkdown = "";
  try {
    const chartSpec = {
      type: "line",
      title: ticker ? `${ticker} Price (Sample)` : "Price (Sample)",
      data: [
        { x: 1, y: 10 },
        { x: 2, y: 12 },
        { x: 3, y: 9 },
        { x: 4, y: 15 }
      ]
    };

    const chartResult = await generateChartViaMcp(mcpConfig, chartSpec);
    const dataUrl = chartResult && (chartResult.dataUrl || chartResult.url || chartResult.image);
    if (dataUrl && typeof dataUrl === "string") {
      chartImageMarkdown = `\n\n![Chart](${dataUrl})\n`;
    }
  } catch {}

  // Compose system and user messages
  const systemPreamble = `You are a world-class equity research analyst. Only analyze the company specified by the Target Ticker in the user message. Ignore any example companies that may appear in the prompt body. Use the provided prompt as your workflow. If market data is provided from tools, incorporate it. When uncertain, state assumptions.`;

  const toolContext = `Tool Context JSON (if any):\n${JSON.stringify({ ticker, overview: plusEData, financials: historical && historical.financials, earnings }, null, 2)}`;

  const userHeader = `Target Ticker: ${ticker ?? "(not specified)"}\n${toolContext}\n\n`;

  const userContent = `${userHeader}${prompt}`;

  console.error(`Using provider: ${provider}`);

  const text = await sendToModel(provider, systemPreamble, userContent);

  const finalMd = text + chartImageMarkdown + "\n";

  // Determine output path: use --out if provided, else default to reports/<ticker or report>_<YYYY-MM-DD>.md
  if (!outPath) {
    const reportsDir = path.resolve("reports");
    ensureDirSync(reportsDir);
    const base = ticker ? `${ticker}_Report` : `Report`;
    const dateStr = new Date().toISOString().slice(0,10);
    outPath = path.join(reportsDir, `${base}_${dateStr}.md`);
  } else {
    // Ensure parent directory exists
    ensureDirSync(path.dirname(path.resolve(outPath)));
  }

  fs.writeFileSync(outPath, finalMd, "utf8");
  console.error(`Report written to: ${outPath}`);

  if (exportPdf) {
    const pdfPath = outPath.replace(/\.md$/i, '.pdf');
    try {
      await markdownToPdf(finalMd, pdfPath);
      console.error(`PDF written to: ${pdfPath}`);
    } catch (e) {
      console.error(`Failed to export PDF: ${e.message}`);
    }
  }
}

// Ensure global fetch (Node >=18 has fetch)
if (typeof fetch === "undefined") {
  global.fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

