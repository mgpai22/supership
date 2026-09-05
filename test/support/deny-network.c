/* Test-only direct-network boundary, not a hostile-code sandbox. AF_UNIX is
 * required by OMP eval and can still reach local proxies or receive passed FDs.
 * The caller must isolate ambient services, credentials, and configuration.
 * Build: gcc -std=c11 -O2 -Wall -Wextra -Werror -o /tmp/deny-network deny-network.c
 */
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <string.h>

#if defined(__linux__) && defined(__x86_64__) && !defined(__ILP32__)
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

static int fail(const char *operation) {
    fprintf(stderr, "deny-network: %s: %s; target not executed\n", operation, strerror(errno));
    return 125;
}

static int launch(char **argv) {
    int invalid_stdio = 0;
    for (int fd = 0; fd <= 2; ++fd) {
        int domain;
        socklen_t size = sizeof(domain);
        if (getsockopt(fd, SOL_SOCKET, SO_DOMAIN, &domain, &size) == 0) {
            if (domain != AF_UNIX) {
                close(fd);
                invalid_stdio = 1;
            }
        } else if (errno != ENOTSOCK && errno != EBADF) {
            return fail("cannot verify standard descriptors");
        }
    }
    if (invalid_stdio) {
        fprintf(stderr, "deny-network: non-UNIX socket on stdin, stdout, or stderr; target not executed\n");
        return 125;
    }
    /* close_range also closes descriptors above a lowered RLIMIT_NOFILE. */
    if (syscall(SYS_close_range, 3U, UINT_MAX, 0U) != 0)
        return fail("cannot close inherited descriptors (close_range required)");
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0)
        return fail("cannot set no_new_privs");

#define DENY_SYSCALL(number) \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (number), 0, 1), \
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        /* x32 shares AUDIT_ARCH_X86_64. Reject its bit and legacy 512..547
         * syscall numbers, which older kernels also accepted without the bit. */
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000U, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 512, 0, 2),
        BPF_JUMP(BPF_JMP | BPF_JGT | BPF_K, 547, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        /* io_uring can perform socket operations without socket syscalls.
         * pidfd_getfd can import an unfiltered process's network descriptor. */
        DENY_SYSCALL(SYS_io_uring_setup),
        DENY_SYSCALL(SYS_io_uring_enter),
        DENY_SYSCALL(SYS_io_uring_register),
        DENY_SYSCALL(SYS_pidfd_getfd),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socket, 2, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socketpair, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        /* The kernel casts the domain to int, so compare its low 32 bits. */
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
#undef DENY_SYSCALL
    struct sock_fprog program = {
        .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
        .filter = filter,
    };
    if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &program) != 0)
        return fail("cannot install seccomp filter (Linux x86_64 seccomp required)");
    execvp(argv[0], argv);
    int status = errno == ENOENT ? 127 : 126;
    fprintf(stderr, "deny-network: cannot execute %s: %s\n", argv[0], strerror(errno));
    return status;
}
#endif

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: deny-network PROGRAM [ARGS...]\n");
        return 2;
    }
#if defined(__linux__) && defined(__x86_64__) && !defined(__ILP32__)
    return launch(argv + 1);
#else
    (void)argv;
    fprintf(stderr, "deny-network: unsupported platform; Linux x86_64 required; target not executed\n");
    return 125;
#endif
}
