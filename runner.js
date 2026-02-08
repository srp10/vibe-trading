"use strict";

/*
 Vibe Trading Runner
 - Fetches financial data via Yahoo Finance (no API key needed)
 - Generates professional charts via QuickChart.io (no API key needed)
 - Calls Claude (default) or OpenAI to generate equity research reports
 - Outputs a markdown report with embedded charts + optional PDF

 Usage:
   node runner.js --ticker AAPL
   node runner.js --ticker AAPL --out reports/AAPL_Report.md
   node runner.js --ticker AAPL --out reports/AAPL_Report.md --pdf
   node runner.js --ticker AAPL --provider openai

 Requirements:
   - Node 18+ (recommended Node 20+)
   - npm install
*/

const fs = require("fs");
const path = require("path");
require("dotenv").config({ override: true });

const YahooFinance = require("yahoo-finance2").default;
const QuickChart = require("quickchart-js");

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

// ── CLI arg parsing ──────────────────────────────────────────────────
const args = process.argv.slice(2);

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

const ticker = getArg("--ticker");
let outPath = getArg("--out");
const exportPdf = args.includes("--pdf");
let provider = getArg("--provider") || process.env.PROVIDER || "claude";

// ── Utility helpers ──────────────────────────────────────────────────
function readFileOrThrow(p) {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
  return fs.readFileSync(abs, "utf8");
}

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Yahoo Finance data fetching ──────────────────────────────────────
async function fetchAllData(symbol) {
  console.error(`Fetching data for ${symbol} from Yahoo Finance...`);

  const [summary, priceData] = await Promise.all([
    yf.quoteSummary(symbol, {
      modules: [
        "price", "summaryDetail", "financialData", "defaultKeyStatistics",
        "earnings", "earningsHistory", "earningsTrend",
        "incomeStatementHistory", "incomeStatementHistoryQuarterly",
        "balanceSheetHistory", "cashflowStatementHistory",
        "recommendationTrend", "upgradeDowngradeHistory", "assetProfile"
      ]
    }),
    yf.chart(symbol, {
      period1: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
      interval: "1wk"
    })
  ]);

  console.error(`Data fetched: ${priceData.quotes.length} price points, ` +
    `${summary.earnings?.earningsChart?.quarterly?.length || 0} earnings quarters`);

  return { summary, priceData };
}

// ── QuickChart generation ────────────────────────────────────────────
const CHART_COLORS = {
  green: "#10b981",
  blue: "#3b82f6",
  red: "#ef4444",
  gray: "#6b7280",
  orange: "#f59e0b",
  purple: "#8b5cf6",
  teal: "#14b8a6",
  gridLine: "rgba(0,0,0,0.08)",
};

function makeChartUrl(config) {
  const chart = new QuickChart();
  chart.setConfig(config);
  chart.setWidth(750);
  chart.setHeight(420);
  chart.setBackgroundColor("#ffffff");
  chart.setVersion("4");
  return chart.getUrl();
}

function buildEarningsChart(ticker, earningsQuarterly) {
  if (!earningsQuarterly || earningsQuarterly.length === 0) return null;

  const labels = earningsQuarterly.map(e => e.date || e.calendarQuarter || "Q");
  const actuals = earningsQuarterly.map(e => e.actual ?? 0);
  const estimates = earningsQuarterly.map(e => e.estimate ?? 0);

  return makeChartUrl({
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Actual EPS",
          data: actuals,
          backgroundColor: CHART_COLORS.green,
          borderRadius: 4,
        },
        {
          label: "Estimate EPS",
          data: estimates,
          backgroundColor: CHART_COLORS.blue,
          borderRadius: 4,
        }
      ]
    },
    options: {
      plugins: {
        title: { display: true, text: `${ticker} — Earnings Per Share (Actual vs Estimate)`, font: { size: 16, weight: "bold" } },
        legend: { position: "bottom" }
      },
      scales: {
        y: { title: { display: true, text: "EPS ($)" }, grid: { color: CHART_COLORS.gridLine } },
        x: { grid: { display: false } }
      }
    }
  });
}

function buildRevenueChart(ticker, incomeStatements) {
  if (!incomeStatements || incomeStatements.length === 0) return null;

  const data = [...incomeStatements].reverse();
  const labels = data.map(s => {
    const d = new Date(s.endDate);
    return `${d.getFullYear()}-Q${Math.ceil((d.getMonth() + 1) / 3)}`;
  });
  const revenues = data.map(s => +(((s.totalRevenue || 0) / 1e9).toFixed(1)));
  const netIncomes = data.map(s => +(((s.netIncome || 0) / 1e9).toFixed(1)));

  return makeChartUrl({
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Revenue ($B)",
          data: revenues,
          backgroundColor: CHART_COLORS.blue,
          borderRadius: 4,
        },
        {
          label: "Net Income ($B)",
          data: netIncomes,
          backgroundColor: CHART_COLORS.green,
          borderRadius: 4,
        }
      ]
    },
    options: {
      plugins: {
        title: { display: true, text: `${ticker} — Quarterly Revenue & Net Income`, font: { size: 16, weight: "bold" } },
        legend: { position: "bottom" }
      },
      scales: {
        y: { title: { display: true, text: "USD (Billions)" }, grid: { color: CHART_COLORS.gridLine } },
        x: { grid: { display: false } }
      }
    }
  });
}

function buildPriceChart(ticker, quotes) {
  if (!quotes || quotes.length === 0) return null;

  const labels = quotes.map(q => {
    const d = new Date(q.date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const closes = quotes.map(q => +(q.close?.toFixed(2) ?? 0));

  return makeChartUrl({
    type: "line",
    data: {
      labels,
      datasets: [{
        label: `${ticker} Close Price`,
        data: closes,
        borderColor: CHART_COLORS.blue,
        backgroundColor: "rgba(59,130,246,0.08)",
        fill: true,
        pointRadius: 0,
        borderWidth: 2.5,
        tension: 0.3,
      }]
    },
    options: {
      plugins: {
        title: { display: true, text: `${ticker} — 1-Year Price History`, font: { size: 16, weight: "bold" } },
        legend: { display: false }
      },
      scales: {
        y: { title: { display: true, text: "Price ($)" }, grid: { color: CHART_COLORS.gridLine } },
        x: {
          grid: { display: false },
          ticks: { maxTicksLimit: 12 }
        }
      }
    }
  });
}

function buildAnalystChart(ticker, recommendationTrend) {
  if (!recommendationTrend || !recommendationTrend.trend || recommendationTrend.trend.length === 0) return null;

  const current = recommendationTrend.trend[0];
  const labels = ["Strong Buy", "Buy", "Hold", "Sell", "Strong Sell"];
  const data = [
    current.strongBuy || 0,
    current.buy || 0,
    current.hold || 0,
    current.sell || 0,
    current.strongSell || 0
  ];

  return makeChartUrl({
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "# of Analysts",
        data,
        backgroundColor: [
          CHART_COLORS.green,
          CHART_COLORS.teal,
          CHART_COLORS.orange,
          CHART_COLORS.red,
          "#991b1b"
        ],
        borderRadius: 4,
      }]
    },
    options: {
      indexAxis: "y",
      plugins: {
        title: { display: true, text: `${ticker} — Analyst Recommendations`, font: { size: 16, weight: "bold" } },
        legend: { display: false }
      },
      scales: {
        x: { title: { display: true, text: "Number of Analysts" }, grid: { color: CHART_COLORS.gridLine } },
        y: { grid: { display: false } }
      }
    }
  });
}

function generateAllCharts(ticker, summary, priceData) {
  const charts = [];

  // 1. Price history chart
  const priceUrl = buildPriceChart(ticker, priceData?.quotes);
  if (priceUrl) charts.push({ alt: `${ticker} Price History`, url: priceUrl });

  // 2. Earnings chart
  const earningsUrl = buildEarningsChart(ticker, summary?.earnings?.earningsChart?.quarterly);
  if (earningsUrl) charts.push({ alt: `${ticker} Earnings`, url: earningsUrl });

  // 3. Revenue & net income chart
  const revenueUrl = buildRevenueChart(ticker,
    summary?.incomeStatementHistoryQuarterly?.incomeStatementHistory);
  if (revenueUrl) charts.push({ alt: `${ticker} Revenue`, url: revenueUrl });

  // 4. Analyst recommendations
  const analystUrl = buildAnalystChart(ticker, summary?.recommendationTrend);
  if (analystUrl) charts.push({ alt: `${ticker} Analyst Ratings`, url: analystUrl });

  console.error(`Generated ${charts.length} charts`);
  return charts;
}

// ── PDF export ───────────────────────────────────────────────────────
async function markdownToPdf(markdown, pdfPath) {
  const { marked } = await import("marked");
  const puppeteer = await import("puppeteer");

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 32px; color: #1a1a1a; line-height: 1.6; }
    h1 { border-bottom: 2px solid #3b82f6; padding-bottom: 8px; }
    h2 { color: #1e40af; margin-top: 1.5em; }
    h3 { color: #374151; }
    pre, code { background: #f1f5f9; border-radius: 4px; padding: 2px 6px; font-size: 0.9em; }
    pre { padding: 12px; }
    img { max-width: 100%; margin: 16px 0; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    table { border-collapse: collapse; width: 100%; margin: 12px 0; }
    th, td { border: 1px solid #e5e7eb; padding: 8px 12px; text-align: left; }
    th { background: #f8fafc; font-weight: 600; }
    hr { border: none; border-top: 1px solid #e5e7eb; margin: 24px 0; }
  </style>
  </head><body>${marked.parse(markdown)}</body></html>`;

  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle0" });
  await page.pdf({ path: pdfPath, format: "A4", printBackground: true, margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" } });
  await browser.close();
}

// ── AI model call ────────────────────────────────────────────────────
async function sendToModel(provider, systemPreamble, userContent) {
  if (provider === "claude") {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
    const resp = await anthropic.messages.create({
      model,
      max_tokens: 4000,
      system: systemPreamble,
      messages: [{ role: "user", content: userContent }]
    });
    return resp?.content?.[0]?.text || "";
  } else {
    const { OpenAI } = require("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPreamble },
        { role: "user", content: userContent }
      ],
      temperature: 0.3
    });
    return response.choices?.[0]?.message?.content || "";
  }
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  // Validate API key
  if (provider === "openai" && !process.env.OPENAI_API_KEY) {
    console.error("Missing OPENAI_API_KEY. Set it in .env or export it.");
    process.exit(1);
  }
  if (provider === "claude" && !process.env.ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY. Set it in .env or export it.");
    process.exit(1);
  }

  // Load prompt.md
  const prompt = readFileOrThrow(path.resolve("prompt.md"));

  // Fetch financial data & generate charts
  let summary = null;
  let priceData = null;
  let charts = [];

  if (ticker) {
    const data = await fetchAllData(ticker);
    summary = data.summary;
    priceData = data.priceData;
    charts = generateAllCharts(ticker, summary, priceData);
  }

  // Build chart markdown section
  let chartSection = "";
  if (charts.length > 0) {
    chartSection = "\n\n---\n\n## Charts\n\n";
    for (const c of charts) {
      chartSection += `![${c.alt}](${c.url})\n\n`;
    }
  }

  // Compose the AI prompt with financial data context
  const systemPreamble = `You are a world-class equity research analyst. Only analyze the company specified by the Target Ticker. Ignore any example companies in the prompt. Use the provided prompt as your workflow. Incorporate the real market data provided. When uncertain, state assumptions clearly.`;

  // Prepare a condensed data summary for the model (avoid huge JSON)
  const dataSummary = summary ? {
    ticker,
    price: summary.price,
    financialData: summary.financialData,
    defaultKeyStatistics: summary.defaultKeyStatistics,
    summaryDetail: summary.summaryDetail,
    earnings: summary.earnings,
    earningsHistory: summary.earningsHistory,
    recommendationTrend: summary.recommendationTrend,
    upgradeDowngradeHistory: summary.upgradeDowngradeHistory?.history?.slice(0, 10),
    incomeQuarterly: summary.incomeStatementHistoryQuarterly?.incomeStatementHistory,
    assetProfile: summary.assetProfile ? {
      sector: summary.assetProfile.sector,
      industry: summary.assetProfile.industry,
      fullTimeEmployees: summary.assetProfile.fullTimeEmployees,
      longBusinessSummary: summary.assetProfile.longBusinessSummary
    } : null
  } : { ticker };

  const toolContext = `Financial Data (from Yahoo Finance):\n${JSON.stringify(dataSummary, null, 2)}`;
  const userContent = `Target Ticker: ${ticker ?? "(not specified)"}\n\n${toolContext}\n\n${prompt}`;

  console.error(`Using provider: ${provider}`);
  const text = await sendToModel(provider, systemPreamble, userContent);

  const finalMd = text + chartSection + "\n";

  // Determine output path
  if (!outPath) {
    const reportsDir = path.resolve("reports");
    ensureDirSync(reportsDir);
    const dateStr = new Date().toISOString().slice(0, 10);
    outPath = path.join(reportsDir, `${ticker || "Report"}_Report_${dateStr}.md`);
  } else {
    ensureDirSync(path.dirname(path.resolve(outPath)));
  }

  fs.writeFileSync(outPath, finalMd, "utf8");
  console.error(`Report written to: ${outPath}`);

  if (exportPdf) {
    const pdfPath = outPath.replace(/\.md$/i, ".pdf");
    try {
      await markdownToPdf(finalMd, pdfPath);
      console.error(`PDF written to: ${pdfPath}`);
    } catch (e) {
      console.error(`Failed to export PDF: ${e.message}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
