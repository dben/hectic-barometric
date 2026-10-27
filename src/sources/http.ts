export async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    // fetch() hides the useful part (DNS, TLS, reset) in `cause`.
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : "";
    throw new Error(`GET ${url} failed${cause}`, { cause: err });
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}
