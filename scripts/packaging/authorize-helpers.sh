#!/bin/sh
# Installation/upgrade runs as root. Never ask for a password in a package hook.
# EMCLI_PACKAGE_ROOT is used by installation tests on a staged package.
root=${EMCLI_PACKAGE_ROOT:-/usr/lib/emcli}
if command -v setcap >/dev/null 2>&1; then
    for name in EthercatFdBrokerExecutable CanFdBrokerExecutable EthernetXdpBrokerExecutable ThreadPriorityHelper; do
        case "$name" in
            ThreadPriorityHelper) caps=cap_sys_nice+ep ;;
            EthernetXdpBrokerExecutable) caps=cap_net_raw,cap_net_admin,cap_bpf+ep ;;
            *) caps=cap_net_raw,cap_net_admin+ep ;;
        esac
        find "$root/modules" -type f -name "$name" -exec sh -c '
            caps=$1; shift
            for helper do
                setcap "$caps" "$helper" || printf "emcli: Could not authorize %s; run emcli doctor before using hardware.\n" "$helper" >&2
            done
        ' sh "$caps" {} +
    done
else
    printf 'emcli: setcap unavailable; install libcap tools and run emcli doctor --request-permissions.\n' >&2
fi
if command -v udevadm >/dev/null 2>&1; then
    udevadm control --reload-rules >/dev/null 2>&1 || true
fi
exit 0
