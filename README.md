# TempMail

TempMail is an Astro static site with a Cloudflare Pages Function that calls the documented Guerrilla Mail JSON API. Guerrilla Mail creates and hosts mailbox addresses and messages; this project is not a mail server.

## Requirements

- Node.js 22.23.4 or newer (required by Astro 7.4.12)
- npm
- Wrangler 4.36.0+ (the `dev:pages` and `deploy` scripts fetch the pinned CLI with `npx`)
- A Cloudflare account to publish the site

## Install and run

```powershell
npm install
npm run dev
```

`npm run dev` serves the Astro pages at `http://localhost:4321`. Astro's development server does not execute Cloudflare Pages Functions, so the mailbox API is not available in that mode.

To run the site and its Pages Function together:

```powershell
npm run dev:pages
```

This builds the static site and starts Wrangler Pages at `http://127.0.0.1:8788`. The browser must be able to reach `https://api.guerrillamail.com`; provider operations are live and create real, temporary mailboxes. Treat addresses and messages as real data.

## Test the mailbox

1. Open the Wrangler Pages URL and wait for an address returned by Guerrilla Mail.
2. Send a test message from a mailbox you control. Do not send sensitive information.
3. Wait for the 30-second inbox check or select **Refresh**.
4. Open the message to inspect the formatted and plain-text views.
5. Test copy, QR, a custom address name, message deletion, address extension, and **New address**.
6. Reload before the provider's inactivity expiry to check session restoration. The session cookie is HttpOnly; the address and timestamp are cached in local storage.
7. Test a malformed API action or temporarily block the provider host to inspect error handling.

There is no fake inbox or mock provider mode. A provider outage prevents live mailbox tests.

## Build and checks

```powershell
npm run check
npm run build
```

The static output is `dist/`. `npm run build` also generates the sitemap. The Cloudflare Function stays in the root `functions/` directory and is deployed alongside the static output by Pages.

## Guerrilla Mail integration notes

The implementation was based on Guerrilla Mail's [published JSON API documentation](https://www.guerrillamail.com/GuerrillaMailAPI.html). The documentation specifies `get_email_address`, `check_email`, `get_email_list`, `fetch_email`, `set_email_user`, `forget_me`, `del_email`, and `extend`; it requires the visitor IP and user-agent, and says the `PHPSESSID` cookie must be retained and sent on subsequent calls. It describes non-subscriber addresses as lasting 60 minutes, inactive sessions as expiring after about 18 minutes, and numeric API rate limits as unpublished.

The live HTTPS `get_email_address` endpoint was checked during development: it returned HTTP 200 JSON with an email and Unix timestamp and set `PHPSESSID`. Its response also contained fields not needed by this application; the Function does not forward provider session tokens or arbitrary response fields. The provider currently advertises `Access-Control-Allow-Origin: *`; the browser calls TempMail's same-origin `/api/mailbox` endpoint instead, avoiding credentialed cross-origin requests. The Function forwards only the required IP/user-agent parameters and its own HttpOnly provider-session cookie. API failures and session expiry remain dependent on the live provider.

The service does not document a numeric API quota. The app polls every 30 seconds, and a Cloudflare Rate Limiting binding is configured for 30 requests per minute per edge location. Cloudflare describes these counters as approximate and location-scoped, not a strict global quota. A small per-isolate fallback is used when the binding is absent (for example, in a non-Wrangler test); if a configured binding fails, the API fails closed with HTTP 503. For a strict limit, put the site behind a Cloudflare zone with an appropriate WAF rate-limiting rule; do not raise provider request frequency without permission.

### Provider limitations

- Guerrilla Mail controls mailbox delivery, address reuse, retention, and session expiry.
- The provider documents `del_email` and `extend`, but success depends on provider response.
- TempMail's browser receives an address and message content; message bodies are not put into an application database or logged by this Function.
- Email HTML is sanitized with DOMPurify and displayed in an iframe with an empty sandbox, a restrictive content security policy, and remote images disabled. The provider also documents filtering HTML in `fetch_email`; this client-side isolation is an additional boundary.
- A provider session can expire even if a cached address remains in local storage. Local storage does not restore the provider session; the HttpOnly cookie does.
- The provider's public API documentation dates from 2011. The endpoint and initial-address response were live-checked, but provider behavior may change without notice.

## Cloudflare Pages deployment

### Git-connected Pages project (recommended)

1. Push this project to a Git provider connected to your Cloudflare account.
2. In **Workers & Pages → Create → Pages → Connect to Git**, select the repository.
3. Set the production branch to `main` (or your chosen branch).
4. Set the build command to `npm run build` and the build output directory to `dist`.
5. Use Node.js 22.23.4 or newer for the build environment (set `NODE_VERSION=22.23.4` in the Pages build environment). The Pages Functions source is `functions/` at the repository root.
6. Keep `wrangler.jsonc` in the repository. It defines the Pages output directory and mailbox rate-limit binding. Use an integer `namespace_id` unique to your Cloudflare account if `730241` is already in use.
7. Use the Pages V2 build system, which supports the Wrangler configuration file and its bindings.
8. Deploy. Pages builds the static Astro site and deploys `functions/api/[[path]].js` with it.
9. In **Settings → Domains & Routes**, confirm the generated `tempmail.pages.dev` address. No API key, provider credential, KV namespace, or mailbox secret is required.

### Deploy from a local checkout

```powershell
npm install
npm run deploy
```

Authenticate Wrangler first with `npx --yes wrangler@4.162.0 login`. The command builds `dist/` and deploys it to the Pages project named `tempmail`; `functions/` is discovered from the project root. If this is the first deployment, create the Pages project with that name in the Cloudflare dashboard first.

The production canonical origin is `https://tempmail.pages.dev`. No localhost address is embedded in the production site.

## Troubleshooting

- **The page loads but the mailbox does not:** use `npm run dev:pages`, not `npm run dev`. Check the browser Network panel for `/api/mailbox` errors.
- **Provider timeout or 502:** Guerrilla Mail may be unavailable, or Cloudflare may not be able to reach it. Retry after a short wait; do not poll repeatedly.
- **401 / session expired:** select **New address**. Provider sessions can expire after inactivity and cannot be restored from local storage alone.
- **429:** wait before refreshing. Provider quotas are unpublished; the app also applies its own rate limit.
- **Cloudflare Function is missing after deployment:** confirm `functions/` is at the repository root, not inside `public/` or `dist/`, and check the Pages deployment's Functions logs.
- **The address changes after a long pause:** this can happen when the provider session expires and is consistent with the provider's documented behavior.
- **Email images do not load:** remote content is intentionally blocked in the isolated message viewer to prevent tracking and unsafe content from contacting third parties.
- **Wrangler rejects the rate limit binding:** the project scripts pin Wrangler 4.162.0; use version 4.36.0 or later and a `namespace_id` unique to your account. Verify that `wrangler.jsonc` is the configuration source used by your Pages project.
