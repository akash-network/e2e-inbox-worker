import PostalMime from "postal-mime";

export interface Env {
  DB: D1Database;
  INBOX_API_TOKEN: string;
}

/** Messages older than this are excluded from reads and purged on each insert and on the scheduled cron. */
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1_000;

const MESSAGES_PATH = /^\/messages\/([^/]+)$/;

/** Attribute values are matched as whole quoted strings, so a `>` inside one does not end the tag early. */
const ANCHOR = /<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a\s*>/gi;

const HREF_ATTRIBUTE = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };

const MAX_CODE_POINT = 0x10ffff;

export interface EmailLink {
  text: string;
  href: string;
}

export default {
  async email(message, env): Promise<void> {
    const parsed = await PostalMime.parse(message.raw);
    const html = parsed.html ?? "";
    const textBody = parsed.text?.trim() ? parsed.text : htmlToText(html);

    await env.DB.batch([
      purgeExpiredStatement(env),
      env.DB.prepare("INSERT INTO messages (id, recipient, received_ms, subject, text_body, links) VALUES (?, ?, ?, ?, ?, ?)").bind(
        crypto.randomUUID(),
        message.to.toLowerCase(),
        Date.now(),
        parsed.subject ?? "",
        textBody,
        JSON.stringify(extractLinks(html))
      )
    ]);
  },

  async scheduled(_controller, env): Promise<void> {
    await purgeExpiredStatement(env).run();
  },

  async fetch(request, env): Promise<Response> {
    if (!isAuthorized(request, env)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const recipientMatch = request.method === "GET" ? new URL(request.url).pathname.match(MESSAGES_PATH) : null;
    if (!recipientMatch) {
      return new Response("Not found", { status: 404 });
    }

    const recipient = decodeURIComponent(recipientMatch[1]).toLowerCase();
    const { results } = await env.DB.prepare(
      "SELECT id, received_ms, subject, text_body, links FROM messages WHERE recipient = ? AND received_ms >= ? ORDER BY received_ms DESC"
    )
      .bind(recipient, Date.now() - MESSAGE_TTL_MS)
      .all();

    return Response.json(
      results.map(row => ({
        id: row.id,
        receivedMs: row.received_ms,
        subject: row.subject,
        text: row.text_body,
        links: JSON.parse(String(row.links)) as EmailLink[]
      }))
    );
  }
} satisfies ExportedHandler<Env>;

function purgeExpiredStatement(env: Env): D1PreparedStatement {
  return env.DB.prepare("DELETE FROM messages WHERE received_ms < ?").bind(Date.now() - MESSAGE_TTL_MS);
}

function isAuthorized(request: Request, env: Env): boolean {
  return Boolean(env.INBOX_API_TOKEN) && request.headers.get("Authorization") === `Bearer ${env.INBOX_API_TOKEN}`;
}

/** Fallback for emails that carry only an HTML part: strip tags so OTP-code regexes can run over plain text. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The flattened text drops every href, so emailed links (confirmation buttons, invitations) are kept beside it with their labels. */
function extractLinks(html: string): EmailLink[] {
  return [...html.matchAll(ANCHOR)].flatMap(([, attributes, content]) => {
    const href = attributes.match(HREF_ATTRIBUTE);
    if (!href) return [];

    return [{ text: decodeEntities(htmlToText(content)), href: decodeEntities(href[1] ?? href[2] ?? href[3]).trim() }];
  });
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith("#")) {
      const codePoint = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return codePoint <= MAX_CODE_POINT ? String.fromCodePoint(codePoint) : entity;
    }

    return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
  });
}
