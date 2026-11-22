/** Friendly decoding for `/orca-api` HTTP responses, including non-JSON proxy or gateway errors. */

import { isRecord } from "../core/schema.ts";

/** i18n keys used when formatting HTTP/non-JSON response failures for the UI. */
export type ApiErrorKey = "errHttpStatus" | "errHttpStatusDetail" | "errInvalidResponse";

const DEFAULT_MESSAGES: Record<ApiErrorKey, string> = {
  errHttpStatus: "Request failed (HTTP {status})",
  errHttpStatusDetail: "Request failed (HTTP {status}): {detail}",
  errInvalidResponse: "Invalid response from host (HTTP {status})",
};

const MAX_ERROR_DETAIL = 160;

/** Collapse whitespace and cap length so a plain-text server error stays readable in the UI. */
function summarizeDetail(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MAX_ERROR_DETAIL ? `${clean.slice(0, MAX_ERROR_DETAIL - 1)}…` : clean;
}

/** Short title extracted from an HTML error page (e.g. nginx `<title>502 Bad Gateway</title>`), if any. */
function htmlTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (match === null) return "";
  return summarizeDetail((match[1] ?? "").replace(/<[^>]*>/g, ""));
}

/** True when a non-JSON body looks like an HTML document rather than plain error text. */
function looksLikeHtml(contentType: string, text: string): boolean {
  if (/text\/html|application\/xhtml/i.test(contentType)) return true;
  return /^\s*</.test(text);
}

/** Drop a redundant leading HTTP status code (e.g. `"502 Bad Gateway"` → `"Bad Gateway"`). */
function stripLeadingStatus(detail: string, statusCode: number): string {
  const prefix = new RegExp(`^${statusCode}(?:\\s*[:\\-–—]?\\s+|\\s*$)`);
  return detail.replace(prefix, "").trim();
}

/**
 * Decode one `/orca-api` response into its JSON payload or throw a concise,
 * UI-friendly error when the host or an intermediate proxy returns an error
 * or a non-JSON body (such as an HTML 502 page or empty response).
 */
export async function parseApiResponse(
  response: Response,
  translate: (key: ApiErrorKey) => string = (key) => DEFAULT_MESSAGES[key],
): Promise<unknown> {
  const text = await response.text();
  let data: unknown;
  let parsed = false;
  if (text.trim() !== "") {
    try {
      data = JSON.parse(text);
      parsed = true;
    } catch {
      // Non-JSON body; handled below with a concise, UI-friendly message.
    }
  }
  const statusText = response.statusText.trim();
  const status = statusText !== "" ? `${response.status} ${statusText}` : String(response.status);
  if (!response.ok) {
    if (parsed && isRecord(data)) {
      const message =
        typeof data.error === "string" && data.error.trim() !== ""
          ? data.error.trim()
          : typeof data.message === "string" && data.message.trim() !== ""
            ? data.message.trim()
            : null;
      if (message !== null) throw new Error(message);
    }
    const contentType = response.headers.get("content-type") ?? "";
    let detail = "";
    if (looksLikeHtml(contentType, text)) {
      detail = stripLeadingStatus(htmlTitle(text), response.status);
    } else if (!parsed) {
      detail = stripLeadingStatus(summarizeDetail(text), response.status);
    }
    if (
      detail !== "" &&
      (detail.toLowerCase() === statusText.toLowerCase() || detail.toLowerCase() === status.toLowerCase())
    ) {
      detail = "";
    }
    const message =
      detail !== ""
        ? translate("errHttpStatusDetail").replace("{status}", status).replace("{detail}", detail)
        : translate("errHttpStatus").replace("{status}", status);
    throw new Error(message);
  }
  if (!parsed) {
    throw new Error(translate("errInvalidResponse").replace("{status}", status));
  }
  return data;
}
