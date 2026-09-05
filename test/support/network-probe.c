/* Raw-syscall probes for offline-boundary.test.ts. Never contacts a remote host. */
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static void denied(long result) {
    assert(result == -1);
    assert(errno == EPERM);
}

static void killed_syscall(int kind) {
    pid_t pid = fork();
    assert(pid >= 0);
    if (pid == 0) {
        if (kind == 0) {
            /* i386 getpid, even though this executable is x86_64. */
            __asm__ volatile("int $0x80" : : "a"(20) : "memory");
        } else {
            syscall(kind == 1 ? (0x40000000L | SYS_getpid) : kind == 2 ? 512L : 547L);
        }
        _exit(42);
    }
    int status;
    assert(waitpid(pid, &status, 0) == pid);
    assert(WIFSIGNALED(status) && WTERMSIG(status) == SIGSYS);
}

static void verify(void) {
    struct rlimit core = {0, 0};
    assert(setrlimit(RLIMIT_CORE, &core) == 0);
    assert(prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) == 1);
    assert(prctl(PR_GET_SECCOMP) == SECCOMP_MODE_FILTER);

    int pair[2];
    for (int family = -1; family <= AF_MAX; ++family) {
        if (family == AF_UNIX) continue;
        denied(socket(family, SOCK_STREAM, 0));
        denied(socketpair(family, SOCK_STREAM, 0, pair));
    }
    /* Nonzero high argument bits must not disguise an INET domain. */
    denied(syscall(SYS_socket, (1UL << 32) | AF_INET, SOCK_STREAM, 0));
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    assert(fd >= 0);
    close(fd);
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0);
    assert(write(pair[0], "ok", 2) == 2);
    char message[2];
    assert(read(pair[1], message, 2) == 2 && memcmp(message, "ok", 2) == 0);
    close(pair[0]);
    close(pair[1]);

    denied(syscall(SYS_io_uring_setup, 0, NULL));
    denied(syscall(SYS_io_uring_enter, -1, 0, 0, 0, NULL, 0));
    denied(syscall(SYS_io_uring_register, -1, 0, NULL, 0));
    denied(syscall(SYS_pidfd_getfd, -1, 0, 0));
    for (int kind = 0; kind < 4; ++kind) killed_syscall(kind);
    puts("socket families, UNIX I/O, io_uring, pidfd_getfd, i386, x32, and active filter: passed");
}

int main(int argc, char **argv) {
    if (argc == 1) {
        verify();
        return 0;
    }
    if (argc == 3 && strcmp(argv[1], "check-closed") == 0) {
        assert(fcntl(atoi(argv[2]), F_GETFD) == -1 && errno == EBADF);
        puts("inherited network descriptor closed");
        return 0;
    }
    if (argc == 4 && strcmp(argv[1], "inherit") == 0) {
        int fd = socket(AF_INET, SOCK_STREAM, 0);
        assert(fd >= 0);
        int target = atoi(argv[2]);
        assert(dup2(fd, target) == target);
        if (fd != target) close(fd);
        if (target > 2) {
            /* A close loop using only the current soft limit would miss it. */
            struct rlimit limit;
            assert(getrlimit(RLIMIT_NOFILE, &limit) == 0);
            limit.rlim_cur = 64;
            assert(setrlimit(RLIMIT_NOFILE, &limit) == 0);
            execl(argv[3], argv[3], argv[0], "check-closed", argv[2], NULL);
        } else {
            execl(argv[3], argv[3], "/bin/echo", "TARGET_EXECUTED", NULL);
        }
        perror("exec launcher");
        return 1;
    }
    if (argc == 4 && strcmp(argv[1], "deny-setup") == 0) {
        int syscall_number = strcmp(argv[2], "close_range") == 0 ? SYS_close_range :
            strcmp(argv[2], "no_new_privs") == 0 ? SYS_prctl : SYS_seccomp;
        struct sock_filter filter[] = {
            BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
            BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, syscall_number, 0, 1),
            BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
            BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        };
        struct sock_fprog program = {.len = sizeof(filter) / sizeof(filter[0]), .filter = filter};
        assert(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0);
        assert(syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &program) == 0);
        execl(argv[3], argv[3], "/bin/echo", "TARGET_EXECUTED", NULL);
        perror("exec launcher");
        return 1;
    }
    fprintf(stderr, "invalid probe arguments\n");
    return 2;
}
