import type { Comment, Focus, ViewerModel } from "@partstyle/engine";

// The custom header makes every write a non-simple request, which the server only accepts from
// its own origin: a web page elsewhere cannot post to the local viewer.
const headers = { "content-type": "application/json", "x-partstyle": "1" };

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

/** Which version of the design to show: the main line or a variant, optionally with a pending patch. */
export interface View {
  variant?: string;
  preview?: string;
}

export async function fetchModel(view: View = {}): Promise<ViewerModel> {
  const q = new URLSearchParams();
  if (view.variant) q.set("variant", view.variant);
  if (view.preview) q.set("preview", view.preview);
  const res = await fetch(`api/model${q.size > 0 ? `?${q}` : ""}`);
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as ViewerModel;
}

type Result = { ok: boolean; text: string };

export const revert = (id: string, variant?: string) => post<Result>("api/revert", { id, variant });

export const checkpoint = (message: string, variant?: string) =>
  post<Result>("api/checkpoint", { message, variant });

export const decidePending = (op: "accept" | "reject", id: string, variant?: string) =>
  post<Result>("api/pending", { op, id, variant });

export const variantOp = (op: "create" | "adopt" | "remove", name: string) =>
  post<Result>("api/variant", { op, name });

export const sendFocus = (focus: Focus) => post<{ ok: true }>("api/focus", focus);

export const addComment = (subject: string, text: string) =>
  post<Comment>("api/comments", { subject, text });

export const resolveComment = (id: string) =>
  post<{ ok: boolean; text: string }>(`api/comments/${encodeURIComponent(id)}/resolve`, {});

export const verifyPart = (id: string) => post<{ ok: boolean; text: string }>("api/verify", { id });

/** Calls `onChange` whenever the project's files change; returns an unsubscribe function. */
export function subscribe(onChange: () => void): () => void {
  const events = new EventSource("api/events");
  events.addEventListener("change", onChange);
  return () => events.close();
}
