/**
 * direct-image — local pi extension (forked capability from @pi-unipi/image)
 *
 * Registers `image_direct`, which generates images through OpenRouter's
 * DEDICATED images endpoint (POST /api/v1/images/generations) instead of
 * the chat/completions API that @pi-unipi/image (via pi-ai) uses.
 *
 * Why: image-only models such as meta/muse-image ($0.01/image) are rejected
 * by chat/completions with:
 *   "is an image generation model and cannot be used with the
 *    chat/completions endpoint. Use the /api/v1/images endpoint instead."
 *
 * Deliberate differences from image_generate:
 * - Returns ONLY the saved file path as text. The image bytes are never
 *   inlined into the conversation, so this cannot blow up context (the
 *   failure mode that motivated this fork — a 700KB SVG inlined as text).
 * - Generation-only (no image editing / image input) for now.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_MODEL = "meta/muse-image";
const IMAGES_URL = "https://openrouter.ai/api/v1/images/generations";

function outputDir(): string {
  return path.join(os.homedir(), ".unipi", "images");
}

/** OpenRouter key: pi's auth store first, env fallback. */
function resolveApiKey(): string | undefined {
  try {
    const raw = fs.readFileSync(
      path.join(os.homedir(), ".pi", "agent", "auth.json"),
      "utf-8",
    );
    const key = (JSON.parse(raw) as { openrouter?: { key?: string } })
      ?.openrouter?.key;
    if (key) return key;
  } catch {
    // Fall through to env.
  }
  return process.env.OPENROUTER_API_KEY || undefined;
}

function slugify(prompt: string, maxLength = 40): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "image";
}

/** Allowlist check for model-returned download URLs: https only, no local/private hosts. */
function isSafeDownloadUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "0.0.0.0"
    )
      return false;
    if (host === "127.0.0.1" || host === "::1" || host === "[::1]")
      return false;
    if (
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host)
    )
      return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Detect extension from magic bytes (dedicated models often return webp). */
function extensionFor(buffer: Buffer): string {
  if (
    buffer.length > 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  )
    return ".webp";
  if (
    buffer.length > 4 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  )
    return ".png";
  if (buffer.length > 2 && buffer[0] === 0xff && buffer[1] === 0xd8)
    return ".jpg";
  if (buffer.length > 6 && buffer.toString("ascii", 0, 6).startsWith("GIF"))
    return ".gif";
  return ".img";
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "image_direct",
    label: "Generate Image (direct)",
    description:
      "Generate an image via OpenRouter's dedicated images endpoint and save it to disk. " +
      "Use this (not image_generate) for image-only models like meta/muse-image. " +
      "Returns ONLY the saved file path as text — the image is never inlined into context.",
    parameters: Type.Object({
      prompt: Type.String({
        description: "Description of the image to generate. Be specific.",
      }),
      model: Type.Optional(
        Type.String({
          description: `Model id, e.g. "meta/muse-image". Defaults to "${DEFAULT_MODEL}".`,
        }),
      ),
      size: Type.Optional(
        Type.String({
          description:
            'Optional size passthrough, e.g. "1024x1024". Omit for model default.',
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const apiKey = resolveApiKey();
      if (!apiKey) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No OpenRouter API key — sign in with /login or set OPENROUTER_API_KEY.",
            },
          ],
          isError: true,
          details: {},
        };
      }

      const model = params.model?.trim() || DEFAULT_MODEL;
      const body: Record<string, unknown> = {
        model,
        prompt: params.prompt,
        response_format: "b64_json",
      };
      if (params.size?.trim()) body.size = params.size.trim();

      let payload: { data?: Array<{ b64_json?: string; url?: string }> };
      try {
        const res = await fetch(IMAGES_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          return {
            content: [
              {
                type: "text" as const,
                text: `Image request failed (${res.status}): ${text.slice(0, 300)}`,
              },
            ],
            isError: true,
            details: {},
          };
        }
        payload = (await res.json()) as typeof payload;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: "text" as const, text: `Image request failed: ${message}` },
          ],
          isError: true,
          details: {},
        };
      }

      const first = payload.data?.[0];
      let buffer: Buffer | undefined;
      if (first?.b64_json) {
        buffer = Buffer.from(first.b64_json, "base64");
      } else if (first?.url) {
        if (!isSafeDownloadUrl(first.url)) {
          return {
            content: [
              {
                type: "text" as const,
                text: "The model returned an unsafe download URL (only public https: allowed).",
              },
            ],
            isError: true,
            details: {},
          };
        }
        try {
          const res = await fetch(first.url, { signal });
          if (!res.ok) throw new Error(`download status ${res.status}`);
          buffer = Buffer.from(await res.arrayBuffer());
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: "text" as const,
                text: `Generated but download failed: ${message}`,
              },
            ],
            isError: true,
            details: {},
          };
        }
      }
      if (!buffer || buffer.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "The model returned no image data.",
            },
          ],
          isError: true,
          details: {},
        };
      }

      const dir = outputDir();
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .slice(0, 19);
      const modelSlug =
        model
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "model";
      const file = path.join(
        dir,
        `${stamp}-${modelSlug}-${slugify(params.prompt)}${extensionFor(buffer)}`,
      );
      try {
        fs.writeFileSync(file, buffer);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `Generated but save failed: ${message}`,
            },
          ],
          isError: true,
          details: {},
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Generated with ${model}. Saved to:\n  ${file}`,
          },
        ],
        details: { model, path: file },
      };
    },
  });
}
