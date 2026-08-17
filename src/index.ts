import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// --- Config -----------------------------------------------------------
// Self Client credentials from the Zoho API Console (api-console.zoho.com).
// See README for how to generate these.
const CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;

// Zoho splits users across regional data centers, each on its own domain.
// Most US accounts are "com". If your Zoho Mail URL in the browser is
// mail.zoho.eu / mail.zoho.in / etc., set ZOHO_DATA_CENTER to match
// ("eu", "in", "com.au", "jp", "ca", "sa").
const DATA_CENTER = process.env.ZOHO_DATA_CENTER || "com";
const ACCOUNTS_BASE = `https://accounts.zoho.${DATA_CENTER}`;
const MAIL_BASE = `https://mail.zoho.${DATA_CENTER}`;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error(
    "ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, and ZOHO_REFRESH_TOKEN environment variables are required"
  );
  process.exit(1);
}

// --- OAuth token management --------------------------------------------
// Zoho access tokens are short-lived (1hr). The refresh token doesn't
// expire on its own, so we just mint a new access token whenever the
// cached one is stale, rather than trying to persist anything to disk.
let accessToken: string | null = null;
let accessTokenExpiresAt = 0; // epoch ms

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  // 60s buffer so we don't hand out a token that expires mid-request.
  if (accessToken && now < accessTokenExpiresAt - 60_000) {
    return accessToken;
  }

  const url = new URL(`${ACCOUNTS_BASE}/oauth/v2/token`);
  url.searchParams.set("refresh_token", REFRESH_TOKEN!);
  url.searchParams.set("client_id", CLIENT_ID!);
  url.searchParams.set("client_secret", CLIENT_SECRET!);
  url.searchParams.set("grant_type", "refresh_token");

  const res = await fetch(url.toString(), { method: "POST" });
  const data = await res.json();

  if (!res.ok || !data.access_token) {
    throw new Error(`Zoho token refresh failed: ${JSON.stringify(data)}`);
  }

  accessToken = data.access_token as string;
  accessTokenExpiresAt = now + (data.expires_in ?? 3600) * 1000;
  return accessToken;
}

// Thin fetch wrapper for the Zoho Mail API. Handles auth, JSON parsing,
// and Zoho's status-in-200-body error convention.
async function zohoFetch(path: string, init: RequestInit = {}): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(`${MAIL_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      // Zoho's own OAuth docs say "Bearer", but the Mail API specifically
      // wants this non-standard prefix instead. Using "Bearer" here just
      // gets a silent 401.
      Authorization: `Zoho-oauthtoken ${token}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });

  const data = await res.json();
  if (!res.ok || (data?.status?.code && data.status.code >= 400)) {
    throw new Error(`Zoho API error (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

// --- Account / folder resolution ---------------------------------------
// Cached for the life of the process. accountId and the primary send
// address don't change mid-session, and re-fetching folders on every
// call would be wasteful.
let cachedAccount: { accountId: string; primaryAddress: string } | null = null;
let cachedFolders: any[] | null = null;

async function getAccount() {
  if (cachedAccount) return cachedAccount;
  const data = await zohoFetch("/api/accounts");
  const acct = data.data[0];
  const primaryAddress =
    acct.emailAddress?.find((e: any) => e.isPrimary)?.mailId ?? acct.incomingUserName;
  cachedAccount = { accountId: acct.accountId as string, primaryAddress: primaryAddress as string };
  return cachedAccount;
}

async function getFolders() {
  if (cachedFolders) return cachedFolders;
  const { accountId } = await getAccount();
  const data = await zohoFetch(`/api/accounts/${accountId}/folders`);
  cachedFolders = data.data;
  return cachedFolders!;
}

// Accepts a raw folderId, a folder name ("Inbox", "Drafts", ...), or
// nothing (defaults to Inbox) — so tool calls don't have to look up the
// folderId separately for the common case.
async function resolveFolderId(folderIdOrName?: string): Promise<string> {
  const folders = await getFolders();
  if (!folderIdOrName) {
    const inbox = folders.find((f) => f.folderType === "Inbox");
    if (!inbox) throw new Error("Could not find an Inbox folder on this account");
    return inbox.folderId;
  }
  const byId = folders.find((f) => f.folderId === folderIdOrName);
  if (byId) return byId.folderId;
  const byName = folders.find(
    (f) => f.folderName.toLowerCase() === folderIdOrName.toLowerCase()
  );
  if (byName) return byName.folderId;
  // Not matched by name — assume the caller already passed a real folderId.
  return folderIdOrName;
}

// The numeric "messageId" Zoho uses in its own URLs is not the same thing
// as the RFC 822 Message-ID header, and threading a reply needs the
// latter. We fetch the raw header block and pull it out with a regex
// rather than relying on any particular parsed-JSON shape, since Zoho's
// docs don't show what raw=false returns.
function extractMessageIdHeader(headerContent: string): string | null {
  const match = headerContent.match(/^Message-Id:\s*(<[^>]+>)/im);
  return match ? match[1] : null;
}

// --- MCP server ----------------------------------------------------------
const server = new Server(
  { name: "zoho-mail-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_folders",
      description: "List all folders in the Zoho Mail account (Inbox, Drafts, Sent, custom folders, etc.)",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_emails",
      description: "List recent emails in a folder, most recent first. Defaults to Inbox.",
      inputSchema: {
        type: "object",
        properties: {
          folder: { type: "string", description: "Folder name (e.g. 'Inbox', 'Sent') or folderId. Defaults to Inbox." },
          limit: { type: "number", description: "Max emails to return (1-200)", default: 10 },
          start: { type: "number", description: "1-based starting index, for pagination", default: 1 },
        },
      },
    },
    {
      name: "search_emails",
      description:
        "Search emails using Zoho Mail's search syntax, e.g. 'from:jane@example.com', 'subject:invoice', or 'newMails' for unread.",
      inputSchema: {
        type: "object",
        properties: {
          searchKey: { type: "string", description: "Zoho Mail search syntax" },
          limit: { type: "number", default: 10 },
          start: { type: "number", default: 1 },
        },
        required: ["searchKey"],
      },
    },
    {
      name: "get_email",
      description:
        "Get the full content of a specific email (subject, from, to, cc, date, body) given its messageId and folderId from list_emails or search_emails.",
      inputSchema: {
        type: "object",
        properties: {
          messageId: { type: "string" },
          folderId: { type: "string" },
        },
        required: ["messageId", "folderId"],
      },
    },
    {
      name: "create_draft_reply",
      description:
        "Save a draft reply to an existing email, properly threaded (To, Re: subject, and reply headers filled in automatically). Never sends — the draft waits in the Drafts folder for manual review and send.",
      inputSchema: {
        type: "object",
        properties: {
          messageId: { type: "string", description: "messageId of the email being replied to" },
          folderId: { type: "string", description: "folderId of the email being replied to" },
          content: { type: "string", description: "Reply body" },
          mailFormat: { type: "string", enum: ["html", "plaintext"], default: "html" },
          ccAddress: { type: "string" },
          bccAddress: { type: "string" },
        },
        required: ["messageId", "folderId", "content"],
      },
    },
    {
      name: "create_draft",
      description:
        "Save a new (non-reply) draft email. Never sends — the draft waits in the Drafts folder for manual review and send.",
      inputSchema: {
        type: "object",
        properties: {
          toAddress: { type: "string" },
          subject: { type: "string" },
          content: { type: "string" },
          mailFormat: { type: "string", enum: ["html", "plaintext"], default: "html" },
          ccAddress: { type: "string" },
          bccAddress: { type: "string" },
        },
        required: ["toAddress", "subject", "content"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list_folders": {
        const folders = await getFolders();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                folders.map((f) => ({
                  folderId: f.folderId,
                  folderName: f.folderName,
                  folderType: f.folderType,
                  path: f.path,
                })),
                null,
                2
              ),
            },
          ],
        };
      }

      case "list_emails": {
        const { accountId } = await getAccount();
        const folderId = await resolveFolderId(args?.folder as string);
        const limit = (args?.limit as number) ?? 10;
        const start = (args?.start as number) ?? 1;
        const data = await zohoFetch(
          `/api/accounts/${accountId}/messages/view?folderId=${folderId}&start=${start}&limit=${limit}`
        );
        const emails = (data.data ?? []).map((m: any) => ({
          messageId: m.messageId,
          folderId: m.folderId,
          subject: m.subject,
          from: m.fromAddress,
          to: m.toAddress,
          receivedTime: m.receivedTime ? new Date(Number(m.receivedTime)).toISOString() : null,
          summary: m.summary,
          hasAttachment: m.hasAttachment === "1",
        }));
        return { content: [{ type: "text", text: JSON.stringify(emails, null, 2) }] };
      }

      case "search_emails": {
        const { accountId } = await getAccount();
        const searchKey = encodeURIComponent(args!.searchKey as string);
        const limit = (args?.limit as number) ?? 10;
        const start = (args?.start as number) ?? 1;
        const data = await zohoFetch(
          `/api/accounts/${accountId}/messages/search?searchKey=${searchKey}&start=${start}&limit=${limit}`
        );
        const emails = (data.data ?? []).map((m: any) => ({
          messageId: m.messageId,
          folderId: m.folderId,
          subject: m.subject,
          from: m.fromAddress,
          to: m.toAddress,
          receivedTime: m.receivedTime ? new Date(Number(m.receivedTime)).toISOString() : null,
          summary: m.summary,
        }));
        return { content: [{ type: "text", text: JSON.stringify(emails, null, 2) }] };
      }

      case "get_email": {
        const { accountId } = await getAccount();
        const folderId = args!.folderId as string;
        const messageId = args!.messageId as string;

        const [detailsData, contentData, headerData] = await Promise.all([
          zohoFetch(`/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/details`),
          zohoFetch(`/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/content`),
          zohoFetch(`/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/header`),
        ]);
        const d = detailsData.data;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  messageId,
                  folderId,
                  subject: d.subject,
                  from: d.fromAddress,
                  to: d.toAddress,
                  cc: d.ccAddress,
                  receivedTime: d.receivedTime ? new Date(Number(d.receivedTime)).toISOString() : null,
                  hasAttachment: d.hasAttachment === "1",
                  content: contentData.data.content,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "create_draft_reply": {
        const { accountId, primaryAddress } = await getAccount();
        const folderId = args!.folderId as string;
        const messageId = args!.messageId as string;

        const [detailsData, headerData] = await Promise.all([
          zohoFetch(`/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/details`),
          zohoFetch(`/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/header`),
        ]);
        const original = detailsData.data;
        const origMessageIdHeader = extractMessageIdHeader(headerData.data.headerContent);
        const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;

        const body: Record<string, unknown> = {
          mode: "draft",
          fromAddress: primaryAddress,
          toAddress: original.fromAddress,
          subject,
          content: args!.content as string,
          mailFormat: (args?.mailFormat as string) ?? "html",
        };
        if (args?.ccAddress) body.ccAddress = args.ccAddress;
        if (args?.bccAddress) body.bccAddress = args.bccAddress;
        if (origMessageIdHeader) {
          body.inReplyTo = origMessageIdHeader;
          body.refHeader = origMessageIdHeader;
        }

        const data = await zohoFetch(`/api/accounts/${accountId}/messages`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: "text",
              text: `Draft reply saved to Drafts (not sent).\n${JSON.stringify(data.data, null, 2)}`,
            },
          ],
        };
      }

      case "create_draft": {
        const { accountId, primaryAddress } = await getAccount();
        const body: Record<string, unknown> = {
          mode: "draft",
          fromAddress: primaryAddress,
          toAddress: args!.toAddress as string,
          subject: args!.subject as string,
          content: args!.content as string,
          mailFormat: (args?.mailFormat as string) ?? "html",
        };
        if (args?.ccAddress) body.ccAddress = args.ccAddress;
        if (args?.bccAddress) body.bccAddress = args.bccAddress;

        const data = await zohoFetch(`/api/accounts/${accountId}/messages`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        return {
          content: [
            { type: "text", text: `Draft saved to Drafts (not sent).\n${JSON.stringify(data.data, null, 2)}` },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Zoho Mail MCP server running");
