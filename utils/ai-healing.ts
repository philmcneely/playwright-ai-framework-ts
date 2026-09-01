/**
 * AI Healing Service for Playwright Tests Using Ollama Model
 *
 * Port of the Python OllamaAIHealingService. Captures test failure context,
 * queries Ollama for healing analysis, and generates detailed healing reports.
 *
 * Environment Variables:
 *   OLLAMA_MODEL            - Ollama model to use (default: qwen3:8b)
 *   AI_HEALING_ENABLED      - Enable AI healing (true|false, default: false)
 *   AI_HEALING_CONFIDENCE   - Confidence threshold (default: 0.7)
 *   OLLAMA_HOST             - Ollama server URL (default: http://localhost:11434)
 *   OLLAMA_TEMPERATURE      - Temperature for generation (default: 0.1)
 *   AI_HEALING_CONTEXT_WINDOW - Max DOM characters to include (default: 5000)
 */

import { Ollama } from "ollama";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { AI_HEALING_REPORT_DIR } from "../config/artifact-paths.js";
import { debugPrint } from "../config/settings.js";

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

export function stripStyleTags(html: string): string {
  return html.replace(/<style.*?>.*?<\/style>/gis, "");
}

// ---------------------------------------------------------------------------
// OllamaAIHealingService
// ---------------------------------------------------------------------------

export interface HealingResponse {
  analysis?: string;
  root_cause?: string;
  confidence?: number;
  suggested_fix?: string;
  updated_test_code?: string;
  recommendations?: string;
  raw_ollama_response?: string;
  raw_unparsed_response?: string;
  error?: string;
}

export class OllamaAIHealingService {
  model: string;
  enabled: boolean;
  confidenceThreshold: number;
  ollamaHost: string;
  temperature: number;
  contextWindow: number;
  private client: Ollama;

  constructor() {
    this.model = process.env.OLLAMA_MODEL || "qwen3:8b";
    this.enabled =
      (process.env.AI_HEALING_ENABLED || "false").toLowerCase() === "true";
    this.confidenceThreshold = parseFloat(
      process.env.AI_HEALING_CONFIDENCE || "0.7",
    );
    this.ollamaHost = process.env.OLLAMA_HOST || "http://localhost:11434";
    this.temperature = parseFloat(process.env.OLLAMA_TEMPERATURE || "0.1");
    this.contextWindow = parseInt(
      process.env.AI_HEALING_CONTEXT_WINDOW || "5000",
      10,
    );
    this.client = new Ollama({ host: this.ollamaHost });
  }

  // -----------------------------------------------------------------------
  // captureFailureContext
  // -----------------------------------------------------------------------

  /**
   * Build a context dict from information available in the Reporter.
   * The Reporter does NOT have access to the Page object, so DOM/screenshot
   * capture relies on Playwright's built-in screenshot-on-failure.
   */
  captureFailureContext(
    errorMessage: string,
    errorType: string,
    testName: string,
    testFile: string,
    dom?: string,
    screenshotPath?: string,
  ): Record<string, string> {
    const context: Record<string, string> = {
      test_name: testName,
      error_message: errorMessage,
      error_type: errorType,
      test_file: testFile,
    };

    if (dom) {
      const stripped = stripStyleTags(dom);
      context.dom =
        stripped.length > this.contextWindow
          ? stripped.slice(0, this.contextWindow) + "..."
          : stripped;
    }

    if (screenshotPath) {
      context.screenshot_path = screenshotPath;
    }

    return context;
  }

  // -----------------------------------------------------------------------
  // buildHealingPrompt
  // -----------------------------------------------------------------------

  buildHealingPrompt(
    context: Record<string, string>,
    originalTestCode: string,
  ): string {
    return `
You are an expert Quality Assurance Engineer and test automation specialist.

A Playwright TypeScript test has failed and needs analysis for potential auto-healing.

## Test Information:
- **Test Name**: ${context.test_name}
- **Error Type**: ${context.error_type ?? "Unknown"}
- **URL**: ${context.url ?? "N/A"}
- **Page Title**: ${context.title ?? "N/A"}

## Error Message:
\`\`\`
${context.error_message}
\`\`\`

## Original Test Code:
\`\`\`typescript
${originalTestCode}
\`\`\`

## DOM Context (truncated):
\`\`\`html
${context.dom ?? "No DOM captured"}
\`\`\`

## Your Task:
Analyze this test failure and provide:

1. **Root Cause Analysis**: What exactly caused this test to fail?
2. **Confidence Score**: Rate your confidence in the analysis (0.0 to 1.0)
3. **Suggested Fix**: Specific code changes or approach to fix the test
4. **Updated Test Code**: Always provide a corrected version of the test code that fixes the failure. Return only the updated test function code in TypeScript.
5. **Recommendations**: Additional suggestions for test stability

IMPORTANT: Respond ONLY with a valid JSON object, no markdown formatting or extra text.

{
    "analysis": "Detailed analysis of what went wrong",
    "root_cause": "Specific root cause identified",
    "confidence": 0.85,
    "suggested_fix": "Specific fix recommendation",
    "updated_test_code": "Complete fixed test code (if confident)",
    "recommendations": "Additional recommendations for improvement"
}

Focus on common Playwright issues like:
- Element not found/changed selectors
- Timing issues and race conditions
- Network/loading problems
- State management issues
- Flaky test patterns
`;
  }

  // -----------------------------------------------------------------------
  // queryOllama
  // -----------------------------------------------------------------------

  async queryOllama(
    prompt: string,
    screenshotPath?: string,
  ): Promise<string | null> {
    try {
      console.log(`[AI Healing] Querying Ollama model: ${this.model}`);

      const requestParams: {
        model: string;
        prompt: string;
        stream: false;
        system: string;
        options: { temperature: number; num_ctx: number };
        images?: string[];
      } = {
        model: this.model,
        prompt,
        stream: false as const,
        system:
          "You are an expert Quality Assurance Engineer and test automation specialist. Respond ONLY with valid JSON, no markdown or extra text.",
        options: {
          temperature: this.temperature,
          num_ctx: 8192,
        },
      };

      if (screenshotPath && fs.existsSync(screenshotPath)) {
        const base64 = fs.readFileSync(screenshotPath).toString("base64");
        requestParams.images = [base64];
        console.log(
          `[AI Healing] Including screenshot: ${screenshotPath}`,
        );
      }

      const response = await this.client.generate(requestParams);
      return response.response;
    } catch (err) {
      console.error(`[AI Healing] Ollama query failed: ${err}`);
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // parseOllamaResponse  (6 fallback strategies, mirrors Python)
  // -----------------------------------------------------------------------

  parseOllamaResponse(responseText: string): HealingResponse | null {
    if (!responseText) {
      console.log("[AI Healing] Empty response from Ollama");
      return null;
    }

    console.log(
      `[AI Healing] Raw Ollama response (first 200 chars): ${responseText.slice(0, 200)}...`,
    );

    let candidate: string;

    // Strategy 1: JSON inside ```json ... ``` code block
    const jsonBlockMatch = responseText.match(
      /```json\s*({.*?})\s*```/s,
    );
    if (jsonBlockMatch) {
      candidate = jsonBlockMatch[1];
      debugPrint("[AI Healing] Found JSON in code block");
    } else {
      // Strategy 2: Any code block
      const codeBlockMatch = responseText.match(/```(.*?)```/s);
      if (codeBlockMatch) {
        candidate = codeBlockMatch[1].trim();
        debugPrint("[AI Healing] Found content in code block");
      } else {
        // Strategy 3: JSON-like structure anywhere
        const jsonPatternMatch = responseText.match(
          /({\s*"[^"]+":.*?})/s,
        );
        if (jsonPatternMatch) {
          candidate = jsonPatternMatch[1];
          debugPrint("[AI Healing] Found JSON-like structure in text");
        } else {
          // Strategy 4: Entire response
          candidate = responseText.trim();
          debugPrint("[AI Healing] Using entire response as candidate");
        }
      }
    }

    // Attempt direct parse
    try {
      const parsed = JSON.parse(candidate) as HealingResponse;
      console.log("[AI Healing] Successfully parsed JSON response");
      return parsed;
    } catch {
      debugPrint("[AI Healing] JSON parsing failed, trying fallbacks");
    }

    // Strategy 5: Strip non-JSON leading/trailing text
    try {
      let cleaned = candidate.replace(/^[^{]*/, "");
      cleaned = cleaned.replace(/[^}]*$/, "");
      if (cleaned) {
        const parsed = JSON.parse(cleaned) as HealingResponse;
        console.log("[AI Healing] Successfully parsed cleaned JSON");
        return parsed;
      }
    } catch {
      // continue
    }

    // Strategy 6: Manual regex extraction
    try {
      const analysisMatch = responseText.match(
        /"analysis"\s*:\s*"([^"]*)"/,
      );
      const rootCauseMatch = responseText.match(
        /"root_cause"\s*:\s*"([^"]*)"/,
      );
      const confidenceMatch = responseText.match(
        /"confidence"\s*:\s*([0-9.]+)/,
      );

      const manual: HealingResponse = {
        analysis: analysisMatch
          ? analysisMatch[1]
          : responseText.slice(0, 500),
        root_cause: rootCauseMatch
          ? rootCauseMatch[1]
          : "Could not extract root cause",
        confidence: confidenceMatch
          ? parseFloat(confidenceMatch[1])
          : 0.3,
        suggested_fix:
          "Manual review required - JSON parsing failed",
        recommendations: "Check Ollama model output format",
      };
      console.log("[AI Healing] Manually extracted key information");
      return manual;
    } catch {
      // continue
    }

    // Final fallback
    console.log(
      "[AI Healing] All parsing strategies failed, returning raw response",
    );
    return {
      analysis: responseText,
      root_cause: "Could not parse structured response",
      confidence: 0.2,
      suggested_fix:
        "Manual review required - response parsing failed",
      recommendations:
        "Consider using a different Ollama model or adjusting prompt",
      raw_unparsed_response: responseText,
    };
  }

  // -----------------------------------------------------------------------
  // callOllamaHealing  (orchestrator)
  // -----------------------------------------------------------------------

  async callOllamaHealing(
    context: Record<string, string>,
    originalTestCode: string,
    screenshotPath?: string,
  ): Promise<HealingResponse> {
    try {
      debugPrint("[AI Healing] Building healing prompt...");
      const prompt = this.buildHealingPrompt(context, originalTestCode);

      debugPrint("[AI Healing] Querying Ollama service...");
      const rawResponse = await this.queryOllama(prompt, screenshotPath);

      if (rawResponse) {
        debugPrint("[AI Healing] Parsing Ollama response...");
        const parsed = this.parseOllamaResponse(rawResponse);

        if (!parsed) {
          return { error: "Failed to parse Ollama response" };
        }

        parsed.raw_ollama_response = rawResponse;
        return parsed;
      }

      return { error: "No response from Ollama" };
    } catch (err) {
      console.error(`[AI Healing] Ollama healing service error: ${err}`);
      return { error: String(err) };
    }
  }

  // -----------------------------------------------------------------------
  // generateHealingReport
  // -----------------------------------------------------------------------

  async generateHealingReport(
    testName: string,
    aiResponse: HealingResponse,
    context: Record<string, string>,
  ): Promise<void> {
    const healingDir = AI_HEALING_REPORT_DIR;
    fs.mkdirSync(healingDir, { recursive: true });

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const safeTestName = testName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const reportFile = path.join(
      healingDir,
      `${safeTestName}_${timestamp}_ollama_analysis.md`,
    );

    const confidence = aiResponse.confidence ?? 0;
    const confidencePct = `${(confidence * 100).toFixed(1)}%`;

    const reportContent = `# AI Healing Report

## Test Information
- **Test Name**: \`${testName}\`
- **Timestamp**: \`${timestamp}\`
- **Model Used**: \`${this.model}\`
- **URL**: \`${context.url ?? "N/A"}\`
- **Error Type**: \`${context.error_type ?? "Unknown"}\`

## Error Details
\`\`\`
${context.error_message ?? "No error message"}
\`\`\`

## Ollama Analysis
\`\`\`
${aiResponse.analysis ?? "No analysis provided"}
\`\`\`

## Root Cause
\`\`\`
${aiResponse.root_cause ?? "Not identified"}
\`\`\`

## Suggested Fix
\`\`\`
${aiResponse.suggested_fix ?? "No fix suggested"}
\`\`\`

## Updated Code
\`\`\`typescript
${aiResponse.updated_test_code ?? "No fix suggested"}
\`\`\`

## Confidence Level
**${confidencePct}**

## Recommendations
\`\`\`
${aiResponse.recommendations ?? "None provided"}
\`\`\`

## Raw Ollama Response
<details>
<summary>Click to expand raw response</summary>

\`\`\`
${aiResponse.raw_ollama_response ?? "No raw response"}
\`\`\`
</details>

---
*Generated by Ollama AI Healing System*
`;

    fs.writeFileSync(reportFile, reportContent, "utf-8");

    // Save healed test if provided
    if (aiResponse.updated_test_code) {
      const healedFile = path.join(
        healingDir,
        `${safeTestName}_${timestamp}_ollama_healed.ts`,
      );
      fs.writeFileSync(healedFile, aiResponse.updated_test_code, "utf-8");
      console.log(`[AI Healing] Healed test saved: ${healedFile}`);
    }

    // Console summary
    const sep = "=".repeat(80);
    console.log(`\n${sep}`);
    console.log(`OLLAMA AI HEALING: ${testName}`);
    console.log(sep);
    console.log(`  Model: ${this.model}`);
    console.log(`  Confidence: ${confidencePct}`);
    console.log(
      `  Root Cause: ${aiResponse.root_cause ?? "Unknown"}`,
    );
    console.log(
      `  Suggestion: ${aiResponse.suggested_fix ?? "None"}`,
    );
    console.log(`  Full Report: ${reportFile}`);

    if (confidence > this.confidenceThreshold) {
      console.log("  HIGH confidence - Review the healed test");
    } else {
      console.log("  LOW confidence - Manual review recommended");
    }
    console.log(`${sep}\n`);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _service: OllamaAIHealingService | null = null;

export function getOllamaService(): OllamaAIHealingService {
  if (!_service) {
    _service = new OllamaAIHealingService();
  }
  return _service;
}

// ---------------------------------------------------------------------------
// ensureOllamaReady
// ---------------------------------------------------------------------------

let _ollamaChecked = false;

export async function ensureOllamaReady(
  modelName?: string,
  host?: string,
  maxWait = 180,
): Promise<boolean> {
  if (_ollamaChecked) return true;

  const service = getOllamaService();
  const model = modelName ?? service.model;
  const ollamaHost = host ?? service.ollamaHost;

  console.log(`[AI Healing] Checking Ollama service at ${ollamaHost}...`);

  // Check if Ollama is reachable
  let running = false;
  try {
    const resp = await fetch(`${ollamaHost}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      console.log("[AI Healing] Ollama service is already running.");
      running = true;
    } else {
      console.log(
        `[AI Healing] Ollama responded with status ${resp.status}`,
      );
    }
  } catch {
    console.log(
      "[AI Healing] Ollama service not running, attempting to start...",
    );
  }

  // Try to start Ollama if not running
  if (!running) {
    try {
      const proc = spawn("ollama", ["serve"], {
        detached: true,
        stdio: "ignore",
      });
      proc.unref();
      console.log(
        `[AI Healing] Ollama process started with PID: ${proc.pid}`,
      );

      // Wait up to 30s for it to become available
      let started = false;
      for (let i = 0; i < 30; i++) {
        try {
          const resp = await fetch(`${ollamaHost}/api/tags`, {
            signal: AbortSignal.timeout(2000),
          });
          if (resp.ok) {
            console.log(
              "[AI Healing] Ollama service started successfully.",
            );
            started = true;
            break;
          }
        } catch {
          // not ready yet
        }
        await sleep(1000);
        if (i % 5 === 0) {
          console.log(
            `[AI Healing] Still waiting for Ollama... (${i + 1}/30)`,
          );
        }
      }
      if (!started) {
        console.log(
          "[AI Healing] Failed to start Ollama service within 30 seconds.",
        );
        return false;
      }
    } catch (err) {
      console.log(`[AI Healing] Could not start Ollama service: ${err}`);
      return false;
    }
  }

  // Ensure the model is available and warm
  try {
    console.log(`[AI Healing] Checking if model ${model} is available...`);
    const tagsResp = await fetch(`${ollamaHost}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!tagsResp.ok) {
      console.log(
        `[AI Healing] Failed to get model list: ${tagsResp.status}`,
      );
      return false;
    }

    const tagsData = (await tagsResp.json()) as {
      models?: Array<{ name?: string }>;
    };
    const models = tagsData.models ?? [];
    const modelExists = models.some((m) =>
      (m.name ?? "").includes(model),
    );

    if (!modelExists) {
      console.log(
        `[AI Healing] Model ${model} not found. Attempting to pull...`,
      );
      const pullResp = await fetch(`${ollamaHost}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: model }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!pullResp.ok) {
        console.log(`[AI Healing] Failed to pull model ${model}`);
        return false;
      }
      console.log(`[AI Healing] Model ${model} pulled successfully.`);
    }

    // Warm up
    console.log(
      `[AI Healing] Warming up model ${model} (waiting for a real response)...`,
    );
    const start = Date.now();
    while (Date.now() - start < maxWait * 1000) {
      try {
        const genResp = await fetch(`${ollamaHost}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            prompt: "Hello",
            stream: false,
            options: { num_predict: 5 },
          }),
          signal: AbortSignal.timeout(30_000),
        });
        if (genResp.ok) {
          const data = (await genResp.json()) as {
            response?: string;
            error?: string;
          };
          if (data.response?.trim()) {
            console.log(
              `[AI Healing] Model ${model} is loaded and ready.`,
            );
            _ollamaChecked = true;
            return true;
          }
          if (data.error) {
            debugPrint(
              `[AI Healing] Model not ready yet: ${data.error}`,
            );
          }
        }
      } catch {
        // still loading
      }
      await sleep(3000);
    }
    console.log(
      `[AI Healing] Model ${model} did not become ready in ${maxWait} seconds.`,
    );
    return false;
  } catch (err) {
    console.log(
      `[AI Healing] Error checking/loading model ${model}: ${err}`,
    );
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
