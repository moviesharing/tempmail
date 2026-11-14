import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { onRequest } from "../functions/api/[[path]].js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function request(action, values = {}, options = {}) {
  return new Request("https://tempmail.pages.dev/api/mailbox", {
    method: options.method || "POST",
    headers: {
      "Content-Type": options.contentType || "application/json",
      "CF-Connecting-IP": options.ip || `192.0.2.${Math.floor(Math.random() * 200) + 1}`,
      "User-Agent": "TempMail API test",
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.origin ? { Origin: options.origin } : {}),
    },
    body: options.method === "GET" ? undefined : JSON.stringify({ action, ...values }),
  });
}

async function invoke(req, env = {}) {
  return onRequest({ request: req, env });
}

test("initialization stores the upstream session in a scoped HttpOnly cookie", async () => {
  let upstream;
  globalThis.fetch = async (input, init) => {
    upstream = { url: new URL(input), init };
    return new Response(JSON.stringify({
      email_addr: "example@sharklasers.com",
      email_timestamp: 1_800_000_000,
      sid_token: "must-not-reach-browser",
    }), {
      headers: { "Set-Cookie": "PHPSESSID=provider-session; Path=/; HttpOnly" },
    });
  };

  const response = await invoke(request("init", {}, {
    origin: "https://tempmail.pages.dev",
    ip: "192.0.2.1",
  }));
  const data = await response.json();
  const cookie = response.headers.get("Set-Cookie");

  assert.equal(response.status, 200);
  assert.deepEqual(data, { email: "example@sharklasers.com", timestamp: 1_800_000_000, subscriptionActive: false });
  assert.match(cookie, /tm_gm_session=provider-session/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\/api/);
  assert.equal(upstream.url.origin, "https://api.guerrillamail.com");
  assert.equal(upstream.url.searchParams.get("f"), "get_email_address");
  assert.equal(upstream.url.searchParams.get("ip"), "192.0.2.1");
  assert.equal(upstream.init.headers.Cookie, undefined);
  assert.equal(JSON.stringify(data).includes("must-not-reach-browser"), false);
});

test("inbox checks forward only the provider session and return normalized message fields", async () => {
  let upstream;
  globalThis.fetch = async (input, init) => {
    upstream = { url: new URL(input), init };
    return new Response(JSON.stringify({
      email: "example@sharklasers.com",
      ts: 1_800_000_000,
      count: 1,
      list: [{
        mail_id: 47,
        mail_from: "sender@example.net",
        mail_subject: "Hello",
        mail_excerpt: "A short preview",
        mail_timestamp: 1_800_000_010,
        mail_date: "2027-01-15 12:00",
        mail_read: 0,
        sid_token: "must-not-reach-browser",
      }],
      sid_token: "must-not-reach-browser",
    }), {
      headers: { "Set-Cookie": "PHPSESSID=rotated-session; Path=/; HttpOnly" },
    });
  };

  const response = await invoke(request("check", { seq: 0 }, {
    cookie: "tm_gm_session=old-session",
    origin: "https://tempmail.pages.dev",
  }));
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(upstream.url.searchParams.get("f"), "check_email");
  assert.equal(upstream.url.searchParams.get("seq"), "0");
  assert.equal(upstream.init.headers.Cookie, "PHPSESSID=old-session");
  assert.equal(response.headers.get("Set-Cookie").includes("rotated-session"), true);
  assert.equal(data.messages[0].mail_id, 47);
  assert.equal(JSON.stringify(data).includes("sid_token"), false);
});

test("message retrieval returns only whitelisted content fields", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    mail_id: 47,
    mail_from: "sender@example.net",
    mail_subject: "Hello",
    mail_body: "<p>Hello</p>",
    mail_text: "Hello",
    sid_token: "must-not-reach-browser",
  }));

  const response = await invoke(request("fetch", { id: 47 }, {
    cookie: "tm_gm_session=provider-session",
  }));
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.mail_body, "<p>Hello</p>");
  assert.equal(data.mail_text, "Hello");
  assert.equal(Object.hasOwn(data, "sid_token"), false);
});

test("new address forgets the old address, then initializes the provider's replacement", async () => {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    const params = init.method === "POST" ? new URLSearchParams(init.body) : url.searchParams;
    calls.push({ fn: params.get("f"), cookie: init.headers.Cookie });
    if (params.get("f") === "forget_me") {
      return new Response("true", {
        headers: { "Set-Cookie": "PHPSESSID=after-forget; Path=/; HttpOnly" },
      });
    }
    return new Response(JSON.stringify({
      email_addr: "replacement@sharklasers.com",
      email_timestamp: 1_800_000_100,
    }), {
      headers: { "Set-Cookie": "PHPSESSID=final-session; Path=/; HttpOnly" },
    });
  };

  const response = await invoke(request("new", {
    email: "old@sharklasers.com",
  }, {
    cookie: "tm_gm_session=old-session",
  }));

  assert.equal(response.status, 200);
  assert.equal((await response.json()).email, "replacement@sharklasers.com");
  assert.deepEqual(calls, [
    { fn: "forget_me", cookie: "PHPSESSID=old-session" },
    { fn: "get_email_address", cookie: "PHPSESSID=after-forget" },
  ]);
  assert.match(response.headers.get("Set-Cookie"), /final-session/);
});

test("deletion uses the documented email_ids[] argument and validates returned ids", async () => {
  let upstream;
  globalThis.fetch = async (input, init) => {
    upstream = { url: new URL(input), init };
    return new Response(JSON.stringify([47]));
  };

  const response = await invoke(request("delete", { ids: [47] }, {
    cookie: "tm_gm_session=provider-session",
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deletedIds: [47] });
  const form = new URLSearchParams(upstream.init.body);
  assert.equal(upstream.url.href, "https://api.guerrillamail.com/ajax.php");
  assert.equal(upstream.init.method, "POST");
  assert.equal(form.get("f"), "del_email");
  assert.deepEqual(form.getAll("email_ids[]"), ["47"]);
});

test("unsupported, malformed, and cross-origin requests are rejected before contacting the provider", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("Provider should not be called");
  };

  const unsupported = await invoke(request("proxy", {}, { cookie: "tm_gm_session=valid" }));
  const invalidMessage = await invoke(request("fetch", { id: -1 }, { cookie: "tm_gm_session=valid" }));
  const crossOrigin = await invoke(request("init", {}, { origin: "https://attacker.example" }));
  const wrongMethod = await invoke(request("init", {}, { method: "GET" }));

  assert.equal(unsupported.status, 400);
  assert.equal(invalidMessage.status, 400);
  assert.equal(crossOrigin.status, 403);
  assert.equal(wrongMethod.status, 405);
  assert.equal(calls, 0);
});

test("provider rate limits are surfaced as HTTP 429", async () => {
  globalThis.fetch = async () => new Response("limited", { status: 429 });
  const response = await invoke(request("init"));
  const data = await response.json();

  assert.equal(response.status, 429);
  assert.match(data.error, /rate limiting/);
});
