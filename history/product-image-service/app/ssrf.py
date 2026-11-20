from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse


class SSRFBlocked(ValueError):
    pass


def validate_public_url(url: str, allow_synthetic_dns: bool = False) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise SSRFBlocked("only http(s) URLs with a hostname are allowed")
    host = parsed.hostname.rstrip(".").lower()
    if host in {"localhost", "localhost.localdomain", "metadata.google.internal"}:
        raise SSRFBlocked("local and metadata hosts are blocked")
    try:
        addresses = {
            item[4][0]
            for item in socket.getaddrinfo(host, parsed.port or 443, type=socket.SOCK_STREAM)
        }
    except socket.gaierror as exc:
        raise SSRFBlocked("hostname does not resolve") from exc
    for address in addresses:
        ip = ipaddress.ip_address(address)
        synthetic = ip in ipaddress.ip_network("127.0.0.1/15") or ip in ipaddress.ip_network(
            "fdfe:dcba:9876::/48"
        )
        if synthetic and allow_synthetic_dns:
            continue
        if any(
            (
                ip.is_private,
                ip.is_loopback,
                ip.is_link_local,
                ip.is_multicast,
                ip.is_reserved,
                ip.is_unspecified,
            )
        ):
            raise SSRFBlocked("private or special-use IP is blocked")
