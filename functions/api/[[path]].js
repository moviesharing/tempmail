const API_URL = "https://api.guerrillamail.com/ajax.php";
const SESSION_COOKIE = "tm_gm_session";
const SESSION_MAX_AGE = 18 * 60;
const MAX_BODY_BYTES = 16_384;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 60;
const MUTATING_FUNCTIONS = new Set(["set_email_user", "forget_me", "del_email", "extend"]);
const requestsByAddress = new Map();
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
      ...headers,
    },
  });

function getCookie(request, name) {
  const entry = request.headers
    .get("Cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!entry) return "";
  try {
    return decodeURIComponent(entry.slice(name.length + 1));
  } catch {
    return "";
  }
}

function cookieHeader(value, secure) {
  const secureAttribute = secure ? "; Secure" : "";
  if (!value) {
    return `${SESSION_COOKIE}=; Path=/api; Max-Age=0; HttpOnly; SameSite=Strict${secureAttribute}`;
  }
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/api; Max-Age=${SESSION_MAX_AGE}; HttpOnly; SameSite=Strict${secureAttribute}`;
}

function providerSession(headers) {
  const setCookie = headers.get("Set-Cookie") || "";
  const match = setCookie.match(/(?:^|,\s*)PHPSESSID=([^;\s]+)/i);
  return match?.[1] || "";
}

function validEmail(value) {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)
  );
}

function validId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function allowedFields(source, fields) {
  const result = {};
  for (const field of fields) {
    if (source[field] !== undefined && source[field] !== null) {
      result[field] = source[field];
    }
  }
  return result;
}

async function rateLimited(request, env) {
  const key = request.headers.get("CF-Connecting-IP") || "unknown";
  if (env?.MAILBOX_RATE_LIMITER) {
    try {
      const { success } = await env.MAILBOX_RATE_LIMITER.limit({ key });
      if (!success) return true;
    } catch {
      return null;
    }
  }
  const now = Date.now();
  const current = requestsByAddress.get(key);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    requestsByAddress.set(key, { startedAt: now, count: 1 });
    if (requestsByAddress.size > 2_000) {
      for (const [address, entry] of requestsByAddress) {
        if (now - entry.startedAt >= RATE_WINDOW_MS) requestsByAddress.delete(address);
      }
      while (requestsByAddress.size > 2_000) {
        requestsByAddress.delete(requestsByAddress.keys().next().value);
      }
    }
    return false;
  }
  current.count += 1;
  return current.count > RATE_LIMIT;
}

async function callProvider(fn, args, session, clientIp, userAgent) {
  const params = new URLSearchParams();
  params.set("f", fn);
  params.set("ip", clientIp);
  params.set("agent", userAgent.slice(0, 160));
  for (const [key, value] of Object.entries(args)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.set(key, String(value));
    }
  }
  const headers = { Accept: "application/json" };
  if (session) headers.Cookie = `PHPSESSID=${session}`;
  const method = MUTATING_FUNCTIONS.has(fn) ? "POST" : "GET";
  const endpoint = method === "GET" ? `${API_URL}?${params.toString()}` : API_URL;
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";

  let response;
  try {
    response = await fetch(endpoint, {
      method,
      headers,
      ...(method === "POST" ? { body: params.toString() } : {}),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw Object.assign(new Error("The mail provider timed out."), { status: 504 });
    }
    throw Object.assign(new Error("The mail provider could not be reached."), { status: 502 });
  }

  const nextSession = providerSession(response.headers) || session;
  if (!response.ok) {
    throw Object.assign(
      new Error(response.status === 429 ? "The mail provider is rate limiting requests." : "The mail provider returned an error."),
      { status: response.status === 429 ? 429 : 502, session: nextSession },
    );
  }

  let result;
  try {
    if (Number(response.headers.get("Content-Length")) > 2_000_000) {
      throw Object.assign(new Error("The provider response is too large."), {
        status: 502,
        session: nextSession,
      });
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw Object.assign(new Error("The provider returned an empty response."), {
        status: 502,
        session: nextSession,
      });
    }
    const chunks = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > 2_000_000) {
        await reader.cancel();
        throw Object.assign(new Error("The provider response is too large."), {
          status: 502,
          session: nextSession,
        });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder().decode(bytes);
    result = JSON.parse(text);
  } catch (error) {
    if (error?.status === 502) throw error;
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw Object.assign(new Error("The mail provider timed out."), {
        status: 504,
        session: nextSession,
      });
    }
    throw Object.assign(new Error("The mail provider returned an unreadable response."), {
      status: 502,
      session: nextSession,
    });
  }
  if (result === null || result === undefined) {
    throw Object.assign(new Error("The mail provider returned an invalid response."), {
      status: 502,
      session: nextSession,
    });
  }
  if (typeof result === "object" && !Array.isArray(result) && result.error) {
    throw Object.assign(new Error("The mail provider rejected the request."), {
      status: 502,
      session: nextSession,
    });
  }
  return { result, session: nextSession };
}

function normalizeAddress(result) {
  if (!validEmail(result.email_addr) || !Number.isFinite(Number(result.email_timestamp))) {
    throw Object.assign(new Error("The provider did not return a valid email address."), { status: 502 });
  }
  return {
    email: result.email_addr,
    timestamp: Number(result.email_timestamp),
    subscriptionActive: result.s_active === "Y",
  };
}

function normalizeMessages(result) {
  if (!Array.isArray(result.list)) {
    throw Object.assign(new Error("The provider did not return a message list."), { status: 502 });
  }
  const list = result.list;
  return {
    email: validEmail(result.email) ? result.email : null,
    timestamp: Number.isFinite(Number(result.ts)) ? Number(result.ts) : null,
    count: Number.isFinite(Number(result.count)) ? Number(result.count) : list.length,
    messages: list.slice(0, 20).map((message) =>
      allowedFields(message, [
        "mail_id",
        "mail_from",
        "mail_subject",
        "mail_excerpt",
        "mail_timestamp",
        "mail_date",
        "mail_read",
      ]),
    ),
  };
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/mailbox") return json({ error: "Not found." }, 404);
  if (request.method !== "POST") {
    return json({ error: "Use POST for mailbox requests." }, 405, { Allow: "POST" });
  }
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ error: "Cross-origin requests are not allowed." }, 403);
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Expected a JSON request." }, 415);
  }
  if (Number(request.headers.get("Content-Length")) > MAX_BODY_BYTES) {
    return json({ error: "Request is too large." }, 413);
  }
  const limited = await rateLimited(request, env);
  if (limited === null) return json({ error: "Mailbox rate limiting is unavailable. Please try again later." }, 503);
  if (limited) return json({ error: "Too many mailbox requests. Please wait a moment." }, 429);

  let body;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json({ error: "Request is too large." }, 413);
    }
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON request." }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.action !== "string") {
    return json({ error: "A mailbox action is required." }, 400);
  }

  const secure = url.protocol === "https:";
  let session = getCookie(request, SESSION_COOKIE);
  if (request.headers.get("Cookie")?.includes(`${SESSION_COOKIE}=`) && !/^[A-Za-z0-9.,_-]{1,128}$/.test(session)) {
    return json({ error: "The mailbox session is invalid. Generate a new address." }, 401, {
      "Set-Cookie": cookieHeader("", secure),
    });
  }
  const clientIp = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const userAgent = request.headers.get("User-Agent") || "TempMail";

  try {
    const call = (fn, args = {}) => callProvider(fn, args, session, clientIp, userAgent);
    let response;
    let payload;

    switch (body.action) {
      case "init": {
        const { result, session: nextSession } = await call("get_email_address", { lang: "en" });
        session = nextSession;
        payload = normalizeAddress(result);
        response = json({ ...payload });
        break;
      }
      case "check":
      case "list": {
        if (!session) return json({ error: "Mailbox session expired. Generate a new address." }, 401);
        const offset = body.action === "list" ? Number(body.offset ?? 0) : 0;
        const seq = body.seq === undefined ? undefined : Number(body.seq);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000 || (seq !== undefined && (!Number.isSafeInteger(seq) || seq < 0))) {
          return json({ error: "Invalid inbox cursor." }, 400);
        }
        const args = { offset: String(offset) };
        if (seq !== undefined) args.seq = String(seq);
        const { result, session: nextSession } = await call(
          body.action === "check" ? "check_email" : "get_email_list",
          body.action === "check" ? { seq: String(seq ?? 0) } : args,
        );
        session = nextSession;
        payload = normalizeMessages(result);
        response = json(payload);
        break;
      }
      case "fetch": {
        const id = validId(body.id);
        if (!session) return json({ error: "Mailbox session expired. Generate a new address." }, 401);
        if (!id) return json({ error: "Invalid message id." }, 400);
        const { result, session: nextSession } = await call("fetch_email", { email_id: String(id) });
        session = nextSession;
        payload = allowedFields(result, [
          "mail_id",
          "mail_from",
          "mail_to",
          "mail_recipient",
          "mail_subject",
          "mail_date",
          "mail_timestamp",
          "mail_read",
          "mail_body",
          "mail_body_plain",
          "mail_text",
          "mail_html",
          "body",
          "body_text",
          "body_html",
        ]);
        if (!Object.keys(payload).some((key) => /body|text|html/i.test(key))) {
          throw Object.assign(new Error("The provider did not return message content."), { status: 502 });
        }
        response = json(payload);
        break;
      }
      case "change": {
        const user = body.user;
        if (!session) return json({ error: "Mailbox session expired. Generate a new address." }, 401);
        if (typeof user !== "string" || !/^[a-z0-9._+-]{1,64}$/i.test(user)) {
          return json({ error: "Enter a valid address name (letters, numbers, dots, underscores or hyphens)." }, 400);
        }
        const { result, session: nextSession } = await call("set_email_user", { email_user: user, lang: "en" });
        session = nextSession;
        payload = normalizeAddress(result);
        response = json(payload);
        break;
      }
      case "new": {
        if (!session) {
          const { result, session: nextSession } = await call("get_email_address", { lang: "en" });
          session = nextSession;
          payload = normalizeAddress(result);
          response = json(payload);
          break;
        }
        if (!validEmail(body.email)) return json({ error: "The current email address is required." }, 400);
        const forgotten = await call("forget_me", { email_addr: body.email });
        if (forgotten.result !== true && forgotten.result?.success !== true) {
          throw Object.assign(new Error("The provider could not release the current address."), {
            status: 502,
            session: forgotten.session,
          });
        }
        session = forgotten.session;
        const created = await call("get_email_address", { lang: "en" });
        session = created.session;
        payload = normalizeAddress(created.result);
        response = json(payload);
        break;
      }
      case "delete": {
        if (!session) return json({ error: "Mailbox session expired. Generate a new address." }, 401);
        if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 20) {
          return json({ error: "Select one to twenty messages to delete." }, 400);
        }
        const ids = [...new Set(body.ids.map(validId))];
        if (ids.some((id) => !id)) return json({ error: "Invalid message id." }, 400);
        const params = { "email_ids[]": ids.map(String) };
        const { result, session: nextSession } = await call("del_email", params);
        session = nextSession;
        const deletedIds = Array.isArray(result)
          ? result
          : Array.isArray(result?.deleted_ids)
            ? result.deleted_ids
            : Array.isArray(result?.email_ids)
              ? result.email_ids
              : null;
        if (!deletedIds) {
          throw Object.assign(new Error("The provider returned an invalid deletion response."), {
            status: 502,
            session: nextSession,
          });
        }
        response = json({ deletedIds: deletedIds.map(Number).filter((id) => ids.includes(id)) });
        break;
      }
      case "extend": {
        if (!session) return json({ error: "Mailbox session expired. Generate a new address." }, 401);
        const { result, session: nextSession } = await call("extend");
        session = nextSession;
        response = json(allowedFields(result, ["expired", "email_timestamp", "affected"]));
        break;
      }
      default:
        return json({ error: "Unsupported mailbox action." }, 400);
    }

    if (session) response.headers.set("Set-Cookie", cookieHeader(session, secure));
    return response;
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 502;
    const headers = {};
    if (error?.session || session) headers["Set-Cookie"] = cookieHeader(error?.session || session, secure);
    return json({ error: error?.message || "The mailbox request failed." }, status, headers);
  }
}
