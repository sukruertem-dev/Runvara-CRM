const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const WEB_BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

interface SearchResponse {
  messages?: { ID: string; Subject: string; To: { Address: string }[] }[];
}

interface MessageResponse {
  Text: string;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits for a mail to `to` whose subject contains `subject`, and returns the first link whose path starts with `pathPrefix`. */
export async function waitForLink(to: string, subject: string, pathPrefix: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    if (res.ok) {
      const body = (await res.json()) as SearchResponse;
      const hit = body.messages?.find((m) => m.Subject.includes(subject));
      if (hit) {
        const msg = await fetch(`${MAILPIT_URL}/api/v1/message/${hit.ID}`);
        const detail = (await msg.json()) as MessageResponse;
        for (const match of detail.Text.matchAll(/https?:\/\/[^\s<>"')]+/g)) {
          const url = new URL(match[0]);
          if (url.pathname.startsWith(pathPrefix)) return new URL(`${url.pathname}${url.search}`, WEB_BASE).toString();
        }
      }
    }
    await sleep(500);
  }
  throw new Error(`No mail to ${to} with subject "${subject}" and link ${pathPrefix} within ${String(timeoutMs)} ms`);
}

/** The `token` query parameter of the first link in a matching mail (verification, invitation). */
export async function waitForToken(to: string, subject: string, timeoutMs = 15_000): Promise<string> {
  const link = await waitForLink(to, subject, '/', timeoutMs);
  const token = new URL(link).searchParams.get('token');
  if (!token) throw new Error(`mail to ${to} has no token link`);
  return token;
}
