export interface Page<T> {
  items: T[];
  nextPageToken: string | null | undefined;
}

export interface CollectOptions<T> {
  /** Hard cap on pages fetched (default 50), so a misbehaving API can't loop forever. */
  maxPages?: number;
  /** Called with each page's items. Return true to stop after this page. */
  stopAfter?: (items: T[]) => boolean;
}

/** Fetches Google-style pages (pageToken/nextPageToken) and concatenates their items. */
export async function collectPages<T>(
  fetchPage: (pageToken: string | undefined) => Promise<Page<T>>,
  opts: CollectOptions<T> = {},
): Promise<T[]> {
  const maxPages = opts.maxPages ?? 50;
  const out: T[] = [];
  const seen = new Set<string>();
  let token: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(token);
    out.push(...page.items);
    if (opts.stopAfter?.(page.items)) break;
    const next = page.nextPageToken;
    if (!next || seen.has(next)) break;
    seen.add(next);
    token = next;
  }
  return out;
}
