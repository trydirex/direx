// SPDX-License-Identifier: AGPL-3.0-only
// A scripted SMTP server for what a real test server can't do on demand: refuse at a chosen step,
// or take a message and then drop or go silent.
import { createServer, type Socket } from "node:net";

export type SmtpScript = {
  auth?: string;
  mail?: string;
  rcpt?: string;
  /** The reply after the message; "drop" closes the connection and "hang" says nothing. */
  afterData?: string | "drop" | "hang";
};

export type FakeSmtp = { port: number; script: SmtpScript; messages: string[]; stop: () => void };

export async function startFakeSmtp(): Promise<FakeSmtp> {
  const messages: string[] = [];
  const script: SmtpScript = {};
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let inData = false;
    let buffer = "";
    const say = (line: string) => socket.write(`${line}\r\n`);
    say("220 fake ESMTP");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          messages.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          inData = false;
          const reply = script.afterData ?? "250 queued";
          if (reply === "drop") return void socket.destroy();
          if (reply === "hang") return;
          say(reply);
          continue;
        }
        const nl = buffer.indexOf("\r\n");
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO") say("250-fake\r\n250 AUTH PLAIN LOGIN");
        else if (verb === "AUTH") say(script.auth ?? "235 ok");
        else if (verb === "MAIL") say(script.mail ?? "250 ok");
        else if (verb === "RCPT") say(script.rcpt ?? "250 ok");
        else if (verb === "DATA") {
          inData = true;
          say("354 go ahead");
        } else if (verb === "QUIT") {
          say("221 bye");
          socket.end();
        } else say("250 ok");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the fake SMTP server has no port");
  return {
    port: address.port,
    script,
    messages,
    stop: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}
