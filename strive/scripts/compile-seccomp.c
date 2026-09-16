/* Build the architecture-specific BPF from the reviewed, default-deny policy. */
#include <errno.h>
#include <linux/sched.h>
#include <seccomp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static void check(int result) {
    if (result < 0) { fprintf(stderr, "seccomp: %s\n", strerror(-result)); exit(1); }
}
int main(int argc, char **argv) {
    if (argc != 2) return 2;
    FILE *input = fopen(argv[1], "r");
    if (!input) { perror("policy"); return 1; }
    scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ERRNO(EPERM));
    if (!ctx) return 1;
    char line[256];
    while (fgets(line, sizeof(line), input)) {
        line[strcspn(line, "\r\n")] = 0;
        if (!line[0] || line[0] == '#') continue;
        int syscall = seccomp_syscall_resolve_name(line);
        if (syscall == __NR_SCMP_ERROR) { fprintf(stderr, "unknown syscall: %s\n", line); return 1; }
        if (syscall >= 0) check(seccomp_rule_add(ctx, SCMP_ACT_ALLOW, syscall, 0));
    }
    fclose(input);
    unsigned long blocked = CLONE_NEWCGROUP | CLONE_NEWIPC | CLONE_NEWNET |
        CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWUSER | CLONE_NEWUTS | CLONE_UNTRACED;
    check(seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(clone), 1,
        SCMP_A0(SCMP_CMP_MASKED_EQ, blocked, 0)));
    check(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(clone3), 0));
    /* No AF_PACKET/NETLINK/VSOCK, including VM-host transports. */
    int domains[] = {AF_UNIX, AF_INET, AF_INET6};
    for (unsigned int i = 0; i < sizeof(domains) / sizeof(domains[0]); i++)
        check(seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(socket), 1,
            SCMP_A0(SCMP_CMP_EQ, domains[i])));
    check(seccomp_export_bpf(ctx, STDOUT_FILENO));
    seccomp_release(ctx);
    return 0;
}
