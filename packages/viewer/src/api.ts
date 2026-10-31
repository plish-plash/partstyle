import type { Comment, Focus, ViewerModel } from "@partstyle/engine";

// The custom header makes every write a non-simple request, which the server only accepts from
// its own origin: a web page elsewhere cannot post to the local viewer.
const headers = { "content-type": "application/json", "x-partstyle": "1" };

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

export async function fetchModel(): Promise<ViewerModel> {
  const res = await fetch("api/model");
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as ViewerModel;
}

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
