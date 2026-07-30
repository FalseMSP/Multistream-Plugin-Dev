import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/clips/[id]/llm-score — use Gemini to score viral potential
//
// Uses the Gemini Developer API (AI Studio) — free forever with quotas:
//   15 RPM, 1500 requests/day, 1M tokens/min
//
// Get your free API key at: https://aistudio.google.com/apikey
// Set it as GEMINI_API_KEY in your .env file.
//
// Alternatively, set GEMINI_API_KEY to a Vertex AI Express Mode key
// and set GEMINI_ENDPOINT=vertex — the request format is identical.
//
// If no API key is set, falls back to using the engagement score as
// the LLM score (so the neural network still gets a feature value).

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";

// Endpoint selection:
//   "developer" (default) → https://generativelanguage.googleapis.com (free forever)
//   "vertex"              → https://aiplatform.googleapis.com (90-day free trial)
const GEMINI_ENDPOINT = process.env.GEMINI_ENDPOINT ?? "developer";

function getGeminiUrl(): string {
  if (GEMINI_ENDPOINT === "vertex") {
    // Vertex AI Express Mode endpoint
    return `https://aiplatform.googleapis.com/v1/publishers/google/models/${GEMINI_MODEL}:generateContent`;
  }
  // Gemini Developer API (AI Studio) — free forever
  return `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    finishReason?: string;
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

async function callGemini(prompt: string, systemPrompt: string): Promise<string> {
  const url = getGeminiUrl();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Vertex AI Express uses x-goog-api-key header; Developer API uses ?key= query param
  if (GEMINI_ENDPOINT === "vertex") {
    headers["x-goog-api-key"] = GEMINI_API_KEY;
  }

  const body = {
    system_instruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 200,
      responseMimeType: "application/json",
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data: GeminiResponse = await res.json();

  if (data.error) {
    throw new Error(`Gemini API error: ${data.error.message ?? "unknown"}`);
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return text;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const clip = await db.clip.findUnique({
      where: { id },
      include: { source: true },
    });
    if (!clip) {
      return NextResponse.json({ error: "clip not found" }, { status: 404 });
    }

    // If no API key configured, fall back to engagement score
    if (!GEMINI_API_KEY) {
      const fallbackScore = clip.engagementScore;
      console.warn(
        "[LLM score] GEMINI_API_KEY not set — using engagement score as fallback. " +
        "Get a free key at https://aistudio.google.com/apikey"
      );
      return NextResponse.json({
        score: fallbackScore,
        reasoning: "GEMINI_API_KEY not configured — using engagement score fallback",
        fallback: true,
      });
    }

    // Build the prompt
    const transcript = clip.transcript ?? "(no transcript available)";
    const peakPhrase = clip.peakPhrase ?? "";
    const duration = (clip.endTimeSec - clip.startTimeSec).toFixed(0);
    const engagementScore = clip.engagementScore.toFixed(2);
    const streamer = clip.source?.streamerName ?? "Unknown";

    const systemPrompt =
      "You are a viral content curator for YouTube Shorts and TikTok. " +
      "You analyze clips and score their viral potential. " +
      "Always respond with valid JSON only, no markdown.";

    const userPrompt = `Score this clip's viral potential from 0 to 100.

CLIP DETAILS:
- Streamer: ${streamer}
- Duration: ${duration}s
- Engagement score (from AI analysis): ${engagementScore}
- Peak phrase detected: "${peakPhrase}"

TRANSCRIPT:
"${transcript}"

Consider:
1. Hook strength — does it grab attention in the first 3 seconds?
2. Emotional impact — excitement, humor, surprise, tension?
3. Clarity — is the moment understandable out of context?
4. Shareability — would someone send this to a friend?
5. Replay value — does it reward watching twice?

Respond in EXACTLY this JSON format (no other text):
{"score": <number 0-100>, "reasoning": "<one sentence explanation>"}`;

    // Call Gemini
    let llmResponse: { score: number; reasoning: string };

    try {
      const responseText = await callGemini(userPrompt, systemPrompt);

      // Parse JSON — responseMimeType: "application/json" should give us clean JSON
      // but we handle both clean JSON and markdown-wrapped JSON
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        llmResponse = JSON.parse(jsonMatch[0]);
      } else {
        llmResponse = { score: 50, reasoning: "Failed to parse Gemini response" };
      }

      console.log(
        `[LLM score] Gemini scored clip ${id}: ${llmResponse.score}/100 — ${llmResponse.reasoning}`
      );
    } catch (geminiErr) {
      console.error("[LLM score] Gemini API call failed:", geminiErr);
      // Fallback to engagement score
      llmResponse = {
        score: Math.round(clip.engagementScore * 100),
        reasoning: `Gemini API error — using engagement score fallback: ${geminiErr instanceof Error ? geminiErr.message : "unknown"}`,
      };
    }

    // Normalize score to 0-1
    const normalizedScore = Math.min(1, Math.max(0, llmResponse.score / 100));

    // Store the LLM score on the clip (in thumbnailUrl as JSON blob)
    try {
      await db.clip.update({
        where: { id },
        data: {
          thumbnailUrl: JSON.stringify({
            original: clip.thumbnailUrl,
            llmScore: normalizedScore,
            llmReasoning: llmResponse.reasoning,
          }),
        },
      });
    } catch (err) {
      console.warn("[LLM score] Failed to store score:", err);
    }

    return NextResponse.json({
      score: normalizedScore,
      reasoning: llmResponse.reasoning,
      model: GEMINI_MODEL,
      endpoint: GEMINI_ENDPOINT,
    });
  } catch (err) {
    console.error("[POST /api/clips/[id]/llm-score]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "internal error" },
      { status: 500 }
    );
  }
}
