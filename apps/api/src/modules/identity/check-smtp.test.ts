// SPDX-License-Identifier: AGPL-3.0-only
// The mail check before smtp.url is stored: each failure line, against a fake SMTP server, and
// that no line holds the password.
import { afterEach, expect, test, vi } from "vitest";
import { smtpFailure } from "./adapters/mail";
import { checkSmtp } from "./index";

const PASS = "s3cret pass@/%:";
const user = "direx";
const urlFor = (port: number, query = "") => `smtp://${user}:${encodeURIComponent(PASS)}@127.0.0.1:${port}${query}`;

type Sent = { from: string; to: string[]; data: string };

function smtpLines() {
  const decoder = new TextDecoder();
  let remainder = "";
  return (buf: Uint8Array) => {
    const lines = (remainder + decoder.decode(buf, { stream: true })).split("\r\n");
    remainder = lines.pop()!;
    return lines;
  };
}

/**
 * An SMTP server that offers a login, accepts it only when `login`, answers MAIL FROM with
 * `mailFrom`, refuses STARTTLS, and keeps each message it accepts.
 */
function fakeSmtp({ login = true, mailFrom = "250 ok", hostname = "127.0.0.1" } = {}) {
  const sent: Sent[] = [];
  const state = new Map<unknown, { msg: Sent; data: boolean; lines: ReturnType<typeof smtpLines> }>();
  const server = Bun.listen({
    hostname,
    port: 0,
    socket: {
      open: (s) => {
        state.set(s, { msg: { from: "", to: [], data: "" }, data: false, lines: smtpLines() });
        s.write("220 fake\r\n");
      },
      data: (s, buf) => {
        const st = state.get(s)!;
        for (const line of st.lines(buf)) {
          if (st.data) {
            if (line === ".") {
              st.data = false;
              sent.push(st.msg);
              st.msg = { from: "", to: [], data: "" };
              s.write("250 queued\r\n");
            } else st.msg.data += `${line}\n`;
            continue;
          }
          if (!line) continue;
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === "EHLO") s.write("250-fake\r\n250 AUTH PLAIN LOGIN\r\n");
          else if (cmd === "AUTH") s.write(login ? "235 ok\r\n" : "535 no\r\n");
          else if (cmd === "STAR") s.write("454 TLS not available\r\n");
          else if (cmd === "MAIL") {
            st.msg.from = line;
            s.write(`${mailFrom}\r\n`);
          } else if (cmd === "RCPT") {
            st.msg.to.push(line);
            s.write("250 ok\r\n");
          } else if (cmd === "DATA") {
            st.data = true;
            s.write("354 go\r\n");
          } else if (cmd === "QUIT") s.end("221 bye\r\n");
          else s.write("250 ok\r\n");
        }
      },
      close: (s) => {
        state.delete(s);
      },
    },
  });
  return { server, sent };
}

let servers: ReturnType<typeof fakeSmtp>["server"][] = [];
afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
});
const start = (opts?: Parameters<typeof fakeSmtp>[0]) => {
  const f = fakeSmtp(opts);
  servers.push(f.server);
  return f;
};

const failed = async (p: Promise<{ ok: boolean; line?: string }>) => {
  const r = await p;
  expect(r.ok).toBe(false);
  const line = (r as { line: string }).line;
  expect(line).not.toContain(PASS);
  expect(line).not.toContain(encodeURIComponent(PASS));
  return line;
};

test("the SMTP fixture keeps partial commands and DATA terminators across chunks", () => {
  const lines = smtpLines();
  expect(lines(Buffer.from("EH"))).toEqual([]);
  expect(lines(Buffer.from("LO client\r"))).toEqual([]);
  expect(lines(Buffer.from("\nMAIL FROM:<x>\r\n.\r"))).toEqual(["EHLO client", "MAIL FROM:<x>"]);
  expect(lines(Buffer.from("\nQUIT\r\n"))).toEqual([".", "QUIT"]);
});

test("a refused login names the host and the user", async () => {
  const { server } = start({ login: false });
  expect(await failed(checkSmtp(urlFor(server.port), "a@example.com"))).toBe(`127.0.0.1 refused the login for ${user}`);
  // A stray % that doesn't decode still leaves the line as it is.
  expect(await failed(checkSmtp(`smtp://u%zz:p%zz@127.0.0.1:${server.port}`, "a@example.com"))).toBe("127.0.0.1 refused the login for u%zz");
});

test("a closed port says the server couldn't be reached", async () => {
  const { server } = start();
  const port = server.port;
  server.stop(true);
  expect(await failed(checkSmtp(urlFor(port), "a@example.com"))).toBe(`couldn't reach 127.0.0.1:${port}`);
});

test("a refused sender gives the server's reply, without the password it echoed", async () => {
  const { server, sent } = start({ mailFrom: `550 domain not verified for ${PASS}` });
  const line = await failed(checkSmtp(urlFor(server.port), "a@example.com", "me@example.com"));
  expect(line).toBe("127.0.0.1 refused the test email: 550 domain not verified for ***");
  expect(sent).toEqual([]);
});

test("even a URL with diagnostics enabled keeps replies out of the console", async () => {
  const { server } = start({ mailFrom: `550 refused ${PASS}` });
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const url = urlFor(server.port, "?%6cogger=true&debug=true&transactionLog=true");
    expect(await failed(checkSmtp(url, "a@example.com", "me@example.com"))).toBe("127.0.0.1 refused the test email: 550 refused ***");
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

test("transport construction failures return a sanitized result", async () => {
  const url = `smtp://u:${encodeURIComponent(PASS)}@bad%00.example:587`;
  const line = await failed(checkSmtp(url, ""));
  expect(line).not.toContain(url);
});

test.each(["jsonTransport", "streamTransport"])("rejects the %s transport without sending test mail", async (option) => {
  const { sent, server } = start();
  const url = urlFor(server.port, `?${option}=true`);
  expect(await failed(checkSmtp(url, "a@example.com", "me@example.com"))).toBe("that URL doesn't select an SMTP transport");
  expect(sent).toEqual([]);
});

test("TLS fails on a server that refuses the STARTTLS the URL requires, and on smtps:// to a plain port", async () => {
  const { server } = start();
  const line = `TLS failed on 127.0.0.1:${server.port}; check the port`;
  expect(await failed(checkSmtp(urlFor(server.port, "?requireTLS=true"), "a@example.com"))).toBe(line);
  expect(await failed(checkSmtp(urlFor(server.port).replace("smtp:", "smtps:"), "a@example.com"))).toBe(line);
});

test("a URL that isn't SMTP is refused without echoing it", async () => {
  expect(await failed(checkSmtp(`https://u:${PASS}@x`, "a@example.com"))).toBe("that isn't an smtp:// or smtps:// URL");
  expect(await failed(checkSmtp(PASS, "a@example.com"))).toBe("that isn't an smtp:// or smtps:// URL");
});

test("a login alone sends nothing; with testTo exactly one message goes to it", async () => {
  const { server, sent } = start();
  expect(await checkSmtp(urlFor(server.port), "")).toEqual({ ok: true });
  expect(sent).toEqual([]);
  process.env.DIREX_BASE_URL = "https://direx.example.com";
  try {
    expect(await checkSmtp(urlFor(server.port), "Direx <signin@example.com>", "me@example.com")).toEqual({ ok: true });
  } finally {
    delete process.env.DIREX_BASE_URL;
  }
  expect(sent).toHaveLength(1);
  expect(sent[0]!.from).toContain("signin@example.com");
  expect(sent[0]!.to).toEqual(["RCPT TO:<me@example.com>"]);
  expect(sent[0]!.data).toContain("Subject: Direx sign-in mail works");
  expect(sent[0]!.data).toContain("https://direx.example.com");
});

test("pooled SMTP checks a login over IPv6", async () => {
  const { server, sent } = start({ hostname: "::1" });
  const url = urlFor(server.port, "?pool=true").replace("127.0.0.1", "[::1]");
  expect(await checkSmtp(url, "")).toEqual({ ok: true });
  expect(sent).toEqual([]);
});

const at = { host: "smtp.example.com", port: 587 };
const err = (fields: Record<string, unknown>) => Object.assign(new Error(String(fields.message ?? "boom")), fields);

test("smtpFailure maps each nodemailer error to its line", () => {
  for (const code of ["EDNS", "ECONNECTION", "ETIMEDOUT"]) expect(smtpFailure(err({ code }), "login", at, "u")).toBe("couldn't reach smtp.example.com:587");
  expect(smtpFailure(err({ code: "ESOCKET", originalCode: "ECONNREFUSED" }), "send", at, "u")).toBe("couldn't reach smtp.example.com:587");
  expect(smtpFailure(err({ code: "ETLS" }), "login", at, "u")).toBe("TLS failed on smtp.example.com:587; check the port");
  expect(smtpFailure(err({ code: "ESOCKET", originalCode: "ERR_SSL_WRONG_VERSION_NUMBER" }), "login", at, "u")).toBe("TLS failed on smtp.example.com:587; check the port");
  expect(smtpFailure(err({ code: "ESOCKET", message: "self-signed certificate" }), "login", at, "u")).toBe("TLS failed on smtp.example.com:587; check the port");
  expect(smtpFailure(err({ code: "EAUTH", responseCode: 535 }), "login", at, "u")).toBe("smtp.example.com refused the login for u");
  expect(smtpFailure(err({ code: "EENVELOPE", responseCode: 550, response: "550 no" }), "send", at, "u")).toBe("smtp.example.com refused the test email: 550 no");
  expect(smtpFailure(err({ code: "EMESSAGE", message: "Empty message" }), "send", at, "u")).toBe("smtp.example.com refused: Empty message");
});
