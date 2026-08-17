# zoho-mail-mcp

A Model Context Protocol (MCP) server that gives Claude read access to
Zoho Mail — list and search your inbox, read full email content, and
save draft replies for you to review and send yourself. It never sends
anything on its own.

## Why this exists

Claude chat doesn't ship with a first party Zoho connector. This server
fills that gap the same way `github-mcp` fills it for GitHub: a small
local server Claude Desktop talks to over stdio, authenticated with your
own Zoho credentials.

## What it can do

- List folders (Inbox, Drafts, Sent, custom folders)
- List recent emails in a folder
- Search emails using Zoho Mail's search syntax
- Read the full content of a specific email
- Save a draft reply to an email, properly threaded (To, `Re: subject`,
  and the reply headers filled in automatically)
- Save a new draft from scratch

**It cannot send email.** There is no `send` tool, on purpose — every
draft it creates sits in your Drafts folder until you open it in Zoho
Mail and send it yourself.

## Setup

### 1. Clone and install

```
git clone https://github.com/JessicaTemplet/zoho-mail-mcp.git
cd zoho-mail-mcp
npm install
npm run build
```

### 2. Register a Self Client in the Zoho API Console

Zoho Mail's API uses OAuth2, not a simple token like GitHub's PATs, but
for a personal script like this one, Zoho has a "Self Client" flow that
skips the browser consent screen entirely.

1. Go to [api-console.zoho.com](https://api-console.zoho.com/) and sign
   in with the same Zoho account as your mailbox.
2. Click **GET STARTED**, hover over **Self Client**, click **CREATE
   NOW**, then **CREATE** and **OK**.
3. You'll land on a **Client Secret** tab showing a **Client ID** and
   **Client Secret**. Copy both — you'll need them below.

### 3. Generate an authorization code, then trade it for a refresh token

Still in the API Console, on the same Self Client:

1. Click the **Generate Code** tab.
2. Scope: paste this exactly —
   ```
   ZohoMail.accounts.READ,ZohoMail.folders.READ,ZohoMail.messages.READ,ZohoMail.messages.CREATE
   ```
3. Set an expiry time (10 minutes is plenty — you're about to use it
   immediately) and a description (e.g. "claude mcp"), then click
   **CREATE**.
4. Copy the authorization code it generates. It's only valid for the
   window you picked, so move to the next step right away.
5. Exchange it for tokens. Run this in a terminal (replace the three
   bracketed values):

   ```
   curl "https://accounts.zoho.com/oauth/v2/token?client_id=[CLIENT_ID]&client_secret=[CLIENT_SECRET]&grant_type=authorization_code&code=[AUTH_CODE]"
   ```

   If your Zoho Mail is on a non-US data center (the URL you use to
   check mail is `mail.zoho.eu`, `.in`, etc. instead of `mail.zoho.com`),
   use `accounts.zoho.eu` / `.in` / etc. here instead.

6. The response is JSON with an `access_token` (ignore it, it expires in
   an hour) and a `refresh_token` (this is the one that matters — it
   doesn't expire on its own). Save the refresh token somewhere safe.

### 4. Add it to your Claude Desktop config

Open Claude Desktop → Settings → Developer → Edit Config, and add:

```json
{
  "mcpServers": {
    "zoho-mail": {
      "command": "node",
      "args": ["/absolute/path/to/zoho-mail-mcp/dist/index.js"],
      "env": {
        "ZOHO_CLIENT_ID": "your-client-id",
        "ZOHO_CLIENT_SECRET": "your-client-secret",
        "ZOHO_REFRESH_TOKEN": "your-refresh-token"
      }
    }
  }
}
```

If your account is outside the US data center, also add
`"ZOHO_DATA_CENTER": "eu"` (or `in`, `com.au`, `jp`, `ca`, `sa`) to the
`env` block.

### 5. Restart Claude Desktop

## Notes

- Credentials are read from environment variables at runtime and never
  written to disk by this server. Don't commit a `.env` file or your
  refresh token to this repo.
- The refresh token doesn't expire on its own, but you can revoke it
  anytime from the API Console if you need to cut off access.
- Built against the official `@modelcontextprotocol/sdk`, using native
  `fetch` for the Zoho REST calls (no Zoho SDK exists for this).

## License

MIT, see [LICENSE](./LICENSE).
