# From Vibe Coding to Vibe Trading (OpenAI Edition): An AI-Powered Equity Research Agent

> Transform your AI agent from a general "vibe coding" tool into a sophisticated "vibe trading" analyst by integrating real-time market data and advanced charting capabilities.

This project demonstrates how to leverage OpenAI models via a minimal Node runner, augmented with specialized Model Context Protocol (MCP) servers and a detailed prompt, to perform comprehensive equity research and generate actionable investment recommendations. It showcases the power of "vibe trading" – articulating clear intent and context to an AI to execute complex financial analysis tasks.

## Project Goal

The primary goal of this demo is to illustrate how a versatile AI agent like `gemini-cli` can be specialized for financial analysis by:
1.  Integrating with real-time financial market data sources.
2.  Incorporating data visualization and charting tools.
3.  Guiding its analysis with a highly structured and domain-specific prompt.

This transformation enables the AI to act as an "equity research analyst," providing in-depth reports and investment insights.

## Architecture

The system's architecture is centered around the OpenAI Runner, which orchestrates tasks by interacting with external MCP servers and following a predefined analytical workflow.

```mermaid
graph TD
    A[User Request/Prompt] --> B(OpenAI Runner);
    B --> C{MCP Servers};
    C --> D["fin-data-mcp (PlusE)"];
    C --> E["chart-mcp (AntdV Chart)"];
    B --> F["prompt.md (Equity Research Workflow)"];
    D --> G[Real-time Financial Data];
    E --> H[Charting & Technical Analysis];
    F --> B;
    G --> B;
    H --> B;
    B --> I[Comprehensive Equity Research Report];

