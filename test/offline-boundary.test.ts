import type { Server } from "bun";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Both the launched Bun process and its exec'd child execute this same probe.
const bunProbe = String.raw`
import assert from "node:assert/strict";
const watchdog = setTimeout(() => process.exit(124), 8000);
import net from "node:net";

async function deniedListen(host) {
    const server = net.createServer();
    const { promise, resolve, reject } = Promise.withResolvers();
    server.once("error", reject);
    try {
        server.listen({ host, port: 0 }, () => server.close(resolve));
    } catch (error) {
        reject(error);
    }
    // Bun's node:net listener errors omit errno. The C probe checks EPERM.
    await assert.rejects(promise);
    return "denied";
}

async function unixEcho(path) {
    const { promise, resolve, reject } = Promise.withResolvers();
    const socket = net.connect(path, () => socket.write("unix-echo"));
    let reply = "";
    socket.on("data", data => { reply += data.toString(); });
    socket.on("end", () => resolve(reply));
    socket.on("error", reject);
    return await promise;
}

let server;
try {
    if (!process.env.BOUNDARY_CHILD) {
        server = net.createServer(socket => socket.once("data", data => socket.end(data)));
        const { promise, resolve, reject } = Promise.withResolvers();
        server.once("error", reject);
        server.listen(process.env.UNIX_PATH, resolve);
        await promise;
    }
    await assert.rejects(fetch(process.env.HTTP_URL, {
        proxy: "", signal: AbortSignal.timeout(2000),
    }));
    const self = {
        fetch: "denied",
        ipv4: await deniedListen("127.0.0.1"),
        ipv6: await deniedListen("::1"),
        unix: await unixEcho(process.env.UNIX_PATH),
    };
    assert.equal(self.unix, "unix-echo");
    if (process.env.BOUNDARY_CHILD) {
        console.log(JSON.stringify(self));
    } else {
        const child = Bun.spawn([process.execPath, "-e", process.env.BOUNDARY_SCRIPT], {
            env: { ...process.env, BOUNDARY_CHILD: "1" },
            stdin: "ignore", stdout: "pipe", stderr: "pipe",
        });
        const [status, stdout, stderr] = await Promise.all([
            child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        assert.equal(status, 0, stderr);
        console.log(JSON.stringify({ self, child: JSON.parse(stdout) }));
    }
} finally {
    if (server) {
        const { promise, resolve } = Promise.withResolvers();
        server.close(resolve);
        await promise;
    }
    clearTimeout(watchdog);
}
`;

test("the offline launcher denies direct network access across exec and fails closed", async () => {
    assert.equal(process.platform, "linux", "the offline proof requires Linux");
    assert.equal(process.arch, "x64", "the offline proof requires x86_64");
    const directory = mkdtempSync(join(tmpdir(), "supership-offline-"));
    const launcher = join(directory, "deny-network");
    const probe = join(directory, "network-probe");
    const environment = {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: directory,
        TMPDIR: directory,
        LC_ALL: "C",
    };
    const run = (command: string[], env = environment) => spawnSync(command[0]!, command.slice(1), {
        env, cwd: directory, encoding: "utf8", timeout: 10000,
    });
    const succeeds = (command: string[]) => {
        const result = run(command);
        assert.ifError(result.error);
        assert.equal(result.status, 0, `${command.join(" ")}\n${result.stderr}`);
        return result.stdout;
    };
    let server: Server<undefined> | undefined;
    try {
        for (const name of ["deny-network", "network-probe"]) {
            succeeds(["gcc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
                "-o", join(directory, name), join(import.meta.dir, "support", `${name}.c`)]);
        }
        const usage = run([launcher]);
        assert.equal(usage.status, 2);
        assert.match(usage.stderr, /usage: deny-network/);
        assert.equal(run([launcher, join(directory, "absent")]).status, 127);
        assert.equal(run([launcher, directory]).status, 126);
        const exit = run([launcher, "/bin/sh", "-c", "printf '%s' \"$1\"; exit 23", "sh", "argument with spaces"]);
        assert.equal(exit.status, 23);
        assert.equal(exit.stdout, "argument with spaces");

        succeeds([launcher, probe]);
        assert.match(succeeds([probe, "inherit", "1000", launcher]), /inherited network descriptor closed/);
        for (const descriptor of ["0", "1", "2"]) {
            const rejected = run([probe, "inherit", descriptor, launcher]);
            assert.equal(rejected.status, 125, rejected.stderr);
            assert.equal(rejected.stdout, "", "target must not execute with network stdio");
            if (descriptor !== "2") assert.match(rejected.stderr, /non-UNIX socket/);
        }
        for (const operation of ["close_range", "no_new_privs", "seccomp"]) {
            const rejected = run([probe, "deny-setup", operation, launcher]);
            assert.equal(rejected.status, 125, rejected.stderr);
            assert.match(rejected.stderr, /target not executed/);
            assert.equal(rejected.stdout, "", "setup failure must never execute the target");
        }

        // An unfiltered loopback control prevents a dead endpoint from proving denial.
        // No test request targets an external host or uses ambient credentials/proxies.
        let requests = 0;
        server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
            requests += 1;
            return new Response("reachable");
        } });
        const url = `http://127.0.0.1:${server.port}/`;
        assert.equal(await (await fetch(url, { proxy: "" })).text(), "reachable");
        assert.equal(requests, 1);
        const child = Bun.spawn([launcher, process.execPath, "-e", bunProbe], {
            cwd: directory,
            env: { ...environment, BOUNDARY_SCRIPT: bunProbe, HTTP_URL: url, UNIX_PATH: join(directory, "eval.sock") },
            stdin: "ignore", stdout: "pipe", stderr: "pipe",
        });
        // This real-process watchdog terminates a broken child; it is not a delay
        // used to infer completion. Normal completion awaits the process exit.
        const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
        try {
            const [status, stdout, stderr] = await Promise.all([
                child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
            ]);
            assert.equal(status, 0, stderr);
            const expected = { fetch: "denied", ipv4: "denied", ipv6: "denied", unix: "unix-echo" };
            assert.deepEqual(JSON.parse(stdout), { self: expected, child: expected });
            assert.equal(requests, 1, "neither filtered process may reach the live HTTP server");
        } finally {
            clearTimeout(timeout);
        }
    } finally {
        server?.stop(true);
        // This directory contains only this test's generated binaries and UNIX socket.
        rmSync(directory, { recursive: true, force: true });
    }
}, 20000);
