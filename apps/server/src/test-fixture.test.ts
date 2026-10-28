import { once } from "node:events";
import { connect, type Socket } from "node:net";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vite-plus/test";
import { createHttpSender, createMailSender } from "./adapters/outbound.ts";
import { startHttpReceiver, startMailbox, type ReceivedRequest } from "./test-fixture.ts";

const send = createHttpSender({ allowPrivate: true });

describe("loopback protocol fixtures", () => {
  it("rejects root probes and another fake's path without recording or consuming scripted responses", async () => {
    const received: ReceivedRequest[] = [];
    const statuses = [503, 200];
    const http = await startHttpReceiver((request, response) => {
      received.push(request);
      response.writeHead(statuses.shift() ?? 200).end();
    });
    const other = await startHttpReceiver((_request, response) => response.end());
    try {
      for (const path of ["/", new URL(other.url).pathname])
        expect(await send({ url: new URL(path, http.url).href, method: "GET", body: "" })).toEqual({
          status: 404,
        });
      expect(received).toEqual([]);
      expect(statuses).toEqual([503, 200]);
      expect(await send({ url: `${http.url}/hook?q=1`, body: "owned" })).toEqual({ status: 503 });
      expect(await send({ url: `${http.url}/hook`, body: "next" })).toEqual({ status: 200 });
      expect(received.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
        { method: "POST", url: "/hook?q=1", body: "owned" },
        { method: "POST", url: "/hook", body: "next" },
      ]);
    } finally {
      await Promise.all([http.close(), other.close()]);
    }
  });

  it("survives a reset during an incomplete HTTP body and still records the next complete request", async () => {
    const received: ReceivedRequest[] = [];
    const http = await startHttpReceiver((request, response) => {
      received.push(request);
      response.end();
    });
    const peer = connect(http.port, "127.0.0.1");
    try {
      await once(peer, "connect");
      const incoming = new Promise<IncomingMessage>((done) => http.server.once("request", done));
      peer.write(
        `POST ${new URL(http.url).pathname}/hook HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\nx`,
      );
      const request = await incoming;
      const closed = new Promise<void>((done) => request.once("close", done));
      peer.resetAndDestroy();
      await closed;
      expect(received).toEqual([]);
      expect(await send({ url: `${http.url}/hook`, body: "complete" })).toEqual({ status: 200 });
      expect(received.map(({ body }) => body)).toEqual(["complete"]);
    } finally {
      peer.destroy();
      await http.close();
    }
  });

  it("survives an SMTP peer reset after the greeting without losing subsequent mail", async () => {
    const mail = await startMailbox();
    const accepted = new Promise<Socket>((done) => mail.server.once("connection", done));
    const peer = connect(Number(new URL(mail.url).port), "127.0.0.1");
    try {
      const socket = await accepted;
      await once(peer, "data");
      const closed = new Promise<void>((done) => socket.once("close", done));
      peer.resetAndDestroy();
      await closed;
      expect(mail.messages).toEqual([]);
      await createMailSender(
        mail.url,
        "from@example.test",
      )({ to: "to@example.test", subject: "After reset", text: "still delivered" });
      expect(mail.messages).toHaveLength(1);
      expect(mail.messages[0]).toContain("still delivered");
    } finally {
      peer.destroy();
      await mail.close();
    }
  });
});
